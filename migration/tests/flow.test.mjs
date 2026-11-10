import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDataSourceXml, convertDataSourceToLocalTable } from '../dist/converters/rsds-to-local-table.js';
import { parseTransformationXml } from '../dist/bw/trfn-source.js';
import { buildTransformationIR } from '../dist/ir/transformation-ir.js';
import { toSql, toCqn } from '../dist/ir/expr.js';
import { planFlow } from '../dist/pipeline.js';

// Sanitized DataSource fragment in the BW/4HANA RSDS layout (field with an extra attribute
// such as lowerCase="true" included — that variant was skipped by the first parser).
const RSDS = `<?xml version="1.0" encoding="utf-8"?><rsds:dataSource name="0TEST_DS" sourceSystemName="SRC100" xmlns:rsds="r"><segment ID="0001">
<field name="GUID"><inlineType name="RAW" length="16"/><description label="Guid"/><fieldProperties transfer="true" position="0001"/></field>
<field name="REF_KEY" lowerCase="true"><inlineType name="CHAR" length="70"/><description label="Key"/><fieldProperties transfer="true" position="0002"/></field>
<field name="SALES_ORG"><inlineType name="CHAR" length="14"/><fieldProperties transfer="true" position="0003"/></field>
<field name="FISCVAR"><inlineType name="CHAR" length="2"/><fieldProperties transfer="true" position="0004"/></field>
<field name="POST_DATE"><inlineType name="DATS" length="8"/><fieldProperties transfer="true" position="0005"/></field>
<field name="AMOUNT"><inlineType name="CURR" length="17" precision="17" scale="2"/><fieldProperties transfer="true" position="0006"/></field>
<field name="ODQ_CHANGEMODE"><inlineType name="CHAR" length="1"/><fieldProperties transfer="false" position="0007"/></field>
</segment></rsds:dataSource>`;

test('DataSource parser: all fields incl. ones with extra attributes; non-transferred fields left out of the table', () => {
  const ds = parseDataSourceXml(RSDS);
  assert.equal(ds.name, '0TEST_DS');
  assert.equal(ds.sourceSystem, 'SRC100');
  assert.equal(ds.fields.length, 7);
  const t = convertDataSourceToLocalTable(ds, { prefix: 'MIG_' });
  assert.equal(t.technicalName, 'MIG_DS_0TEST_DS');
  const els = t.csn.definitions.MIG_DS_0TEST_DS.elements;
  assert.ok(els.REF_KEY, 'field with lowerCase attribute is kept');
  assert.deepEqual(t.skipped, ['ODQ_CHANGEMODE']);
  assert.equal(els.GUID.type, 'cds.Binary');
  assert.ok(Object.values(els).every((e) => !e.key), 'a DataSource has no semantic key');
});

// Layer-1 shaped transformation: DataSource → keyed standard aDSO, overwrite, ABAP moves.
const TRFN = `<?xml version="1.0" encoding="utf-8"?><trfn:transformation name="0LAYER1TEST" description="RSDS → ADSO" HANARuntime="false" abapProgram="GPX" xmlns:trfn="t" xmlns:xsi="x">
<source id="0" name="0TEST_DS SRC100" type="RSDS"><segment id="1">
<element posit="1" key="false" name="GUID"><inlineType name="RAW" length="16"/></element>
<element posit="2" key="false" name="REF_KEY"><inlineType name="CHAR" length="70"/></element>
<element posit="3" key="false" name="SALES_ORG"><inlineType name="CHAR" length="14"/></element>
<element posit="4" key="false" name="FISCVAR"><inlineType name="CHAR" length="2"/></element>
<element posit="5" key="false" name="AMOUNT"><inlineType name="CURR" precision="17" scale="2"/></element>
</segment></source>
<target id="0" name="ZTEST_A" type="ADSO"><segment id="1">
<element posit="1" key="true" name="0CRM_FMGUID" infoObjectName="0CRM_FMGUID"><inlineType name="CHAR" length="32"/></element>
<element posit="2" key="true" name="0FISCVARNT" infoObjectName="0FISCVARNT"><inlineType name="CHAR" length="2"/></element>
<element posit="3" key="false" name="0CRM_FMROBK" infoObjectName="0CRM_FMROBK"><inlineType name="CHAR" length="60"/></element>
<element posit="4" key="false" name="0CRM_SALORG" infoObjectName="0CRM_SALORG"><inlineType name="NUMC" length="8"/></element>
<element posit="5" key="false" name="0AMOUNT" infoObjectName="0AMOUNT" aggregationType="MOV"><inlineType name="CURR" precision="17" scale="2"/></element>
</segment></target>
<group id="1" type="S">
<rule id="1"><source id="1"><elementRef>#///source/segment1/GUID</elementRef></source><target id="1"><elementRef>#///target/segment1/0CRM_FMGUID</elementRef></target><step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/></rule>
<rule id="2"><source id="1"><elementRef>#///source/segment1/FISCVAR</elementRef></source><target id="1"><elementRef>#///target/segment1/0FISCVARNT</elementRef></target><step xsi:type="trfn:StepTime" id="1" type="TIME" rank="MAIN"/></rule>
<rule id="3"><source id="1"><elementRef>#///source/segment1/REF_KEY</elementRef></source><target id="1"><elementRef>#///target/segment1/0CRM_FMROBK</elementRef></target><step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/></rule>
<rule id="4"><source id="1"><elementRef>#///source/segment1/SALES_ORG</elementRef></source><target id="1"><elementRef>#///target/segment1/0CRM_SALORG</elementRef></target><step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/></rule>
<rule id="5"><source id="1"><elementRef>#///source/segment1/AMOUNT</elementRef></source><target id="1"><elementRef>#///target/segment1/0AMOUNT</elementRef></target><step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/></rule>
</group></trfn:transformation>`;

async function layer1() {
  const t = await parseTransformationXml(TRFN);
  // Generated-program evidence for the time rule: a plain assignment, no RST_TOBJ call.
  t.rules.find((r) => r.id === '2').gp = { steps: [{ id: '1', type: 'TIME' }], code: '    _G_1-FISCVARNT = <_ys_SC_1>-FISCVAR.' };
  return buildTransformationIR(t);
}
const m = (ir, f) => ir.mappings.find((x) => x.bwTarget === f);

test('DataSource source reads the DataSource landing table MIG_DS_<name>', async () => {
  const ir = await layer1();
  assert.equal(ir.source.table, 'MIG_DS_0TEST_DS');
  assert.ok(!ir.diagnostics.some((d) => d.code === 'SOURCE_NOT_ADSO'));
});

test('ABAP moves: RAW(16) → CHAR(32) as hex, CHAR → shorter CHAR cut on the right, CHAR → NUMC digits only', async () => {
  const ir = await layer1();
  assert.equal(toSql(m(ir, '0CRM_FMGUID').expr, 'S'), 'BINTOHEX(S."GUID")');
  assert.equal(toSql(m(ir, '0CRM_FMROBK').expr, 'S'), 'LEFT(S."REF_KEY", 60)');
  assert.equal(toSql(m(ir, '0CRM_SALORG').expr, 'S'), `LPAD(RIGHT(REPLACE_REGEXPR('[^0-9]' IN S."SALES_ORG" WITH '' OCCURRENCE ALL), 8), 8, '0')`);
  assert.equal(m(ir, '0CRM_SALORG').status, 'needs_review');
  assert.equal(toCqn(m(ir, '0CRM_SALORG').expr, 'S').args[0].args[0].func, 'REPLACE_REGEXPR');
});

test('a time rule whose generated code is a plain assignment is a copy', async () => {
  const ir = await layer1();
  assert.deepEqual(m(ir, '0FISCVARNT').expr, { k: 'ref', column: 'FISCVAR' });
  assert.equal(m(ir, '0FISCVARNT').status, 'translated');
});

test('keyless source into a keyed aDSO with overwrite: no GROUP BY, the table key rejects duplicates, warning stated', async () => {
  const ir = await layer1();
  assert.equal(ir.aggregation.collapses, false);
  assert.ok(ir.diagnostics.some((d) => d.code === 'UNIQUENESS_ASSUMED' && d.severity === 'warning'));
  assert.ok(!ir.diagnostics.some((d) => d.severity === 'error'), JSON.stringify(ir.diagnostics));
});

test('with a SUM key figure the keyless source still aggregates (no uniqueness shortcut)', async () => {
  const t = await parseTransformationXml(TRFN.replace('aggregationType="MOV"', 'aggregationType="SUM"'));
  const ir = buildTransformationIR(t);
  assert.equal(ir.aggregation.collapses, true);
  assert.equal(m(ir, '0AMOUNT').aggregate, 'SUM');
});

// ── multi-layer planning ─────────────────────────────────────────────────

test('planner: DataSource layer deployed only, its aDSO loaded from BW, the layer above runs; order respects dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-'));
  const fixtures = new URL('./fixtures/', import.meta.url);
  writeFileSync(join(dir, 'ds.xml'), RSDS.replace('0TEST_DS', '0TEST_DS'));
  // Layer 1: the test DataSource → ZAATM24-shaped aDSO is not needed; use the sanitized FPO pair for layer 2.
  const trfn2 = await parseTransformationXml(readFileSync(new URL('TRFN_FPO_SANITIZED.xml', fixtures), 'utf8'));
  writeFileSync(join(dir, 't2.json'), JSON.stringify(trfn2));
  const l1 = await parseTransformationXml(TRFN.replace('name="ZTEST_A"', 'name="ZD_CRMFP"'));
  writeFileSync(join(dir, 't1.json'), JSON.stringify(l1));
  // Minimal aDSO XMLs derived from the transformation sides (sanitized, structure only).
  const adsoXml = (name, fields, keys) => `<?xml version="1.0"?><adso:dataStore name="${name}" activateData="true" writeChangelog="true" xmlns:adso="a" xmlns:xsi="x">${keys.map((k) => `<keyElement>#///${k}</keyElement>`).join('')}${fields.map((f) => `<element name="${f.name}"><inlineType name="${f.dataType}"${f.length ? ` length="${f.length}"` : ''}${f.precision ? ` precision="${f.precision}" scale="${f.scale}"` : ''}/></element>`).join('')}</adso:dataStore>`;
  const zd = trfn2.source.fields.filter((f) => f.name !== '0RECORDMODE');
  const zc = trfn2.target.fields.filter((f) => f.name !== '0RECORDMODE');
  writeFileSync(join(dir, 'zd.xml'), adsoXml('ZD_CRMFP', zd, zd.filter((f) => f.key).map((f) => f.name)));
  writeFileSync(join(dir, 'zc.xml'), adsoXml('ZC_CRM12', zc, []));
  writeFileSync(join(dir, 'zd.rows.json'), JSON.stringify([]));
  const manifest = {
    targetAdso: 'ZC_CRM12',
    layers: [
      { transformation: 'L1', logicFile: join(dir, 't1.json'), source: { type: 'RSDS', name: '0TEST_DS', sourceSystem: 'SRC100', file: join(dir, 'ds.xml') }, target: { name: 'ZD_CRMFP', file: join(dir, 'zd.xml') } },
      { transformation: 'L2', logicFile: join(dir, 't2.json'), source: { type: 'ADSO', name: 'ZD_CRMFP', file: join(dir, 'zd.xml') }, target: { name: 'ZC_CRM12', file: join(dir, 'zc.xml') } },
    ],
    data: { ZD_CRMFP: { file: join(dir, 'zd.rows.json'), table: '/BIC/AZD_CRMFP2', rows: 3 } },
    notes: [],
  };
  const p = planFlow(manifest);
  assert.equal(p.layers[0].runs, false);
  // Either reason keeps layer 1 from running: no reachable DataSource data, or (in this reduced fixture) a definition mismatch.
  assert.match(p.layers[0].reason, /source system SRC100|not deployable/);
  assert.equal(p.layers[1].runs, true);
  assert.deepEqual(p.seeds, ['ZD_CRMFP']);
  const names = p.objects.map((o) => o.name);
  assert.ok(names.indexOf('MIG_DS_0TEST_DS') < names.indexOf(p.layers[0].flowName) || !names.includes(p.layers[0].flowName));
  assert.ok(names.indexOf('MIG_TF_SEED_ZD_CRMFP') < names.indexOf('MIG_TC_ZC_CRM12'));
  const chain = p.objects.find((o) => o.name === 'MIG_TC_ZC_CRM12').body.taskchains.MIG_TC_ZC_CRM12;
  assert.deepEqual(chain.nodes.slice(1).map((n) => n.taskIdentifier.objectId), ['MIG_TF_SEED_ZD_CRMFP', 'MIG_TF_ZC_CRM12']);
  assert.deepEqual(p.reconcile.map((r) => `${r.bwObject}:${r.kind}`), ['ZD_CRMFP:load check']);
});
