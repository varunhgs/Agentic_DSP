import { BwClient } from '../bw-client.js';
import { adtSelect, SqlRow } from './adt-sql.js';
import { callRfc, tableRows } from './rfc.js';

/**
 * Process chain run control — NEW in the PC automation kit (not in bw-modeling-mcp).
 *
 * Two channels, both over the same BwClient HTTPS session:
 *   - READ  via ADT data preview on the RSPC log tables (RSPCLOGCHAIN, RSPCPROCESSLOG, TBTCO).
 *           Works without any extra ICF service, on BW/4HANA and BW 7.5.
 *   - ACT   via SOAP-RFC on the SAP standard process chain API (RSPC_API_*).
 *           Needs ICF service /sap/bc/soap/rfc active (SICF).
 *
 * Function module signatures used here were read from the local system (see docs/SAP-REFERENCE.md);
 * all of them are remote-enabled (ADT processingType="rfc").
 */

// ── Status codes (domain RSPC_STATE) ─────────────────────────────────────────

const STATE_TEXT: Record<string, string> = {
  G: 'Successfully completed',
  F: 'Completed',
  R: 'Ended with errors',
  X: 'Cancelled',
  J: 'Framework error',
  A: 'Active',
  P: 'Planned',
  Y: 'Ready',
  Q: 'Released',
  S: 'Skipped',
};
export const RED_STATES = new Set(['R', 'X', 'J']);
const GREEN_STATES = new Set(['G', 'F']);
const RUNNING_STATES = new Set(['A', 'P', 'Y', 'Q']);

function colour(state: string): string {
  if (RED_STATES.has(state)) return 'red';
  if (GREEN_STATES.has(state)) return 'green';
  if (RUNNING_STATES.has(state)) return 'yellow';
  if (state === 'S') return 'grey';
  return 'unknown';
}

function stateLabel(state: string): string {
  return `${STATE_TEXT[state] ?? 'Unknown'} (${state || '-'}) [${colour(state)}]`;
}

// TBTCO-STATUS
const JOB_STATUS_TEXT: Record<string, string> = {
  R: 'running', F: 'finished', A: 'cancelled', S: 'scheduled', Y: 'ready', P: 'planned', Z: 'released/suspended', X: 'unknown',
};

// ── Input validation (values are embedded in SQL / SOAP) ──────────────────────

function checked(value: string | undefined, label: string, pattern: RegExp): string {
  const v = (value ?? '').trim().toUpperCase();
  if (!pattern.test(v)) {
    throw new Error(`Invalid ${label}: '${value ?? ''}'`);
  }
  return v;
}
const chainId = (v: string | undefined) => checked(v, 'chain id', /^[A-Z0-9_/]{1,30}$/);
const logId = (v: string | undefined) => checked(v, 'log id', /^[A-Z0-9]{1,25}$/);
const procType = (v: string | undefined) => checked(v, 'process type', /^[A-Z0-9_]{1,10}$/);
const variant = (v: string | undefined) => checked(v, 'process variant', /^[A-Z0-9_/]{1,30}$/);
const instance = (v: string | undefined) => checked(v, 'process instance', /^[A-Z0-9_/]{1,30}$/);
const isoDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Invalid date '${v}', expected YYYY-MM-DD`);
  return v.replace(/-/g, '');
};

// ── Timestamps ───────────────────────────────────────────────────────────────

/** RSPC timestamps are UTC long timestamps: YYYYMMDDhhmmss.fffffff */
function tsToDate(ts: string | undefined): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(ts ?? '');
  if (!m || m[1] === '0000') return undefined;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function runtime(start?: Date, end?: Date): string {
  if (!start) return '';
  const s = Math.round(((end ?? new Date()).getTime() - start.getTime()) / 1000);
  return end ? `${s}s` : `${s}s (still open)`;
}

// ── Reads: run log (ADT data preview) ────────────────────────────────────────

export interface StepRow {
  chain: string;
  logId: string;
  depth: number;
  type: string;
  variant: string;
  instance: string;
  state: string;
  start?: Date;
  end?: Date;
  jobCount: string;
  jobStatus?: string;
  subLogId?: string;
}

async function latestLogId(client: BwClient, chain: string): Promise<string | undefined> {
  const rows = await adtSelect(
    client,
    `SELECT LOG_ID, DATUM, ZEIT FROM RSPCLOGCHAIN WHERE CHAIN_ID = '${chain}' ORDER BY DATUM DESCENDING, ZEIT DESCENDING`,
    1,
  );
  return rows[0]?.LOG_ID;
}

/**
 * Log id of the sub-chain run started by a CHAIN step of the parent run.
 *
 * RSPCLOGCHAIN-META_LOG holds the log id of the calling (meta) chain run. Not yet seen
 * on the local system (it has no nested chains) — verify with a nested test chain.
 */
async function subChainLogId(client: BwClient, subChain: string, parentLog: string): Promise<string | undefined> {
  const rows = await adtSelect(
    client,
    `SELECT LOG_ID FROM RSPCLOGCHAIN WHERE CHAIN_ID = '${subChain}' AND META_LOG = '${parentLog}'`,
    5,
  );
  return rows[0]?.LOG_ID;
}

async function jobStatus(client: BwClient, jobCount: string): Promise<string | undefined> {
  if (!/^\d{8}$/.test(jobCount) || /^0+$/.test(jobCount)) return undefined;
  const rows = await adtSelect(
    client,
    `SELECT JOBNAME, STATUS FROM TBTCO WHERE JOBCOUNT = '${jobCount}' AND JOBNAME LIKE 'BI_PROCESS%'`,
    5,
  );
  if (rows.length === 0) return 'no job found (deleted or not started)';
  return rows.map((r) => `${r.JOBNAME}: ${JOB_STATUS_TEXT[r.STATUS] ?? r.STATUS}`).join(', ');
}

/** All steps of one run, descending into sub-chains (max depth 10). */
export async function collectSteps(
  client: BwClient,
  chain: string,
  log: string,
  recursive: boolean,
  withJobs: boolean,
  depth = 0,
): Promise<StepRow[]> {
  const rows: SqlRow[] = await adtSelect(
    client,
    'SELECT TYPE, VARIANTE, INSTANCE, STATE, ACTUAL_STATE, STARTTIMESTAMP, ENDTIMESTAMP, JOB_COUNT ' +
      `FROM RSPCPROCESSLOG WHERE LOG_ID = '${log}' ORDER BY STARTTIMESTAMP`,
    1000,
  );
  const steps: StepRow[] = [];
  for (const r of rows) {
    const state = r.ACTUAL_STATE || r.STATE;
    const step: StepRow = {
      chain,
      logId: log,
      depth,
      type: r.TYPE,
      variant: r.VARIANTE,
      instance: r.INSTANCE,
      state,
      start: tsToDate(r.STARTTIMESTAMP),
      end: tsToDate(r.ENDTIMESTAMP),
      jobCount: r.JOB_COUNT,
    };
    if (withJobs && state === 'A') step.jobStatus = await jobStatus(client, r.JOB_COUNT);
    steps.push(step);
    if (recursive && r.TYPE === 'CHAIN' && depth < 10) {
      step.subLogId = await subChainLogId(client, r.VARIANTE, log);
      if (step.subLogId) {
        steps.push(...(await collectSteps(client, r.VARIANTE, step.subLogId, recursive, withJobs, depth + 1)));
      }
    }
  }
  return steps;
}

export async function bwListProcessChainLog(
  client: BwClient,
  chainName?: string,
  status?: string,
  dateFrom?: string,
  limit = 20,
): Promise<string> {
  const where: string[] = [];
  if (chainName) where.push(`CHAIN_ID = '${chainId(chainName)}'`);
  if (status) where.push(`ANALYZED_STATUS = '${checked(status, 'status', /^[A-Z]$/)}'`);
  if (dateFrom) where.push(`DATUM >= '${isoDate(dateFrom)}'`);
  const rows = await adtSelect(
    client,
    'SELECT CHAIN_ID, LOG_ID, DATUM, ZEIT, ANALYZED_STATUS, META_LOG FROM RSPCLOGCHAIN' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY DATUM DESCENDING, ZEIT DESCENDING',
    Math.max(1, Math.min(limit, 500)),
  );
  const lines = [`Process Chain Log (RSPCLOGCHAIN) — ${chainName ?? 'all chains'} — ${rows.length} run(s)`, ''];
  if (rows.length === 0) return lines.concat('(no runs found)').join('\n');
  for (const r of rows) {
    const d = r.DATUM, t = r.ZEIT;
    lines.push(`Run: ${r.LOG_ID}`);
    lines.push(`  Chain:    ${r.CHAIN_ID}`);
    lines.push(`  Started:  ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)} (system time)`);
    lines.push(`  Status:   ${stateLabel(r.ANALYZED_STATUS)}`);
    if (r.META_LOG) lines.push(`  Called by run: ${r.META_LOG} (this is a sub-chain run)`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export async function bwGetProcessChainSteps(
  client: BwClient,
  chainName: string,
  log?: string,
  recursive = true,
  withJobs = true,
): Promise<string> {
  const chain = chainId(chainName);
  const runLog = log ? logId(log) : await latestLogId(client, chain);
  if (!runLog) return `No runs found for process chain ${chain}.`;

  const steps = await collectSteps(client, chain, runLog, recursive, withJobs);
  const lines = [`Process Chain Steps — ${chain} / run ${runLog} — ${steps.length} step(s)`, ''];
  for (const s of steps) {
    const pad = '  '.repeat(s.depth);
    lines.push(`${pad}${s.type.padEnd(10)} ${s.variant}`);
    lines.push(`${pad}  Status:   ${stateLabel(s.state)}`);
    lines.push(`${pad}  Start:    ${s.start?.toISOString() ?? ''}   End: ${s.end?.toISOString() ?? ''}   Runtime: ${runtime(s.start, s.end)}`);
    lines.push(`${pad}  Instance: ${s.instance}   Job: ${s.jobCount}${s.jobStatus ? ` (${s.jobStatus})` : ''}`);
    if (s.type === 'CHAIN') {
      lines.push(`${pad}  Sub-chain run: ${s.subLogId ?? 'not found (link via RSPCLOGCHAIN-META_LOG — verify on a nested chain)'}`);
    }
    if (s.depth > 0) lines.push(`${pad}  (inside sub-chain ${s.chain}, run ${s.logId})`);
    lines.push('');
  }

  const red = steps.filter((s) => RED_STATES.has(s.state) && s.type !== 'CHAIN');
  const running = steps.filter((s) => RUNNING_STATES.has(s.state));
  lines.push('── Summary ──');
  lines.push(`  green: ${steps.filter((s) => GREEN_STATES.has(s.state)).length}   red: ${steps.filter((s) => RED_STATES.has(s.state)).length}   yellow: ${running.length}`);
  if (red.length > 0) {
    lines.push('  Failed leaf steps (restart with bw_restart_process_chain on the chain/run shown):');
    for (const s of red) {
      lines.push(`    - ${s.type} ${s.variant} → chain_id=${s.chain} log_id=${s.logId} instance=${s.instance}`);
    }
  }
  return lines.join('\n').trimEnd();
}

// ── Actions: SAP process chain API (SOAP-RFC) ────────────────────────────────

export async function bwCheckRfcConnection(client: BwClient): Promise<string> {
  await callRfc(client, 'RFC_PING');
  const info = await callRfc(client, 'RFC_SYSTEM_INFO');
  const si = (info.RFCSI_EXPORT ?? {}) as Record<string, string>;
  return [
    'SOAP-RFC connection OK (/sap/bc/soap/rfc).',
    `  System:   ${si.RFCSYSID ?? ''}`,
    `  Host:     ${si.RFCHOST ?? ''}`,
    `  Release:  ${si.RFCSAPRL ?? ''}`,
    `  Database: ${si.RFCDBSYS ?? ''}`,
  ].join('\n');
}

export async function bwStartProcessChain(client: BwClient, chainName: string, synchronous = false): Promise<string> {
  const chain = chainId(chainName);
  const res = await callRfc(client, 'RSPC_API_CHAIN_START', {
    I_CHAIN: chain,
    ...(synchronous ? { I_SYNCHRONOUS: 'X' } : {}),
  });
  const failed = tableRows(res, 'E_T_PROCESS_FAILED');
  return [
    `Process chain ${chain} started.`,
    `  Log ID: ${res.E_LOGID ?? ''}`,
    ...(failed.length ? [`  Processes reported as failed at start: ${failed.map((f) => JSON.stringify(f)).join(', ')}`] : []),
    'Follow progress with bw_get_process_chain_steps (chain_id + log_id).',
  ].join('\n');
}

export async function bwGetProcessChainStatus(
  client: BwClient,
  chainName: string,
  log: string,
  refresh = false,
): Promise<string> {
  const chain = chainId(chainName);
  const res = await callRfc(client, 'RSPC_API_CHAIN_GET_STATUS', {
    I_CHAIN: chain,
    I_LOGID: logId(log),
    // Without I_DONT_UPDATE the API re-evaluates the run and may write the new status to the log.
    ...(refresh ? {} : { I_DONT_UPDATE: 'X' }),
  });
  const state = String(res.E_STATUS ?? '');
  return [
    `Process chain ${chain} / run ${log}`,
    `  Status:  ${stateLabel(state)}`,
    `  Manually aborted: ${res.E_MANUAL_ABORT || 'no'}`,
    `  Message: ${res.E_MESSAGE ?? ''}`,
  ].join('\n');
}

export async function bwRestartProcessChain(
  client: BwClient,
  chainName: string,
  log: string,
  onlyRed = true,
  force = false,
): Promise<string> {
  const chain = chainId(chainName);
  const runLog = logId(log);

  // Never restart while a step of this run is still running.
  const steps = await collectSteps(client, chain, runLog, false, true);
  const active = steps.filter((s) => s.state === 'A' && !/no job found|finished|cancelled/.test(s.jobStatus ?? ''));
  if (active.length > 0 && !force) {
    return [
      `Not restarted: ${active.length} step(s) of run ${runLog} are still active:`,
      ...active.map((s) => `  - ${s.type} ${s.variant} (${s.jobStatus ?? 'job status unknown'})`),
      'Wait for them to finish, or pass force=true if you have confirmed the jobs are dead.',
    ].join('\n');
  }
  const red = steps.filter((s) => RED_STATES.has(s.state));
  if (red.length === 0 && onlyRed) {
    return `Nothing to restart: run ${runLog} of ${chain} has no failed steps.`;
  }

  const res = await callRfc(client, 'RSPC_API_CHAIN_RESTART', {
    I_CHAIN: chain,
    I_LOGID: runLog,
    ...(onlyRed ? { I_ONLY_RED: 'X' } : {}),
    // Return at once; follow progress with bw_get_process_chain_steps.
    I_DONT_POLL: 'X',
  });
  const msg = (res.E_S_SUCCESSMSG ?? {}) as Record<string, string>;
  return [
    `Restart requested for ${chain} / run ${runLog} (${onlyRed ? 'only failed steps' : 'all restartable steps'}).`,
    `  Failed steps before restart: ${red.map((s) => `${s.type} ${s.variant}`).join(', ') || 'none'}`,
    ...(msg.MSGID ? [`  SAP message ${msg.MSGID} ${msg.MSGNO}: repeated=${msg.MSGV1 ?? ''} repaired=${msg.MSGV2 ?? ''}`] : []),
    'SAP decides per step whether to repair (same instance) or repeat (new instance).',
    'Check the result with bw_get_process_chain_steps in a few seconds.',
  ].join('\n');
}

const SETTABLE_STATES = new Set(['R', 'G', 'F', 'X']);

export async function bwSetProcessStatus(
  client: BwClient,
  chainName: string,
  log: string,
  type: string,
  variantName: string,
  instanceId: string,
  state: string,
): Promise<string> {
  const target = checked(state, 'state', /^[A-Z]$/);
  if (!SETTABLE_STATES.has(target)) {
    throw new Error(`State must be one of ${[...SETTABLE_STATES].join(', ')} (got ${target}).`);
  }
  await callRfc(client, 'RSPC_PROCESS_FINISH', {
    I_LOGID: logId(log),
    I_CHAIN: chainId(chainName),
    I_TYPE: procType(type),
    I_VARIANT: variant(variantName),
    I_INSTANCE: instance(instanceId),
    I_STATE: target,
  });
  return [
    `Status of ${type} ${variantName} in run ${log} set to ${stateLabel(target)}.`,
    'Note: setting a status does not execute the step. Green lets the chain continue; red allows a restart.',
  ].join('\n');
}

export async function bwInterruptProcessChain(client: BwClient, chainName: string, kill = false): Promise<string> {
  const chain = chainId(chainName);
  await callRfc(client, 'RSPC_API_CHAIN_INTERRUPT', { I_CHAIN: chain, ...(kill ? { I_KILL: 'X' } : {}) });
  return `Process chain ${chain} interrupted${kill ? ' (running jobs killed)' : ''}. Scheduled starts are removed until the chain is scheduled again.`;
}
