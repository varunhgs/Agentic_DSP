import { BwClient, MEDIA_TYPES, freshRead } from '../bw-client.js';
import { parseAdsoXml, readAdsoXml, ParsedAdso } from './adso.js';
import { parseTransformationXml } from './trfn_logic.js';
import { bwXrefEntries, bwSearchEntries, SearchEntry } from './search.js';
import { bwGetSourceSystem } from './datasource.js';
import { bwGetProcessChain } from './processchain.js';
import { bwGetProcessVariant } from './processvariant.js';
import { readAbapSource } from './abap_source.js';
import { adtSelect } from './adt-sql.js';
import { assertBwTechnicalName, encodeBwObjectName } from './bw-names.js';

/**
 * Loader census — every mechanism that can write data into an aDSO.
 *
 * Evidence channels (all verified on BW/4HANA 2.0 SP17):
 *   definition   aDSO XML flags: directUpdate, planningMode, pushMode (write interface)
 *   xref         where-used of the aDSO: TRFN and DTPA (both directions — direction is
 *                read from the transformation XML), ALVL, HCPR
 *   planning     ALVL on the aDSO, or on a CompositeProvider that contains it,
 *                -> planning functions (+ their type) and queries -> planning sequences
 *   write APIs   ADT where-used of RSDSO_(DU_)WRITE_API(_RFC), callers' source scanned
 *                for the aDSO name
 *   chains       ABAP steps of every process chain, report source scanned for the name
 *   runtime      RSPMPROCESS (ADT data preview): DTP_LOAD, PLAN, SELDEL, DEL_REQ, ...
 *
 * Status semantics — deliberately strict:
 *   EXPLAINED   at least one loader; every channel was checked successfully; every load
 *               recorded at runtime is explained by a loader found in metadata; no open
 *               item; and the aDSO has no write path whose callers cannot be enumerated
 *               (direct update, write interface). Residual blind spots are still listed:
 *               EXPLAINED is not proof that no other writer exists.
 *   PARTIAL     loaders found, but at least one open item, failed or skipped channel,
 *               unexplained runtime activity, or a non-enumerable write path.
 *   UNRESOLVED  every channel that could run found no loader.
 *   NOT_ASSESSED  neither the aDSO definition nor its where-used could be read (e.g. the
 *               system was unreachable) — nothing is known; never read as "no loader".
 */

export type LoaderMechanism =
  | 'TRANSFORMATION_DTP'
  | 'FILE_UPLOAD'
  | 'PLANNING'
  | 'DIRECT_UPDATE_API'
  | 'WRITE_INTERFACE'
  | 'ABAP_PROGRAM'
  | 'RUNTIME_ONLY';

export type CheckResult = 'ok' | 'failed' | 'skipped';
export type EvidenceCheck = 'definition' | 'xref' | 'planning' | 'writeApiWhereUsed' | 'processChainAbap' | 'runtimeHistory';

export interface Loader {
  mechanism: LoaderMechanism;
  object: string;
  evidence: 'metadata' | 'runtime' | 'metadata+runtime';
  details: Record<string, unknown>;
}

export interface TrfnHeader {
  name: string;
  status: string;
  sourceType: string;
  sourceName: string;
  sourceSystem?: string;
  targetType: string;
  targetName: string;
  hanaRuntime?: string;
  routineTypes: string[];
}

export interface DtpHeader {
  name: string;
  status: string;
  sourceTlogo: string;
  sourceName: string;
  sourceSystem?: string;
  adapter?: string;
  targetTlogo: string;
  targetName: string;
  transformation?: string;
  extractionMode?: string;
  processChains: string[];
  /** 'runtime' when the DTP was not returned by xref but found through the request history. */
  foundVia?: 'xref' | 'runtime';
}

export interface RuntimeRow { processType: string; processId: string; count: number }

export interface PlanningFacts {
  aggregationLevels: Array<{ name: string; via: 'ADSO' | 'HCPR'; provider?: string }>;
  functions: Array<{ alvl: string; name: string; type?: string }>;
  sequences: Array<{ fn: string; name: string }>;
  queries: Array<{ alvl: string; name: string }>;
}

export interface LoaderFacts {
  adso: string;
  parsed?: ParsedAdso;
  xref: SearchEntry[];
  trfns: TrfnHeader[];
  dtps: DtpHeader[];
  sourceSystemTypes: Record<string, string>;
  planning: PlanningFacts;
  apiCallers: Array<{ api: string; caller: string; mentionsAdso: boolean | null }>;
  chainAbap: Array<{ chain: string; variant: string; program?: string; mentionsAdso: boolean | null }> | null;
  runtime: RuntimeRow[] | null;
  /** Runtime DTP ids that no longer exist in the repository (HTTP 404). */
  deletedDtps?: string[];
  checks: Record<EvidenceCheck, CheckResult>;
  readErrors: string[];
  notes: string[];
}

export interface LoaderCensus {
  adso: string;
  type?: string;
  flags?: Record<string, boolean>;
  status: 'EXPLAINED' | 'PARTIAL' | 'UNRESOLVED' | 'NOT_ASSESSED';
  mechanisms: LoaderMechanism[];
  loaders: Loader[];
  evidenceChecks: Record<EvidenceCheck, CheckResult>;
  dataModifications: Array<{ processType: string; count: number; meaning: string }>;
  unresolved: string[];
  residualRisks: string[];
  systemWideBlindSpots: string[];
  readErrors: string[];
  notes: string[];
}

const WRITE_APIS = ['RSDSO_DU_WRITE_API', 'RSDSO_DU_WRITE_API_RFC', 'RSDSO_WRITE_API', 'RSDSO_WRITE_API_RFC'];

/** Blind spots that apply to every aDSO, whatever the census found. */
export const SYSTEM_WIDE_BLIND_SPOTS = [
  'Remote systems can write through the RFC-enabled write APIs (RSDSO_WRITE_API_RFC, RSDSO_DU_WRITE_API_RFC); such callers are not visible in BW metadata, and whether every such write appears in the request history has not been verified.',
  'ABAP code that chooses its target aDSO at runtime (names built dynamically, configuration tables, classes) is not followed; only literal aDSO names in report main sources are matched.',
  'Write-API callers come from the ADT where-used index; whether that index is complete on this system has not been verified.',
  'The request history (RSPMPROCESS) can be reduced by housekeeping; older loads may no longer be visible. Not checked.',
];

const MODIFICATION_MEANING: Record<string, string> = {
  SELDEL: 'selective deletion — active data no longer equals the sum of loads',
  DEL_REQ: 'request deletion',
  MOV_REQ: 'request moved (e.g. between storage areas)',
  ADSO_ACT: 'activation',
};

const CHECK_LABEL: Record<EvidenceCheck, string> = {
  definition: 'aDSO definition',
  xref: 'where-used (xref)',
  planning: 'planning objects',
  writeApiWhereUsed: 'write-API where-used',
  processChainAbap: 'process-chain ABAP steps',
  runtimeHistory: 'request history (RSPMPROCESS)',
};

// ── Pure classification ──────────────────────────────────────────────────────

export function classifyLoaders(f: LoaderFacts): LoaderCensus {
  const adso = f.adso.toUpperCase();
  const loaders: Loader[] = [];
  const unresolved: string[] = [];
  const residualRisks: string[] = [];
  const flags = f.parsed?.flags;

  const runtime = f.runtime ?? [];
  const runtimeDtpIds = new Set(runtime.filter((r) => r.processType === 'DTP_LOAD').map((r) => r.processId.toUpperCase()));
  const runtimePlan = runtime.filter((r) => r.processType === 'PLAN');

  // 1. Transformations into this aDSO, joined with the DTPs that execute them.
  const inbound = f.trfns.filter((t) => t.targetName.toUpperCase() === adso);
  const dtpsIn = f.dtps.filter((d) => d.targetName.toUpperCase() === adso);
  const usedDtps = new Set<string>();
  for (const t of inbound) {
    const dtps = dtpsIn.filter((d) => d.transformation?.toUpperCase() === t.name.toUpperCase());
    dtps.forEach((d) => usedDtps.add(d.name));
    const sourceKind = sourceKindOf(t.sourceType, t.sourceSystem, f.sourceSystemTypes);
    const ranAtRuntime = dtps.some((d) => runtimeDtpIds.has(d.name.toUpperCase()));
    loaders.push({
      mechanism: sourceKind === 'FILE' ? 'FILE_UPLOAD' : 'TRANSFORMATION_DTP',
      object: t.name,
      evidence: ranAtRuntime ? 'metadata+runtime' : 'metadata',
      details: {
        source: `${t.sourceType} ${t.sourceName}${t.sourceSystem ? ` / ${t.sourceSystem}` : ''}`,
        sourceKind,
        transformationStatus: t.status,
        hanaRuntime: t.hanaRuntime,
        routines: t.routineTypes,
        selfLoop: t.sourceName.toUpperCase() === adso || undefined,
        dtps: dtps.map((d) => ({ name: d.name, status: d.status, mode: d.extractionMode, chains: d.processChains, foundVia: d.foundVia })),
      },
    });
    if (dtps.length === 0) unresolved.push(`Transformation ${t.name} has no DTP into ${adso} — defined but not executable as a load path.`);
    if (t.status !== 'active' && t.status !== 'unknown') unresolved.push(`Transformation ${t.name} is ${t.status} — its active logic may differ from the model.`);
  }
  for (const d of dtpsIn.filter((x) => !usedDtps.has(x.name))) {
    loaders.push({
      mechanism: 'TRANSFORMATION_DTP',
      object: d.name,
      evidence: runtimeDtpIds.has(d.name.toUpperCase()) ? 'metadata+runtime' : 'metadata',
      details: { source: `${d.sourceTlogo} ${d.sourceName}`, transformation: d.transformation, note: 'DTP whose transformation was not readable' },
    });
    unresolved.push(`DTP ${d.name} targets ${adso} but its transformation ${d.transformation ?? '(unknown)'} was not readable.`);
  }

  // 2. Planning: aggregation levels on the aDSO or on a CompositeProvider containing it.
  const planningMeta = f.planning.aggregationLevels.length > 0;
  if (flags?.planningMode || planningMeta || runtimePlan.length) {
    loaders.push({
      mechanism: 'PLANNING',
      object: f.planning.aggregationLevels.map((a) => a.name).join(', ') || '(no aggregation level found)',
      evidence: planningMeta && runtimePlan.length ? 'metadata+runtime' : planningMeta ? 'metadata' : 'runtime',
      details: {
        planningEnabled: flags?.planningMode ?? null,
        aggregationLevels: f.planning.aggregationLevels,
        planningFunctions: f.planning.functions,
        planningSequences: f.planning.sequences,
        queriesOnAggregationLevels: f.planning.queries,
        runtimePlanProcesses: runtimePlan.reduce((n, r) => n + r.count, 0),
      },
    });
    if (f.planning.queries.length) {
      residualRisks.push(`${f.planning.queries.length} query/queries are defined on its aggregation levels; input-ready ones allow manual entry, which is not distinguishable from metadata alone.`);
    }
    if (runtimePlan.length && !planningMeta) {
      unresolved.push(`Planning wrote to ${adso} (${runtimePlan.reduce((n, r) => n + r.count, 0)} PLAN processes) but no aggregation level was found on it or on a CompositeProvider containing it.`);
    }
    if (planningMeta && flags && !flags.planningMode) {
      unresolved.push('Aggregation levels reach this aDSO but its planning mode is off — confirm whether planning can write here.');
    }
  }
  for (const fn of f.planning.functions.filter((x) => /FILE_UPLOAD/i.test(x.type ?? ''))) {
    loaders.push({
      mechanism: 'FILE_UPLOAD',
      object: fn.name,
      evidence: 'metadata',
      details: { via: 'planning function', functionType: fn.type, aggregationLevel: fn.alvl, sequences: f.planning.sequences.filter((s) => s.fn === fn.name).map((s) => s.name) },
    });
  }

  // 3. ABAP programs naming this aDSO: write-API callers and process-chain reports.
  for (const c of f.apiCallers.filter((x) => x.mentionsAdso)) {
    loaders.push({ mechanism: 'ABAP_PROGRAM', object: c.caller, evidence: 'metadata', details: { via: c.api } });
  }
  for (const s of (f.chainAbap ?? []).filter((x) => x.mentionsAdso)) {
    loaders.push({ mechanism: 'ABAP_PROGRAM', object: s.program ?? s.variant, evidence: 'metadata', details: { processChain: s.chain, variant: s.variant } });
  }
  for (const s of (f.chainAbap ?? []).filter((x) => x.mentionsAdso === false)) {
    residualRisks.push(`Process-chain report ${s.program ?? s.variant} (chain ${s.chain}) does not name ${adso} in its source; if it chooses its targets at runtime it could write here.`);
  }
  for (const c of f.apiCallers.filter((x) => x.mentionsAdso === false)) {
    residualRisks.push(`${c.caller} calls ${c.api} without naming ${adso} literally; it could write here if the name is computed.`);
  }

  // 4. Write paths whose callers cannot be enumerated from BW.
  if (flags?.directUpdate) {
    const identified = loaders.filter((l) => l.mechanism === 'ABAP_PROGRAM' || l.mechanism === 'PLANNING').map((l) => l.mechanism);
    loaders.push({
      mechanism: 'DIRECT_UPDATE_API',
      object: adso,
      evidence: 'metadata',
      details: { apis: ['RSDSO_DU_WRITE_API', 'RSDSO_DU_WRITE_API_RFC'], writersIdentified: [...new Set(identified)] },
    });
    unresolved.push(identified.length
      ? `Direct-update aDSO: ${[...new Set(identified)].join(' and ')} identified as writer(s), but other callers of the direct-update API (incl. remote RFC) cannot be excluded from BW metadata.`
      : 'Direct-update aDSO with no identified writer: no in-system caller of the direct-update API names it. The writer may be a remote system (RSDSO_DU_WRITE_API_RFC), an application, or manual — confirm with the system owner or RFC statistics.');
  }
  if (flags?.pushMode) {
    loaders.push({ mechanism: 'WRITE_INTERFACE', object: adso, evidence: 'metadata', details: { api: 'BW/4HANA push (write interface) — external caller' } });
    unresolved.push('Write interface enabled: external push callers cannot be identified from BW metadata.');
  }

  // 5. Runtime activity not explained by metadata.
  const knownDtps = new Set(f.dtps.map((d) => d.name.toUpperCase()));
  const deleted = new Set((f.deletedDtps ?? []).map((d) => d.toUpperCase()));
  for (const r of runtime.filter((x) => x.processType === 'DTP_LOAD' && !knownDtps.has(x.processId.toUpperCase()))) {
    const gone = deleted.has(r.processId.toUpperCase());
    loaders.push({ mechanism: 'RUNTIME_ONLY', object: r.processId, evidence: 'runtime', details: { processType: r.processType, runs: r.count, dtpExists: gone ? false : null } });
    unresolved.push(gone
      ? `DTP ${r.processId} loaded ${adso} (${r.count}x) and no longer exists — data in ${adso} may come from logic that is gone.`
      : `DTP ${r.processId} loaded ${adso} (${r.count}x) but could not be read.`);
  }
  for (const d of dtpsIn.filter((x) => x.foundVia === 'runtime')) {
    unresolved.push(`DTP ${d.name} was found only through the request history — xref did not return it.`);
  }
  const knownTypes = new Set(['DTP_LOAD', 'PLAN', ...Object.keys(MODIFICATION_MEANING)]);
  for (const r of runtime.filter((x) => !knownTypes.has(x.processType))) {
    loaders.push({ mechanism: 'RUNTIME_ONLY', object: r.processId, evidence: 'runtime', details: { processType: r.processType, runs: r.count } });
    unresolved.push(`Unclassified runtime process type ${r.processType} on ${adso}.`);
  }
  if (f.runtime && loaders.some((l) => l.mechanism !== 'RUNTIME_ONLY') && !runtime.some((r) => r.processType === 'DTP_LOAD' || r.processType === 'PLAN')) {
    residualRisks.push('No load is recorded in the request history although loaders exist — never loaded, loaded only by a path that leaves no request, or history removed.');
  }

  const dataModifications = Object.entries(
    runtime.filter((r) => MODIFICATION_MEANING[r.processType])
      .reduce<Record<string, number>>((m, r) => ({ ...m, [r.processType]: (m[r.processType] ?? 0) + r.count }), {}),
  ).map(([processType, count]) => ({ processType, count, meaning: MODIFICATION_MEANING[processType] }));

  // 6. Channels that failed or were skipped are open items, never silent.
  for (const [check, result] of Object.entries(f.checks) as Array<[EvidenceCheck, CheckResult]>) {
    if (result === 'failed') unresolved.push(`Evidence channel failed: ${CHECK_LABEL[check]} — loaders it would show may be missing.`);
    if (result === 'skipped') unresolved.push(`Evidence channel not checked: ${CHECK_LABEL[check]}.`);
  }
  for (const c of f.apiCallers.filter((x) => x.mentionsAdso === null)) {
    unresolved.push(`${c.caller} calls ${c.api} but its source could not be read — it may write to ${adso}.`);
  }
  for (const s of (f.chainAbap ?? []).filter((x) => x.mentionsAdso === null)) {
    unresolved.push(`Chain ${s.chain} runs ABAP variant ${s.variant}${s.program ? ` (${s.program})` : ''} whose source could not be read.`);
  }
  if (loaders.length === 0) {
    unresolved.push(f.runtime && f.runtime.length === 0
      ? 'No loader in metadata and no load in the request history — never loaded, or written by a mechanism that leaves no request.'
      : 'No loader identified.');
  }

  const mechanisms = [...new Set(loaders.map((l) => l.mechanism))];
  // Neither the definition nor the where-used could be read: nothing was assessed, which
  // must not be confused with "assessed and nothing found".
  const notAssessed = f.checks.definition === 'failed' && f.checks.xref === 'failed';
  const status: LoaderCensus['status'] = notAssessed
    ? 'NOT_ASSESSED'
    : loaders.length === 0
      ? 'UNRESOLVED'
      : unresolved.length || f.readErrors.length ? 'PARTIAL' : 'EXPLAINED';

  return {
    adso,
    type: f.parsed?.type,
    flags,
    status,
    mechanisms,
    loaders,
    evidenceChecks: f.checks,
    dataModifications,
    unresolved,
    residualRisks,
    systemWideBlindSpots: SYSTEM_WIDE_BLIND_SPOTS,
    readErrors: f.readErrors,
    notes: f.notes,
  };
}

function sourceKindOf(tlogo: string, sourceSystem: string | undefined, types: Record<string, string>): string {
  switch (tlogo.toUpperCase()) {
    case 'RSDS': {
      const t = sourceSystem ? types[sourceSystem.toUpperCase()] : undefined;
      if (t === 'F' || t === 'FILE') return 'FILE';
      if (t === 'O' || t?.startsWith('ODP')) return 'ODP';
      return t ? `DATASOURCE_${t}` : 'DATASOURCE';
    }
    case 'ADSO': return 'ADSO';
    case 'TRCS': return 'INFOSOURCE';
    case 'IOBJ': return 'INFOOBJECT';
    default: return tlogo.toUpperCase();
  }
}

// ── Fact collection (I/O) ────────────────────────────────────────────────────

/** Shared caches for one census run, so 261 aDSOs do not re-read the same objects. */
export class CensusContext {
  trfns = new Map<string, TrfnHeader | Error>();
  dtps = new Map<string, DtpHeader | Error>();
  xref = new Map<string, SearchEntry[] | Error>();
  plseTypes = new Map<string, string | Error>();
  sourceSystemTypes: Record<string, string> = {};
  apiCallers?: Array<{ api: string; caller: string; source: string | null }>;
  apiScanFailed = false;
  chainAbap?: Array<{ chain: string; variant: string; program?: string; source: string | null }>;
  chainScanFailed = false;
  runtime?: Map<string, RuntimeRow[]> | null;
  runtimeError?: string;
  notes: string[] = [];
}

export interface LoaderOptions {
  includeRuntime?: boolean;
  scanProcessChains?: boolean;
  scanWriteApis?: boolean;
}

export async function collectLoaderFacts(
  client: BwClient,
  adsoName: string,
  ctx: CensusContext,
  opts: LoaderOptions = {},
): Promise<LoaderFacts> {
  const adso = assertBwTechnicalName(adsoName);
  const readErrors: string[] = [];
  const facts: LoaderFacts = {
    adso,
    xref: [],
    trfns: [],
    dtps: [],
    sourceSystemTypes: ctx.sourceSystemTypes,
    planning: { aggregationLevels: [], functions: [], sequences: [], queries: [] },
    apiCallers: [],
    chainAbap: null,
    runtime: null,
    checks: { definition: 'ok', xref: 'ok', planning: 'ok', writeApiWhereUsed: 'skipped', processChainAbap: 'skipped', runtimeHistory: 'skipped' },
    readErrors,
    notes: [],
  };

  try {
    facts.parsed = parseAdsoXml((await readAdsoXml(adso, 'active')).body);
  } catch {
    try {
      facts.parsed = parseAdsoXml((await readAdsoXml(adso, 'inactive')).body);
      facts.notes.push('Active aDSO version not readable — flags taken from the inactive version.');
    } catch (err) {
      facts.checks.definition = 'failed';
      readErrors.push(`aDSO ${adso}: ${firstLine(err)}`);
    }
  }

  const xref = await cachedXref(client, ctx, 'ADSO', adso);
  if (xref instanceof Error) {
    facts.checks.xref = 'failed';
    readErrors.push(`xref ${adso}: ${firstLine(xref)}`);
  } else {
    facts.xref = xref;
  }

  for (const e of facts.xref.filter((x) => x.objectType === 'TRFN')) {
    const t = await cached(ctx.trfns, e.objectName, () => readTrfnHeader(e.objectName, e.objectStatus));
    if (t instanceof Error) readErrors.push(`transformation ${e.objectName}: ${firstLine(t)}`);
    else facts.trfns.push(t);
  }
  for (const e of facts.xref.filter((x) => x.objectType === 'DTPA')) {
    const d = await cached(ctx.dtps, e.objectName, () => readDtpHeader(e.objectName, e.objectStatus));
    if (d instanceof Error) readErrors.push(`DTP ${e.objectName}: ${firstLine(d)}`);
    else facts.dtps.push({ ...d, foundVia: 'xref' });
  }
  await resolveSourceSystemTypes(client, ctx, facts);

  // Planning: ALVL directly on the aDSO, and — for planning-enabled aDSOs — ALVL on a
  // CompositeProvider that contains it (planning writes through the provider).
  const alvls: PlanningFacts['aggregationLevels'] = facts.xref
    .filter((x) => x.objectType === 'ALVL')
    .map((x) => ({ name: x.objectName, via: 'ADSO' as const }));
  if (facts.parsed?.flags.planningMode) {
    for (const hcpr of facts.xref.filter((x) => x.objectType === 'HCPR')) {
      const up = await cachedXref(client, ctx, 'HCPR', hcpr.objectName);
      if (up instanceof Error) {
        facts.checks.planning = 'failed';
        readErrors.push(`xref HCPR ${hcpr.objectName}: ${firstLine(up)}`);
        continue;
      }
      for (const a of up.filter((x) => x.objectType === 'ALVL')) {
        if (!alvls.some((x) => x.name === a.objectName)) alvls.push({ name: a.objectName, via: 'HCPR', provider: hcpr.objectName });
      }
    }
  }
  facts.planning.aggregationLevels = alvls;
  for (const alvl of alvls) {
    const users = await cachedXref(client, ctx, 'ALVL', alvl.name);
    if (users instanceof Error) {
      facts.checks.planning = 'failed';
      readErrors.push(`xref ALVL ${alvl.name}: ${firstLine(users)}`);
      continue;
    }
    for (const q of users.filter((x) => x.objectType === 'ELEM' && /\/query\//i.test(x.href))) {
      facts.planning.queries.push({ alvl: alvl.name, name: q.objectName });
    }
    for (const fn of users.filter((x) => x.objectType === 'PLSE')) {
      const type = await cached(ctx.plseTypes, fn.objectName, () => readPlanningFunctionType(fn.objectName));
      if (type instanceof Error) readErrors.push(`planning function ${fn.objectName}: ${firstLine(type)}`);
      facts.planning.functions.push({ alvl: alvl.name, name: fn.objectName, type: type instanceof Error ? undefined : type });
      const seqs = await cachedXref(client, ctx, 'PLSE', fn.objectName);
      if (seqs instanceof Error) {
        facts.checks.planning = 'failed';
        readErrors.push(`xref PLSE ${fn.objectName}: ${firstLine(seqs)}`);
        continue;
      }
      for (const sq of seqs.filter((x) => x.objectType === 'PLSQ')) facts.planning.sequences.push({ fn: fn.objectName, name: sq.objectName });
    }
  }

  if (opts.scanWriteApis ?? true) {
    ctx.apiCallers ??= await scanWriteApiCallers(client, ctx);
    facts.checks.writeApiWhereUsed = ctx.apiScanFailed ? 'failed' : 'ok';
    facts.apiCallers = ctx.apiCallers.map((c) => ({ api: c.api, caller: c.caller, mentionsAdso: c.source === null ? null : mentions(c.source, adso) }));
  }

  if (opts.scanProcessChains) {
    ctx.chainAbap ??= await scanChainAbapSteps(client, ctx);
    facts.checks.processChainAbap = ctx.chainScanFailed ? 'failed' : 'ok';
    facts.chainAbap = ctx.chainAbap.map((s) => ({ chain: s.chain, variant: s.variant, program: s.program, mentionsAdso: s.source === null ? null : mentions(s.source, adso) }));
  }

  if (opts.includeRuntime ?? true) {
    if (ctx.runtime === undefined) {
      try {
        ctx.runtime = await readRuntimeProcesses(client);
      } catch (err) {
        ctx.runtime = null;
        ctx.runtimeError = firstLine(err);
      }
    }
    facts.checks.runtimeHistory = ctx.runtime ? 'ok' : 'failed';
    facts.runtime = ctx.runtime ? ctx.runtime.get(adso) ?? [] : null;
    if (ctx.runtime === null) facts.notes.push(`Runtime evidence unavailable: ${ctx.runtimeError}`);

    // DTPs seen at runtime but not returned by xref: look them up directly.
    const known = new Set(facts.dtps.map((d) => d.name.toUpperCase()));
    facts.deletedDtps = [];
    for (const r of (facts.runtime ?? []).filter((x) => x.processType === 'DTP_LOAD' && !known.has(x.processId.toUpperCase()))) {
      const d = await cached(ctx.dtps, r.processId, () => readDtpHeader(r.processId, 'unknown'));
      if (d instanceof Error) {
        if (/HTTP 404/.test(d.message)) facts.deletedDtps.push(r.processId);
        else readErrors.push(`DTP ${r.processId}: ${firstLine(d)}`);
      } else {
        facts.dtps.push({ ...d, foundVia: 'runtime' });
        if (d.transformation && !facts.trfns.some((t) => t.name === d.transformation)) {
          const t = await cached(ctx.trfns, d.transformation, () => readTrfnHeader(d.transformation!, 'unknown'));
          if (t instanceof Error) readErrors.push(`transformation ${d.transformation}: ${firstLine(t)}`);
          else facts.trfns.push(t);
        }
      }
    }
    await resolveSourceSystemTypes(client, ctx, facts);
  }
  return facts;
}

export async function bwGetAdsoLoaders(
  client: BwClient,
  adsoName: string,
  opts: LoaderOptions = {},
  ctx: CensusContext = new CensusContext(),
): Promise<LoaderCensus> {
  const census = classifyLoaders(await collectLoaderFacts(client, adsoName, ctx, opts));
  census.notes.push(...ctx.notes);
  return census;
}

async function resolveSourceSystemTypes(client: BwClient, ctx: CensusContext, facts: LoaderFacts) {
  for (const t of facts.trfns) {
    const ss = t.sourceSystem?.toUpperCase();
    if (t.sourceType.toUpperCase() !== 'RSDS' || !ss || ss in ctx.sourceSystemTypes) continue;
    try {
      const parsed = JSON.parse(await bwGetSourceSystem(client, ss));
      ctx.sourceSystemTypes[ss] = parsed.type ?? parsed.source_system_type ?? 'UNKNOWN';
    } catch (err) {
      ctx.sourceSystemTypes[ss] = 'UNKNOWN';
      facts.readErrors.push(`source system ${ss}: ${firstLine(err)}`);
    }
  }
}

async function readTrfnHeader(name: string, status: string): Promise<TrfnHeader> {
  const xml = (await freshRead(`/sap/bw/modeling/trfn/${name.toLowerCase()}/a`, MEDIA_TYPES['trfn'])
    .catch(() => freshRead(`/sap/bw/modeling/trfn/${name.toLowerCase()}/m`, MEDIA_TYPES['trfn']))).body;
  const p = parseTransformationXml(xml);
  return {
    name: p.name || name,
    status,
    sourceType: p.source.type,
    sourceName: p.source.name,
    sourceSystem: p.source.sourceSystem,
    targetType: p.target.type,
    targetName: p.target.name,
    hanaRuntime: p.hanaRuntime,
    routineTypes: [...new Set(p.rules.flatMap((r) => r.routineType ? [r.routineType] : r.steps.some((s) => s.kind === 'ROUTINE') ? ['FIELD'] : []))],
  };
}

export function parseDtpXml(name: string, status: string, xml: string): DtpHeader {
  const tag = (t: string) => xml.match(new RegExp(`<${t}\\b[^>]*>`))?.[0] ?? '';
  const attr = (src: string, a: string) => src.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
  const src = tag('source');
  const tgt = tag('target');
  const [sourceName, sourceSystemFromName] = (attr(src, 'name') ?? '').trim().split(/\s+/);
  return {
    name,
    status,
    sourceTlogo: attr(src, 'tlogo') ?? attr(src, 'type') ?? '',
    sourceName: sourceName ?? '',
    sourceSystem: attr(tag('sourceSystem'), 'name') ?? sourceSystemFromName,
    adapter: attr(tag('adapter'), 'name'),
    targetTlogo: attr(tgt, 'tlogo') ?? attr(tgt, 'type') ?? '',
    targetName: (attr(tgt, 'name') ?? '').trim(),
    transformation: xml.match(/<object name="([^"]+)"[^>]*tlogo="TRFN"/)?.[1],
    extractionMode: attr(tag('extractionSettings'), 'extractionMode'),
    processChains: [...xml.matchAll(/<processChain name="([^"]+)"/g)].map((m) => m[1]),
  };
}

async function readDtpHeader(name: string, status: string): Promise<DtpHeader> {
  const xml = (await freshRead(`/sap/bw/modeling/dtpa/${name.toLowerCase()}/m`, MEDIA_TYPES['dtpa'])).body;
  return parseDtpXml(name, status, xml);
}

/** Planning function type, e.g. 0RSPL_FILE_UPLOAD_AO, from planningServiceType="<type>.plst#//". */
export function parsePlanningFunctionType(xml: string): string | undefined {
  return xml.match(/planningServiceType="([^".]+)/)?.[1];
}

async function readPlanningFunctionType(name: string): Promise<string> {
  const xml = (await freshRead(`/sap/bw/modeling/plse/${encodeBwObjectName(name)}/a`, MEDIA_TYPES['plse'])).body;
  return parsePlanningFunctionType(xml) ?? 'UNKNOWN';
}

/** Bulk read of RSPMPROCESS: process type / id / count per aDSO. */
async function readRuntimeProcesses(client: BwClient): Promise<Map<string, RuntimeRow[]>> {
  const rows = await adtSelect(
    client,
    "SELECT unique_target_dta, process_type, process_id, COUNT(*) AS cnt FROM rspmprocess WHERE unique_target_tlogo = 'ADSO' GROUP BY unique_target_dta, process_type, process_id",
    5000,
  );
  const map = new Map<string, RuntimeRow[]>();
  for (const r of rows) {
    const target = (r.UNIQUE_TARGET_DTA ?? '').toUpperCase();
    if (!target) continue;
    const list = map.get(target) ?? [];
    list.push({ processType: r.PROCESS_TYPE, processId: r.PROCESS_ID, count: Number(r.CNT) || 0 });
    map.set(target, list);
  }
  return map;
}

/** Callers of the aDSO write APIs (ADT where-used), with their source for literal matching. */
async function scanWriteApiCallers(client: BwClient, ctx: CensusContext) {
  const out: Array<{ api: string; caller: string; source: string | null }> = [];
  const body = '<?xml version="1.0" encoding="UTF-8"?><usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>';
  for (const api of WRITE_APIS) {
    const group = api.startsWith('RSDSO_DU') ? 'rsdso_api_direct_upd' : 'rsdso_update';
    const uri = `/sap/bc/adt/functions/groups/${group}/fmodules/${api.toLowerCase()}`;
    try {
      const xml = await client.postRaw(
        `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(uri)}`,
        body,
        'application/vnd.sap.adt.repository.usagereferences.request.v1+xml',
        { Accept: 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml' },
      );
      const declared = Number(xml.match(/numberOfResults="(\d+)"/)?.[1] ?? '0');
      const refs = [...xml.matchAll(/<usageReferences:adtObject\b([^>]*)>/g)].map((m) => ({
        type: m[1].match(/adtcore:type="([^"]+)"/)?.[1] ?? '',
        name: m[1].match(/adtcore:name="([^"]+)"/)?.[1] ?? '',
      })).filter((r) => r.name && !r.type.startsWith('DEVC') && !r.type.startsWith('FUGR/FF'));
      if (declared > 0 && refs.length === 0) {
        ctx.apiScanFailed = true;
        ctx.notes.push(`Where-used of ${api} reports ${declared} result(s) that could not be parsed — callers not checked.`);
      }
      for (const r of refs) {
        const kind = r.type.startsWith('CLAS') ? 'CLAS' : r.type.startsWith('PROG/I') ? 'INCL' : 'PROG';
        let source: string | null = null;
        try { source = (await readAbapSource(client, kind, r.name)).source; } catch { source = null; }
        out.push({ api, caller: `${r.type} ${r.name}`, source });
      }
    } catch (err) {
      ctx.apiScanFailed = true;
      ctx.notes.push(`Where-used of ${api} failed: ${firstLine(err)}`);
    }
  }
  return out;
}

/** ABAP steps of all process chains, with the report source for literal matching. */
async function scanChainAbapSteps(client: BwClient, ctx: CensusContext) {
  const out: Array<{ chain: string; variant: string; program?: string; source: string | null }> = [];
  let chains: SearchEntry[] = [];
  try {
    chains = await bwSearchEntries(client, '*', 'RSPC');
  } catch (err) {
    ctx.chainScanFailed = true;
    ctx.notes.push(`Process-chain search failed: ${firstLine(err)}`);
    return out;
  }
  if (chains.length >= 250) ctx.notes.push(`Process-chain search returned ${chains.length} entries — the list may be capped.`);
  for (const c of chains) {
    let nodes: Array<{ sProcessType?: string; sProcessVariant?: string }> = [];
    try {
      nodes = JSON.parse(await bwGetProcessChain(client, c.objectName, 'raw', false)).aNode ?? [];
    } catch (err) {
      ctx.chainScanFailed = true;
      ctx.notes.push(`Process chain ${c.objectName} not readable: ${firstLine(err)}`);
      continue;
    }
    for (const n of nodes.filter((x) => x.sProcessType === 'ABAP' && x.sProcessVariant)) {
      let program: string | undefined;
      let source: string | null = null;
      try {
        const pv = JSON.parse(await bwGetProcessVariant(client, 'ABAP', n.sProcessVariant!, 'raw'));
        program = pv?.oDetail?.PROGRAM?.[0]?.key || undefined;
        if (program) source = (await readAbapSource(client, 'PROG', program)).source;
      } catch {
        source = null;
      }
      out.push({ chain: c.objectName, variant: n.sProcessVariant!, program, source });
    }
  }
  return out;
}

function mentions(source: string, adso: string): boolean {
  return source.toUpperCase().includes(`'${adso}'`) || source.toUpperCase().includes(`\`${adso}\``);
}

async function cachedXref(client: BwClient, ctx: CensusContext, type: string, name: string): Promise<SearchEntry[] | Error> {
  return cached(ctx.xref, `${type}:${name}`, () => bwXrefEntries(client, type, name));
}

async function cached<T>(map: Map<string, T | Error>, key: string, load: () => Promise<T>): Promise<T | Error> {
  if (!map.has(key)) {
    try { map.set(key, await load()); } catch (err) { map.set(key, err as Error); }
  }
  return map.get(key)!;
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0];
}
