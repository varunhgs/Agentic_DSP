import { XMLParser } from 'fast-xml-parser';
import { BwClient, MEDIA_TYPES, freshRead } from '../bw-client.js';
import { extractMethod, listMethods, normalizeAbap, readAbapSource } from './abap_source.js';

/**
 * Structured extraction of a Transformation for migration analysis.
 *
 * Three sources are combined, each with a different role:
 *   1. Transformation XML (/sap/bw/modeling/trfn/{id}/a) — the model: rules, steps,
 *      formulas, constants, aggregation per key figure, runtime flag. Authoritative.
 *   2. Generated program GP<id> (ADT /programs/programs) — the activated ABAP runtime.
 *      It shows what the XML leaves implicit: conversion-exit steps (CONVERT),
 *      initial-value checks, the record-mode handling and the aggregation applied per key
 *      figure, and an inline copy of every routine. Only the *executed* artifact when the
 *      transformation runs in the ABAP runtime (HANARuntime="false").
 *   3. Routine class /BIC/<id>_M — the editable routine source. The active XML points at
 *      the _A class, which ADT does not serve (HTTP 404 on BW/4HANA 2.0), so the _M class
 *      is read and compared with the GP copy: a mismatch means unactivated changes.
 *
 * GP markers relied on (template RSTRAN_MASTER_TMPL, verified on BW/4HANA 2.0 SP17):
 *   *<<<    Rule ID: '<n>'.          rule block start
 *   *       Step ID: '<k>', Type: 'X'.  step inside a rule block
 *   *>>>                              rule block end
 *   METHOD compute_<rule>_<step>.     field routine copy
 *   METHOD start_routine / end_routine / expert_routine.  global routine copies
 * The template is SAP-internal; parsing degrades to a reported issue, never a guess.
 */

const ARRAY_PATHS = new Set([
  'trfn:transformation.group',
  'trfn:transformation.group.rule',
  'trfn:transformation.group.rule.source',
  'trfn:transformation.group.rule.target',
  'trfn:transformation.group.rule.step',
  'trfn:transformation.source.segment',
  'trfn:transformation.target.segment',
  'trfn:transformation.source.segment.element',
  'trfn:transformation.target.segment.element',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name: string, jpath: string) => ARRAY_PATHS.has(jpath),
});

export interface TrfnField {
  name: string;
  infoObject?: string;
  key: boolean;
  dataType?: string;
  length?: string;
  precision?: string;
  scale?: string;
  intType?: string;
  conversionRoutine?: string;
  aggregationType?: string;
  aggregationBehavior?: string;
}

export interface TrfnStep {
  id: string;
  kind: string;
  type?: string;
  rank?: string;
  formula?: string;
  constant?: string;
  routineClass?: string;
  routineMethod?: string;
  attributes: Record<string, string>;
}

export interface TrfnRule {
  groupId: string;
  groupType: string;
  id: string;
  description?: string;
  routineType?: string;
  sourceFields: string[];
  targetFields: string[];
  steps: TrfnStep[];
  conversionClass: 'A' | 'B' | 'C' | 'E';
  classReason: string;
  gp?: { steps: Array<{ id: string; type: string }>; code?: string };
  routine?: RoutineInfo;
}

export interface RoutineInfo {
  kind: 'FIELD' | 'START' | 'END' | 'EXPERT';
  editableClass?: string;
  editableMethod?: string;
  gpMethod?: string;
  editableSource?: string;
  activatedSource?: string;
  sourcesMatch?: boolean;
  language: 'ABAP' | 'SQLSCRIPT' | 'UNKNOWN';
}

export interface ParsedTransformation {
  name: string;
  description: string;
  abapProgram?: string;
  hanaRuntime?: string;
  hanaExecutionPossible?: string;
  flags: Record<string, string>;
  source: { type: string; name: string; sourceSystem?: string; fields: TrfnField[] };
  target: { type: string; name: string; fields: TrfnField[] };
  rules: TrfnRule[];
  targetFieldsWithoutRule: string[];
}

const toArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function fieldOf(el: any): TrfnField {
  const t = el.inlineType ?? {};
  return {
    name: el.name,
    infoObject: el.infoObjectName,
    key: el.key === 'true',
    dataType: t.name,
    length: t.length,
    precision: t.precision,
    scale: t.scale,
    intType: el.intType,
    conversionRoutine: el.conversionRoutine,
    aggregationType: el.aggregationType,
    aggregationBehavior: el.aggregationBehavior,
  };
}

function lastSegment(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

const CLASS_A = new Set(['DIRECT', 'CONSTANT', 'NO_UPDATE', 'NOUPDATE', 'INITIAL']);
const CLASS_B = new Set(['TIME', 'FORMULA', 'READ', 'HIERARCHYSPLIT', 'UNIT', 'CURRENCY']);

/** Deterministic first classification of a rule (see the conversion matrix). */
export function classifyRule(steps: TrfnStep[], routineType?: string): { cls: TrfnRule['conversionClass']; reason: string } {
  if (routineType) return { cls: 'C', reason: `${routineType} routine — custom ABAP` };
  const kinds = steps.map((s) => s.kind.toUpperCase());
  if (kinds.includes('ROUTINE')) return { cls: 'C', reason: 'field routine — custom ABAP' };
  if (kinds.length === 0) return { cls: 'E', reason: 'rule without steps' };
  const unknown = kinds.filter((k) => !CLASS_A.has(k) && !CLASS_B.has(k));
  if (unknown.length) return { cls: 'E', reason: `unassessed step type(s): ${unknown.join(', ')}` };
  const b = kinds.filter((k) => CLASS_B.has(k));
  if (b.length) return { cls: 'B', reason: `needs semantic validation: ${[...new Set(b)].join(', ')}` };
  return { cls: 'A', reason: 'direct/constant/initial mapping' };
}

export function parseTransformationXml(xml: string): ParsedTransformation {
  const doc = parser.parse(xml);
  const root = doc['trfn:transformation'];
  if (!root) throw new Error('Not a transformation document (missing <trfn:transformation>).');

  const flags: Record<string, string> = {};
  for (const [k, v] of Object.entries(root)) {
    if (typeof v === 'string' && !k.startsWith('xmlns')) flags[k] = v;
  }

  const sideOf = (node: any) => {
    const fields = toArray<any>(node?.segment).flatMap((seg) => toArray<any>(seg.element).map(fieldOf));
    const rawName: string = node?.name ?? '';
    const [name, sourceSystem] = rawName.trim().split(/\s+/);
    return { type: node?.type ?? '', name: name ?? '', sourceSystem, fields };
  };
  const source = sideOf(root.source);
  const targetSide = sideOf(root.target);
  const target = { type: targetSide.type, name: targetSide.name, fields: targetSide.fields };

  const rules: TrfnRule[] = [];
  for (const group of toArray<any>(root.group)) {
    for (const rule of toArray<any>(group.rule)) {
      const steps: TrfnStep[] = toArray<any>(rule.step).map((s) => {
        const attributes: Record<string, string> = {};
        for (const [k, v] of Object.entries(s)) if (typeof v === 'string') attributes[k] = v;
        const kind = (s['xsi:type'] ?? '').replace(/^trfn:Step/, '') || (s.type ?? '');
        return {
          id: s.id,
          kind: kind.toUpperCase() === 'NOUPDATE' ? 'NO_UPDATE' : kind.toUpperCase(),
          type: s.type,
          rank: s.rank,
          formula: s.formula?.trim(),
          constant: s.constant,
          routineClass: s.classNameM,
          routineMethod: s.methodNameM,
          attributes,
        };
      });
      const routineType = rule.routinetype || undefined;
      const { cls, reason } = classifyRule(steps, routineType);
      rules.push({
        groupId: group.id,
        groupType: group.type,
        id: rule.id,
        description: rule.description || undefined,
        routineType,
        sourceFields: toArray<any>(rule.source).map((x) => lastSegment(x.elementRef ?? '')).filter(Boolean),
        targetFields: toArray<any>(rule.target).map((x) => lastSegment(x.elementRef ?? '')).filter(Boolean),
        steps,
        conversionClass: cls,
        classReason: reason,
      });
    }
  }

  const covered = new Set(rules.flatMap((r) => r.targetFields));
  const expertPresent = rules.some((r) => r.routineType === 'EXPERT');
  const targetFieldsWithoutRule = expertPresent ? [] : target.fields.map((f) => f.name).filter((n) => !covered.has(n));

  return {
    name: root.name,
    description: root.description ?? '',
    abapProgram: root.abapProgram || undefined,
    hanaRuntime: root.HANARuntime,
    hanaExecutionPossible: root.sapHANAExecutionPossible,
    flags,
    source,
    target,
    rules,
    targetFieldsWithoutRule,
  };
}

export interface GpRuleBlock {
  ruleId: string;
  steps: Array<{ id: string; type: string }>;
  code: string;
}

export interface ParsedGp {
  header: Record<string, string>;
  rules: GpRuleBlock[];
  methods: Array<{ name: string; line: number }>;
  aggregationNotes: string[];
  recordModeLines: string[];
  lineCount: number;
}

/** Split a transformation's generated program into rule blocks and routine copies. */
export function parseGeneratedProgram(source: string): ParsedGp {
  const lines = source.split('\n');
  const header: Record<string, string> = {};
  for (const l of lines.slice(0, 60)) {
    // "TranID........: X" (RSTRAN_MASTER_TMPL) and "TranID     ...: X" (RSTRAN_MASTER_TMPL_EXPERT)
    const m = l.match(/^\*\s+(Template|TranID|Source|Target|Program class)[\s.]*:?\s+(.+?)\s*$/);
    if (m && !header[m[1]]) header[m[1]] = m[2].replace(/\s+Version:.*$/, '').replace(/\s{2,}/g, ' ');
    const g = l.match(/^\*\s+-\s+(Time stamp|Release|User name)\s+(.+?)\s*$/);
    if (g && !header[g[1]]) header[g[1]] = g[2];
  }

  const rules: GpRuleBlock[] = [];
  let current: GpRuleBlock | null = null;
  let buf: string[] = [];
  for (const l of lines) {
    const start = l.match(/^\*<<<\s+Rule ID:\s*'(\w+)'/);
    if (start) {
      current = { ruleId: start[1], steps: [], code: '' };
      buf = [];
      continue;
    }
    if (current && /^\*>>>/.test(l)) {
      current.code = buf.join('\n');
      rules.push(current);
      current = null;
      continue;
    }
    if (current) {
      const step = l.match(/^\*\s+Step ID:\s*'(\w+)',\s*Type:\s*'([\w]+)'/);
      if (step) current.steps.push({ id: step[1], type: step[2] });
      buf.push(l);
    }
  }

  const aggregationNotes = [...new Set(lines.filter((l) => /^\*\s+aggregation\b/i.test(l)).map((l) => l.replace(/^\*\s+/, '').trim()))];
  const recordModeLines = lines
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(({ l }) => /RECORDMODE\b.*=/.test(l) && !l.startsWith('*'))
    .slice(0, 40)
    .map(({ l, i }) => `${i}: ${l}`);

  return { header, rules, methods: listMethods(source), aggregationNotes, recordModeLines, lineCount: lines.length };
}

const GLOBAL_GP_METHOD: Record<string, string> = { START: 'start_routine', END: 'end_routine', EXPERT: 'expert_routine' };
const STEP_TYPES_WITH_CODE = new Set(['ROUTINE', 'CONVERT', 'TIME', 'FORMULA', 'READ', 'CONSTANT', '_INITIAL_VALUE_CHECK', 'UNIT', 'CURRENCY', 'IOBJ_ROUT']);
const MAX_RULE_CODE_LINES = 120;

export interface TransformationLogic {
  transformation: string;
  versionRead: 'active' | 'inactive';
  runtime: { hanaRuntime?: string; hanaExecutionPossible?: string; executedArtifact: string };
  description: string;
  source: ParsedTransformation['source'];
  target: ParsedTransformation['target'];
  rules: TrfnRule[];
  targetFieldsWithoutRule: string[];
  generatedProgram?: {
    name: string;
    header: Record<string, string>;
    lineCount: number;
    aggregationNotes: string[];
    recordModeLines: string[];
    gpOnlyStepTypes: string[];
  };
  summary: Record<string, number>;
  completeness: 'complete' | 'partial';
  issues: string[];
}

/**
 * Read and combine XML, generated program and routine sources for one transformation.
 */
export async function bwGetTransformationLogic(
  client: BwClient,
  transformationName: string,
  options: { version?: 'active' | 'inactive'; includeGp?: boolean; includeRoutineSource?: boolean } = {},
): Promise<TransformationLogic> {
  const issues: string[] = [];
  const trfnLower = transformationName.trim().toLowerCase();
  const wanted = options.version ?? 'active';
  let versionRead: 'active' | 'inactive' = wanted;
  // Fresh session per read: a long-lived session can serve a stale model buffer
  // (see freshReadInactive in transformation.ts).
  let xml: string;
  try {
    xml = (await freshRead(`/sap/bw/modeling/trfn/${trfnLower}/${wanted === 'active' ? 'a' : 'm'}`, MEDIA_TYPES['trfn'])).body;
  } catch (err) {
    if (wanted !== 'active') throw err;
    xml = (await freshRead(`/sap/bw/modeling/trfn/${trfnLower}/m`, MEDIA_TYPES['trfn'])).body;
    versionRead = 'inactive';
    issues.push('Active version not readable — inactive (M) version used; it may contain unactivated changes.');
  }

  const parsed = parseTransformationXml(xml);
  const abapRuntime = parsed.hanaRuntime === 'false';
  const executedArtifact = abapRuntime
    ? `ABAP runtime — generated program ${parsed.abapProgram ?? '(unknown)'} is the executed code`
    : 'HANA runtime — rules are executed by the HANA engine; the generated program is reference only';

  let gp: ReturnType<typeof parseGeneratedProgram> | undefined;
  let gpSource: string | undefined;
  if ((options.includeGp ?? true) && parsed.abapProgram) {
    try {
      gpSource = (await readAbapSource(client, 'PROG', parsed.abapProgram)).source;
      gp = parseGeneratedProgram(gpSource);
      if (gp.header['TranID'] && !gp.header['TranID'].toUpperCase().startsWith(parsed.name.toUpperCase())) {
        issues.push(`Generated program header TranID (${gp.header['TranID']}) does not match the transformation.`);
      }
    } catch (err) {
      issues.push(`Generated program ${parsed.abapProgram} not readable: ${firstLine(err)}`);
    }
  } else if (!parsed.abapProgram) {
    issues.push('No generated program referenced (abapProgram attribute empty).');
  }

  const gpByRule = new Map((gp?.rules ?? []).map((r) => [r.ruleId, r]));
  const xmlStepTypes = new Set(parsed.rules.flatMap((r) => r.steps.map((s) => s.kind)));
  const gpOnly = new Set<string>();

  const routineSourceCache = new Map<string, string | null>();
  async function editableClassSource(cls: string): Promise<string | null> {
    if (!routineSourceCache.has(cls)) {
      try {
        routineSourceCache.set(cls, (await readAbapSource(client, 'CLAS', cls)).source);
      } catch (err) {
        issues.push(`Routine class ${cls} not readable: ${firstLine(err)}`);
        routineSourceCache.set(cls, null);
      }
    }
    return routineSourceCache.get(cls) ?? null;
  }

  for (const rule of parsed.rules) {
    const block = gpByRule.get(rule.id);
    if (block) {
      for (const s of block.steps) if (!xmlStepTypes.has(s.type)) gpOnly.add(s.type);
      const interesting = block.steps.some((s) => STEP_TYPES_WITH_CODE.has(s.type));
      const codeLines = block.code.split('\n');
      rule.gp = {
        steps: block.steps,
        code: interesting
          ? codeLines.slice(0, MAX_RULE_CODE_LINES).join('\n') + (codeLines.length > MAX_RULE_CODE_LINES ? '\n* … truncated' : '')
          : undefined,
      };
    }

    const routineStep = rule.steps.find((s) => s.kind === 'ROUTINE');
    if (!routineStep && !rule.routineType) continue;
    const kind: RoutineInfo['kind'] = (rule.routineType as RoutineInfo['kind']) ?? 'FIELD';
    const declaredClass = routineStep?.routineClass;
    const editableClass = declaredClass ? declaredClass.replace(/_A$/i, '_M') : undefined;
    const editableMethod = routineStep?.routineMethod;
    const gpMethod = kind === 'FIELD'
      ? `compute_${rule.id}_${routineStep?.id ?? '1'}`
      : GLOBAL_GP_METHOD[kind];
    const info: RoutineInfo = {
      kind,
      editableClass,
      editableMethod,
      gpMethod,
      language: routineStep?.attributes['hanaRuntime'] === 'true' || (!declaredClass && !abapRuntime) ? 'SQLSCRIPT' : declaredClass ? 'ABAP' : 'UNKNOWN',
    };
    const activated = gpSource && gpMethod ? extractMethod(gpSource, gpMethod) : null;
    if (gpSource && gpMethod && !activated) issues.push(`Rule ${rule.id}: routine copy ${gpMethod} not found in generated program.`);
    let editable: string | null = null;
    if ((options.includeRoutineSource ?? true) && editableClass && editableMethod) {
      const cls = await editableClassSource(editableClass);
      editable = cls ? extractMethod(cls, editableMethod) : null;
      if (cls && !editable) issues.push(`Rule ${rule.id}: method ${editableMethod} not found in ${editableClass}.`);
    }
    if (!editableClass && !activated) issues.push(`Rule ${rule.id}: ${kind} routine has no readable source (no class reference, no GP copy).`);
    info.editableSource = editable ?? undefined;
    info.activatedSource = activated ?? undefined;
    if (editable && activated) {
      info.sourcesMatch = routineBody(editable) === routineBody(activated);
      if (!info.sourcesMatch) {
        issues.push(`Rule ${rule.id}: ${kind} routine differs between ${editableClass}=>${editableMethod} and the generated program — unactivated changes or generator differences; review before conversion.`);
      }
    }
    rule.routine = info;
  }

  const summary: Record<string, number> = { rules: parsed.rules.length };
  for (const r of parsed.rules) summary[`class_${r.conversionClass}`] = (summary[`class_${r.conversionClass}`] ?? 0) + 1;
  for (const k of xmlStepTypes) summary[`step_${k}`] = parsed.rules.reduce((n, r) => n + r.steps.filter((s) => s.kind === k).length, 0);

  if (parsed.hanaRuntime === 'true' && parsed.hanaExecutionPossible === 'MUST_NOT') {
    issues.push('HANARuntime="true" but sapHANAExecutionPossible="MUST_NOT" — inconsistent runtime flags; confirm the runtime in BW.');
  }

  return {
    transformation: parsed.name,
    versionRead,
    runtime: { hanaRuntime: parsed.hanaRuntime, hanaExecutionPossible: parsed.hanaExecutionPossible, executedArtifact },
    description: parsed.description,
    source: parsed.source,
    target: parsed.target,
    rules: parsed.rules,
    targetFieldsWithoutRule: parsed.targetFieldsWithoutRule,
    generatedProgram: gp && parsed.abapProgram
      ? {
        name: parsed.abapProgram,
        header: gp.header,
        lineCount: gp.lineCount,
        aggregationNotes: gp.aggregationNotes,
        recordModeLines: gp.recordModeLines,
        gpOnlyStepTypes: [...gpOnly],
      }
      : undefined,
    summary,
    completeness: issues.length === 0 ? 'complete' : 'partial',
    issues,
  };
}

/** Body comparison that ignores the generator's comment header and placeholder lines. */
function routineBody(method: string): string {
  return normalizeAbap(
    method
      .split('\n')
      .filter((l) => !/^\s*\.\.\.\s*("|$)/.test(l))
      .join('\n'),
  );
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0];
}
