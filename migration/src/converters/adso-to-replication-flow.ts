import type { AdsoDefinition, AdsoField } from '../bw/adso-parser.js';
import { columnName } from './adso-to-local-table.js';

/**
 * BW aDSO → Datasphere replication flow (`sap.dis.replicationflow`) that copies the aDSO's
 * active data over ODP into a new local table.
 *
 * Shape follows the BW-sourced flows saved by the Datasphere editor on the target tenant
 * (BW_POC / BW_EKPO_POC in DEMO_SPACE_1, read 2026-10-26): source container "/BW", source
 * object "<ADSO>$F", ODP columns named like the aDSO's database columns (0CRM_PROD → CRM_PROD)
 * plus RECORDMODE and the ODQ_CHANGEMODE / ODQ_ENTITYCNTR columns, content type "Native Type"
 * (a DATS field arrives as a 10-character string).
 *
 * Load type INITIAL (initial load only, a literal used by 89 tasks on the tenant): no delta
 * subscription is opened in BW. Delta (REPLICATE) is a deliberate later step, because it leaves
 * a permanent ODQ subscription running in the source system.
 */

export interface ReplicationOptions {
  /** Datasphere connection to the BW system (type SAPBW). */
  connectionId: string;
  flowName: string;
  targetTable: string;
}

export interface ReplicationColumn {
  name: string;
  vtype: string;
  key: boolean;
  bwType: string;
  /** BW DATS field delivered as a string: needs conversion in the transformation flow. */
  dateAsString: boolean;
}

export interface ReplicationResult {
  flowName: string;
  targetTable: string;
  sourceObject: string;
  columns: ReplicationColumn[];
  document: { replicationflows: Record<string, any> };
}

const ODP_READ = { 'odp.read.maxPartitions': '3', 'odp.read.truncateLongData': 'true', 'odp.read.replaceInvalidCharacter': 'true' };

const ODQ_COLUMNS: ReplicationColumn[] = [
  { name: 'ODQ_CHANGEMODE', vtype: 'string_1', key: false, bwType: 'ODQ', dateAsString: false },
  { name: 'ODQ_ENTITYCNTR', vtype: 'decimal_19_0', key: false, bwType: 'ODQ', dateAsString: false },
];

/** vType of an ODP column in "Native Type" content mode. Undefined: not covered (refused). */
export function odpVType(f: Pick<AdsoField, 'dataType' | 'length' | 'precision' | 'scale'>): string | undefined {
  switch (f.dataType) {
    case 'CHAR':
    case 'NUMC':
    case 'CUKY':
    case 'UNIT':
    case 'LANG':
      return f.length ? `string_${f.length}` : undefined;
    case 'DATS':
      return 'string_10';
    case 'CURR':
    case 'QUAN':
    case 'DEC':
      return f.precision !== undefined ? `decimal_${f.precision}_${f.scale ?? 0}` : undefined;
    default:
      return undefined;
  }
}

function vTypeDef(id: string): Record<string, unknown> {
  const s = id.match(/^string_(\d+)$/);
  if (s) return { name: id, description: `String(${s[1]})`, 'vflow.type': 'scalar', template: 'string', 'value.length': Number(s[1]) };
  const d = id.match(/^decimal_(\d+)_(\d+)$/)!;
  return { name: id, description: `Decimal(${d[1]},${d[2]})`, 'vflow.type': 'scalar', template: 'decimal', 'value.precision': Number(d[1]), 'value.scale': Number(d[2]) };
}

export function convertAdsoToReplicationFlow(adso: AdsoDefinition, opts: ReplicationOptions): ReplicationResult {
  const columns: ReplicationColumn[] = [];
  for (const f of adso.fields) {
    const vtype = odpVType(f);
    if (!vtype) throw new Error(`BW field ${f.name}: data type ${f.dataType} has no ODP column type mapping yet`);
    columns.push({ name: columnName(f.name), vtype, key: f.isKey, bwType: f.dataType, dateAsString: f.dataType === 'DATS' });
  }
  // RECORDMODE follows the key in the ODP structure of an aDSO.
  const keyCount = columns.filter((c) => c.key).length;
  columns.splice(keyCount, 0, { name: 'RECORDMODE', vtype: 'string_1', key: false, bwType: 'CHAR', dateAsString: false });
  columns.push(...ODQ_COLUMNS);

  const keys = columns.filter((c) => c.key).map((c) => c.name);
  const sourceObject = `${adso.name}$F`;
  const srcCol = (c: ReplicationColumn) => ({
    name: c.name,
    'vflow.type': 'scalar',
    'vtype-ID': `$DYNAMIC.${c.vtype}`,
    ...(c.key ? { key: true } : {}),
    metadata: c.dateAsString ? { nativeType: { datatype: 'string', length: 10 }, TemplateType: { datatype: 'date' } } : {},
  });
  const tgtCol = (c: ReplicationColumn) => ({
    name: c.name,
    'vflow.type': 'scalar',
    'vtype-ID': `$DYNAMIC.${c.vtype}`,
    ...(c.key ? { key: true } : {}),
    businessName: c.name,
    metadata: {},
  });

  const flow = {
    kind: 'sap.dis.replicationflow',
    '@EndUserText.label': opts.flowName,
    contents: {
      description: `Migrated from BW: initial copy of aDSO ${adso.name} (bw-datasphere-migration)`,
      sourceSystem: [
        {
          connectionId: opts.connectionId,
          connectionType: 'SAPBW',
          container: '/BW',
          maxConnections: 10,
          isGeneric: false,
          metadata: {},
          properties: { ...ODP_READ },
        },
      ],
      targetSystem: [
        { connectionId: '$DWC', connectionType: 'HANA', container: '', maxConnections: 10, isGeneric: false, metadata: { connectionMetaschema: { sources: ['SAP'] } } },
      ],
      vTypes: { scalar: Object.fromEntries([...new Set(columns.map((c) => c.vtype))].map((v) => [v, vTypeDef(v)])) },
      replicationTasks: [
        {
          name: 'replicationtask1',
          loadType: 'INITIAL',
          priority: 50,
          truncate: true,
          // metadata.type and the odp.read properties are required: without them deployment fails with a bare
          // "Failed to deploy" (found by bisecting against BW_POC on the tenant, 2026-10-26).
          sourceObject: { name: sourceObject, definition: { columns: columns.map(srcCol), keys }, metadata: { type: 'tabular' }, properties: { ...ODP_READ } },
          targetObject: {
            name: opts.targetTable,
            definition: { columns: columns.map(tgtCol), keys },
            metadata: { isNew: true },
            properties: {},
            businessName: opts.targetTable,
          },
        },
      ],
      replicationTaskSetting: { hasSkipMappingCapability: true },
      replicationFlowSetting: { ABAPcontentType: 'Native Type' },
      deltaLoadTrigger: 'ON_DELTA_INTERVAL',
    },
    // Dependency sections as the editor writes them (BW_POC): the target table with its columns and the connection.
    sources: {},
    targets: { [opts.targetTable]: { elements: Object.fromEntries(columns.map((c) => [c.name, {}])) } },
    connections: { [opts.connectionId]: {} },
  };

  return { flowName: opts.flowName, targetTable: opts.targetTable, sourceObject, columns, document: { replicationflows: { [opts.flowName]: flow } } };
}
