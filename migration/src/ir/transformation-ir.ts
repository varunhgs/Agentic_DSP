import { mapType, columnName } from '../converters/adso-to-local-table.js';
import type { AdsoField } from '../bw/adso-parser.js';
import { type Expr, type ValueType, func, ref, val } from './expr.js';
import { FormulaError, translateBwFormula } from './bw-formula.js';
import { topoSort } from '../plan/graph.js';

/**
 * Normalised, machine-readable form of one BW transformation (IR version 1).
 *
 * Built deterministically from the structure the BW MCP's own parser returns
 * (`parseTransformationXml` / `bw_get_transformation` format json), so later stages never
 * read raw BW XML or ABAP. Every target column carries either a translated expression or an
 * explicit diagnostic; nothing is dropped silently. DTP settings (filters, delta, package
 * size) are not part of a transformation and get their own IR later (`dtp` stays undefined).
 */

// ── Input: the subset of the BW MCP parser output the IR needs ───────────────

export interface BwTrfnField {
  name: string;
  infoObject?: string;
  key: boolean;
  dataType?: string;
  length?: string;
  precision?: string;
  scale?: string;
  aggregationType?: string;
  aggregationBehavior?: string;
}

export interface BwTrfnStep {
  id: string;
  kind: string;
  rank?: string;
  formula?: string;
  constant?: string;
}

export interface BwTrfnRule {
  groupId: string;
  id: string;
  routineType?: string;
  sourceFields: string[];
  targetFields: string[];
  steps: BwTrfnStep[];
  conversionClass: string;
  routine?: { kind: string; language: string };
  /** Generated-program evidence for the rule (bw_get_transformation json / trfn_logic). */
  gp?: { steps: Array<{ id: string; type: string }>; code?: string };
}

export interface BwTransformation {
  name?: string;
  transformation?: string;
  description: string;
  hanaRuntime?: string;
  runtime?: { hanaRuntime?: string };
  source: { type: string; name: string; sourceSystem?: string; fields: BwTrfnField[] };
  target: { type: string; name: string; fields: BwTrfnField[] };
  rules: BwTrfnRule[];
}

// ── IR ───────────────────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  ruleId?: string;
  field?: string;
}

export interface IrColumn {
  bwField: string;
  column: string;
  infoObject?: string;
  key: boolean;
  bwType: string;
  cdsType?: string;
  length?: number;
  precision?: number;
  scale?: number;
  valueType: ValueType;
  /** Target key figures: BW aggregation type of the rule (SUM, MOV, …). */
  aggregation?: string;
  technical: boolean;
}

export type MappingStatus = 'translated' | 'needs_review' | 'unsupported' | 'technical';

export interface IrMapping {
  bwTarget: string;
  target: string;
  kind: string;
  sources: string[];
  /** Row-level expression over source columns (before any aggregation). */
  expr?: Expr;
  /** Aggregate applied when rows collapse (SUM, MIN, MAX), else undefined. */
  aggregate?: 'SUM' | 'MIN' | 'MAX';
  status: MappingStatus;
  notes: string[];
  trace: { ruleId?: string; groupId?: string; stepIds: string[]; conversionClass?: string; bwFormula?: string; bwConstant?: string };
}

export interface IrDependency {
  id: string;
  kind: 'LOCAL_TABLE' | 'TRANSFORMATION_FLOW';
  name: string;
  bwObject: string;
  role: 'source' | 'target' | 'flow';
  dependsOn: string[];
}

export interface TransformationIR {
  irVersion: 1;
  transformation: string;
  description: string;
  runtime: 'HANA' | 'ABAP' | 'UNKNOWN';
  source: { bwType: string; bwName: string; sourceSystem?: string; table: string; columns: IrColumn[] };
  target: { bwType: string; bwName: string; table: string; columns: IrColumn[] };
  mappings: IrMapping[];
  globalRoutines: Array<{ kind: string; ruleId: string; language?: string }>;
  aggregation: { collapses: boolean; reason: string; groupBy: string[] };
  dependencies: IrDependency[];
  creationOrder: string[];
  diagnostics: Diagnostic[];
  /** Reserved for the DTP IR (filters, delta, extraction source). Not built in this milestone. */
  dtp?: undefined;
}

export interface IrOptions {
  /** Prefix of the Datasphere tables made from the source and target aDSOs (default MIG_). */
  prefix?: string;
  /** Technical name of the transformation flow (default MIG_TF_<target>). */
  flowName?: string;
}

const TECHNICAL_FIELDS = new Set(['RECORDMODE', '0RECORDMODE', 'REQTSN', 'DATAPAKID', 'RECORD']);

export function dspObjectName(prefix: string, bwName: string): string {
  return `${prefix}${bwName.replace(/^\//, '').replace(/\//g, '_')}`;
}

function valueTypeOf(cds?: string): ValueType {
  switch (cds) {
    case 'cds.String':
    case 'cds.LargeString':
      return 'string';
    case 'cds.Date':
      return 'date';
    case 'cds.Decimal':
    case 'cds.Double':
      return 'decimal';
    case 'cds.Integer':
    case 'cds.Integer64':
      return 'integer';
    default:
      return 'unknown';
  }
}

function toColumn(f: BwTrfnField, isTarget: boolean): IrColumn {
  const num = (s?: string) => (s === undefined || s === '' ? undefined : Number(s));
  const asAdso = { name: f.name, dataType: f.dataType ?? '', length: num(f.length), precision: num(f.precision), scale: num(f.scale) } as AdsoField;
  const t = f.dataType ? mapType(asAdso) : undefined;
  return {
    bwField: f.name,
    column: columnName(f.name),
    infoObject: f.infoObject,
    key: f.key,
    bwType: f.dataType ? `${f.dataType}${f.precision ? `(${f.precision},${f.scale ?? 0})` : f.length ? `(${f.length})` : ''}` : '?',
    cdsType: t?.type,
    length: t?.length,
    precision: t?.precision,
    scale: t?.scale,
    valueType: valueTypeOf(t?.type),
    aggregation: isTarget ? (f.aggregationType || f.aggregationBehavior || undefined) : undefined,
    technical: TECHNICAL_FIELDS.has(f.name),
  };
}

/**
 * Time conversions BW performs in a StepTime rule, by source → target InfoObject.
 * BW's initial date 00000000 arrives in Datasphere as NULL (see the aDSO converter), and BW
 * turns it into an initial month/year, so the result is coalesced to the BW initial value.
 * Fiscal conversions need the fiscal year variant and are not covered.
 */
const TIME_CONVERSIONS: Record<string, { from: ValueType; build: (src: Expr) => Expr; note: string }> = {
  '0CALDAY>0CALMONTH': { from: 'date', build: (s) => func('COALESCE', func('TO_VARCHAR', s, val('YYYYMM')), val('000000')), note: 'initial or NULL date → 000000, as BW' },
  '0CALDAY>0CALYEAR': { from: 'date', build: (s) => func('COALESCE', func('TO_VARCHAR', s, val('YYYY')), val('0000')), note: 'initial or NULL date → 0000, as BW' },
  '0CALDAY>0CALMONTH2': { from: 'date', build: (s) => func('COALESCE', func('TO_VARCHAR', s, val('MM')), val('00')), note: 'initial or NULL date → 00, as BW' },
  '0CALDAY>0CALDAY': { from: 'date', build: (s) => s, note: 'same day; an initial date stays initial (NULL in Datasphere)' },
  // BW stores ISO-8601 weeks (verified on the 279 rows of ZC_CRM12, 2026-10-23); HANA ISOWEEK returns 'YYYY-Www'.
  '0CALDAY>0CALWEEK': { from: 'date', build: (s) => func('COALESCE', func('REPLACE', func('ISOWEEK', s), val('-W'), val('')), val('000000')), note: "ISO week YYYYWW; HANA ISOWEEK format 'YYYY-Www' to be confirmed on deployment; initial or NULL date → 000000, as BW" },
  '0CALDAY>0HALFYEAR1': {
    from: 'date',
    build: (s) => {
      const mm = func('COALESCE', func('TO_VARCHAR', s, val('MM')), val('00'));
      return { k: 'case', when: [{ cond: { k: 'cmp', op: '=', left: mm, right: val('00') }, then: val('0') }, { cond: { k: 'cmp', op: '<=', left: mm, right: val('06') }, then: val('1') }], else: val('2') };
    },
    note: 'months 01–06 → 1, 07–12 → 2; initial or NULL date → 0, as BW',
  },
  '0CALMONTH>0CALYEAR': { from: 'string', build: (s) => func('LEFT', s, val(4)), note: 'YYYYMM → YYYY' },
  '0CALMONTH>0CALMONTH2': { from: 'string', build: (s) => func('RIGHT', s, val(2)), note: 'YYYYMM → MM' },
};

function initialValue(c: IrColumn): Expr | undefined {
  if (c.valueType === 'string') return val(c.bwType.startsWith('NUMC') && c.length ? '0'.repeat(c.length) : '');
  if (c.valueType === 'decimal' || c.valueType === 'integer') return val(0);
  return undefined;
}

export function buildTransformationIR(t: BwTransformation, opts: IrOptions = {}): TransformationIR {
  const prefix = opts.prefix ?? 'MIG_';
  const name = (t.name ?? t.transformation ?? '').toUpperCase();
  const hana = t.hanaRuntime ?? t.runtime?.hanaRuntime;
  const diagnostics: Diagnostic[] = [];
  const diag = (severity: Severity, code: string, message: string, ruleId?: string, field?: string) =>
    diagnostics.push({ severity, code, message, ...(ruleId ? { ruleId } : {}), ...(field ? { field } : {}) });

  const srcCols = t.source.fields.map((f) => toColumn(f, false));
  const tgtCols = t.target.fields.map((f) => toColumn(f, true));
  const srcByField = new Map(srcCols.map((c) => [c.bwField, c]));
  const tgtByField = new Map(tgtCols.map((c) => [c.bwField, c]));

  for (const c of [...srcCols, ...tgtCols]) {
    if (!c.technical && !c.cdsType) diag('error', 'UNMAPPED_TYPE', `BW type ${c.bwType} of ${c.bwField} has no Datasphere type mapping`, undefined, c.bwField);
  }
  // A DataSource source reads the DataSource's staging table (MIG_DS_<name>, see rsds-to-local-table).
  if (t.source.type !== 'ADSO' && t.source.type !== 'RSDS') {
    diag('error', 'SOURCE_NOT_ADSO', `Source is ${t.source.type} ${t.source.name}: only aDSO and DataSource sources are supported`);
  }
  if (t.target.type !== 'ADSO') diag('error', 'TARGET_NOT_ADSO', `Target is ${t.target.type} ${t.target.name}: only aDSO targets are supported`);

  const globalRoutines = t.rules
    .filter((r) => r.routineType && r.routineType !== 'FIELD')
    .map((r) => ({ kind: r.routineType!, ruleId: r.id, language: r.routine?.language }));
  for (const g of globalRoutines) {
    diag('error', 'GLOBAL_ROUTINE', `${g.kind} routine (rule ${g.ruleId}, ${g.language ?? 'language unknown'}) changes the whole data package; it needs a manual SQL/SQLScript design before this transformation can be migrated`, g.ruleId);
  }
  const expert = globalRoutines.some((g) => g.kind === 'EXPERT');
  if (expert) diag('error', 'EXPERT_ROUTINE', 'An expert routine replaces all field rules; the rule list below does not describe the actual behaviour');

  const mappings: IrMapping[] = [];
  const mapped = new Set<string>();

  for (const rule of t.rules) {
    if (rule.routineType && rule.routineType !== 'FIELD') continue;
    const trace = { ruleId: rule.id, groupId: rule.groupId, stepIds: rule.steps.map((s) => s.id), conversionClass: rule.conversionClass };
    if (rule.groupId !== undefined && rule.groupId !== '0' && t.rules.some((r) => r.groupId !== rule.groupId && r.targetFields.some((f) => rule.targetFields.includes(f)))) {
      // Several rule groups write the same target: BW sends one record per group. Not supported yet.
      diag('error', 'RULE_GROUPS', `Target field(s) ${rule.targetFields.join(', ')} are written by more than one rule group (one record per group in BW)`, rule.id);
    }
    if (rule.targetFields.length > 1 && rule.steps.length === rule.targetFields.length && rule.steps.every((s) => s.kind.toUpperCase() === 'DIRECT')
        && rule.targetFields.every((f) => rule.sourceFields.includes(f))) {
      // Key figure + its unit/currency (MAIN + MINOR step): the generated program assigns each
      // target from the source field of the same name (e.g. _G_1-CURRENCY = <src>-CURRENCY).
      for (const tf of rule.targetFields) {
        mapped.add(tf);
        const tc = tgtByField.get(tf);
        const sc = srcByField.get(tf);
        if (!tc || !sc) continue;
        const prev = mappings.find((m) => m.bwTarget === tf);
        if (prev) {
          if (prev.expr?.k === 'ref' && prev.expr.column === sc.column) {
            prev.notes.push(`also written by rule ${rule.id} with the same source field`);
            continue;
          }
          diag('error', 'CONFLICTING_RULES', `${tf} is written by rules ${prev.trace.ruleId} and ${rule.id} from different sources`, rule.id, tf);
          continue;
        }
        const ok = sc.valueType === tc.valueType;
        if (!ok) diag('error', 'TYPE_MISMATCH', `${sc.bwField} ${sc.bwType} → ${tc.bwField} ${tc.bwType}`, rule.id, tf);
        mappings.push({ bwTarget: tf, target: tc.column, kind: 'DIRECT', sources: [tf], expr: ok ? ref(sc.column) : undefined, status: ok ? 'translated' : 'unsupported', notes: [`rule ${rule.id} writes ${rule.targetFields.join(' + ')}; same-name assignment per target`], trace });
      }
      continue;
    }
    if (rule.targetFields.length !== 1) {
      for (const tf of rule.targetFields) {
        mapped.add(tf);
        const c = tgtByField.get(tf);
        if (c?.technical) continue;
        mappings.push({ bwTarget: tf, target: c?.column ?? tf, kind: 'MULTI_TARGET', sources: rule.sourceFields, status: 'unsupported', notes: [], trace });
      }
      diag('error', 'MULTI_TARGET_RULE', `Rule writes ${rule.targetFields.length} target fields (${rule.targetFields.join(', ')}); the per-field step assignment is not modelled yet`, rule.id);
      continue;
    }
    const bwTarget = rule.targetFields[0];
    mapped.add(bwTarget);
    const tc = tgtByField.get(bwTarget);
    if (!tc) {
      diag('error', 'UNKNOWN_TARGET', `Rule targets ${bwTarget}, which is not a target field`, rule.id, bwTarget);
      continue;
    }
    const main = rule.steps.filter((s) => (s.rank ?? 'MAIN') === 'MAIN');
    const kind = main.length === 1 ? main[0].kind.toUpperCase() : rule.steps.length ? 'MULTI_STEP' : 'NONE';
    const m: IrMapping = { bwTarget, target: tc.column, kind, sources: rule.sourceFields, status: 'unsupported', notes: [], trace };
    if (tc.technical) {
      m.status = 'technical';
      m.notes.push('BW technical field (record mode / request); not a column of the Datasphere table — load behaviour is decided by the flow load type');
      mappings.push(m);
      continue;
    }
    const srcRef = (f: string) => {
      const c = srcByField.get(f);
      return c && !c.technical ? c.column : undefined;
    };

    switch (kind) {
      case 'DIRECT': {
        const sc = srcByField.get(rule.sourceFields[0]);
        if (rule.sourceFields.length !== 1 || !sc || sc.technical) {
          diag('error', 'DIRECT_SOURCE', `Direct rule needs exactly one non-technical source field, has ${rule.sourceFields.join(', ') || 'none'}`, rule.id, bwTarget);
          break;
        }
        m.expr = ref(sc.column);
        m.status = 'translated';
        if (sc.bwType.startsWith('RAW') && tc.valueType === 'string' && sc.length && tc.length === sc.length * 2) {
          // ABAP moves RAW(n) into CHAR(2n) as uppercase hex digits; BINTOHEX is the SQL equivalent.
          m.expr = func('BINTOHEX', ref(sc.column));
          m.notes.push(`${sc.bwType} → ${tc.bwType}: hexadecimal text, as ABAP converts RAW to CHAR`);
        } else if (sc.valueType !== tc.valueType) {
          m.status = 'unsupported';
          diag('error', 'TYPE_MISMATCH', `${sc.bwField} ${sc.bwType} → ${tc.bwField} ${tc.bwType}: BW converts implicitly; no SQL conversion is generated for this pair`, rule.id, bwTarget);
        } else if (tc.bwType.startsWith('NUMC') && sc.bwType.startsWith('CHAR') && tc.length) {
          // ABAP MOVE CHAR → NUMC: digits only, right-aligned, zero-padded, overflow cut on the left.
          m.expr = func('LPAD', func('RIGHT', { k: 'digits', arg: ref(sc.column) }, val(tc.length)), val(tc.length), val('0'));
          m.status = 'needs_review';
          m.notes.push(`${sc.bwType} → ${tc.bwType}: ABAP keeps the digits only (right-aligned, zero-padded); an empty value becomes ${'0'.repeat(tc.length)}`);
        } else if (tc.bwType.startsWith('NUMC') && sc.bwType.startsWith('NUMC') && sc.length && tc.length && sc.length > tc.length) {
          m.expr = func('RIGHT', ref(sc.column), val(tc.length));
          m.notes.push(`${sc.bwType} → ${tc.bwType}: ABAP keeps the rightmost digits`);
        } else if (sc.length && tc.length && sc.length > tc.length) {
          // ABAP MOVE CHAR → shorter CHAR cuts on the right.
          m.expr = func('LEFT', ref(sc.column), val(tc.length));
          m.notes.push(`${sc.bwType} → ${tc.bwType}: cut to ${tc.length} characters on the right, as ABAP does`);
        } else if ((sc.precision ?? 0) > (tc.precision ?? 99) || (sc.scale ?? 0) > (tc.scale ?? 99)) {
          m.status = 'needs_review';
          m.notes.push(`precision/scale ${sc.precision},${sc.scale} → ${tc.precision},${tc.scale}: rounding differs`);
        }
        break;
      }
      case 'CONSTANT': {
        const v = main[0].constant ?? '';
        m.trace = { ...trace, bwConstant: v };
        if (tc.valueType === 'string') m.expr = val(v);
        else if ((tc.valueType === 'decimal' || tc.valueType === 'integer') && /^-?\d+(\.\d+)?$/.test(v.trim())) m.expr = val(Number(v));
        else {
          diag('error', 'CONSTANT_TYPE', `Constant "${v}" cannot be expressed for ${tc.bwType}`, rule.id, bwTarget);
          break;
        }
        m.status = 'translated';
        break;
      }
      case 'INITIAL':
      case 'NO_UPDATE': {
        const iv = initialValue(tc);
        if (!iv) {
          diag('error', 'INITIAL_VALUE', `No BW-equivalent initial value for ${tc.bwType} (a date initial value is NULL in Datasphere)`, rule.id, bwTarget);
          break;
        }
        if (kind === 'NO_UPDATE' && tc.key) {
          diag('error', 'NO_UPDATE_KEY', 'Key field set to "no update"', rule.id, bwTarget);
          break;
        }
        m.expr = iv;
        m.status = kind === 'NO_UPDATE' ? 'needs_review' : 'translated';
        if (kind === 'NO_UPDATE') m.notes.push('BW keeps the existing value on overwrite; a truncate-and-reload writes the initial value instead');
        break;
      }
      case 'TIME': {
        const sc = srcByField.get(rule.sourceFields[0]);
        // The generated program names the time reference it converts from (i_timnm_from), e.g. a
        // DATS InfoObject such as 0CRMPOSTDAT is converted as 0CALDAY.
        const gpFrom = rule.gp?.code?.match(/i_timnm_from\s*=\s*'(\w+)'/)?.[1];
        const fromIo = gpFrom ?? (sc?.bwType.startsWith('DATS') ? '0CALDAY' : sc?.infoObject ?? sc?.bwField);
        if (gpFrom) m.notes.push(`time reference ${gpFrom} taken from the generated program`);
        else if (sc && fromIo === '0CALDAY' && sc.infoObject !== '0CALDAY') m.notes.push(`${sc.bwField} is a date (DATS) and treated as 0CALDAY; no generated-program evidence`);
        const toIo = tc.infoObject ?? tc.bwField;
        if (!sc || rule.sourceFields.length !== 1) {
          diag('error', 'TIME_SOURCE', 'Time conversion needs exactly one source field', rule.id, bwTarget);
          break;
        }
        if (fromIo === toIo && sc.infoObject === tc.infoObject) {
          m.expr = ref(sc.column);
          m.status = 'translated';
          m.notes.push('same time characteristic on both sides — a copy (the generated program shows a plain assignment)');
          break;
        }
        // The generated program assigns the source unchanged (no RST_TOBJ_TO_DERIVED_TOBJ call): a copy.
        const gpCode = rule.gp?.code ?? '';
        const srcName = sc.column.replace(/[.*+?^${}()|[]\/]/g, '\        const conv = TIME_CONVERSIONS[`${fromIo}>${toIo}`];');
        if (gpCode && !/RST_TOBJ_TO_DERIVED_TOBJ/.test(gpCode) && new RegExp(`<_ys_SC_1>-${srcName}\s*\.`).test(gpCode) && sc.valueType === tc.valueType) {
          m.expr = ref(sc.column);
          m.status = 'translated';
          m.notes.push('the generated program assigns the source field unchanged — a copy');
          break;
        }
        const conv = TIME_CONVERSIONS[`${fromIo}>${toIo}`];
        if (!conv) {
          diag('error', 'TIME_UNSUPPORTED', `Time conversion ${fromIo} → ${toIo} is not covered (fiscal periods need the fiscal year variant)`, rule.id, bwTarget);
          break;
        }
        if (sc.valueType !== conv.from) {
          diag('error', 'TIME_SOURCE_TYPE', `${fromIo} is ${sc.valueType} in Datasphere, conversion expects ${conv.from}`, rule.id, bwTarget);
          break;
        }
        m.expr = conv.build(ref(sc.column));
        m.status = 'needs_review';
        m.notes.push(`${fromIo} → ${toIo}: ${conv.note}`);
        break;
      }
      case 'FORMULA': {
        const formula = main[0].formula ?? '';
        m.trace = { ...trace, bwFormula: formula };
        try {
          const r = translateBwFormula(formula, (f) => (rule.sourceFields.includes(f) ? srcRef(f) : undefined));
          m.expr = r.expr;
          m.notes.push(...r.notes);
          m.status = 'needs_review';
        } catch (e) {
          if (!(e instanceof FormulaError)) throw e;
          diag('error', 'FORMULA_UNSUPPORTED', `Formula not translated (${e.message}): ${formula}`, rule.id, bwTarget);
        }
        break;
      }
      case 'ROUTINE':
        diag('error', 'FIELD_ROUTINE', `Field routine (${rule.routine?.language ?? 'language unknown'}) — custom code, needs a reviewed manual translation`, rule.id, bwTarget);
        break;
      case 'READ':
        diag('error', 'LOOKUP', 'Master-data / aDSO lookup (StepRead) — needs the lookup table and a join; not covered yet', rule.id, bwTarget);
        break;
      case 'UNIT':
      case 'CURRENCY':
        diag('error', 'CONVERSION_TYPE', `${kind} conversion — needs the Datasphere currency/unit conversion tables; not covered yet`, rule.id, bwTarget);
        break;
      default:
        diag('error', 'UNKNOWN_STEP', `Step type ${kind} is not assessed`, rule.id, bwTarget);
    }
    const gpConvert = rule.gp?.steps.filter((s) => s.type === 'CONVERT') ?? [];
    if (gpConvert.length && m.expr) {
      m.status = m.status === 'translated' ? 'needs_review' : m.status;
      const exit = rule.gp?.code?.match(/CONVERSION_EXIT_(\w+?)_INPUT/)?.[1];
      m.notes.push(`generated program adds a conversion-exit check${exit ? ` (${exit})` : ''} that raises a data error for a value not in internal format; the flow copies the value unchecked`);
    }
    mappings.push(m);
  }

  if (!expert) {
    for (const c of tgtCols) {
      if (c.technical || mapped.has(c.bwField)) continue;
      const iv = initialValue(c);
      if (c.key || !iv) {
        diag('error', 'NO_RULE', `Target ${c.key ? 'key ' : ''}field ${c.bwField} has no rule and no expressible initial value`, undefined, c.bwField);
        mappings.push({ bwTarget: c.bwField, target: c.column, kind: 'NONE', sources: [], status: 'unsupported', notes: [], trace: { stepIds: [] } });
      } else {
        mappings.push({ bwTarget: c.bwField, target: c.column, kind: 'NONE', sources: [], expr: iv, status: 'needs_review', notes: ['no rule in BW: the field stays initial'], trace: { stepIds: [] } });
      }
    }
  }

  // ── Aggregation: can several source rows land on one target key? ───────────
  const srcKeys = srcCols.filter((c) => c.key && !c.technical);
  const tgtKeyCols = new Set(tgtCols.filter((c) => c.key && !c.technical).map((c) => c.column));
  const directIntoKey = new Set(
    mappings.filter((m) => tgtKeyCols.has(m.target) && m.expr?.k === 'ref').map((m) => (m.expr as { column: string }).column),
  );
  const uncovered = srcKeys.filter((c) => !directIntoKey.has(c.column));
  // A DataSource declares no key. Into a keyed aDSO with overwrite only (no SUM/MIN/MAX), BW keeps
  // one record per key; the flow loads row by row and the target's primary key rejects duplicates,
  // so an ambiguous load fails loudly instead of picking a record. Stated as a warning below.
  const nonKeyAggs = tgtCols.filter((c) => !c.key && !c.technical).map((c) => (c.aggregation ?? '').toUpperCase());
  const keyEnforced = srcKeys.length === 0 && tgtKeyCols.size > 0 && nonKeyAggs.every((a) => a === '' || a === 'MOV');
  const collapses = !keyEnforced && (srcKeys.length === 0 || uncovered.length > 0);
  if (keyEnforced) {
    diag('warning', 'UNIQUENESS_ASSUMED', `Source has no key; one record per target key (${[...tgtKeyCols].join(', ')}) is assumed. BW would keep the last record for a duplicate key; the Datasphere load fails on one (primary key) instead of choosing silently`);
  }
  const reason = keyEnforced
    ? 'source without key into a keyed aDSO with overwrite: target key enforced by the table'
    : srcKeys.length === 0
    ? 'source key unknown — rows may collapse'
    : uncovered.length
      ? `source key field(s) ${uncovered.map((c) => c.bwField).join(', ')} are not carried 1:1 into the target key — several source rows can share one target key`
      : 'every source key field is mapped 1:1 into the target key — one target row per source row';

  if (collapses) {
    for (const m of mappings) {
      if (!m.expr || tgtKeyCols.has(m.target)) continue;
      const c = tgtByField.get(m.bwTarget)!;
      const agg = (c.aggregation ?? '').toUpperCase();
      if (agg === 'SUM' || agg === 'MIN' || agg === 'MAX') {
        if (c.valueType !== 'decimal' && c.valueType !== 'integer' && agg === 'SUM') {
          m.status = 'unsupported';
          diag('error', 'SUM_NON_NUMERIC', `SUM on non-numeric ${c.bwField}`, m.trace.ruleId, c.bwField);
          continue;
        }
        m.aggregate = agg;
        m.notes.push(`${agg} over rows sharing a target key, as the BW aggregation type ${agg}`);
      } else {
        m.status = 'unsupported';
        diag('error', 'ORDER_DEPENDENT_OVERWRITE', `${c.bwField} uses aggregation ${agg || 'overwrite (MOV)'}: when rows collapse, BW keeps the last record processed — order-dependent, no deterministic SQL equivalent`, m.trace.ruleId, c.bwField);
      }
    }
  }
  if (tgtCols.some((c) => c.aggregation?.toUpperCase() === 'SUM' && !c.technical)) {
    diag('info', 'SUM_DELTA_SEMANTICS', 'BW adds SUM key figures onto the existing target values on every delta load; the flow reproduces the state after a full reload (truncate + load), not delta accumulation');
  }

  // ── Dependencies and creation order ────────────────────────────────────────
  const sourceTable = t.source.type === 'RSDS' ? dspObjectName(`${prefix}DS_`, t.source.name) : dspObjectName(prefix, t.source.name);
  const targetTable = dspObjectName(prefix, t.target.name);
  const flowName = opts.flowName ?? dspObjectName(`${prefix}TF_`, t.target.name);
  const dependencies: IrDependency[] = [
    { id: 'source', kind: 'LOCAL_TABLE', name: sourceTable, bwObject: `${t.source.type}:${t.source.name}`, role: 'source', dependsOn: [] },
    { id: 'target', kind: 'LOCAL_TABLE', name: targetTable, bwObject: `${t.target.type}:${t.target.name}`, role: 'target', dependsOn: [] },
    { id: 'flow', kind: 'TRANSFORMATION_FLOW', name: flowName, bwObject: `TRFN:${name}`, role: 'flow', dependsOn: ['source', 'target'] },
  ];
  const order = topoSort(dependencies.map((d) => ({ id: d.id, dependsOn: d.dependsOn })));
  if (!order.ok) diag('error', 'DEPENDENCY_CYCLE', `Dependency cycle: ${order.cycle.join(' → ')}`);

  return {
    irVersion: 1,
    transformation: name,
    description: t.description,
    runtime: hana === 'true' ? 'HANA' : hana === 'false' ? 'ABAP' : 'UNKNOWN',
    source: { bwType: t.source.type, bwName: t.source.name, sourceSystem: t.source.sourceSystem, table: sourceTable, columns: srcCols },
    target: { bwType: t.target.type, bwName: t.target.name, table: targetTable, columns: tgtCols },
    mappings,
    globalRoutines,
    aggregation: { collapses, reason, groupBy: collapses ? [...tgtKeyCols] : [] },
    dependencies,
    creationOrder: order.ok ? order.order.map((id) => dependencies.find((d) => d.id === id)!.name) : [],
    diagnostics,
  };
}
