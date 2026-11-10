import { BwClient } from '../bw-client.js';

/**
 * Read-only access to BW request-management tables through the ADT data preview
 * (POST /sap/bc/adt/datapreview/freestyle — the service behind Eclipse "Data Preview").
 *
 * Why: the runtime request monitor (/sap/bw4/v1/manage/requests, used by bw_list_requests)
 * can be unavailable (HTTP 403 when its ICF service is inactive), while RSPMPROCESS /
 * RSPMREQUEST carry the same evidence of *how* an aDSO was written (DTP_LOAD, PLAN,
 * SELDEL, ...). This module is deliberately not a general SQL tool: statements may only
 * read the allow-listed administration tables below.
 */
const ALLOWED_TABLES = new Set(['RSPMPROCESS', 'RSPMREQUEST']);

export type SqlRow = Record<string, string>;

export async function adtSelect(client: BwClient, sql: string, maxRows = 500): Promise<SqlRow[]> {
  const statement = sql.trim();
  if (!/^SELECT\s/i.test(statement) || /;/.test(statement)) {
    throw new Error('adtSelect: only a single SELECT statement is allowed.');
  }
  const tables = [...statement.matchAll(/\b(?:FROM|JOIN)\s+([A-Z0-9_/]+)/gi)].map((m) => m[1].toUpperCase());
  if (tables.length === 0 || tables.some((t) => !ALLOWED_TABLES.has(t))) {
    throw new Error(`adtSelect: only ${[...ALLOWED_TABLES].join(', ')} may be read (got ${tables.join(', ') || 'none'}).`);
  }
  const body = await client.postRaw(
    `/sap/bc/adt/datapreview/freestyle?rowNumber=${Math.max(1, Math.min(maxRows, 5000))}`,
    statement,
    'text/plain',
    { Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml' },
  );
  return parseDataPreview(body);
}

/** Convert the column-oriented data-preview XML into row objects. */
export function parseDataPreview(xml: string): SqlRow[] {
  const columns = [...xml.matchAll(/<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g)].map((m) => {
    const name = m[1].match(/dataPreview:name="([^"]+)"/)?.[1] ?? '';
    const values = [...m[1].matchAll(/<dataPreview:data>([^<]*)<\/dataPreview:data>|<dataPreview:data\/>/g)]
      .map((v) => (v[1] ?? '').trim());
    return { name, values };
  });
  const rowCount = Math.max(0, ...columns.map((c) => c.values.length));
  const rows: SqlRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push(Object.fromEntries(columns.map((c) => [c.name, c.values[i] ?? ''])));
  }
  return rows;
}
