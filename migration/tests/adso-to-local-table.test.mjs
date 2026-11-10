import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyAdso, parseAdsoXml } from '../dist/bw/adso-parser.js';
import { columnName, convertAdsoToLocalTable } from '../dist/converters/adso-to-local-table.js';
import { validateLocalTable } from '../dist/validate/local-table.js';

// ZAATM24 as bw_get_adso (format raw) returned it from the BW/4HANA system.
const xml = readFileSync(new URL('./fixtures/ZAATM24.xml', import.meta.url), 'utf8');
const adso = parseAdsoXml(xml);
const conv = convertAdsoToLocalTable(adso, { prefix: 'MIG_' });
const table = conv.csn.definitions.MIG_ZAATM24;

test('parser: all 13 fields, keys first in key order', () => {
  assert.equal(adso.name, 'ZAATM24');
  assert.equal(adso.fields.length, 13);
  assert.deepEqual(adso.keyFields, ['0CRM_PROD', 'VTWED', '0CUSTOMER', 'ZCATEGORY', 'DATBI', 'DATAB', '0CRM_SALORG', '0SOLD_TO']);
  assert.deepEqual(adso.fields.slice(0, 8).map((f) => f.name), adso.keyFields);
  assert.ok(adso.flags.writeChangelog);
});

test('parser: key figure with its currency field', () => {
  const kbetr = adso.fields.find((f) => f.name === 'KBETR');
  assert.equal(kbetr.isKeyFigure, true);
  assert.equal(kbetr.aggregation, 'SUM');
  assert.equal(kbetr.unitCurrencyField, 'KONWA');
  assert.deepEqual([kbetr.precision, kbetr.scale], [11, 2]);
  assert.equal(adso.fields.filter((f) => f.isKeyFigure).length, 1);
});

test('classification is the BW MCP\'s own', async () => {
  assert.deepEqual(await classifyAdso(xml), ['standard']);
});

test('column names: SAP InfoObjects lose the leading 0, namespaces lose the slashes', () => {
  assert.equal(columnName('0CUSTOMER'), 'CUSTOMER');
  assert.equal(columnName('ZCATEGORY'), 'ZCATEGORY');
  assert.equal(columnName('VTWED'), 'VTWED');
  assert.equal(columnName('/ABC/FIELD'), 'ABC_FIELD');
});

test('table: fact with prefixed name and the aDSO label', () => {
  assert.equal(conv.technicalName, 'MIG_ZAATM24');
  assert.equal(conv.semanticUsage, 'ANALYTICAL_FACT');
  assert.equal(table['@ObjectModel.modelingPattern']['#'], 'ANALYTICAL_FACT');
  assert.equal(table['@EndUserText.label'], 'List Price - Products and Customers Explosion');
  assert.equal(Object.keys(table.elements).length, 13);
});

test('types: CHAR/NUMC → String(n), DATS → Date, CURR → Decimal(p,s)', () => {
  const e = table.elements;
  assert.deepEqual([e.CRM_PROD.type, e.CRM_PROD.length], ['cds.String', 32]);
  assert.deepEqual([e.CRM_SALORG.type, e.CRM_SALORG.length], ['cds.String', 8]);
  assert.equal(e.DATBI.type, 'cds.Date');
  assert.deepEqual([e.KBETR.type, e.KBETR.precision, e.KBETR.scale], ['cds.Decimal', 11, 2]);
  assert.deepEqual([e.KONWA.type, e.KONWA.length], ['cds.String', 5]);
  assert.deepEqual([e.KMEIN.type, e.KMEIN.length], ['cds.String', 3]);
});

test('keys: exactly the aDSO key', () => {
  const keys = Object.entries(table.elements).filter(([, e]) => e.key).map(([c]) => c);
  assert.deepEqual(keys, ['CRM_PROD', 'VTWED', 'CUSTOMER', 'ZCATEGORY', 'DATBI', 'DATAB', 'CRM_SALORG', 'SOLD_TO']);
});

test('semantics: measure with SUM, linked to its currency; currency and unit columns marked', () => {
  const e = table.elements;
  assert.deepEqual(e.KBETR['@AnalyticsDetails.measureType'], { '#': 'BASE' });
  assert.deepEqual(e.KBETR['@Aggregation.default'], { '#': 'SUM' });
  assert.deepEqual(e.KBETR['@Semantics.amount.currencyCode'], { '=': 'KONWA' });
  assert.equal(e.KONWA['@Semantics.currencyCode'], true);
  assert.equal(e.KMEIN['@Semantics.unitOfMeasure'], true);
  assert.equal(e.CUSTOMER['@AnalyticsDetails.measureType'], undefined);
});

test('a date in the key is not told to load as NULL', () => {
  assert.ok(conv.warnings.some((w) => w.startsWith('DATBI') && w.includes('cannot be NULL')));
});

test('change log and InfoObject links are reported as follow-up work', () => {
  assert.ok(conv.manual.some((m) => m.includes('delta capture')));
  assert.ok(conv.manual.some((m) => m.includes('0CUSTOMER')));
});

test('a measure referencing a unit outside the aDSO is reported, not invented', () => {
  const lone = { ...adso, fields: adso.fields.filter((f) => f.name !== 'KONWA') };
  const r = convertAdsoToLocalTable(lone, { prefix: 'MIG_' });
  assert.equal(r.csn.definitions.MIG_ZAATM24.elements.KBETR['@Semantics.amount.currencyCode'], undefined);
  assert.ok(r.warnings.some((w) => w.startsWith('KBETR')));
});

test('two BW fields mapping to one column are refused', () => {
  const clash = { ...adso, fields: [...adso.fields, { ...adso.fields[2], name: 'CUSTOMER', isKey: false }] };
  assert.throws(() => convertAdsoToLocalTable(clash, { prefix: 'MIG_' }), /both map to column CUSTOMER/);
});

test('validator: the generated definition read back passes; a changed type fails', () => {
  const ok = validateLocalTable(adso, conv, structuredClone(conv.csn), 'Deployed');
  assert.ok(ok.ok, JSON.stringify(ok.checks.filter((c) => !c.ok)));

  const drift = structuredClone(conv.csn);
  drift.definitions.MIG_ZAATM24.elements.KBETR.scale = 3;
  const bad = validateLocalTable(adso, conv, drift, 'Deployed');
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.some((c) => !c.ok && c.name.startsWith('KBETR')));
});
