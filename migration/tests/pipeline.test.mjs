import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAdsoXml } from '../dist/bw/adso-parser.js';
import { convertAdsoToLocalTable } from '../dist/converters/adso-to-local-table.js';
import { convertAdsoToReplicationFlow, odpVType } from '../dist/converters/adso-to-replication-flow.js';
import { buildSeedView, buildReadView, buildCopyFlow, buildTaskChain, bwDateLiteral, bwNumberLiteral } from '../dist/converters/datasphere-objects.js';
import { reconcile, canonical } from '../dist/validate/reconcile.js';
import { DatasphereClient } from '../dist/datasphere/client.js';

// ZAATM24 fixture: sanitized aDSO definition already used by the aDSO tests.
const adso = parseAdsoXml(readFileSync(new URL('./fixtures/ZAATM24.xml', import.meta.url), 'utf8'));
const table = convertAdsoToLocalTable(adso, { prefix: 'MIG_' }).csn.definitions.MIG_ZAATM24;

// ── replication flow ──────────────────────────────────────────────────────

test('replication flow: ODP source "<ADSO>$F" in /BW, INITIAL load, new target, RECORDMODE after the key, ODQ columns', () => {
  const rf = convertAdsoToReplicationFlow(adso, { connectionId: 'BW_CONN', flowName: 'MIG_RF_X', targetTable: 'MIG_X' });
  const flow = rf.document.replicationflows.MIG_RF_X;
  const task = flow.contents.replicationTasks[0];
  assert.equal(flow.kind, 'sap.dis.replicationflow');
  assert.equal(flow.contents.sourceSystem[0].container, '/BW');
  assert.equal(task.sourceObject.name, 'ZAATM24$F');
  assert.equal(task.loadType, 'INITIAL');
  assert.deepEqual(task.targetObject.metadata, { isNew: true });
  const names = task.sourceObject.definition.columns.map((c) => c.name);
  assert.equal(names[adso.keyFields.length], 'RECORDMODE');
  assert.deepEqual(names.slice(-2), ['ODQ_CHANGEMODE', 'ODQ_ENTITYCNTR']);
  assert.ok(names.includes('CRM_PROD') && !names.includes('0CRM_PROD'));
  assert.deepEqual(task.sourceObject.definition.keys, adso.keyFields.map((k) => k.replace(/^0/, '')));
});

test('replication flow: source object carries metadata.type and the odp.read properties (deploy fails without them)', () => {
  const task = convertAdsoToReplicationFlow(adso, { connectionId: 'C', flowName: 'MIG_RF_X', targetTable: 'MIG_X' }).document.replicationflows.MIG_RF_X.contents.replicationTasks[0];
  assert.deepEqual(task.sourceObject.metadata, { type: 'tabular' });
  assert.equal(task.sourceObject.properties['odp.read.maxPartitions'], '3');
});

test('replication flow: dependency sections name the target table and the connection; every vType used is declared', () => {
  const flow = convertAdsoToReplicationFlow(adso, { connectionId: 'BW_CONN', flowName: 'MIG_RF_X', targetTable: 'MIG_X' }).document.replicationflows.MIG_RF_X;
  assert.deepEqual(Object.keys(flow.connections), ['BW_CONN']);
  assert.ok(flow.targets.MIG_X.elements.RECORDMODE);
  const used = new Set(flow.contents.replicationTasks[0].sourceObject.definition.columns.map((c) => c['vtype-ID'].replace('$DYNAMIC.', '')));
  for (const v of used) assert.ok(flow.contents.vTypes.scalar[v], v);
});

test('ODP column types: DATS is a 10-character string, CURR keeps precision/scale, unknown types are refused', () => {
  assert.equal(odpVType({ dataType: 'DATS', length: 8 }), 'string_10');
  assert.equal(odpVType({ dataType: 'CURR', precision: 17, scale: 2 }), 'decimal_17_2');
  assert.equal(odpVType({ dataType: 'NUMC', length: 7 }), 'string_7');
  assert.equal(odpVType({ dataType: 'RAW', length: 16 }), undefined);
});

// ── seed view, read view, copy flow, task chain ───────────────────────────

test('BW literals: initial date → NULL, date → TO_DATE, trailing ABAP minus moved to the front', () => {
  assert.equal(bwDateLiteral('00000000'), 'NULL');
  assert.equal(bwDateLiteral(''), 'NULL');
  assert.equal(bwDateLiteral('20220724'), "TO_DATE('20220724', 'YYYYMMDD')");
  assert.throws(() => bwDateLiteral('2022/07'), /not a BW date/);
  assert.equal(bwNumberLiteral('200.00-'), '-200.00');
  assert.equal(bwNumberLiteral('319.06'), '319.06');
  assert.throws(() => bwNumberLiteral('1,5'), /not a BW number/);
});

test('seed view: table function with one array per column and UNNEST (no DUMMY, no per-row INSERT)', () => {
  const row = Object.fromEntries(Object.keys(table.elements).map((c) => [c, table.elements[c].type === 'cds.Date' ? '00000000' : table.elements[c].type === 'cds.Decimal' ? '1.50-' : "O'X"]));
  const v = buildSeedView('MIG_V_SEED', table.elements, [row, row], 'seed').definitions.MIG_V_SEED;
  const script = v['@DataWarehouse.tableFunction.script'];
  assert.equal(v['@Analytics.dbViewType'], 'TABLE_FUNCTION');
  assert.ok(!/DUMMY/.test(script));
  assert.ok(!/\.INSERT\(/.test(script));
  assert.equal((script.match(/DECLARE a\d+ /g) ?? []).length, Object.keys(table.elements).length);
  assert.match(script, /UNNEST\(/);
  assert.ok(script.includes("'O''X'"), 'quotes are escaped');
  assert.ok(script.includes('-1.50'));
  assert.ok(Object.values(v.elements).every((e) => !e.key));
  assert.throws(() => buildSeedView('MIG_V', table.elements, [{}], 'x'), /lacks column/);
});

test('read view is exposed and selects every column 1:1 in SQL and CQN', () => {
  const v = buildReadView('MIG_V_R', 'MIG_ZAATM24', table.elements, 'read').definitions.MIG_V_R;
  assert.equal(v['@DataWarehouse.consumption.external'], true);
  assert.equal(v.query.SELECT.columns.length, Object.keys(table.elements).length);
  assert.match(v['@DataWarehouse.sqlEditor.query'], /FROM "MIG_ZAATM24"$/);
});

test('copy flow: full reload of every column into the target table', () => {
  const f = buildCopyFlow('MIG_TF_C', 'MIG_V_SEED', 'MIG_ZAATM24', table.elements, 'd').transformationflows.MIG_TF_C;
  const tgt = f.contents.processes.target1.metadata.config;
  assert.equal(tgt.truncate, true);
  assert.equal(tgt.attributeMappings.length, Object.keys(table.elements).length);
  assert.deepEqual(f.contents.processes.sqltransform1.metadata.config.definition.query.SELECT.from, { ref: ['MIG_V_SEED'], as: 'S' });
});

test('task chain: flows run in order, each after the previous one completed', () => {
  const c = buildTaskChain('MIG_TC', ['A', 'B']).taskchains.MIG_TC;
  assert.deepEqual(c.nodes.map((n) => n.taskIdentifier?.objectId ?? n.type), ['START', 'A', 'B']);
  assert.deepEqual(c.links.map((l) => l.startNode.statusRequired), ['ANY', 'COMPLETED']);
});

// ── reconciliation ────────────────────────────────────────────────────────

const els = { K: { type: 'cds.String', length: 3 }, D: { type: 'cds.Date' }, A: { type: 'cds.Decimal', precision: 17, scale: 2 } };
const bw = [{ K: 'a', D: '20220724', A: '200.00-' }, { K: 'b', D: '00000000', A: '5.00' }, { K: 'b', D: '00000000', A: '5.00' }];
const dsp = [{ K: 'a', D: '2022-07-24', A: -200 }, { K: 'b', D: null, A: 5 }, { K: 'b', D: null, A: 5 }];

test('reconcile: equal after the documented normalisation (dates, initial date, ABAP sign)', () => {
  const r = reconcile(els, bw, dsp);
  assert.equal(r.ok, true);
  assert.equal(r.matchedRows, 3);
  assert.equal(r.columns.find((c) => c.column === 'A').sumBw, '-190.00');
  assert.equal(canonical('cds.Date', undefined, '00000000', 'bw'), canonical('cds.Date', undefined, null, 'dsp'));
});

test('reconcile: a changed value, a missing duplicate and an extra row are all reported', () => {
  const r = reconcile(els, bw, [{ ...dsp[0], A: -199.99 }, dsp[1], { K: 'c', D: null, A: 0 }]);
  assert.equal(r.ok, false);
  assert.equal(r.onlyInBw.length, 2);
  assert.equal(r.onlyInDsp.length, 2);
  assert.equal(r.columns.find((c) => c.column === 'A').sameValueSet, false);
});

// ── client resilience (fake HTTP) ─────────────────────────────────────────

const config = { host: 'https://tenant.example', space: 'S', clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://auth.example/token' };
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).startsWith('https://auth.example')) return new Response(JSON.stringify({ access_token: `t${calls.length}`, expires_in: 3600 }), { status: 200 });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? '', { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, calls };
}

test('client retries 503 and network errors with backoff, then succeeds', async () => {
  const f = fakeFetch([{ status: 503 }, new TypeError('fetch failed'), { status: 200, body: '[]' }]);
  const c = new DatasphereClient(config, { fetchImpl: f.impl, backoffMs: 1 });
  assert.equal(await c.objectStatus('views', 'X'), undefined);
  assert.equal(f.calls.filter((x) => x.url.includes('/views')).length, 3);
});

test('client does not retry permanent errors and reports the correlation id', async () => {
  const f = fakeFetch([{ status: 400, body: '{"message":"bad"}', headers: { 'x-correlationid': 'cid-1' } }]);
  const c = new DatasphereClient(config, { fetchImpl: f.impl, backoffMs: 1 });
  await assert.rejects(c.createObject('views', {}, { deploy: false }), (e) => e.status === 400 && e.correlationId === 'cid-1');
  assert.equal(f.calls.filter((x) => x.url.includes('/views')).length, 1);
});

test('client fetches a new token once on 401, never loops on bad credentials', async () => {
  const f = fakeFetch([{ status: 401 }, { status: 401 }]);
  const c = new DatasphereClient(config, { fetchImpl: f.impl, backoffMs: 1 });
  await assert.rejects(c.getObject('views', 'X'), (e) => e.status === 401);
  assert.equal(f.calls.filter((x) => x.url.startsWith('https://auth.example')).length, 2);
});

test('a retried create that finds its own object (409 ObjectAlreadyExists) counts as created', async () => {
  const f = fakeFetch([{ status: 504 }, { status: 409, body: '{"code":"ObjectAlreadyExists"}' }]);
  const c = new DatasphereClient(config, { fetchImpl: f.impl, backoffMs: 1 });
  await c.createObject('views', {}, { deploy: false });
  const g = fakeFetch([{ status: 409, body: '{"code":"ObjectAlreadyExists"}' }]);
  await assert.rejects(new DatasphereClient(config, { fetchImpl: g.impl }).createObject('views', {}, { deploy: false }), (e) => e.status === 409);
});

test('delete is refused for anything that is not a MIG_ object', async () => {
  const c = new DatasphereClient(config, { fetchImpl: fakeFetch([]).impl });
  await assert.rejects(c.deleteMigrationObject('views', 'BSAD_VIEW'), /only MIG_ objects/);
});
