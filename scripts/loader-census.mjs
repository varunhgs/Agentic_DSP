#!/usr/bin/env node
// Loader census for every aDSO (or a given list): which mechanisms write into each one.
//
// Usage (credentials come from the environment only — never from files in the repo):
//   BW_URL=… BW_USER=… BW_PASSWORD=… BW_CLIENT=100 npm run build && node scripts/loader-census.mjs [--out census-out] [--adso ZD_CRMFP,ZC_CRM12] [--no-chains]
//   or: node --env-file=.env scripts/loader-census.mjs
//
// Output: <out>/loader-census.json (full detail) and <out>/loader-census.csv (one row per aDSO).
// Read-only: issues GET requests, ADT where-used and ADT data-preview SELECTs on RSPMPROCESS.
import fs from 'node:fs';
import path from 'node:path';
import { createClientFromEnv } from '../dist/bw-client.js';
import { bwSearchEntries } from '../dist/tools/search.js';
import { bwGetAdsoLoaders, CensusContext } from '../dist/tools/loaders.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = opt('out', 'census-out');
const only = opt('adso', '');
const scanChains = !args.includes('--no-chains');

if (!process.env.BW_URL) {
  console.error('BW_URL (and BW_USER / BW_PASSWORD or BW_COOKIE_FILE) must be set in the environment.');
  process.exit(2);
}

const client = createClientFromEnv();
await client.loadMediaTypes().catch((e) => console.error(`discovery failed, using fallbacks: ${e.message}`));

/** Enumerate aDSOs; refine by prefix when a search looks capped. */
async function listAdsos() {
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
  const names = new Set();
  async function walk(prefix) {
    const hits = await bwSearchEntries(client, `${prefix}*`, 'ADSO');
    const own = hits.filter((h) => h.objectType === 'ADSO').map((h) => h.objectName);
    if (hits.length >= 250 && prefix.length < 4) {
      for (const c of CHARS) await walk(prefix + c);
    } else {
      own.forEach((n) => names.add(n));
    }
  }
  await walk('');
  return [...names].sort();
}

const adsos = only ? only.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : await listAdsos();
console.error(`aDSOs to analyse: ${adsos.length}${scanChains ? '' : ' (process-chain scan disabled)'}`);

const ctx = new CensusContext();
const results = [];
// Stop when the system becomes unreachable instead of recording hundreds of empty results.
const CONNECTIVITY = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up/;
const MAX_CONSECUTIVE_UNREACHABLE = 3;
let unreachableRun = 0;
let aborted = null;
for (const [i, name] of adsos.entries()) {
  let r;
  try {
    r = await bwGetAdsoLoaders(client, name, { includeRuntime: true, scanProcessChains: scanChains, scanWriteApis: true }, ctx);
  } catch (err) {
    r = { adso: name, status: 'NOT_ASSESSED', mechanisms: [], loaders: [], dataModifications: [], unresolved: [`census failed: ${String(err.message).split('\n')[0]}`], residualRisks: [], readErrors: [String(err.message).split('\n')[0]], notes: [] };
  }
  results.push(r);
  unreachableRun = r.status === 'NOT_ASSESSED' && r.readErrors.some((e) => CONNECTIVITY.test(e)) ? unreachableRun + 1 : 0;
  if (unreachableRun >= MAX_CONSECUTIVE_UNREACHABLE) {
    aborted = `System unreachable for ${unreachableRun} consecutive aDSOs (${r.readErrors.find((e) => CONNECTIVITY.test(e))}); stopped after ${i + 1} of ${adsos.length}.`;
    console.error(aborted);
    break;
  }
  if ((i + 1) % 25 === 0) console.error(`  ${i + 1}/${adsos.length}`);
}

fs.mkdirSync(outDir, { recursive: true });
const summary = {
  generatedAt: new Date().toISOString(),
  system: process.env.BW_URL.replace(/\/\/[^@/]*@/, '//'),
  complete: !aborted && !results.some((r) => r.status === 'NOT_ASSESSED'),
  aborted,
  adsoCount: adsos.length,
  assessedCount: results.filter((r) => r.status !== 'NOT_ASSESSED').length,
  byStatus: tally(results.map((r) => r.status)),
  byMechanism: tally(results.flatMap((r) => r.mechanisms.length ? r.mechanisms : ['(none)'])),
  multiLoaderAdsos: results.filter((r) => r.mechanisms.length > 1).map((r) => r.adso),
  withSelectiveDeletion: results.filter((r) => r.dataModifications?.some((m) => m.processType === 'SELDEL')).map((r) => r.adso),
  systemWideBlindSpots: results.find((r) => r.systemWideBlindSpots)?.systemWideBlindSpots ?? [],
  censusNotes: [...new Set(ctx.notes)],
};
fs.writeFileSync(path.join(outDir, 'loader-census.json'), JSON.stringify({ summary, results }, null, 2));

const csvRows = [['adso', 'type', 'status', 'mechanisms', 'loaders', 'open_items', 'residual_risks', 'failed_or_skipped_checks', 'modifications', 'read_errors']];
for (const r of results) {
  const checks = Object.entries(r.evidenceChecks ?? {}).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}=${v}`);
  csvRows.push([
    r.adso, r.type ?? '', r.status, r.mechanisms.join('|'),
    r.loaders.map((l) => `${l.mechanism}:${l.object}`).join('|'),
    r.unresolved.length, (r.residualRisks ?? []).length, checks.join('|'),
    (r.dataModifications ?? []).map((m) => `${m.processType}=${m.count}`).join('|'), r.readErrors.length,
  ]);
}
fs.writeFileSync(path.join(outDir, 'loader-census.csv'), csvRows.map((r) => r.map(csv).join(',')).join('\n') + '\n');

console.log(JSON.stringify(summary, null, 2));

function tally(values) {
  return values.reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
}
function csv(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
