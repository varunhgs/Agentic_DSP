import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTransformationXml } from '../dist/bw/trfn-source.js';
import { buildTransformationIR } from '../dist/ir/transformation-ir.js';
import { translateBwFormula, FormulaError } from '../dist/ir/bw-formula.js';
import { toSql } from '../dist/ir/expr.js';
import { convertIrToTransformationFlow } from '../dist/converters/trfn-to-transformation-flow.js';
import { validateTransformationFlow, REFERENCE_SHAPE } from '../dist/validate/transformation-flow.js';
import { topoSort } from '../dist/plan/graph.js';

// Sanitized, synthetic fixture shaped after FPO transformation 2 (see the comment in the file).
const XML = readFileSync(new URL('./fixtures/TRFN_FPO_SANITIZED.xml', import.meta.url), 'utf8');
const REF_SHAPE = JSON.parse(readFileSync(new URL('./fixtures/tf-reference-shape.json', import.meta.url), 'utf8'));

async function run(xml = XML, opts = {}) {
  const ir = buildTransformationIR(await parseTransformationXml(xml), opts);
  const flow = convertIrToTransformationFlow(ir);
  return { ir, flow, v: validateTransformationFlow(ir, flow, opts.validate) };
}
const rule = (ir, target) => ir.mappings.find((m) => m.bwTarget === target);
const codes = (ir) => ir.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
/** Replace the single step of rule <id> in the fixture. */
const withStep = (id, step) => XML.replace(new RegExp(`(<rule description="" id="${id}">[\\s\\S]*?)<step [^>]*/>`), `$1${step}`);

test('fixture converts completely: every rule translated or flagged for review, no errors', async () => {
  const { ir, flow, v } = await run();
  assert.deepEqual(codes(ir), []);
  assert.equal(flow.deployable, true);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.deepEqual(ir.mappings.map((m) => [m.bwTarget, m.status]), [
    ['ZFUNDPLAN', 'translated'], ['0CALMONTH', 'needs_review'], ['0CALYEAR', 'needs_review'], ['0CRM_PROD', 'translated'],
    ['0CURRENCY', 'translated'], ['ZSTATGRP', 'needs_review'], ['ZSRCSYS', 'translated'], ['ZAMOUNT', 'translated'], ['0RECORDMODE', 'technical'],
  ]);
});

test('direct rules become column references; BW names follow the table converter (0CRM_PROD → CRM_PROD)', async () => {
  const { ir } = await run();
  assert.deepEqual(rule(ir, '0CRM_PROD').expr, { k: 'ref', column: 'CRM_PROD' });
  assert.equal(rule(ir, '0CRM_PROD').target, 'CRM_PROD');
});

test('time rules: 0CALDAY → 0CALMONTH / 0CALYEAR keep the BW initial value for an initial date', async () => {
  const { ir } = await run();
  assert.equal(toSql(rule(ir, '0CALMONTH').expr, 'S'), `COALESCE(TO_VARCHAR(S."CALDAY", 'YYYYMM'), '000000')`);
  assert.equal(toSql(rule(ir, '0CALYEAR').expr, 'S'), `COALESCE(TO_VARCHAR(S."CALDAY", 'YYYY'), '0000')`);
});

test('a time conversion outside the covered set is an error, not an approximation', async () => {
  const xml = XML.replace('name="0CALYEAR" infoObjectName="0CALYEAR"><inlineType name="NUMC" length="4"/>', 'name="0FISCPER" infoObjectName="0FISCPER"><inlineType name="NUMC" length="7"/>').replace('segment1/0CALYEAR', 'segment1/0FISCPER');
  const { ir, flow, v } = await run(xml);
  assert.ok(codes(ir).includes('TIME_UNSUPPORTED'));
  assert.equal(flow.deployable, false);
  assert.ok(flow.omittedColumns.some((c) => c.column === 'FISCPER'));
  assert.equal(v.ok, false);
});

test('formula IF becomes CASE with the comparison caveat recorded', async () => {
  const { ir } = await run();
  const m = rule(ir, 'ZSTATGRP');
  assert.equal(toSql(m.expr, 'S'), `CASE WHEN (S."ZSTATUS" = 'X') THEN 'CLSD' ELSE 'OPEN' END`);
  assert.equal(m.trace.bwFormula.trim(), "IF ( ZSTATUS = 'X' , 'CLSD' , 'OPEN' )");
  assert.ok(m.notes.some((n) => n.includes('trailing blanks')));
});

test('formula translator: RIGHT swaps BW (length, string) to SQL (string, length); unsupported input throws', () => {
  const col = (f) => (f === 'SALES_ORG' ? 'SALES_ORG' : undefined);
  const r = translateBwFormula(" IF ( SALES_ORG = '<*>' , SALES_ORG , RIGHT ( 8 , SALES_ORG ) )", col);
  assert.equal(toSql(r.expr, 'S'), `CASE WHEN (S."SALES_ORG" = '<*>') THEN S."SALES_ORG" ELSE RIGHT(S."SALES_ORG", 8) END`);
  assert.ok(r.notes.some((n) => n.startsWith('RIGHT')));
  assert.throws(() => translateBwFormula('DATE_WEEKDAY1 ( SALES_ORG )', col), FormulaError);
  assert.throws(() => translateBwFormula('IF ( SALES_ORG = , 1 , 2 )', col), FormulaError);
  assert.throws(() => translateBwFormula('OTHER_FIELD + 1', col), /not a source field/);
  assert.throws(() => translateBwFormula("'open", col), /unterminated/);
});

test('an unsupported formula keeps its text in the diagnostic and blocks deployment', async () => {
  const { ir, flow } = await run(withStep(6, `<step xsi:type="trfn:StepFormula" formula="DATE_WEEKDAY1 ( ZSTATUS )" id="1" type="FORMULA" rank="MAIN"/>`));
  const d = ir.diagnostics.find((x) => x.code === 'FORMULA_UNSUPPORTED');
  assert.ok(d.message.includes('DATE_WEEKDAY1'));
  assert.equal(d.ruleId, '6');
  assert.equal(flow.deployable, false);
});

test('SUM aggregation: rows collapse (0CALDAY → month), ZAMOUNT summed, keys grouped in SQL and CQN, constants not grouped', async () => {
  const { ir, flow } = await run();
  assert.equal(ir.aggregation.collapses, true);
  assert.equal(rule(ir, 'ZAMOUNT').aggregate, 'SUM');
  assert.ok(flow.sql.includes('SUM(S."ZAMOUNT") AS "ZAMOUNT"'));
  assert.ok(!/GROUP BY[\s\S]*'CRM'/.test(flow.sql));
  const sel = Object.values(flow.document.transformationflows)[0].contents.processes.sqltransform1.metadata.config.definition.query.SELECT;
  assert.equal(sel.groupBy.length, 6);
  assert.deepEqual(sel.columns.find((c) => c.as === 'ZAMOUNT'), { func: 'SUM', args: [{ ref: ['S', 'ZAMOUNT'] }], as: 'ZAMOUNT' });
  assert.ok(ir.diagnostics.some((d) => d.code === 'SUM_DELTA_SEMANTICS'));
});

test('no collapse when the source key reaches the target key 1:1: no GROUP BY, no SUM', async () => {
  const xml = XML.replace('<element posit="0002" key="true" name="0CALDAY"', '<element posit="0002" key="false" name="0CALDAY"');
  const { ir, flow, v } = await run(xml);
  assert.equal(ir.aggregation.collapses, false);
  assert.equal(rule(ir, 'ZAMOUNT').aggregate, undefined);
  assert.ok(!flow.sql.includes('GROUP BY'));
  assert.ok(v.ok);
});

test('overwrite (MOV) on a collapsing non-key field is refused as order-dependent', async () => {
  const xml = XML.replace('aggregationType="SUM" aggregationBehavior="SUM"', 'aggregationType="MOV" aggregationBehavior="SUM"');
  const { ir, flow } = await run(xml);
  assert.ok(codes(ir).includes('ORDER_DEPENDENT_OVERWRITE'));
  assert.equal(rule(ir, 'ZAMOUNT').status, 'unsupported');
  assert.equal(flow.deployable, false);
});

test('field routine and start routine are unsupported and named', async () => {
  const routine = withStep(8, `<step xsi:type="trfn:StepRoutine" id="1" type="ROUTINE" rank="MAIN" classNameM="/BIC/X_M" methodNameM="COMPUTE_ZAMOUNT"/>`);
  const r1 = await run(routine);
  assert.ok(codes(r1.ir).includes('FIELD_ROUTINE'));
  assert.equal(r1.flow.deployable, false);
  const start = XML.replace('</group>', '<rule description="" id="90" routinetype="START"><step xsi:type="trfn:StepRoutine" id="1" type="ROUTINE" rank="MAIN"/></rule></group>');
  const r2 = await run(start);
  assert.ok(codes(r2.ir).includes('GLOBAL_ROUTINE'));
  assert.deepEqual(r2.ir.globalRoutines.map((g) => g.kind), ['START']);
});

test('missing dependencies: validation fails when the migrated tables do not exist', async () => {
  const { v } = await run(XML, { validate: { existingTables: new Set(['MIG_ZC_CRM12']) } });
  const c = v.checks.find((x) => x.name.startsWith('source and target tables exist'));
  assert.equal(c.ok, false);
  assert.match(c.detail, /MIG_ZD_CRMFP/);
});

test('invalid expressions in a tampered flow are caught by the validator', async () => {
  const { ir, flow } = await run();
  const m = rule(ir, 'ZFUNDPLAN');
  m.expr = { k: 'func', name: 'SYSUUID', args: [{ k: 'ref', column: 'NOT_A_COLUMN' }] };
  const v = validateTransformationFlow(ir, flow);
  assert.equal(v.checks.find((c) => c.name.startsWith('expressions read only')).ok, false);
  assert.equal(v.checks.find((c) => c.name.startsWith('expressions use only')).ok, false);
});

test('a direct rule between incompatible types is an error', async () => {
  const xml = XML.replace('#///source/segment1/ZAMOUNT</elementRef></source><target id="1"><elementRef>#///target/segment1/ZAMOUNT', '#///source/segment1/ZSTATUS</elementRef></source><target id="1"><elementRef>#///target/segment1/ZAMOUNT');
  const { ir } = await run(xml);
  assert.ok(codes(ir).includes('TYPE_MISMATCH'));
});

test('DataSource source reads the DataSource landing table; other source types are still refused', async () => {
  const { ir } = await run(XML.replace('name="ZD_CRMFP" type="ADSO"', 'name="0CRM_FM_FPO CRPODP100" type="RSDS"'));
  assert.ok(!codes(ir).includes('SOURCE_NOT_ADSO'));
  assert.equal(ir.source.table, 'MIG_DS_0CRM_FM_FPO');
  const other = await run(XML.replace('name="ZD_CRMFP" type="ADSO"', 'name="0MATERIAL" type="IOBJ"'));
  assert.ok(codes(other.ir).includes('SOURCE_NOT_ADSO'));
});

test('generated document has the key structure of the tenant flow Tf_adj_qty', async () => {
  const { flow, v } = await run();
  const norm = (x) => (Array.isArray(x) ? [...x].sort() : x);
  for (const k of Object.keys(REFERENCE_SHAPE)) assert.deepEqual(norm(REF_SHAPE[k]), norm(REFERENCE_SHAPE[k]), k);
  const v2 = validateTransformationFlow((await run()).ir, flow, { reference: REF_SHAPE });
  assert.ok(v2.checks.filter((c) => c.name.includes('reference')).every((c) => c.ok));
  assert.ok(v.ok);
});

test('conversion is deterministic: same input, identical output', async () => {
  const a = await run();
  const b = await run();
  assert.equal(JSON.stringify(a.flow.document), JSON.stringify(b.flow.document));
  assert.equal(JSON.stringify(a.ir), JSON.stringify(b.ir));
});

test('dependency order: tables before the flow; cycles and missing nodes reported', async () => {
  const { ir } = await run();
  assert.deepEqual(ir.creationOrder, ['MIG_ZD_CRMFP', 'MIG_ZC_CRM12', 'MIG_TF_ZC_CRM12']);
  assert.deepEqual(topoSort([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), { ok: false, cycle: ['a', 'b'], missing: [] });
  assert.deepEqual(topoSort([{ id: 'a', dependsOn: ['x'] }]), { ok: false, cycle: [], missing: ['x'] });
});

// ── Regressions from the real FPO transformation 2 (2026-10-23), reproduced on the sanitized fixture ──

const POSTDATE = XML
  .replace('<element posit="0002" key="true" name="0CALDAY" infoObjectName="0CALDAY"><inlineType name="DATS" length="8"/></element>',
    '<element posit="0002" key="true" name="0CRMPOSTDAT" infoObjectName="0CRMPOSTDAT"><inlineType name="DATS" length="8"/></element>')
  .replaceAll('#///source/segment1/0CALDAY', '#///source/segment1/0CRMPOSTDAT');

test('a DATS InfoObject other than 0CALDAY is converted with the time reference named by the generated program', async () => {
  const parsed = await parseTransformationXml(POSTDATE);
  parsed.rules.find((r) => r.id === '2').gp = { steps: [{ id: '1', type: 'TIME' }], code: "i_timnm_from       = '0CALDAY'\ni_timnm_to = '0CALMONTH'" };
  const ir = buildTransformationIR(parsed);
  const m = rule(ir, '0CALMONTH');
  assert.equal(toSql(m.expr, 'S'), `COALESCE(TO_VARCHAR(S."CRMPOSTDAT", 'YYYYMM'), '000000')`);
  assert.ok(m.notes.some((n) => n.includes('taken from the generated program')));
  // Without GP evidence the date is still treated as 0CALDAY, and the note says so.
  assert.ok(rule(ir, '0CALYEAR').notes.some((n) => n.includes('no generated-program evidence')));
  assert.deepEqual(codes(ir), []);
});

test('0CALDAY → 0CALWEEK (ISO week) and → 0HALFYEAR1 keep BW initial values for an empty date', async () => {
  const xml = POSTDATE
    .replace('name="0CALYEAR" infoObjectName="0CALYEAR"><inlineType name="NUMC" length="4"/>', 'name="0CALWEEK" infoObjectName="0CALWEEK"><inlineType name="NUMC" length="6"/>')
    .replace('#///target/segment1/0CALYEAR', '#///target/segment1/0CALWEEK')
    .replace('name="0CALMONTH" infoObjectName="0CALMONTH"><inlineType name="NUMC" length="6"/>', 'name="0HALFYEAR1" infoObjectName="0HALFYEAR1"><inlineType name="NUMC" length="1"/>')
    .replace('#///target/segment1/0CALMONTH', '#///target/segment1/0HALFYEAR1');
  const { ir, v } = await run(xml);
  assert.equal(toSql(rule(ir, '0CALWEEK').expr, 'S'), `COALESCE(REPLACE(ISOWEEK(S."CRMPOSTDAT"), '-W', ''), '000000')`);
  assert.equal(toSql(rule(ir, '0HALFYEAR1').expr, 'S'),
    `CASE WHEN (COALESCE(TO_VARCHAR(S."CRMPOSTDAT", 'MM'), '00') = '00') THEN '0' WHEN (COALESCE(TO_VARCHAR(S."CRMPOSTDAT", 'MM'), '00') <= '06') THEN '1' ELSE '2' END`);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
});

const AMOUNT_CURRENCY = XML.replace(
  /<rule description="" id="8">[\s\S]*?<\/rule>/,
  '<rule description="" id="8"><source id="1"><elementRef>#///source/segment1/0CURRENCY</elementRef></source><source id="2"><elementRef>#///source/segment1/ZAMOUNT</elementRef></source>'
  + '<target id="1"><elementRef>#///target/segment1/ZAMOUNT</elementRef></target><target id="2"><elementRef>#///target/segment1/0CURRENCY</elementRef></target>'
  + '<step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/><step xsi:type="trfn:StepDirect" id="2" type="DIRECT" rank="MINOR"/></rule>');

test('amount + currency rule (MAIN + MINOR direct) maps each target from its same-name source; a repeated currency write is merged', async () => {
  const { ir, v } = await run(AMOUNT_CURRENCY);
  assert.deepEqual(codes(ir), []);
  assert.deepEqual(rule(ir, 'ZAMOUNT').expr, { k: 'ref', column: 'ZAMOUNT' });
  assert.equal(ir.mappings.filter((m) => m.bwTarget === '0CURRENCY').length, 1);
  assert.ok(rule(ir, '0CURRENCY').notes.some((n) => n.includes('also written by rule 8')));
  assert.ok(v.ok);
});

test('two rules writing one target from different sources are a conflict', async () => {
  const xml = AMOUNT_CURRENCY.replace('#///source/segment1/0CURRENCY</elementRef></target>', 'X').replace(
    /<rule description="" id="5">[\s\S]*?<\/rule>/,
    '<rule description="" id="5"><source id="1"><elementRef>#///source/segment1/ZSTATUS</elementRef></source><target id="1"><elementRef>#///target/segment1/0CURRENCY</elementRef></target><step xsi:type="trfn:StepDirect" id="1" type="DIRECT" rank="MAIN"/></rule>');
  const { ir } = await run(xml);
  assert.ok(codes(ir).includes('CONFLICTING_RULES') || codes(ir).includes('TYPE_MISMATCH'));
});

test('a conversion-exit check that only the generated program shows makes the rule "needs review"', async () => {
  const parsed = await parseTransformationXml(XML);
  parsed.rules.find((r) => r.id === '4').gp = { steps: [{ id: '1', type: 'DIRECT' }, { id: '2', type: 'CONVERT' }], code: "CALL 'CONVERSION_EXIT_ALPHA_INPUT'" };
  const ir = buildTransformationIR(parsed);
  const m = rule(ir, '0CRM_PROD');
  assert.equal(m.status, 'needs_review');
  assert.ok(m.notes.some((n) => n.includes('(ALPHA)')));
});

test('data-mart target: the flow takes table keys from the migrated table, not the transformation aggregation key', async () => {
  const { ir } = await run();
  const tables = {
    target: { elements: Object.fromEntries(ir.target.columns.filter((c) => !c.technical).map((c) => [c.column, { type: c.cdsType, ...(c.length ? { length: c.length } : {}), ...(c.precision ? { precision: c.precision, scale: c.scale } : {}) }])) },
  };
  const flow = convertIrToTransformationFlow(ir, { tables });
  const def = Object.values(flow.document.transformationflows)[0].contents.processes;
  assert.ok(Object.values(def.sqltransform1.metadata.config.definition.elements).every((e) => !e.key));
  assert.deepEqual(def.target1.metadata.config.definition.elements, tables.target.elements);
  const v = validateTransformationFlow(ir, flow, { tables });
  assert.ok(v.checks.find((c) => c.name.startsWith('flow target definition')).ok);
  assert.ok(v.checks.find((c) => c.name.startsWith('view key flags')).ok);
  // A flow built without the table would claim keys the table does not have.
  assert.equal(validateTransformationFlow(ir, convertIrToTransformationFlow(ir), { tables }).checks.find((c) => c.name.startsWith('flow target definition')).ok, false);
});
