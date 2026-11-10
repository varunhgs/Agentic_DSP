/**
 * Small Datasphere object generators used around a migrated transformation: a seed view with
 * literal rows, a copy flow, an exposed read view and a task chain. Each mirrors an object saved
 * by the Datasphere editor on the target tenant (DEMO_SPACE_1, read 2026-10-26):
 *   - seed view: SQLScript table function, as 2VR_SC_PRODUCT_HIERARCHY_PATH_01
 *     (`@Analytics.dbViewType: TABLE_FUNCTION`, script in `@DataWarehouse.tableFunction.script`).
 *     Rows are inserted into a table variable — a view may not read DUMMY (MISSING_DEPENDENCY).
 *   - flows: `sap.dis.transformationflow`, as Tf_adj_qty.
 *   - read view: SQL view with SQL text and CQN, as BSAD_VIEW; exposed for the consumption API.
 *   - task chain: `sap.dwc.taskChain`, as TC_SNAPSHOT_FLOW.
 */

export type CsnElements = Record<string, { type: string; length?: number; precision?: number; scale?: number; key?: boolean; [k: string]: unknown }>;

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sqlType(e: CsnElements[string]): string {
  switch (e.type) {
    case 'cds.String':
      return `NVARCHAR(${e.length ?? 5000})`;
    case 'cds.Date':
      return 'DATE';
    case 'cds.Time':
      return 'TIME';
    case 'cds.Decimal':
      return `DECIMAL(${e.precision}, ${e.scale ?? 0})`;
    case 'cds.Integer':
      return 'INTEGER';
    case 'cds.Integer64':
      return 'BIGINT';
    case 'cds.Double':
      return 'DOUBLE';
    default:
      throw new Error(`no SQL type for ${e.type}`);
  }
}

/** BW DATS → SQL date literal or NULL for the initial date (00000000), as the aDSO converter prescribes. */
export function bwDateLiteral(v: string): string {
  const d = v.replace(/-/g, '').trim();
  if (!d || /^0+$/.test(d)) return 'NULL';
  if (!/^\d{8}$/.test(d)) throw new Error(`not a BW date: ${v}`);
  return `TO_DATE(${lit(d)}, 'YYYYMMDD')`;
}

/** ABAP-formatted number (trailing minus: "200.00-") → SQL decimal literal. */
export function bwNumberLiteral(v: string): string {
  const t = v.trim();
  if (!t) return '0';
  const neg = t.endsWith('-') || t.startsWith('-');
  const n = t.replace(/-/g, '');
  if (!/^\d+(\.\d+)?$/.test(n)) throw new Error(`not a BW number: ${v}`);
  return neg ? `-${n}` : n;
}

function valueLiteral(e: CsnElements[string], v: string | undefined): string {
  const raw = v ?? '';
  if (e.type === 'cds.Date') return bwDateLiteral(raw);
  if (e.type === 'cds.Decimal' || e.type === 'cds.Integer' || e.type === 'cds.Integer64' || e.type === 'cds.Double') return bwNumberLiteral(raw);
  return lit(raw);
}

/**
 * Seed view: the given rows (BW column names → BW-formatted values) as a table-function view
 * with exactly the columns of `elements`. A missing column in a row is an error.
 */
export function buildSeedView(name: string, elements: CsnElements, rows: Array<Record<string, string>>, label: string): any {
  const cols = Object.keys(elements);
  for (const [i, r] of rows.entries()) {
    const missing = cols.filter((c) => !(c in r));
    if (missing.length) throw new Error(`seed row ${i + 1} lacks column(s) ${missing.join(', ')}`);
  }
  // One array per column and a single UNNEST: one INSERT per row (279 rows) exhausted the
  // statement memory limit while the flow compiled the view (7 GB, OOM, 2026-10-26).
  const arrays = cols.map((c, i) => `  DECLARE a${i} ${sqlType(elements[c])} ARRAY = ARRAY(${rows.map((r) => valueLiteral(elements[c], r[c])).join(', ')});`).join('\n');
  const script = `BEGIN\n${arrays}\n  lt = UNNEST(${cols.map((_, i) => `:a${i}`).join(', ')}) AS (${cols.map(q).join(', ')});\n  RETURN SELECT ${cols.map(q).join(', ')} FROM :lt;\nEND;`;
  const viewElements = Object.fromEntries(cols.map((c) => {
    const { key: _k, notNull: _n, ...rest } = elements[c] as any;
    return [c, rest];
  }));
  return {
    definitions: {
      [name]: {
        kind: 'entity',
        '@EndUserText.label': label,
        '@ObjectModel.modelingPattern': { '#': 'DATA_STRUCTURE' },
        '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
        '@Analytics.dbViewType': 'TABLE_FUNCTION',
        '@DataWarehouse.consumption.external': true,
        '@DataWarehouse.tableFunction.script': script,
        elements: viewElements,
      },
    },
  };
}

/** SQL view selecting the given columns 1:1 from one object, exposed for the consumption API. */
export function buildReadView(name: string, source: string, elements: CsnElements, label: string): any {
  const cols = Object.keys(elements);
  const viewElements = Object.fromEntries(cols.map((c) => {
    const { key: _k, notNull: _n, ...rest } = elements[c] as any;
    return [c, rest];
  }));
  return {
    definitions: {
      [name]: {
        kind: 'entity',
        '@EndUserText.label': label,
        '@ObjectModel.modelingPattern': { '#': 'DATA_STRUCTURE' },
        '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
        '@DataWarehouse.consumption.external': true,
        '@DataWarehouse.sqlEditor.query': `SELECT\n${cols.map((c) => `    ${q(c)}`).join(',\n')}\nFROM ${q(source)}`,
        query: { SELECT: { from: { ref: [source] }, columns: cols.map((c) => ({ ref: [c] })) } },
        elements: viewElements,
      },
    },
  };
}

/** Transformation flow that copies all columns of `source` (same names) into the target table. */
export function buildCopyFlow(name: string, source: string, target: string, targetElements: CsnElements, description: string): any {
  const cols = Object.keys(targetElements);
  const sql = `SELECT\n${cols.map((c) => `    S.${q(c)}`).join(',\n')}\nFROM ${q(source)} S`;
  const viewElements = Object.fromEntries(cols.map((c) => [c, { '@EndUserText.label': c, ...targetElements[c] }]));
  return {
    transformationflows: {
      [name]: {
        kind: 'sap.dis.transformationflow',
        '@EndUserText.label': name,
        contents: {
          properties: {},
          metadata: { loadType: 'INITIAL_ONLY' },
          parameters: {},
          description,
          processes: {
            sqltransform1: {
              component: 'com.sap.dwc.sqltransform',
              metadata: {
                label: 'View Transform', x: 0, y: 12, height: 40, width: 120,
                config: {
                  name: `${name}$TRF_TV_sqltransform1`,
                  definition: {
                    kind: 'entity',
                    elements: viewElements,
                    query: { SELECT: { from: { ref: [source], as: 'S' }, columns: cols.map((c) => ({ ref: ['S', c] })) } },
                    '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
                    '@EndUserText.label': `${source} → ${target}`,
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
                label: target, x: 200, y: 12, height: 40, width: 120,
                config: {
                  attributeMappings: cols.map((c) => ({ source: c, target: c })),
                  definition: { kind: 'entity', '@EndUserText.label': target, elements: structuredClone(targetElements) },
                  name: target,
                  truncate: true,
                },
              },
            },
          },
          groups: [],
          connections: [{ metadata: { points: '125,32 195,32' }, src: { port: 'outTable', process: 'sqltransform1' }, tgt: { port: 'inTable', process: 'target1' } }],
          inports: {},
          outports: {},
        },
      },
    },
  };
}

/** Task chain running transformation flows one after another; each waits for the previous to complete. */
export function buildTaskChain(name: string, flows: string[]): any {
  const nodes = [{ id: 0, type: 'START' }, ...flows.map((f, i) => ({ id: i + 1, type: 'TASK', taskIdentifier: { applicationId: 'TRANSFORMATION_FLOWS', activity: 'EXECUTE', objectId: f }, ignoreError: false }))];
  const links = flows.map((_, i) => ({ startNode: { nodeId: i, statusRequired: i === 0 ? 'ANY' : 'COMPLETED' }, endNode: { nodeId: i + 1 }, id: i }));
  return { taskchains: { [name]: { kind: 'sap.dwc.taskChain', '@EndUserText.label': name, nodes, links, options: { layout: 'VERTICAL' }, schemaVersion: 2 } } };
}
