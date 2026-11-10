import type { IrColumn, IrMapping, TransformationIR } from '../ir/transformation-ir.js';
import { type Expr, toCqn, toSql } from '../ir/expr.js';

/**
 * Transformation IR → Datasphere transformation flow (`sap.dis.transformationflow`).
 *
 * The document mirrors the structure of a flow saved by the Datasphere editor on the target
 * tenant (Tf_adj_qty in DEMO_SPACE_1, read 2026-10-23): a SQL view transform
 * (`com.sap.dwc.sqltransform`) that carries the SQL text and its CQN, connected
 * `outTable → inTable` to a target (`com.sap.dwc.target`) with attribute mappings.
 *
 * Only mappings with an expression are emitted. Columns whose rule could not be translated are
 * left out and the result is marked not deployable — a partial flow is never proposed as complete.
 */

export const SOURCE_ALIAS = 'S';
export const FLOW_MARKER = 'Migrated from BW transformation';

export interface FlowResult {
  flowName: string;
  sql: string;
  document: { transformationflows: Record<string, any> };
  emittedColumns: string[];
  omittedColumns: Array<{ column: string; reason: string }>;
  deployable: boolean;
}

function elementOf(c: IrColumn): Record<string, unknown> {
  const el: Record<string, unknown> = { '@EndUserText.label': c.bwField, type: c.cdsType };
  if (c.length !== undefined) el.length = c.length;
  if (c.precision !== undefined) el.precision = c.precision;
  if (c.scale !== undefined) el.scale = c.scale;
  if (c.key) {
    el.key = true;
    el.notNull = true;
  }
  return el;
}

export function columnExpr(m: IrMapping): Expr {
  return m.aggregate ? { k: 'func', name: m.aggregate, args: [m.expr!] } : m.expr!;
}

export interface FlowOptions {
  /**
   * CSN of the Datasphere tables made from the source/target aDSOs (aDSO converter). When given,
   * the flow's target definition and the view's key flags are taken from the target table — the
   * "key" of a transformation target field is BW's aggregation key, which is not the table key
   * for a data-mart aDSO (no semantic key).
   */
  tables?: { source?: { elements: Record<string, any> }; target?: { elements: Record<string, any> } };
}

export function convertIrToTransformationFlow(ir: TransformationIR, opts: FlowOptions = {}): FlowResult {
  const flowName = ir.dependencies.find((d) => d.role === 'flow')!.name;
  const tgtByColumn = new Map(ir.target.columns.map((c) => [c.column, c]));

  const emitted = ir.mappings.filter((m) => m.expr && (m.status === 'translated' || m.status === 'needs_review'));
  const omitted = ir.mappings
    .filter((m) => m.status === 'unsupported' || (!m.expr && m.status !== 'technical'))
    .map((m) => ({ column: m.target, reason: ir.diagnostics.find((d) => d.field === m.bwTarget && d.severity === 'error')?.code ?? m.status }));
  // Stable column order: the target's own field order.
  const order = new Map(ir.target.columns.map((c, i) => [c.column, i]));
  emitted.sort((a, b) => (order.get(a.target) ?? 0) - (order.get(b.target) ?? 0));

  // A constant needs no grouping (same result), and a literal in GROUP BY is not portable.
  const groupBy = ir.aggregation.collapses ? emitted.filter((m) => !m.aggregate && tgtByColumn.get(m.target)?.key && m.expr!.k !== 'val') : [];

  const sqlColumns = emitted.map((m) => `    ${toSql(columnExpr(m), SOURCE_ALIAS)} AS "${m.target}"`);
  let sql = `SELECT\n${sqlColumns.join(',\n')}\nFROM "${ir.source.table}" ${SOURCE_ALIAS}`;
  if (groupBy.length) sql += `\nGROUP BY\n${groupBy.map((m) => `    ${toSql(m.expr!, SOURCE_ALIAS)}`).join(',\n')}`;

  const cqnColumns = emitted.map((m) => {
    const c = toCqn(columnExpr(m), SOURCE_ALIAS);
    // A bare reference to the same name needs no alias, as in Tf_adj_qty.
    return c.ref && c.ref[1] === m.target ? c : { ...c, as: m.target };
  });
  const select: Record<string, unknown> = { from: { ref: [ir.source.table], as: SOURCE_ALIAS }, columns: cqnColumns };
  if (groupBy.length) select.groupBy = groupBy.map((m) => toCqn(m.expr!, SOURCE_ALIAS));

  const table = opts.tables?.target?.elements;
  const viewElement = (col: string) => {
    const el = elementOf(tgtByColumn.get(col)!);
    if (table) {
      delete el.key;
      delete el.notNull;
      if (table[col]?.key) Object.assign(el, { key: true, notNull: true });
    }
    return el;
  };
  const viewElements = Object.fromEntries(emitted.map((m) => [m.target, viewElement(m.target)]));
  const targetColumns = ir.target.columns.filter((c) => !c.technical);
  const targetElements = table ? structuredClone(table) : Object.fromEntries(targetColumns.map((c) => [c.column, elementOf(c)]));

  const label = `${ir.source.bwName} → ${ir.target.bwName}`;
  const flow = {
    kind: 'sap.dis.transformationflow',
    '@EndUserText.label': `${flowName}`.slice(0, 120),
    contents: {
      properties: {},
      metadata: { loadType: 'INITIAL_ONLY' },
      parameters: {},
      description: `${FLOW_MARKER} ${ir.transformation} (${label})`,
      processes: {
        sqltransform1: {
          component: 'com.sap.dwc.sqltransform',
          metadata: {
            label: 'View Transform',
            x: 0,
            y: 12,
            height: 40,
            width: 120,
            config: {
              name: `${flowName}$TRF_TV_sqltransform1`,
              definition: {
                kind: 'entity',
                elements: viewElements,
                query: { SELECT: select },
                '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
                '@EndUserText.label': label,
                '@ObjectModel.modelingPattern': { '#': 'DATA_STRUCTURE' },
                '@DataWarehouse.consumption.external': false,
                '@DataWarehouse.sqlEditor.query': sql,
              },
              version: { csn: '1.0' },
              meta: { creator: 'View Editor', kind: 'sap.dwc.viewmodel' },
              $version: '1.0',
            },
          },
        },
        target1: {
          component: 'com.sap.dwc.target',
          metadata: {
            label: ir.target.table,
            x: 200,
            y: 12,
            height: 40,
            width: 120,
            config: {
              attributeMappings: emitted.map((m) => ({ source: m.target, target: m.target })),
              definition: { kind: 'entity', '@EndUserText.label': ir.target.table, elements: targetElements },
              name: ir.target.table,
              // Full reload: the flow reproduces the target state after a complete BW reload.
              truncate: true,
            },
          },
        },
      },
      groups: [],
      connections: [
        { metadata: { points: '125,32 195,32' }, src: { port: 'outTable', process: 'sqltransform1' }, tgt: { port: 'inTable', process: 'target1' } },
      ],
      inports: {},
      outports: {},
    },
  };

  return {
    flowName,
    sql,
    document: { transformationflows: { [flowName]: flow } },
    emittedColumns: emitted.map((m) => m.target),
    omittedColumns: omitted,
    deployable: !ir.diagnostics.some((d) => d.severity === 'error') && omitted.length === 0,
  };
}
