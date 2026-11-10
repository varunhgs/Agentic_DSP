import type { CsnElements } from '../converters/datasphere-objects.js';

/**
 * BW ↔ Datasphere data reconciliation for one target.
 *
 * BW rows come from the aDSO's active table (ADT data preview: every value a string, dates
 * YYYYMMDD, initial date 00000000, numbers with a trailing minus). Datasphere rows come from the
 * consumption API (dates YYYY-MM-DD, initial date NULL, numbers as JSON numbers). Both are
 * normalised to one canonical form per column type before comparing, and the normalisation is
 * part of the report — "equal" only ever means "equal after these documented rules".
 *
 * Rows are compared as multisets of complete rows, so the comparison also works for a data-mart
 * aDSO without a semantic key, and it detects duplicates as well as missing/extra rows.
 */

export const NORMALISATION_RULES = [
  'date: BW 00000000 / empty and Datasphere NULL both → "" (initial); otherwise YYYYMMDD',
  'decimal: trailing ABAP minus moved to the front; compared as a fixed-scale string at the column scale',
  'string: compared as is (no trimming); Datasphere NULL → ""',
];

export function canonical(type: string, scale: number | undefined, v: unknown, side: 'bw' | 'dsp'): string {
  if (v === null || v === undefined) return '';
  if (type === 'cds.Date') {
    const s = String(v).replace(/-/g, '').trim();
    return !s || /^0+$/.test(s) ? '' : s;
  }
  if (type === 'cds.Decimal' || type === 'cds.Integer' || type === 'cds.Integer64' || type === 'cds.Double') {
    let s = String(v).trim();
    if (side === 'bw' && s.endsWith('-')) s = `-${s.slice(0, -1)}`;
    const n = Number(s || '0');
    return n.toFixed(scale ?? 0);
  }
  return String(v);
}

export interface ReconcileResult {
  ok: boolean;
  bwRows: number;
  dspRows: number;
  matchedRows: number;
  onlyInBw: Array<{ row: string; count: number }>;
  onlyInDsp: Array<{ row: string; count: number }>;
  columns: Array<{ column: string; distinctBw: number; distinctDsp: number; sameValueSet: boolean; sumBw?: string; sumDsp?: string }>;
  rules: string[];
}

export function reconcile(elements: CsnElements, bwRows: Array<Record<string, unknown>>, dspRows: Array<Record<string, unknown>>, maxExamples = 10): ReconcileResult {
  const cols = Object.keys(elements);
  const key = (r: Record<string, unknown>, side: 'bw' | 'dsp') => cols.map((c) => canonical(elements[c].type, elements[c].scale, r[c], side)).join('|');
  const count = (rows: Array<Record<string, unknown>>, side: 'bw' | 'dsp') => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r, side), (m.get(key(r, side)) ?? 0) + 1);
    return m;
  };
  const a = count(bwRows, 'bw');
  const b = count(dspRows, 'dsp');
  let matched = 0;
  const onlyInBw: ReconcileResult['onlyInBw'] = [];
  const onlyInDsp: ReconcileResult['onlyInDsp'] = [];
  for (const [k, n] of a) {
    const m = b.get(k) ?? 0;
    matched += Math.min(n, m);
    if (n > m) onlyInBw.push({ row: k, count: n - m });
  }
  for (const [k, n] of b) {
    const m = a.get(k) ?? 0;
    if (n > m) onlyInDsp.push({ row: k, count: n - m });
  }

  const columns = cols.map((c) => {
    const e = elements[c];
    const vb = new Set(bwRows.map((r) => canonical(e.type, e.scale, r[c], 'bw')));
    const vd = new Set(dspRows.map((r) => canonical(e.type, e.scale, r[c], 'dsp')));
    const numeric = e.type === 'cds.Decimal' || e.type.startsWith('cds.Integer') || e.type === 'cds.Double';
    const sum = (rows: Array<Record<string, unknown>>, side: 'bw' | 'dsp') =>
      rows.reduce((s, r) => s + Number(canonical(e.type, e.scale, r[c], side)), 0).toFixed(e.scale ?? 0);
    return {
      column: c,
      distinctBw: vb.size,
      distinctDsp: vd.size,
      sameValueSet: vb.size === vd.size && [...vb].every((v) => vd.has(v)),
      ...(numeric ? { sumBw: sum(bwRows, 'bw'), sumDsp: sum(dspRows, 'dsp') } : {}),
    };
  });

  return {
    ok: onlyInBw.length === 0 && onlyInDsp.length === 0 && bwRows.length === dspRows.length,
    bwRows: bwRows.length,
    dspRows: dspRows.length,
    matchedRows: matched,
    onlyInBw: onlyInBw.slice(0, maxExamples),
    onlyInDsp: onlyInDsp.slice(0, maxExamples),
    columns,
    rules: NORMALISATION_RULES,
  };
}
