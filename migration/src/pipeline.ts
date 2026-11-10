import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAdsoXml } from './bw/adso-parser.js';
import { convertAdsoToLocalTable } from './converters/adso-to-local-table.js';
import { convertDataSourceToLocalTable, parseDataSourceXml } from './converters/rsds-to-local-table.js';
import { buildTransformationIR, type TransformationIR } from './ir/transformation-ir.js';
import { convertIrToTransformationFlow } from './converters/trfn-to-transformation-flow.js';
import { validateTransformationFlow } from './validate/transformation-flow.js';
import { validateLocalTable } from './validate/local-table.js';
import { buildCopyFlow, buildReadView, buildSeedView, buildTaskChain, type CsnElements } from './converters/datasphere-objects.js';
import { reconcile } from './validate/reconcile.js';
import { topoSort } from './plan/graph.js';
import { DatasphereClient } from './datasphere/client.js';
import type { FlowManifest } from './bw/live-source.js';

/**
 * End-to-end migration of an extracted BW flow (see bw/live-source.ts extractFlow):
 * tables for every DataSource and aDSO → one transformation flow per BW transformation →
 * data loading → task chain → run → reconciliation against BW.
 *
 * A layer runs when its source holds data. A layer whose source has no reachable data (a
 * DataSource whose source system cannot be read) is deployed but not run; the aDSO it fills is
 * loaded with BW's own records instead, so the layers above it run on real data. Loading uses a
 * seed view built from the BW active-table rows — the substitute for a replication flow while
 * replication from on-premise systems fails on the tenant. Every object is MIG_-prefixed, created
 * only if the name is free (or was created by this pipeline), saved first without deployment,
 * read back, then deployed in dependency order.
 */

export interface PlannedObject {
  id: string;
  collection: 'localtables' | 'views' | 'transformationflows' | 'taskchains';
  name: string;
  body: any;
  dependsOn: string[];
  purpose: string;
}

export interface LayerPlan {
  transformation: string;
  flowName: string;
  source: string;
  target: string;
  runs: boolean;
  reason: string;
  ir: TransformationIR;
  validation: ReturnType<typeof validateTransformationFlow>;
}

export interface PipelinePlan {
  objects: PlannedObject[];
  layers: LayerPlan[];
  tables: Map<string, { name: string; elements: CsnElements; bwType: 'ADSO' | 'RSDS'; validate?: () => ReturnType<typeof validateLocalTable> }>;
  seeds: string[];
  reconcile: Array<{ bwObject: string; view: string; rowsFile: string; kind: 'load check' | 'transformation result' }>;
}

const xmlOf = (f: string) => {
  const t = readFileSync(f, 'utf8');
  return t.slice(Math.max(0, t.indexOf('<?xml')));
};

export function planFlow(manifest: FlowManifest, prefix = 'MIG_'): PipelinePlan {
  const objects: PlannedObject[] = [];
  const tables: PipelinePlan['tables'] = new Map();
  const n = (s: string) => `${prefix}${s}`;

  const addAdsoTable = (name: string, file: string) => {
    if (tables.has(name)) return;
    const adso = parseAdsoXml(xmlOf(file));
    const conv = convertAdsoToLocalTable(adso, { prefix });
    const entity = conv.csn.definitions[conv.technicalName];
    tables.set(name, { name: conv.technicalName, elements: entity.elements as CsnElements, bwType: 'ADSO', validate: () => ({ ok: true, checks: [] }) });
    objects.push({ id: `table:${name}`, collection: 'localtables', name: conv.technicalName, body: conv.csn, dependsOn: [], purpose: `table for aDSO ${name}` });
  };
  const addDsTable = (name: string, file: string) => {
    if (tables.has(name)) return;
    const conv = convertDataSourceToLocalTable(parseDataSourceXml(xmlOf(file)), { prefix });
    const entity = conv.csn.definitions[conv.technicalName];
    tables.set(name, { name: conv.technicalName, elements: entity.elements, bwType: 'RSDS' });
    objects.push({ id: `table:${name}`, collection: 'localtables', name: conv.technicalName, body: conv.csn, dependsOn: [], purpose: `landing table for DataSource ${name} (fields: ${Object.keys(entity.elements).length})` });
  };

  for (const l of manifest.layers) {
    if (l.source.type === 'RSDS') addDsTable(l.source.name, l.source.file);
    else addAdsoTable(l.source.name, l.source.file);
    addAdsoTable(l.target.name, l.target.file);
  }

  // Which layers can run, which aDSOs need loading from BW.
  const available = new Set<string>();
  const seeds: string[] = [];
  const produced = new Set(manifest.layers.map((l) => l.target.name));
  const hasData = (name: string) => (manifest.data[name]?.rows ?? 0) > 0;
  for (const l of manifest.layers) if (!produced.has(l.source.name) && hasData(l.source.name)) { seeds.push(l.source.name); available.add(l.source.name); }

  const layers: LayerPlan[] = [];
  for (const l of manifest.layers) {
    const src = tables.get(l.source.name)!;
    const tgt = tables.get(l.target.name)!;
    const logic = JSON.parse(readFileSync(l.logicFile, 'utf8'));
    const ir = buildTransformationIR(logic, { prefix });
    const t = { source: { elements: src.elements }, target: { elements: tgt.elements } };
    const flow = convertIrToTransformationFlow(ir, { tables: t });
    const validation = validateTransformationFlow(ir, flow, { tables: t });
    let runs = available.has(l.source.name);
    let reason = runs ? `source ${l.source.name} holds data` : `source ${l.source.name} holds no reachable data${l.source.type === 'RSDS' ? ` (DataSource: records are in source system ${l.source.sourceSystem})` : ''}`;
    if (!validation.ok || !flow.deployable) {
      runs = false;
      reason = `not deployable: ${validation.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`;
    }
    if (runs) available.add(l.target.name);
    else if (hasData(l.target.name)) { seeds.push(l.target.name); available.add(l.target.name); }
    layers.push({ transformation: l.transformation, flowName: flow.flowName, source: l.source.name, target: l.target.name, runs, reason, ir, validation });
    if (flow.deployable && validation.ok) {
      objects.push({ id: `flow:${l.transformation}`, collection: 'transformationflows', name: flow.flowName, body: flow.document, dependsOn: [`table:${l.source.name}`, `table:${l.target.name}`], purpose: `migrated BW transformation ${l.transformation} (${l.source.name} → ${l.target.name})${runs ? '' : ' — deployed, not run'}` });
    }
  }

  for (const s of seeds) {
    const tbl = tables.get(s)!;
    const rows = JSON.parse(readFileSync(manifest.data[s].file, 'utf8'));
    const view = n(`V_SEED_${s}`);
    const flow = n(`TF_SEED_${s}`);
    objects.push({ id: `seedView:${s}`, collection: 'views', name: view, body: buildSeedView(view, tbl.elements, rows, `BW ${s} active data (${rows.length} rows)`), dependsOn: [], purpose: `${rows.length} BW records of ${s} (${manifest.data[s].table})` });
    objects.push({ id: `seedFlow:${s}`, collection: 'transformationflows', name: flow, body: buildCopyFlow(flow, view, tbl.name, tbl.elements, `Loads BW ${s} records into ${tbl.name} (bw-datasphere-migration)`), dependsOn: [`seedView:${s}`, `table:${s}`], purpose: `loads ${tbl.name} with BW data` });
  }

  const recon: PipelinePlan['reconcile'] = [];
  for (const [bwName, tbl] of tables) {
    if (tbl.bwType !== 'ADSO' || !hasData(bwName)) continue;
    const view = n(`V_${bwName}`);
    objects.push({ id: `read:${bwName}`, collection: 'views', name: view, body: buildReadView(view, tbl.name, tbl.elements, `Read view on ${tbl.name}`), dependsOn: [`table:${bwName}`], purpose: 'reconciliation read access' });
    recon.push({ bwObject: bwName, view, rowsFile: manifest.data[bwName].file, kind: seeds.includes(bwName) ? 'load check' : 'transformation result' });
  }

  const chainFlows = [...seeds.map((s) => n(`TF_SEED_${s}`)), ...layers.filter((l) => l.runs).map((l) => l.flowName)];
  const chain = n(`TC_${manifest.targetAdso}`);
  objects.push({ id: 'chain', collection: 'taskchains', name: chain, body: buildTaskChain(chain, chainFlows), dependsOn: objects.filter((o) => o.collection === 'transformationflows' && chainFlows.includes(o.name)).map((o) => o.id), purpose: `runs ${chainFlows.join(' → ')}` });

  const order = topoSort(objects.map((o) => ({ id: o.id, dependsOn: o.dependsOn })));
  if (!order.ok) throw new Error(`dependency problem: ${JSON.stringify(order)}`);
  const byId = new Map(objects.map((o) => [o.id, o]));
  return { objects: order.order.map((id) => byId.get(id)!), layers, tables, seeds, reconcile: recon };
}

export async function runPipeline(dsp: DatasphereClient, manifest: FlowManifest, outDir: string, stages: Set<string>, log: (m: string) => void, prefix = 'MIG_'): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  const plan = planFlow(manifest, prefix);
  writeFileSync(join(outDir, 'plan.json'), JSON.stringify({ objects: plan.objects.map(({ body: _b, ...o }) => o), layers: plan.layers.map(({ ir: _i, validation, ...l }) => ({ ...l, validationOk: validation.ok })), seeds: plan.seeds, reconcile: plan.reconcile }, null, 2));
  for (const o of plan.objects) writeFileSync(join(outDir, `${o.name}.${o.collection}.json`), JSON.stringify(o.body, null, 2));
  for (const l of plan.layers) log(`layer ${l.transformation}: ${l.source} → ${l.target} as ${l.flowName} — ${l.runs ? 'RUNS' : 'deployed only'} (${l.reason})`);
  log(`plan: ${plan.objects.map((o) => o.name).join(' → ')}`);

  const created = join(outDir, 'created-objects.json');
  const record: Array<{ collection: string; name: string; at: string; status?: string }> = existsSync(created) ? JSON.parse(readFileSync(created, 'utf8')) : [];
  const mine = new Set(record.map((r) => `${r.collection}/${r.name}`));
  const save = () => writeFileSync(created, JSON.stringify(record, null, 2));

  if (stages.has('create')) {
    for (const o of plan.objects) {
      const existing = await dsp.objectStatus(o.collection, o.name);
      if (existing && !mine.has(`${o.collection}/${o.name}`)) throw new Error(`${o.collection}/${o.name} exists and was not created by this pipeline — stopping`);
      if (existing) {
        await dsp.updateObject(o.collection, o.name, o.body, { deploy: false });
        log(`${o.name}: updated (deploy=false)`);
      } else {
        await dsp.createObject(o.collection, o.body, { deploy: false });
        record.push({ collection: o.collection, name: o.name, at: new Date().toISOString() });
        mine.add(`${o.collection}/${o.name}`);
        save();
        log(`${o.name}: created (deploy=false) — ${o.purpose}`);
      }
      const back = await dsp.getObject(o.collection, o.name);
      writeFileSync(join(outDir, `${o.name}.readback.json`), JSON.stringify(back, null, 2));
      const coll = Object.keys(o.body)[0];
      const expected = Object.values(o.body[coll])[0] as any;
      const actual = back?.[coll]?.[o.name];
      if (!actual) throw new Error(`${o.name}: not readable after create`);
      if (o.collection === 'localtables') {
        const want = Object.keys(expected.elements).sort().join(',');
        const got = Object.keys(actual.elements ?? {}).sort().join(',');
        const keysW = Object.entries<any>(expected.elements).filter(([, e]) => e.key).map(([k]) => k).sort().join(',');
        const keysG = Object.entries<any>(actual.elements ?? {}).filter(([, e]) => e.key).map(([k]) => k).sort().join(',');
        log(`${o.name}: read back — columns ${want === got ? 'match' : 'DIFFER'} (${Object.keys(actual.elements ?? {}).length}), key ${keysW === keysG ? 'matches' : 'DIFFERS'} [${keysG}]`);
        if (want !== got || keysW !== keysG) throw new Error(`${o.name}: stored table differs from the definition`);
      } else log(`${o.name}: read back OK`);
    }
  }

  if (stages.has('deploy')) {
    for (const o of plan.objects) {
      await dsp.updateObject(o.collection, o.name, o.body, { deploy: true });
      const s = await dsp.waitForObject(o.collection, o.name, 600_000);
      const entry = record.find((r) => r.collection === o.collection && r.name === o.name);
      if (entry) entry.status = s?.status;
      save();
      log(`${o.name}: deploy → ${s?.status}`);
      if (!/^Deployed$/i.test(s?.status ?? '')) throw new Error(`${o.name} not deployed (${s?.status}) — stopping before dependants`);
    }
  }

  if (stages.has('run')) {
    const chain = plan.objects.find((o) => o.collection === 'taskchains')!.name;
    const started = await dsp.runTaskChain(chain);
    const logId = started?.logId ?? started?.id;
    log(`${chain}: run started (log ${logId})`);
    let final: any;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 20000));
      final = await dsp.taskLog(logId);
      if (!/RUNNING|PENDING|STARTED/i.test(final?.status ?? '')) break;
    }
    writeFileSync(join(outDir, `tasklog-${logId}.json`), JSON.stringify(final, null, 2));
    log(`${chain}: run ${final?.status}`);
    for (const f of plan.objects.filter((o) => o.collection === 'transformationflows')) {
      const logs = await dsp.taskLogs(f.name);
      const last = Array.isArray(logs) ? [...logs].sort((a: any, b: any) => String(b.startTime).localeCompare(String(a.startTime)))[0] : undefined;
      log(`  ${f.name}: last run ${last ? `${last.status} (log ${last.logId}, ${last.startTime})` : 'never (not part of the chain)'}`);
    }
    if (!/COMPLETED/i.test(final?.status ?? '')) return false;
  }

  if (stages.has('reconcile')) {
    const results: Record<string, unknown> = {};
    let ok = true;
    for (const r of plan.reconcile) {
      const tbl = plan.tables.get(r.bwObject)!;
      const res = reconcile(tbl.elements, JSON.parse(readFileSync(r.rowsFile, 'utf8')), await dsp.readView(r.view));
      results[`${r.bwObject} (${r.kind})`] = res;
      ok &&= res.ok;
      log(`reconcile ${r.bwObject} [${r.kind}]: BW ${res.bwRows} rows, Datasphere ${res.dspRows}, matched ${res.matchedRows}, only BW ${res.onlyInBw.length}, only DSP ${res.onlyInDsp.length} → ${res.ok ? 'EQUAL' : 'DIFFERENT'}`);
      const sums = res.columns.filter((c) => c.sumBw !== undefined).map((c) => `${c.column} ${c.sumBw}${c.sumBw === c.sumDsp ? '' : ` ≠ ${c.sumDsp}`}`);
      if (sums.length) log(`  totals: ${sums.join(', ')}`);
    }
    writeFileSync(join(outDir, 'reconciliation.json'), JSON.stringify(results, null, 2));
    return ok;
  }
  return true;
}

export function fileLogger(outDir: string): (m: string) => void {
  mkdirSync(outDir, { recursive: true });
  return (m: string) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    console.log(line);
    appendFileSync(join(outDir, 'pipeline.log'), line + '\n');
  };
}
