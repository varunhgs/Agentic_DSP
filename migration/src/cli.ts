#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MIGRATION_ROOT, loadDatasphereConfig } from './config.js';
import { BwMcpSource } from './bw/mcp-source.js';
import { classifyAdso, parseAdsoXml } from './bw/adso-parser.js';
import { convertAdsoToLocalTable } from './converters/adso-to-local-table.js';
import { DatasphereClient, DatasphereError } from './datasphere/client.js';
import { validateLocalTable } from './validate/local-table.js';
import { readFileSync } from 'node:fs';
import { parseTransformationXml } from './bw/trfn-source.js';
import { buildTransformationIR } from './ir/transformation-ir.js';
import { convertIrToTransformationFlow } from './converters/trfn-to-transformation-flow.js';
import { validateTransformationFlow } from './validate/transformation-flow.js';
import { renderMappingReport } from './report/trfn-report.js';
import { fileLogger, planFlow, runPipeline } from './pipeline.js';
import { extractFlow } from './bw/live-source.js';

const USAGE = `Usage: node dist/cli.js adso <ADSO_NAME> [options]
       node dist/cli.js trfn (--xml <file> | --logic <file>) [--source-adso <xml>] [--target-adso <xml>] [--prefix p] [--name n] [--out dir]   (dry run only)

  --prefix <p>     prefix for the Datasphere technical name (default MIG_)
  --name <n>       explicit Datasphere technical name (overrides --prefix)
  --dry-run        read and convert only — write the CSN to output/, touch nothing in Datasphere
  --no-deploy      save the table in Datasphere without deploying it
  --overwrite      replace the table if it already exists (otherwise the run stops)
  --out <dir>      output directory (default migration/output)`;

const log = (msg: string) => console.log(msg);

async function migrateAdso(adsoName: string, o: Record<string, string | boolean | undefined>): Promise<boolean> {
  const name = adsoName.toUpperCase();
  const outDir = join((o.out as string) ?? join(MIGRATION_ROOT, 'output'), name);
  mkdirSync(outDir, { recursive: true });

  // 1. Read — through the existing BW Modeling MCP.
  log(`[1/5] BW: reading aDSO ${name} via bw-modeling-mcp`);
  const bw = await BwMcpSource.connect();
  let xml: string;
  try {
    xml = await bw.getAdsoXml(name);
  } finally {
    await bw.close();
  }
  writeFileSync(join(outDir, 'bw-source.xml'), xml);
  const adso = parseAdsoXml(xml);
  const adsoType = (await classifyAdso(xml))[0] ?? 'unknown';
  log(`      ${adso.label} — type ${adsoType}, ${adso.fields.length} fields, ${adso.keyFields.length} key fields`);

  // 2. Convert.
  log('[2/5] Converting aDSO → Datasphere local table');
  const conv = convertAdsoToLocalTable(adso, { prefix: (o.prefix as string) ?? 'MIG_', technicalName: o.name as string | undefined });
  const csnFile = join(outDir, `${conv.technicalName}.csn.json`);
  writeFileSync(csnFile, JSON.stringify(conv.csn, null, 2));
  log(`      ${conv.technicalName} (${conv.semanticUsage}) → ${csnFile}`);
  console.table(conv.columns.map(({ bwField, column, role, bwType, dspType }) => ({ bwField, column, role, bwType, dspType })));
  for (const w of conv.warnings) log(`      ⚠ ${w}`);

  const report: Record<string, unknown> = {
    adso: name,
    adsoType,
    target: { space: undefined as string | undefined, technicalName: conv.technicalName, semanticUsage: conv.semanticUsage },
    columns: conv.columns,
    warnings: conv.warnings,
    manual: conv.manual,
    startedAt: new Date().toISOString(),
  };
  const writeReport = () => writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (o['dry-run']) {
    report.result = 'dry-run';
    writeReport();
    log('[3/5] Dry run — nothing written to Datasphere');
    return true;
  }

  // 3. Create (or replace) in Datasphere.
  const dsp = new DatasphereClient(loadDatasphereConfig());
  (report.target as any).space = dsp.space;
  const deploy = !o['no-deploy'];
  const existing = await dsp.localTableStatus(conv.technicalName);
  if (existing && !o.overwrite) {
    throw new Error(`${conv.technicalName} already exists in space ${dsp.space} (status ${existing.status}) — rerun with --overwrite to replace it`);
  }
  log(`[3/5] Datasphere: ${existing ? 'updating' : 'creating'} ${dsp.space}.${conv.technicalName} (${deploy ? 'save + deploy' : 'save only'})`);
  if (existing) await dsp.updateLocalTable(conv.technicalName, conv.csn, { deploy });
  else await dsp.createLocalTable(conv.csn, { deploy });

  // 4. Wait for deployment.
  let status = (await dsp.localTableStatus(conv.technicalName))?.status;
  if (deploy) {
    log('[4/5] Waiting for deployment');
    status = (await dsp.waitForLocalTable(conv.technicalName))?.status;
  } else {
    log('[4/5] Not deployed (--no-deploy)');
  }
  log(`      status: ${status}`);

  // 5. Validate against the BW definition.
  log('[5/5] Validating the Datasphere table against the BW definition');
  const actual = await dsp.getLocalTable(conv.technicalName, 'design-time');
  writeFileSync(join(outDir, `${conv.technicalName}.datasphere.json`), JSON.stringify(actual, null, 2));
  const validation = validateLocalTable(adso, conv, actual, deploy ? status : undefined);
  for (const c of validation.checks) log(`      ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);

  report.status = status;
  report.validation = validation;
  report.result = validation.ok ? 'success' : 'validation-failed';
  report.finishedAt = new Date().toISOString();
  writeReport();

  log(`\n${validation.ok ? 'SUCCESS' : 'VALIDATION FAILED'}: ${name} → ${dsp.space}.${conv.technicalName}`);
  if (conv.manual.length) {
    log('Not covered by this step:');
    for (const m of conv.manual) log(`  - ${m}`);
  }
  log(`Report: ${join(outDir, 'report.json')}`);
  return validation.ok;
}

/**
 * Transformation → proposed transformation flow. Offline and dry-run only in this milestone:
 * reads a saved transformation XML, writes the proposal, touches neither BW nor Datasphere.
 */
async function proposeTransformation(o: Record<string, string | boolean | undefined>): Promise<boolean> {
  if (!o.xml && !o.logic) throw new Error('trfn needs --xml <file> or --logic <file> (live BW read and Datasphere creation are not part of this milestone)');
  // --logic: the JSON of bw_get_transformation (format "json") — XML structure plus generated-program evidence per rule.
  const parsed = o.logic ? JSON.parse(readFileSync(o.logic as string, 'utf8')) : await parseTransformationXml(readFileSync(o.xml as string, 'utf8'));
  const ir = buildTransformationIR(parsed, { prefix: (o.prefix as string) ?? 'MIG_', flowName: o.name as string | undefined });
  // Optional: the real source/target aDSO definitions (bw_get_adso raw), converted with the existing aDSO converter.
  const tableOf = (file?: string) => {
    if (!file) return undefined;
    const text = readFileSync(file, 'utf8');
    const conv = convertAdsoToLocalTable(parseAdsoXml(text.slice(Math.max(0, text.indexOf('<?xml')))), { prefix: (o.prefix as string) ?? 'MIG_' });
    return conv.csn.definitions[conv.technicalName];
  };
  const tables = { source: tableOf(o['source-adso'] as string | undefined), target: tableOf(o['target-adso'] as string | undefined) };
  const flow = convertIrToTransformationFlow(ir, { tables });
  const validation = validateTransformationFlow(ir, flow, { tables });
  const outDir = join((o.out as string) ?? join(MIGRATION_ROOT, 'output'), ir.transformation);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'ir.json'), JSON.stringify(ir, null, 2));
  writeFileSync(join(outDir, `${flow.flowName}.transformationflow.json`), JSON.stringify(flow.document, null, 2));
  writeFileSync(join(outDir, `${flow.flowName}.sql`), flow.sql + '\n');
  writeFileSync(join(outDir, 'dependencies.json'), JSON.stringify({ dependencies: ir.dependencies, creationOrder: ir.creationOrder }, null, 2));
  writeFileSync(join(outDir, 'validation.json'), JSON.stringify(validation, null, 2));
  writeFileSync(join(outDir, 'issues.json'), JSON.stringify({ deployable: flow.deployable, omittedColumns: flow.omittedColumns, diagnostics: ir.diagnostics }, null, 2));
  writeFileSync(join(outDir, 'mapping-report.md'), renderMappingReport(ir, flow, validation));
  for (const m of ir.mappings) log(`  rule ${(m.trace.ruleId ?? '-').padStart(3)}  ${m.bwTarget.padEnd(14)} ${m.kind.padEnd(10)} ${m.status}`);
  for (const d of ir.diagnostics) log(`  ${d.severity.toUpperCase()} ${d.code}${d.ruleId ? ` rule ${d.ruleId}` : ''}: ${d.message}`);
  for (const c of validation.checks) log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  log(`
DRY RUN ${validation.ok && flow.deployable ? 'OK' : 'WITH OPEN ISSUES'}: ${ir.transformation} → ${flow.flowName}. Nothing was written to BW or Datasphere.
Artifacts: ${outDir}`);
  return validation.ok && flow.deployable;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prefix: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-deploy': { type: 'boolean' },
      overwrite: { type: 'boolean' },
      xml: { type: 'string' },
      logic: { type: 'string' },
      'source-adso': { type: 'string' },
      'target-adso': { type: 'string' },
      manifest: { type: 'string' },
      stages: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [objectType, objectName] = positionals;
  if (objectType?.toLowerCase() === 'extract') {
    // Read-only against BW: walks the flow upstream from the target aDSO and saves everything + manifest.json.
    if (!objectName) throw new Error('extract needs a target aDSO name');
    const out = (values.out as string) ?? join(MIGRATION_ROOT, 'output', 'flows', objectName.toUpperCase());
    const m = await extractFlow(objectName, out);
    log(`
${m.layers.length} layer(s): ${m.layers.map((l) => `${l.source.type} ${l.source.name} → ${l.target.name}`).join(' | ')}`);
    for (const note of m.notes) log(`  note: ${note}`);
    log(`manifest: ${join(out, 'manifest.json')}`);
    return;
  }
  if (objectType?.toLowerCase() === 'pipeline') {
    // ⚠ Every stage except "plan" writes to Datasphere. Stages: plan,create,deploy,run,reconcile.
    if (!values.manifest) throw new Error('pipeline needs --manifest <manifest.json> (from the extract command)');
    const manifest = JSON.parse(readFileSync(values.manifest as string, 'utf8'));
    const outDir = (values.out as string) ?? join(MIGRATION_ROOT, 'output', 'pipeline', manifest.targetAdso);
    const stages = new Set(String(values.stages ?? 'plan').split(','));
    if (stages.size === 1 && stages.has('plan')) {
      const p = planFlow(manifest, (values.prefix as string) ?? 'MIG_');
      for (const l of p.layers) log(`  layer ${l.transformation}: ${l.source} → ${l.target} as ${l.flowName} — ${l.runs ? 'RUNS' : 'deployed only'} (${l.reason}); offline validation ${l.validation.ok ? 'passed' : 'FAILED'}`);
      for (const o of p.objects) log(`  ${o.collection.padEnd(20)} ${o.name.padEnd(30)} ${o.purpose}`);
      return;
    }
    process.exitCode = (await runPipeline(new DatasphereClient(loadDatasphereConfig()), manifest, outDir, stages, fileLogger(outDir), (values.prefix as string) ?? 'MIG_')) ? 0 : 1;
    return;
  }
  if (objectType?.toLowerCase() === 'trfn') {
    process.exitCode = (await proposeTransformation(values)) ? 0 : 1;
    return;
  }
  if (values.help || !objectType || !objectName) {
    log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  switch (objectType.toLowerCase()) {
    case 'adso':
      process.exitCode = (await migrateAdso(objectName, values)) ? 0 : 1;
      return;
    default:
      throw new Error(`object type "${objectType}" is not supported yet — available: adso`);
  }
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : e}`);
  if (e instanceof DatasphereError && e.correlationId) console.error(`Datasphere correlation ID: ${e.correlationId}`);
  process.exit(1);
});
