/**
 * Scope enforcement for the HTTP transport.
 *
 * Copied from bw-modeling-mcp src/scopes.ts; only READ_TOOLS changed to this kit's tools.
 *
 * Two scopes, matching the two role collections:
 *   read  — the tools that only read.
 *   write — the tools that create, update, activate, start, restart, interrupt or set status.
 *           `write` implies `read`.
 *
 * The READ set is the explicit one, and anything unrecognised requires `write`. That
 * direction matters: a tool added later without touching this file is unavailable to
 * read-only callers rather than silently offered to them.
 *
 * This gates who may call the server. What a caller can actually see or change in BW is
 * decided by BW, against the ABAP user behind the request — under principal propagation
 * that is the caller themselves. Scopes restrict; they never widen.
 *
 * stdio has no authInfo and therefore no scopes: whoever runs the process already holds
 * the credentials.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type Scope = 'read' | 'write';

const READ_TOOLS = new Set([
  // from bw-modeling-mcp
  'bw_get_process_chain',
  'bw_get_process_chain_run_detail',
  'bw_get_process_variant',
  'bw_get_request',
  'bw_list_changeable_transports',
  'bw_list_process_chain_last_status',
  'bw_list_process_chain_runs',
  'bw_list_requests',
  // new in the PC automation kit
  'bw_check_rfc_connection',
  'bw_get_process_chain_steps',
  'bw_list_process_chain_log',
  // bw_get_process_chain_status is read-only by default but can update the log (refresh=true),
  // so it is classified as write.
]);

export function requiredScope(toolName: string): Scope {
  return READ_TOOLS.has(toolName) ? 'read' : 'write';
}

/** Accepts bare or XSUAA-qualified scopes (`bwmcp!t123.read`). */
function has(scopes: readonly string[], scope: Scope): boolean {
  return scopes.some((s) => s === scope || s.endsWith(`.${scope}`));
}

export function hasScope(authInfo: AuthInfo | undefined, scope: Scope): boolean {
  if (!authInfo) return true; // stdio
  const scopes = authInfo.scopes ?? [];
  if (has(scopes, scope)) return true;
  return scope === 'read' && has(scopes, 'write'); // write implies read
}

/** Hide tools the caller cannot invoke, so a model never proposes a call that will be denied. */
export function filterToolsByScope<T extends { name: string }>(
  tools: T[],
  authInfo: AuthInfo | undefined,
): T[] {
  if (!authInfo) return tools;
  return tools.filter((t) => hasScope(authInfo, requiredScope(t.name)));
}
