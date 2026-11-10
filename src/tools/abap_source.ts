import { BwClient } from '../bw-client.js';
import { encodeAdtObjectName } from './bw-names.js';

/**
 * Read ABAP source through ADT. Used to extract the code behind BW objects:
 *   - transformation routines (generated class /BIC/<id>_M, method per routine)
 *   - transformation generated programs (GP<id>, the activated runtime incl. routine copies)
 *   - DTP filter routines, process-chain ABAP steps, function modules called by routines
 *
 * Endpoints (verified on BW/4HANA 2.0 SP17):
 *   CLAS  /sap/bc/adt/oo/classes/{name}/source/main
 *   PROG  /sap/bc/adt/programs/programs/{name}/source/main
 *   FUNC  /sap/bc/adt/functions/groups/{group}/fmodules/{name}/source/main
 *   INCL  /sap/bc/adt/programs/includes/{name}/source/main   (standard ADT path, not yet exercised)
 * Function groups are resolved with the ADT quick search when the caller omits them.
 */
export type AbapObjectType = 'CLAS' | 'PROG' | 'FUNC' | 'INCL';

export interface AbapSourceResult {
  objectType: AbapObjectType;
  name: string;
  uri: string;
  version: 'active' | 'inactive';
  source: string;
}

export async function readAbapSource(
  client: BwClient,
  objectType: AbapObjectType,
  name: string,
  options: { functionGroup?: string; version?: 'active' | 'inactive' } = {},
): Promise<AbapSourceResult> {
  const version = options.version ?? 'active';
  const enc = encodeAdtObjectName(name);
  let base: string;
  switch (objectType) {
    case 'CLAS': base = `/sap/bc/adt/oo/classes/${enc}`; break;
    case 'PROG': base = `/sap/bc/adt/programs/programs/${enc}`; break;
    case 'INCL': base = `/sap/bc/adt/programs/includes/${enc}`; break;
    case 'FUNC': {
      const group = options.functionGroup ?? await resolveFunctionGroup(client, name);
      base = `/sap/bc/adt/functions/groups/${encodeAdtObjectName(group)}/fmodules/${enc}`;
      break;
    }
    default:
      throw new Error(`Unsupported ABAP object type "${objectType}". Use CLAS, PROG, FUNC or INCL.`);
  }
  const uri = `${base}/source/main?version=${version}`;
  const result = await client.rawGet(uri, { Accept: 'text/plain' });
  return { objectType, name: name.toUpperCase(), uri, version, source: result.body };
}

/** Resolve the function group of a function module with the ADT quick search. */
export async function resolveFunctionGroup(client: BwClient, functionModule: string): Promise<string> {
  const query = encodeURIComponent(functionModule.toUpperCase());
  const result = await client.rawGet(
    `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${query}&maxResults=10`,
    { Accept: 'application/xml' },
  );
  const fm = functionModule.toLowerCase();
  const m = result.body.match(new RegExp(`/sap/bc/adt/functions/groups/([^/"]+)/fmodules/${fm.replace(/\//g, '%2f')}"`, 'i'));
  if (!m) throw new Error(`Function module ${functionModule.toUpperCase()} not found via ADT quick search.`);
  return decodeURIComponent(m[1]);
}

/**
 * Return the METHOD <name> … ENDMETHOD. block (inclusive) or null.
 * Matches METHOD statements only — never the METHODS declarations in the definition part.
 */
export function extractMethod(source: string, methodName: string): string | null {
  const lines = source.split('\n');
  const startRe = new RegExp(`^\\s*METHOD\\s+${escapeRegExp(methodName)}\\s*\\.`, 'i');
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*ENDMETHOD\s*\./i.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

/** List METHOD implementations (name + 1-based line) in a source. */
export function listMethods(source: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  source.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*METHOD\s+([\w~/]+)\s*\./i);
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

/**
 * Normalise ABAP for comparison: drop full-line and trailing comments, the METHOD/
 * ENDMETHOD statements themselves, blank lines, case and whitespace. Used to tell whether
 * the editable routine class and the activated generated program contain the same logic —
 * the generator adds comment headers and reflows DATA declarations.
 */
export function normalizeAbap(code: string): string {
  return code
    .split('\n')
    .filter((l) => !/^\s*\*/.test(l))
    .map((l) => l.replace(/"[^']*$/, ''))
    .filter((l) => !/^\s*(END)?METHOD\b/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([.:,])\s*/g, '$1')
    .trim()
    .toUpperCase();
}

export function bwGetAbapSourceText(
  result: AbapSourceResult,
  options: { method?: string; startLine?: number; maxLines?: number } = {},
): string {
  let body = result.source;
  let scope = 'full source';
  if (options.method) {
    const block = extractMethod(result.source, options.method);
    if (!block) {
      const available = listMethods(result.source).map((m) => m.name).join(', ') || '(none)';
      throw new Error(`Method ${options.method.toUpperCase()} not found in ${result.name}. Available: ${available}`);
    }
    body = block;
    scope = `method ${options.method.toUpperCase()}`;
  }
  const lines = body.split('\n');
  const start = Math.max(1, options.startLine ?? 1);
  const max = Math.max(1, Math.min(options.maxLines ?? 400, 5000));
  const slice = lines.slice(start - 1, start - 1 + max);
  const end = start - 1 + slice.length;
  const truncated = end < lines.length;
  const header = [
    `ABAP source: ${result.objectType} ${result.name} (${result.version})`,
    `URI: ${result.uri}`,
    `Scope: ${scope}, lines ${start}-${end} of ${lines.length}${truncated ? ' — TRUNCATED, raise max_lines or use start_line' : ''}`,
  ];
  if (!options.method && result.objectType === 'CLAS') {
    const methods = listMethods(result.source);
    if (methods.length) header.push(`Methods: ${methods.map((m) => `${m.name}@${m.line}`).join(', ')}`);
  }
  return `${header.join('\n')}\n\n${slice.join('\n')}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
