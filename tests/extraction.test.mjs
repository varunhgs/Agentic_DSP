import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBwObjectName, assertBwTechnicalName } from '../dist/tools/bw-names.js';
import { classifyAdsoFlags, parseAdsoXml } from '../dist/tools/adso.js';
import { parseTransformationXml, parseGeneratedProgram, classifyRule } from '../dist/tools/trfn_logic.js';
import { extractMethod, normalizeAbap, listMethods } from '../dist/tools/abap_source.js';
import { parseDtpXml, classifyLoaders, parsePlanningFunctionType } from '../dist/tools/loaders.js';
import { parseDataPreview, adtSelect } from '../dist/tools/adt-sql.js';

// Fixtures are trimmed copies of the shapes returned by BW/4HANA 2.0 SP17 (structure kept,
// payload reduced). No credentials or business data.

test('namespaced names are encoded the way BW serves them', () => {
  assert.equal(encodeBwObjectName('/JBPB/IPLAN'), '%24jbpb%24iplan');
  assert.equal(encodeBwObjectName('ZD_CRMFP'), 'zd_crmfp');
});

test('SQL name guard rejects anything but BW technical names', () => {
  assert.equal(assertBwTechnicalName('zd_crmfp'), 'ZD_CRMFP');
  assert.equal(assertBwTechnicalName('/JBPB/IPLAN'), '/JBPB/IPLAN');
  assert.throws(() => assertBwTechnicalName("ZD' OR '1'='1"));
  assert.throws(() => assertBwTechnicalName(''));
});

test('aDSO type classification is the inverse of the creation presets', () => {
  const f = (activateData, cubeDeltaOnly, directUpdate, isReportingObject, noAqDeletion) =>
    classifyAdsoFlags({ activateData, cubeDeltaOnly, directUpdate, isReportingObject, noAqDeletion });
  assert.equal(f(true, false, false, true, false), 'standard');
  assert.equal(f(false, false, false, false, false), 'staging_inbound_only');
  assert.equal(f(true, false, false, false, false), 'staging_compress');
  assert.equal(f(true, false, false, true, true), 'staging_reporting');
  assert.equal(f(true, true, false, true, false), 'datamart'); // e.g. ZC_CRM12 "Fund Posting Cube"
  assert.equal(f(false, false, true, false, false), 'direct_update');
  assert.equal(f(false, true, false, true, true), 'unknown');
});

const ADSO_XML = `<?xml version="1.0" encoding="utf-8"?><adso:dataStore schemaVersion="1.0" name="ZD_TEST" activateData="true" writeChangelog="true" cubeDeltaOnly="false" noAqDeletion="false" directUpdate="false" planningMode="false" isReportingObject="true" pushMode="false" xmlns:adso="x" xmlns:xsi="y"><endUserTexts label="Fund &amp; Posting"/><tlogoProperties><adtcore:packageRef adtcore:name="ZBW" xmlns:adtcore="z"/><infoArea>0CRM_FM</infoArea><objectVersion>A</objectVersion></tlogoProperties>
<element xsi:type="adso:AdsoElement" name="0CRM_FMGUID" infoObjectName="0CRM_FMGUID" dimension="d"><inlineType name="CHAR" length="32"/></element>
<element xsi:type="adso:AdsoElement" name="0CRM_FMAMOT" infoObjectName="0CRM_FMAMOT" aggregationBehavior="SUM"><inlineType name="CURR" precision="17" scale="2"/><unitCurrencyElement>#///0CURRENCY</unitCurrencyElement></element>
<keyElement>#///0CRM_FMGUID</keyElement><tables tableName="/BIC/AZD_TEST2" tableType="AT" ddicStatus="A"/></adso:dataStore>`;

test('aDSO XML is parsed into type, flags, keys and fields', () => {
  const p = parseAdsoXml(ADSO_XML);
  assert.equal(p.name, 'ZD_TEST');
  assert.equal(p.type, 'standard');
  assert.equal(p.description, 'Fund & Posting');
  assert.equal(p.flags.writeChangelog, true);
  assert.deepEqual(p.keyFields, ['0CRM_FMGUID']);
  assert.equal(p.fields.length, 2);
  assert.equal(p.fields[1].aggregation, 'SUM');
  assert.equal(p.fields[1].unitField, '0CURRENCY');
  assert.deepEqual(p.tables, [{ name: '/BIC/AZD_TEST2', type: 'AT' }]);
});

const TRFN_XML = `<?xml version="1.0" encoding="utf-8"?><trfn:transformation name="0G1WTEST" description="RSDS X -&gt; ADSO /JBPB/SAFV_M" startRoutine="" sapHANAExecutionPossible="MUST_NOT" HANARuntime="false" abapProgram="GPTEST" xmlns:trfn="t" xmlns:xsi="x">
<source id="0" name="SALESORG_FISCV_MAP            CRMCLNT100" type="RSDS"><segment id="1"><element posit="0001" key="true" intType="C" name="SALES_ORG"><inlineType name="CHAR" length="14"/></element><element posit="0002" key="false" intType="C" name="FISCAL_YEAR_VARIANT"><inlineType name="CHAR" length="2"/></element></segment></source>
<target id="0" name="/JBPB/SAFV_M" type="ADSO"><segment id="1"><element posit="0001" key="true" name="$JBPB$SAL_ORG" infoObjectName="$JBPB$SAL_ORG"><inlineType name="CHAR" length="8"/></element><element posit="0002" key="false" name="0FISCVARNT" infoObjectName="0FISCVARNT"><inlineType name="CHAR" length="2"/></element><element posit="0003" key="false" name="0RECORDMODE" infoObjectName="0RECORDMODE"><inlineType name="CHAR" length="1"/></element><element posit="0004" key="false" name="0AMOUNT" infoObjectName="0AMOUNT" aggregationType="MOV" aggregationBehavior="SUM"><inlineType name="CURR" precision="17" scale="2"/></element></segment></target>
<group id="2" description="Rules" type="S"><rule description="" id="2"><source id="1"><elementRef>#///source/segment1/SALES_ORG</elementRef></source><target id="1"><elementRef>#///target/segment1/$JBPB$SAL_ORG</elementRef></target><step xsi:type="trfn:StepFormula" formula=" IF ( SALES_ORG = '&lt;*&gt;' , SALES_ORG , RIGHT ( 8 , SALES_ORG ) )" id="1" type="FORMULA" rank="MAIN"/></rule>
<rule description="" id="3"><source id="1"><elementRef>#///source/segment1/FISCAL_YEAR_VARIANT</elementRef></source><target id="1"><elementRef>#///target/segment1/0FISCVARNT</elementRef></target><step xsi:type="trfn:StepTime" id="2" type="TIME" rank="MAIN"/></rule></group>
<group id="1" description="Technical Rules" type="T"><rule description="" id="1"><target id="1"><elementRef>#///target/segment1/0RECORDMODE</elementRef></target><step xsi:type="trfn:StepConstant" id="1" type="CONSTANT" rank="MAIN"/></rule></group>
</trfn:transformation>`;

test('transformation XML is parsed into rules, steps, classes and aggregation', () => {
  const p = parseTransformationXml(TRFN_XML);
  assert.equal(p.source.type, 'RSDS');
  assert.equal(p.source.name, 'SALESORG_FISCV_MAP');
  assert.equal(p.source.sourceSystem, 'CRMCLNT100'); // from the XML, not the (possibly stale) description
  assert.equal(p.target.name, '/JBPB/SAFV_M');
  assert.equal(p.hanaRuntime, 'false');
  assert.equal(p.rules.length, 3);
  const formula = p.rules.find((r) => r.id === '2');
  assert.equal(formula.steps[0].kind, 'FORMULA');
  assert.match(formula.steps[0].formula, /RIGHT \( 8 , SALES_ORG \)/);
  assert.equal(formula.conversionClass, 'B');
  assert.equal(p.rules.find((r) => r.id === '1').conversionClass, 'A');
  assert.equal(p.target.fields.find((f) => f.name === '0AMOUNT').aggregationType, 'MOV');
  assert.deepEqual(p.targetFieldsWithoutRule, ['0AMOUNT']);
});

test('rule classification routes routines to C and unknown steps to E', () => {
  assert.equal(classifyRule([{ kind: 'ROUTINE' }]).cls, 'C');
  assert.equal(classifyRule([{ kind: 'DIRECT' }], 'EXPERT').cls, 'C');
  assert.equal(classifyRule([{ kind: 'SOMETHING_NEW' }]).cls, 'E');
  assert.equal(classifyRule([{ kind: 'DIRECT' }, { kind: 'NO_UPDATE' }]).cls, 'A');
});

const GP = [
  '***********************************************************************',
  '*   Template......: RSTRAN_MASTER_TMPL',
  '*   TranID........: 0G1WTEST   Version: 0',
  '*   Source........: RSDS SALESORG_FISCV_MAP CRMCLNT100',
  '*   Target........: ADSO /JBPB/SAFV_M',
  'class lcl_transform implementation.',
  'method execute.',
  '* ======  RULES',
  "*<<<    Rule ID: '3'.",
  "*       Step ID: '1', Type: 'TIME'.",
  '    _G_1-FISCVARNT = <_ys_SC_1>-FISCAL_YEAR_VARIANT.',
  "*       Step ID: '2', Type: 'CONVERT'.",
  "    CALL 'CONVERSION_EXIT_ALPHA_INPUT' ID 'INPUT' FIELD l_in.",
  '*>>>',
  "*<<<    Rule ID: '1'.",
  "*       Step ID: '1', Type: 'CONSTANT'.",
  "    _G_2-RECORDMODE = ' '.",
  '*>>>',
  '*   aggregation MOVE',
  '      IF _G_2-RECORDMODE = rstr_c_recordmode-reverse_image.',
  'endmethod.',
  '  METHOD compute_10_1.',
  '*   IMPORTING',
  '*     request     type rsrequest',
  '    DATA:',
  '      MONITOR_REC    TYPE rsmonitor.',
  '    RESULT = SOURCE_FIELDS-LOGSYS.',
  '  ENDMETHOD.',
].join('\n');

test('generated program is split into rule blocks with implicit steps', () => {
  const gp = parseGeneratedProgram(GP);
  assert.equal(gp.header.Template, 'RSTRAN_MASTER_TMPL');
  assert.equal(gp.header.TranID, '0G1WTEST');
  assert.equal(gp.rules.length, 2);
  assert.deepEqual(gp.rules[0].steps, [{ id: '1', type: 'TIME' }, { id: '2', type: 'CONVERT' }]);
  assert.match(gp.rules[1].code, /RECORDMODE = ' '/);
  assert.deepEqual(gp.aggregationNotes, ['aggregation MOVE']);
  assert.ok(gp.recordModeLines.some((l) => l.includes("RECORDMODE = ' '")));
  assert.ok(gp.methods.some((m) => m.name === 'compute_10_1'));
});

test('expert-routine template header (different label padding) is parsed', () => {
  const gp = parseGeneratedProgram([
    '* Template           RSTRAN_MASTER_TMPL_EXPERT',
    '*   TranID     ...: 094YTEST   Version: 0',
    '*   Source........: ADSO /JBPB/IDMCT',
  ].join('\n'));
  assert.equal(gp.header.Template, 'RSTRAN_MASTER_TMPL_EXPERT');
  assert.equal(gp.header.TranID, '094YTEST');
  assert.equal(gp.header.Source, 'ADSO /JBPB/IDMCT');
});

test('routine copy in the GP and the editable class compare equal after normalisation', () => {
  const editable = 'METHOD S0001_G01_R10.\n\n  DATA: MONITOR_REC     TYPE rsmonitor.\n    RESULT = SOURCE_FIELDS-LOGSYS. "copy\nENDMETHOD.';
  const activated = extractMethod(GP, 'compute_10_1');
  assert.ok(activated);
  assert.equal(normalizeAbap(editable), normalizeAbap(activated));
  assert.notEqual(normalizeAbap(editable), normalizeAbap(activated.replace('LOGSYS', 'OTHER')));
  assert.equal(extractMethod(GP, 'nope'), null);
  assert.deepEqual(listMethods('CLASS x DEFINITION.\n METHODS a.\nENDCLASS.\nMETHOD a.\nENDMETHOD.').map((m) => m.name), ['a']);
});

const DTP_XML = `<dtpa:dataTransferProcess name="DTP_X" xmlns:dtpa="d"><extractionSettings extractionMode="D" packageSize="24000"/><overview><object name="0P07TEST" description="x" tlogo="TRFN"/></overview><source type="DTASRC" name="0CRM_FM_FPO                   CRPODP100" description="CRM FM Funds Posting" tlogo="RSDS"><dataSource dataSource="0CRM_FM_FPO" type="D"><sourceSystem name="CRPODP100" tlogo="LSYS"/><adapter name="ODP" category="E"/></dataSource></source><target type="ADSO" name="ZD_CRMFP" description="Fund Posting DSO" tlogo="ADSO"/><usageInProcessChains><processChain name="ZPC_TPM_FPO" description="Fund Posting Dataload" tlogo="RSPC"/></usageInProcessChains></dtpa:dataTransferProcess>`;

test('DTP XML yields source, target, transformation, mode and chains', () => {
  const d = parseDtpXml('DTP_X', 'active', DTP_XML);
  assert.equal(d.sourceTlogo, 'RSDS');
  assert.equal(d.sourceName, '0CRM_FM_FPO');
  assert.equal(d.sourceSystem, 'CRPODP100');
  assert.equal(d.adapter, 'ODP');
  assert.equal(d.targetName, 'ZD_CRMFP');
  assert.equal(d.transformation, '0P07TEST');
  assert.equal(d.extractionMode, 'D');
  assert.deepEqual(d.processChains, ['ZPC_TPM_FPO']);
});

test('data preview XML becomes rows; only allow-listed tables can be read', async () => {
  const xml = '<dataPreview:tableData xmlns:dataPreview="p"><dataPreview:columns><dataPreview:metadata dataPreview:name="PROCESS_TYPE"/><dataPreview:dataSet><dataPreview:data>DTP_LOAD</dataPreview:data><dataPreview:data>PLAN</dataPreview:data></dataPreview:dataSet></dataPreview:columns><dataPreview:columns><dataPreview:metadata dataPreview:name="CNT"/><dataPreview:dataSet><dataPreview:data>3 </dataPreview:data><dataPreview:data/></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>';
  assert.deepEqual(parseDataPreview(xml), [{ PROCESS_TYPE: 'DTP_LOAD', CNT: '3' }, { PROCESS_TYPE: 'PLAN', CNT: '' }]);
  await assert.rejects(adtSelect(null, 'SELECT * FROM usr02'), /only RSPMPROCESS, RSPMREQUEST/);
  await assert.rejects(adtSelect(null, 'DELETE FROM rspmprocess'), /single SELECT/);
  await assert.rejects(adtSelect(null, 'SELECT * FROM rspmprocess; SELECT * FROM usr02'), /single SELECT/);
});

// ── Loader classification ────────────────────────────────────────────────────

const allChecksOk = { definition: 'ok', xref: 'ok', planning: 'ok', writeApiWhereUsed: 'ok', processChainAbap: 'ok', runtimeHistory: 'ok' };
const baseFacts = (over = {}) => ({
  adso: 'ZD_CRMFP',
  parsed: { type: 'standard', flags: { planningMode: false, directUpdate: false, pushMode: false } },
  xref: [],
  trfns: [],
  dtps: [],
  sourceSystemTypes: { CRPODP100: 'O', ZFILE: 'F' },
  planning: { aggregationLevels: [], functions: [], sequences: [], queries: [] },
  apiCallers: [],
  chainAbap: [],
  runtime: [],
  checks: { ...allChecksOk },
  readErrors: [],
  notes: [],
  ...over,
});
const trfn = (over = {}) => ({ name: 'T1', status: 'active', sourceType: 'RSDS', sourceName: '0CRM_FM_FPO', sourceSystem: 'CRPODP100', targetType: 'ADSO', targetName: 'ZD_CRMFP', hanaRuntime: 'false', routineTypes: [], ...over });
const dtp = (over = {}) => ({ name: 'DTP_1', status: 'active', sourceTlogo: 'RSDS', sourceName: '0CRM_FM_FPO', targetTlogo: 'ADSO', targetName: 'ZD_CRMFP', transformation: 'T1', extractionMode: 'D', processChains: ['ZPC_TPM_FPO'], foundVia: 'xref', ...over });
const planningAdso = { type: 'direct_update', flags: { planningMode: true, directUpdate: true, pushMode: false } };

test('FPO-shaped aDSO: ODP transformation + DTP confirmed at runtime, all channels ok → EXPLAINED', () => {
  const c = classifyLoaders(baseFacts({
    trfns: [trfn(), trfn({ name: 'T2', sourceType: 'ADSO', sourceName: 'ZD_CRMFP', targetName: 'ZC_CRM12' })],
    dtps: [dtp()],
    runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_1', count: 1 }, { processType: 'MOV_REQ', processId: 'ADSO_ZD_CRMFP', count: 1 }],
  }));
  assert.equal(c.status, 'EXPLAINED');
  assert.deepEqual(c.mechanisms, ['TRANSFORMATION_DTP']);
  assert.equal(c.loaders.length, 1); // the outbound transformation T2 is not a loader
  assert.equal(c.loaders[0].evidence, 'metadata+runtime');
  assert.equal(c.loaders[0].details.sourceKind, 'ODP');
  assert.deepEqual(c.dataModifications.map((m) => m.processType), ['MOV_REQ']);
  assert.ok(c.systemWideBlindSpots.length >= 4); // EXPLAINED never comes without its blind spots
});

test('a failed or skipped evidence channel prevents EXPLAINED', () => {
  const ok = { trfns: [trfn()], dtps: [dtp()], runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_1', count: 1 }] };
  const failed = classifyLoaders(baseFacts({ ...ok, checks: { ...allChecksOk, writeApiWhereUsed: 'failed' } }));
  assert.equal(failed.status, 'PARTIAL');
  assert.ok(failed.unresolved.some((u) => /channel failed: write-API where-used/.test(u)));
  const skipped = classifyLoaders(baseFacts({ ...ok, chainAbap: null, checks: { ...allChecksOk, processChainAbap: 'skipped' } }));
  assert.equal(skipped.status, 'PARTIAL');
  assert.ok(skipped.unresolved.some((u) => /not checked: process-chain ABAP steps/.test(u)));
});

test('file DataSource source is reported as FILE_UPLOAD', () => {
  const c = classifyLoaders(baseFacts({ trfns: [trfn({ sourceSystem: 'ZFILE' })], dtps: [dtp()] }));
  assert.deepEqual(c.mechanisms, ['FILE_UPLOAD']);
});

test('several loaders on one aDSO are all reported', () => {
  const c = classifyLoaders(baseFacts({
    parsed: { type: 'standard', flags: { planningMode: true, directUpdate: false, pushMode: false } },
    trfns: [trfn()], dtps: [dtp()],
    planning: { aggregationLevels: [{ name: 'ZAL1', via: 'ADSO' }], functions: [{ alvl: 'ZAL1', name: 'ZPF1', type: '0RSPL_COPY' }], sequences: [], queries: [] },
    runtime: [{ processType: 'PLAN', processId: 'ADSOZD_CRMFP', count: 2 }, { processType: 'DTP_LOAD', processId: 'DTP_1', count: 1 }],
  }));
  assert.deepEqual(c.mechanisms.sort(), ['PLANNING', 'TRANSFORMATION_DTP']);
  assert.equal(c.loaders.find((l) => l.mechanism === 'PLANNING').evidence, 'metadata+runtime');
});

test('one identified writer never makes a direct-update aDSO EXPLAINED', () => {
  const c = classifyLoaders(baseFacts({
    adso: '/JBPB/IPLAN',
    parsed: planningAdso,
    planning: { aggregationLevels: [{ name: '/JBPB/APLN_M', via: 'ADSO' }], functions: [], sequences: [], queries: [] },
    runtime: [{ processType: 'PLAN', processId: 'ADSO/JBPB/IPLAN', count: 1 }],
  }));
  assert.equal(c.status, 'PARTIAL');
  assert.ok(c.unresolved.some((u) => /PLANNING identified as writer\(s\), but other callers .* cannot be excluded/.test(u)));
});

test('direct-update aDSO without an identified writer is PARTIAL and says why', () => {
  const c = classifyLoaders(baseFacts({ adso: 'ZAATM02', parsed: { type: 'direct_update', flags: { planningMode: false, directUpdate: true, pushMode: false } } }));
  assert.equal(c.status, 'PARTIAL');
  assert.deepEqual(c.mechanisms, ['DIRECT_UPDATE_API']);
  assert.ok(c.unresolved.some((u) => /no identified writer/.test(u)));
});

test('planning through a CompositeProvider and file upload by planning function are reported', () => {
  const c = classifyLoaders(baseFacts({
    adso: 'ZBASEVOL',
    parsed: { type: 'standard', flags: { planningMode: true, directUpdate: false, pushMode: false } },
    planning: {
      aggregationLevels: [{ name: 'ZVOL001', via: 'HCPR', provider: 'ZVOL0001' }],
      functions: [{ alvl: 'ZVOL001', name: 'ZPF_AO_UPLOAD', type: '0RSPL_FILE_UPLOAD_AO' }],
      sequences: [{ fn: 'ZPF_AO_UPLOAD', name: 'ZPS_AO_FILE_UPLOAD' }],
      queries: [{ alvl: 'ZVOL001', name: 'ZVOL_Q001' }],
    },
    runtime: [{ processType: 'PLAN', processId: 'ADSOZBASEVOL', count: 1 }],
  }));
  assert.deepEqual(c.mechanisms.sort(), ['FILE_UPLOAD', 'PLANNING']);
  const upload = c.loaders.find((l) => l.mechanism === 'FILE_UPLOAD');
  assert.equal(upload.details.via, 'planning function');
  assert.deepEqual(upload.details.sequences, ['ZPS_AO_FILE_UPLOAD']);
  assert.ok(c.residualRisks.some((r) => /manual entry/.test(r)));
});

test('planning at runtime without planning metadata is an open item', () => {
  const c = classifyLoaders(baseFacts({ parsed: planningAdso, runtime: [{ processType: 'PLAN', processId: 'ADSOX', count: 3 }] }));
  assert.ok(c.unresolved.some((u) => /no aggregation level was found/.test(u)));
});

test('a chain report that does not name the aDSO is listed as a residual risk', () => {
  const c = classifyLoaders(baseFacts({
    trfns: [trfn()], dtps: [dtp()], runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_1', count: 1 }],
    chainAbap: [{ chain: '/JBPB/LOAD_LOG_DATA', variant: 'V1', program: '/JBPB/R_UPDATE_LOGGING_ADSO', mentionsAdso: false }],
  }));
  assert.equal(c.status, 'EXPLAINED');
  assert.ok(c.residualRisks.some((r) => /R_UPDATE_LOGGING_ADSO.*does not name/.test(r)));
});

test('no loader anywhere is UNRESOLVED; runtime DTPs missing from metadata are surfaced', () => {
  assert.equal(classifyLoaders(baseFacts({ adso: 'ZAATM24' })).status, 'UNRESOLVED');
  const c = classifyLoaders(baseFacts({ runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_GONE', count: 4 }] }));
  assert.deepEqual(c.mechanisms, ['RUNTIME_ONLY']);
  assert.ok(c.unresolved.some((u) => /DTP_GONE/.test(u)));
  const gone = classifyLoaders(baseFacts({ runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_GONE', count: 4 }], deletedDtps: ['DTP_GONE'] }));
  assert.ok(gone.unresolved.some((u) => /no longer exists/.test(u)));
});

test('a DTP found only through runtime history is a loader, with the xref gap flagged', () => {
  const c = classifyLoaders(baseFacts({
    trfns: [trfn()], dtps: [dtp({ foundVia: 'runtime' })],
    runtime: [{ processType: 'DTP_LOAD', processId: 'DTP_1', count: 2 }],
  }));
  assert.deepEqual(c.mechanisms, ['TRANSFORMATION_DTP']);
  assert.equal(c.loaders[0].evidence, 'metadata+runtime');
  assert.ok(c.unresolved.some((u) => /xref did not return it/.test(u)));
});

test('an aDSO whose definition and where-used both failed is NOT_ASSESSED, never UNRESOLVED', () => {
  const c = classifyLoaders(baseFacts({
    adso: 'ZAATM02', parsed: undefined,
    checks: { ...allChecksOk, definition: 'failed', xref: 'failed' },
    readErrors: ['aDSO ZAATM02: getaddrinfo ENOTFOUND bw.host'],
  }));
  assert.equal(c.status, 'NOT_ASSESSED');
});

test('planning function type is read from planningServiceType', () => {
  assert.equal(parsePlanningFunctionType('<bwPlanningService:planningService name="ZPF_AO_UPLOAD" planningServiceType="0RSPL_FILE_UPLOAD_AO.plst#//" alvl="ZAL_SALES.composite#//">'), '0RSPL_FILE_UPLOAD_AO');
  assert.equal(parsePlanningFunctionType('<x/>'), undefined);
});

