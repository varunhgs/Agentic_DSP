import type { AdsoDefinition } from '../bw/adso-parser.js';
import type { ConversionResult, CsnElement } from '../converters/adso-to-local-table.js';

/**
 * Compares the table Datasphere actually stored with the BW definition it came from: every BW field
 * present as a column, with the mapped type, key flag and semantics — and nothing extra.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: Check[];
}

const SEMANTIC_KEYS = [
  '@Semantics.currencyCode',
  '@Semantics.unitOfMeasure',
  '@Semantics.amount.currencyCode',
  '@Semantics.quantity.unitOfMeasure',
  '@AnalyticsDetails.measureType',
  '@Aggregation.default',
] as const;

export function validateLocalTable(
  adso: AdsoDefinition,
  conversion: ConversionResult,
  actual: { definitions: Record<string, any> },
  status?: string,
): ValidationResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const entity = actual.definitions?.[conversion.technicalName];
  add('table exists in Datasphere', !!entity);
  if (!entity) return { ok: false, checks };

  if (status !== undefined) add('deployment status', /deployed/i.test(status) && !/not/i.test(status), status);

  const expected = conversion.csn.definitions[conversion.technicalName];
  add(
    'semantic usage',
    entity['@ObjectModel.modelingPattern']?.['#'] === conversion.semanticUsage,
    `${entity['@ObjectModel.modelingPattern']?.['#']} (expected ${conversion.semanticUsage})`,
  );

  const actualCols: Record<string, CsnElement> = entity.elements ?? {};
  add(
    'column count = BW field count',
    Object.keys(actualCols).length === adso.fields.length,
    `${Object.keys(actualCols).length} columns, ${adso.fields.length} BW fields`,
  );

  const actualKeys = Object.entries(actualCols).filter(([, e]) => e.key).map(([c]) => c).sort();
  const expectedKeys = conversion.columns.filter((c) => c.role === 'key').map((c) => c.column).sort();
  add('primary key = aDSO key', JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), actualKeys.join(', '));

  for (const m of conversion.columns) {
    const exp = expected.elements[m.column];
    const act = actualCols[m.column];
    if (!act) {
      add(`${m.bwField} → ${m.column}`, false, 'column missing');
      continue;
    }
    const diffs: string[] = [];
    for (const k of ['type', 'length', 'precision', 'scale'] as const) {
      if (exp[k] !== undefined && act[k] !== exp[k]) diffs.push(`${k} ${act[k]} ≠ ${exp[k]}`);
    }
    if (!!act.key !== !!exp.key) diffs.push(`key ${!!act.key} ≠ ${!!exp.key}`);
    for (const k of SEMANTIC_KEYS) {
      if (JSON.stringify(act[k]) !== JSON.stringify(exp[k])) diffs.push(`${k} ${JSON.stringify(act[k])} ≠ ${JSON.stringify(exp[k])}`);
    }
    add(`${m.bwField} → ${m.column} (${m.bwType} → ${m.dspType})`, diffs.length === 0, diffs.join('; ') || undefined);
  }

  const extra = Object.keys(actualCols).filter((c) => !conversion.columns.some((m) => m.column === c));
  add('no unexpected columns', extra.length === 0, extra.join(', ') || undefined);

  return { ok: checks.every((c) => c.ok), checks };
}
