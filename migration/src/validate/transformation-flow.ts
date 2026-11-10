import type { TransformationIR } from '../ir/transformation-ir.js';
import { ALLOWED_FUNCTIONS, AGGREGATE_FUNCTIONS, functionsOf, refsOf, typeOf } from '../ir/expr.js';
import { type FlowResult, SOURCE_ALIAS, columnExpr } from '../converters/trfn-to-transformation-flow.js';
import type { Check, ValidationResult } from './local-table.js';

/**
 * Offline validation of a proposed transformation flow. Structural and semantic checks only:
 * passing them means the document is consistent with the BW rules and with the shape Datasphere
 * stores — not that Datasphere will deploy it, and not that it computes the same data.
 */

/** Key sets of a flow saved by the Datasphere editor (Tf_adj_qty, DEMO_SPACE_1, 2026-10-23). */
export interface FlowShape {
  kind: string;
  contents: string[];
  metadata: string[];
  sqltransformConfig: string[];
  sqltransformDefinition: string[];
  targetConfig: string[];
  connectionPorts: [string, string];
}

export const REFERENCE_SHAPE: FlowShape = {
  kind: 'sap.dis.transformationflow',
  contents: ['properties', 'metadata', 'parameters', 'description', 'processes', 'groups', 'connections', 'inports', 'outports'],
  metadata: ['loadType'],
  sqltransformConfig: ['name', 'definition', 'version', 'meta', '$version'],
  sqltransformDefinition: ['kind', 'elements', 'query', '@ObjectModel.supportedCapabilities', '@EndUserText.label', '@ObjectModel.modelingPattern', '@DataWarehouse.consumption.external', '@DataWarehouse.sqlEditor.query'],
  targetConfig: ['attributeMappings', 'definition', 'name', 'truncate'],
  connectionPorts: ['outTable', 'inTable'],
};

/** Shape of an actual flow document (used to derive / compare reference shapes). */
export function shapeOf(doc: { transformationflows: Record<string, any> }): FlowShape {
  const flow = Object.values(doc.transformationflows)[0];
  const procs = Object.values<any>(flow.contents.processes);
  const sqlt = procs.find((p) => p.component === 'com.sap.dwc.sqltransform')?.metadata.config ?? {};
  const tgt = procs.find((p) => p.component === 'com.sap.dwc.target')?.metadata.config ?? {};
  const conn = flow.contents.connections?.[0];
  return {
    kind: flow.kind,
    contents: Object.keys(flow.contents),
    metadata: Object.keys(flow.contents.metadata ?? {}),
    sqltransformConfig: Object.keys(sqlt),
    sqltransformDefinition: Object.keys(sqlt.definition ?? {}),
    targetConfig: Object.keys(tgt),
    connectionPorts: [conn?.src?.port, conn?.tgt?.port],
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateTransformationFlow(
  ir: TransformationIR,
  flow: FlowResult,
  opts: { reference?: FlowShape; existingTables?: Set<string>; tables?: { source?: { elements: Record<string, any> }; target?: { elements: Record<string, any> } } } = {},
): ValidationResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const ref = opts.reference ?? REFERENCE_SHAPE;

  // 1. Structure against the editor-saved reference flow.
  const doc = flow.document;
  add('API body is one JSON object under "transformationflows"', typeof doc === 'object' && Object.keys(doc).length === 1 && !!doc.transformationflows);
  const shape = shapeOf(doc);
  add('kind = sap.dis.transformationflow', shape.kind === ref.kind, shape.kind);
  add('contents keys match the reference flow', sameSet(shape.contents, ref.contents), shape.contents.join(','));
  add('load type set as in the reference flow', sameSet(shape.metadata, ref.metadata));
  add('SQL view transform config keys match the reference flow', sameSet(shape.sqltransformConfig, ref.sqltransformConfig), shape.sqltransformConfig.join(','));
  add('SQL view transform definition keys match the reference flow', sameSet(shape.sqltransformDefinition, ref.sqltransformDefinition), shape.sqltransformDefinition.join(','));
  add('target config keys match the reference flow', sameSet(shape.targetConfig, ref.targetConfig), shape.targetConfig.join(','));
  add('one connection outTable → inTable', shape.connectionPorts[0] === ref.connectionPorts[0] && shape.connectionPorts[1] === ref.connectionPorts[1]);
  add('technical names are valid', [flow.flowName, ir.source.table, ir.target.table].every((n) => NAME_RE.test(n)), [flow.flowName, ir.source.table, ir.target.table].join(', '));

  const f = doc.transformationflows[flow.flowName];
  const view = f.contents.processes.sqltransform1.metadata.config.definition;
  const tgt = f.contents.processes.target1.metadata.config;
  const select = view.query.SELECT;

  // 2. Source and target references.
  add('view reads the migrated source table', select.from?.ref?.[0] === ir.source.table && view['@DataWarehouse.sqlEditor.query'].includes(`FROM "${ir.source.table}"`), ir.source.table);
  add('target is the migrated target table', tgt.name === ir.target.table, tgt.name);

  // 3. Mappings.
  const targetCols = ir.target.columns.filter((c) => !c.technical).map((c) => c.column);
  const mapped = (tgt.attributeMappings as Array<{ source: string; target: string }>);
  const unmapped = targetCols.filter((c) => !mapped.some((m) => m.target === c));
  add('every target column is filled by the flow', unmapped.length === 0, unmapped.length ? `not filled: ${unmapped.join(', ')}` : undefined);
  const badMap = mapped.filter((m) => !(m.source in view.elements) || !(m.target in tgt.definition.elements));
  add('attribute mappings reference existing view and target columns', badMap.length === 0, badMap.map((m) => `${m.source}→${m.target}`).join(', ') || undefined);
  const cqnNames = select.columns.map((c: any) => c.as ?? c.ref?.[1]);
  add('CQN columns = view elements = SQL columns', sameSet(cqnNames, Object.keys(view.elements)) && (flow.sql.match(/ AS "/g) ?? []).length === cqnNames.length);

  // 4. Expressions, references and types.
  const srcCols = new Map(ir.source.columns.filter((c) => !c.technical).map((c) => [c.column, c]));
  const emitted = ir.mappings.filter((m) => flow.emittedColumns.includes(m.target));
  const badRefs = emitted.flatMap((m) => refsOf(m.expr!).filter((r) => !srcCols.has(r)).map((r) => `${m.target}: ${r}`));
  add('expressions read only existing source columns', badRefs.length === 0, badRefs.join('; ') || undefined);
  const badFuncs = emitted.flatMap((m) => functionsOf(columnExpr(m)).filter((fn) => !ALLOWED_FUNCTIONS.has(fn)).map((fn) => `${m.target}: ${fn}`));
  add('expressions use only allow-listed SQL functions', badFuncs.length === 0, badFuncs.join('; ') || undefined);
  const nestedAgg = emitted.filter((m) => functionsOf(m.expr!).some((fn) => AGGREGATE_FUNCTIONS.has(fn)));
  add('no aggregate inside a row expression', nestedAgg.length === 0, nestedAgg.map((m) => m.target).join(', ') || undefined);
  const colType = (c: string) => srcCols.get(c)?.valueType ?? 'unknown';
  const typeIssues = emitted.flatMap((m) => {
    const want = ir.target.columns.find((c) => c.column === m.target)!.valueType;
    const got = typeOf(columnExpr(m), colType);
    const numeric = (t: string) => t === 'decimal' || t === 'integer';
    return got === want || (numeric(got) && numeric(want)) ? [] : [`${m.target}: ${got} → ${want}`];
  });
  add('expression result types match target column types', typeIssues.length === 0, typeIssues.join('; ') || undefined);
  const aggOk = !ir.aggregation.collapses || emitted.every((m) => m.aggregate || ir.target.columns.find((c) => c.column === m.target)?.key);
  add(ir.aggregation.collapses ? 'rows collapse: every non-key column is aggregated, keys are grouped' : 'rows do not collapse: no GROUP BY needed', aggOk, ir.aggregation.reason);
  if (ir.aggregation.collapses) {
    add('GROUP BY in SQL and CQN', /\nGROUP BY\n/.test(flow.sql) && Array.isArray(select.groupBy) && select.groupBy.length > 0);
  }
  add(`SQL uses alias ${SOURCE_ALIAS} consistently`, !/(?<![A-Za-z_])"[A-Z0-9_]+"\./.test(flow.sql));

  // 4b. Against the tables the aDSO converter makes from the real source and target aDSOs.
  const typeKeys = ['type', 'length', 'precision', 'scale'] as const;
  if (opts.tables?.source) {
    const els = opts.tables.source.elements;
    const diffs = [...srcCols.values()].flatMap((c) => !els[c.column] ? [`${c.column} missing`] : typeKeys.filter((k) => els[c.column][k] !== ({ type: c.cdsType, length: c.length, precision: c.precision, scale: c.scale } as any)[k]).map((k) => `${c.column}.${k}`));
    add('source columns exist in the migrated source table with the same types', diffs.length === 0, diffs.join(', ') || undefined);
  }
  if (opts.tables?.target) {
    const els = opts.tables.target.elements;
    const same = JSON.stringify(tgt.definition.elements) === JSON.stringify(els);
    add('flow target definition = migrated target table (columns, types, key)', same);
    const viewKeyDiff = Object.keys(view.elements).filter((c) => !!view.elements[c].key !== !!els[c]?.key);
    add('view key flags = target table key', viewKeyDiff.length === 0, viewKeyDiff.join(', ') || undefined);
  }

  // 5. Dependencies.
  if (opts.existingTables) {
    const miss = [ir.source.table, ir.target.table].filter((t) => !opts.existingTables!.has(t));
    add('source and target tables exist in Datasphere', miss.length === 0, miss.length ? `missing: ${miss.join(', ')}` : undefined);
  }
  add('creation order resolved (tables before flow)', ir.creationOrder.length === ir.dependencies.length && ir.creationOrder.at(-1) === flow.flowName, ir.creationOrder.join(' → '));

  // 6. Unsupported constructs.
  const errors = ir.diagnostics.filter((d) => d.severity === 'error');
  add('no unsupported BW constructs', errors.length === 0, errors.map((d) => `${d.code}${d.ruleId ? `@rule ${d.ruleId}` : ''}${d.field ? `/${d.field}` : ''}`).join('; ') || undefined);

  return { ok: checks.every((c) => c.ok), checks };
}
