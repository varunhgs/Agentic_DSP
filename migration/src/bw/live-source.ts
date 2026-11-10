import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, loadBwEnv } from '../config.js';

/**
 * Live, read-only extraction of a BW flow, upstream from a target aDSO.
 *
 * Uses the BW MCP server's own modules (dist/), the same code behind its tools:
 *   bw_xref (where-used)            → transformations writing into an aDSO
 *   bw_get_transformation (json)    → rules + generated-program evidence (trfn_logic)
 *   bw_get_adso (raw)               → aDSO definition, incl. its active table (type AT)
 *   bw_get_datasource (raw)         → DataSource definition
 *   ADT data preview (SELECT only)  → active-table rows of every aDSO, for loading and reconciliation
 * Stops at a DataSource or after `maxLayers`. Writes everything plus manifest.json to outDir.
 */

export interface FlowLayer {
  transformation: string;
  logicFile: string;
  source: { type: 'ADSO' | 'RSDS'; name: string; sourceSystem?: string; file: string };
  target: { name: string; file: string };
}

export interface FlowManifest {
  extractedAt: string;
  targetAdso: string;
  /** Upstream first: layers[0] reads the most upstream object. */
  layers: FlowLayer[];
  /** BW active-table rows per aDSO name (file path), when the aDSO holds data. */
  data: Record<string, { file: string; table: string; rows: number }>;
  notes: string[];
}

const mod = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(join(REPO_ROOT, 'dist', rel)).href)) as T;

export async function connectBw(): Promise<any> {
  for (const [k, v] of Object.entries(loadBwEnv())) if (!process.env[k]) process.env[k] = v;
  const { createClientFromEnv } = await mod<any>('bw-client.js');
  const client = createClientFromEnv();
  await client.loadMediaTypes();
  return client;
}

export async function readBwTable(client: any, table: string, maxRows = 100_000): Promise<Array<Record<string, string>>> {
  if (!/^[A-Z0-9_/]+$/.test(table)) throw new Error(`not a table name: ${table}`);
  const { parseDataPreview } = await mod<any>('tools/adt-sql.js');
  const xml = await client.postRaw(`/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`, `SELECT * FROM ${table}`, 'text/plain', {
    Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml',
  });
  const rows = parseDataPreview(xml);
  if (rows.length >= maxRows) throw new Error(`${table}: ${rows.length} rows reached the read limit — paging is not implemented, refusing a partial read`);
  return rows;
}

export async function extractFlow(targetAdso: string, outDir: string, opts: { maxLayers?: number; log?: (m: string) => void } = {}): Promise<FlowManifest> {
  const log = opts.log ?? ((m: string) => console.log(m));
  mkdirSync(outDir, { recursive: true });
  const client = await connectBw();
  const { bwXrefEntries } = await mod<any>('tools/search.js');
  const { bwGetTransformationLogic } = await mod<any>('tools/trfn_logic.js');
  const { bwGetAdso, parseAdsoXml } = await mod<any>('tools/adso.js');
  const { bwGetDatasource } = await mod<any>('tools/datasource.js');

  const manifest: FlowManifest = { extractedAt: new Date().toISOString(), targetAdso: targetAdso.toUpperCase(), layers: [], data: {}, notes: [] };
  const adsoFiles = new Map<string, string>();

  async function adso(name: string): Promise<string> {
    if (adsoFiles.has(name)) return adsoFiles.get(name)!;
    const xml = await bwGetAdso(client, name, 'raw', 'active');
    const file = join(outDir, `${name.replace(/\//g, '_')}.adso.xml`);
    writeFileSync(file, xml);
    adsoFiles.set(name, file);
    const parsed = parseAdsoXml(xml.slice(Math.max(0, xml.indexOf('<?xml'))));
    log(`aDSO ${name}: ${parsed.fields.length} fields, type ${parsed.type}`);
    const active = parsed.tables.find((t: any) => t.type === 'AT')?.name;
    if (active) {
      const rows = await readBwTable(client, active);
      const dataFile = join(outDir, `${name.replace(/\//g, '_')}.active.json`);
      writeFileSync(dataFile, JSON.stringify(rows));
      manifest.data[name] = { file: dataFile, table: active, rows: rows.length };
      log(`aDSO ${name}: active table ${active}, ${rows.length} rows read`);
    }
    return file;
  }

  const layersDownstreamFirst: FlowLayer[] = [];
  let current = targetAdso.toUpperCase();
  for (let depth = 0; depth < (opts.maxLayers ?? 5); depth++) {
    const targetFile = await adso(current);
    const xref = await bwXrefEntries(client, 'ADSO', current);
    const candidates = [...new Set(xref.filter((e: any) => e.objectType === 'TRFN').map((e: any) => e.objectName as string))];
    const inbound: any[] = [];
    for (const id of candidates) {
      const logic = await bwGetTransformationLogic(client, id, {});
      if (logic.target.name.toUpperCase() === current && logic.source.name.toUpperCase() !== current) inbound.push(logic);
    }
    if (!inbound.length) {
      manifest.notes.push(`${current}: no inbound transformation found — flow starts here`);
      break;
    }
    if (inbound.length > 1) manifest.notes.push(`${current}: ${inbound.length} inbound transformations (${inbound.map((l) => l.transformation).join(', ')}); following ${inbound[0].transformation}, the others are not migrated`);
    const logic = inbound[0];
    const logicFile = join(outDir, `${logic.transformation}.logic.json`);
    writeFileSync(logicFile, JSON.stringify(logic, null, 2));
    log(`transformation ${logic.transformation}: ${logic.source.type} ${logic.source.name} → ${current}, ${logic.rules.length} rules, ${logic.runtime.hanaRuntime === 'true' ? 'HANA' : 'ABAP'} runtime${logic.issues.length ? `, issues: ${logic.issues.join('; ')}` : ''}`);

    const layer: FlowLayer = { transformation: logic.transformation, logicFile, source: { type: logic.source.type, name: logic.source.name, sourceSystem: logic.source.sourceSystem, file: '' }, target: { name: current, file: targetFile } };
    if (logic.source.type === 'RSDS') {
      const xml = await bwGetDatasource(client, logic.source.name, logic.source.sourceSystem, 'raw');
      layer.source.file = join(outDir, `${logic.source.name}.${logic.source.sourceSystem}.rsds.xml`);
      writeFileSync(layer.source.file, xml);
      log(`DataSource ${logic.source.name} (${logic.source.sourceSystem}): definition read`);
      layersDownstreamFirst.push(layer);
      manifest.notes.push(`${logic.source.name}: DataSource — its records live in the source system ${logic.source.sourceSystem}, not in BW`);
      break;
    }
    if (logic.source.type !== 'ADSO') {
      manifest.notes.push(`${logic.source.type} ${logic.source.name}: source type not followed further`);
      layersDownstreamFirst.push(layer);
      break;
    }
    layer.source.file = await adso(logic.source.name);
    layersDownstreamFirst.push(layer);
    current = logic.source.name.toUpperCase();
  }
  manifest.layers = layersDownstreamFirst.reverse();
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
