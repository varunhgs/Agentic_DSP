import type { AdsoDefinition, AdsoField } from '../bw/adso-parser.js';

/**
 * BW aDSO → SAP Datasphere local table (CSN).
 *
 * The structure is migrated, not the data: one aDSO becomes one local table with the aDSO's
 * semantic key as primary key. An aDSO with key figures becomes a table of semantic usage
 * "Fact" (ANALYTICAL_FACT), its key figures measures with their default aggregation, and the
 * amount → currency / quantity → unit links become @Semantics annotations. The annotation shapes
 * follow what Datasphere itself writes for fact tables.
 */

export interface ConversionOptions {
  /** Prefix for the technical name of the table, e.g. "MIG_". */
  prefix: string;
  /** Overrides prefix + aDSO name. */
  technicalName?: string;
}

export type ColumnRole = 'key' | 'attribute' | 'measure' | 'currency' | 'unit';

export interface ColumnMapping {
  bwField: string;
  infoObject?: string;
  column: string;
  role: ColumnRole;
  bwType: string;
  dspType: string;
}

export interface ConversionResult {
  technicalName: string;
  semanticUsage: 'ANALYTICAL_FACT' | 'DATA_STRUCTURE';
  csn: { definitions: Record<string, CsnEntity> };
  columns: ColumnMapping[];
  /** Converted, but with a deliberate choice the reviewer should know about. */
  warnings: string[];
  /** Not part of a structure migration — needs a follow-up step or manual work. */
  manual: string[];
}

export interface CsnEntity {
  kind: 'entity';
  elements: Record<string, CsnElement>;
  [annotation: `@${string}`]: unknown;
}

export interface CsnElement {
  type: string;
  key?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  [annotation: `@${string}`]: unknown;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Column name for a BW field. SAP-delivered InfoObjects lose their leading "0" (0CUSTOMER → CUSTOMER),
 * namespaced ones turn "/" into "_" — the same names BW uses for the fields of its external SAP HANA
 * views. Everything else keeps the BW name.
 */
export function columnName(bwField: string): string {
  if (/^0[A-Z]/.test(bwField)) return bwField.slice(1);
  if (bwField.startsWith('/')) return bwField.replace(/^\//, '').replace(/\//g, '_');
  return bwField;
}

const AGGREGATIONS = new Set(['SUM', 'MIN', 'MAX']);

interface TypeMapping {
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
}

/** BW/ABAP data type → CDS type as Datasphere stores it. Returns undefined for an unmapped type. */
export function mapType(f: AdsoField): TypeMapping | undefined {
  switch (f.dataType) {
    case 'CHAR':
    case 'NUMC': // kept as string: leading zeros are part of the value
    case 'CUKY':
    case 'UNIT':
    case 'LANG':
    case 'CLNT':
    case 'SSTR':
      return { type: 'cds.String', length: f.length ?? defaultLength(f.dataType) };
    case 'STRG':
      return { type: 'cds.LargeString' };
    case 'DATS':
      return { type: 'cds.Date' };
    case 'TIMS':
      return { type: 'cds.Time' };
    case 'CURR':
    case 'QUAN':
    case 'DEC':
      return { type: 'cds.Decimal', precision: f.precision ?? f.length, scale: f.scale ?? 0 };
    case 'INT1':
    case 'INT2':
    case 'INT4':
      return { type: 'cds.Integer' };
    case 'INT8':
      return { type: 'cds.Integer64' };
    case 'FLTP':
      return { type: 'cds.Double' };
    case 'RAW':
      return { type: 'cds.Binary', length: f.length };
    default:
      return undefined;
  }
}

function defaultLength(t: string): number | undefined {
  return t === 'CUKY' ? 5 : t === 'UNIT' ? 3 : t === 'LANG' ? 1 : t === 'CLNT' ? 3 : undefined;
}

export function convertAdsoToLocalTable(adso: AdsoDefinition, opts: ConversionOptions): ConversionResult {
  const technicalName = opts.technicalName ?? `${opts.prefix}${adso.name}`;
  if (!NAME_RE.test(technicalName)) throw new Error(`invalid Datasphere technical name: ${technicalName}`);

  const warnings: string[] = [];
  const manual: string[] = [];
  const columns: ColumnMapping[] = [];
  const elements: Record<string, CsnElement> = {};

  // Column names first, so measure → currency/unit references resolve to target names.
  const colOf = new Map<string, string>();
  for (const f of adso.fields) {
    const col = columnName(f.name);
    if (!NAME_RE.test(col)) throw new Error(`BW field ${f.name} has no valid Datasphere column name (${col})`);
    const clash = [...colOf.entries()].find(([, c]) => c.toUpperCase() === col.toUpperCase());
    if (clash) throw new Error(`BW fields ${clash[0]} and ${f.name} both map to column ${col}`);
    colOf.set(f.name, col);
  }

  const hasMeasures = adso.fields.some((f) => f.isKeyFigure);

  for (const f of adso.fields) {
    const col = colOf.get(f.name)!;
    const t = mapType(f);
    if (!t) throw new Error(`BW field ${f.name}: data type ${f.dataType} has no mapping yet`);

    const el: CsnElement = { '@EndUserText.label': f.label, type: t.type };
    if (t.length !== undefined) el.length = t.length;
    if (t.precision !== undefined) el.precision = t.precision;
    if (t.scale !== undefined) el.scale = t.scale;
    if (f.isKey) el.key = true;

    let role: ColumnRole = f.isKey ? 'key' : 'attribute';

    if (f.dataType === 'CUKY' || f.semanticType === 'currencyCode') {
      el['@Semantics.currencyCode'] = true;
      if (!f.isKey) role = 'currency';
    } else if (f.dataType === 'UNIT' || f.semanticType === 'unitOfMeasure') {
      el['@Semantics.unitOfMeasure'] = true;
      if (!f.isKey) role = 'unit';
    }

    if (f.isKeyFigure) {
      if (f.isKey) throw new Error(`key figure ${f.name} is part of the key — not supported for a fact table`);
      role = 'measure';
      el['@AnalyticsDetails.measureType'] = { '#': 'BASE' };
      const agg = (f.aggregation ?? 'SUM').toUpperCase();
      if (!AGGREGATIONS.has(agg)) warnings.push(`${f.name}: BW aggregation ${agg} has no Datasphere default aggregation; set to SUM`);
      el['@Aggregation.default'] = { '#': AGGREGATIONS.has(agg) ? agg : 'SUM' };

      const unitField = f.unitCurrencyField;
      if (f.dataType === 'CURR' || f.semanticType === 'amount') {
        if (unitField && colOf.has(unitField)) el['@Semantics.amount.currencyCode'] = { '=': colOf.get(unitField) };
        else warnings.push(`${f.name}: amount without a currency field in the aDSO (fixed currency on the InfoObject?) — not linked`);
      } else if (f.dataType === 'QUAN' || f.semanticType === 'quantity') {
        if (unitField && colOf.has(unitField)) el['@Semantics.quantity.unitOfMeasure'] = { '=': colOf.get(unitField) };
        else warnings.push(`${f.name}: quantity without a unit field in the aDSO (fixed unit on the InfoObject?) — not linked`);
      }
    }

    if (f.dataType === 'DATS') {
      warnings.push(
        f.isKey
          ? `${f.name}: DATS → cds.Date in the key — BW initial value 00000000 cannot be NULL here; map it to a fixed date (e.g. 0001-01-01) when loading`
          : `${f.name}: DATS → cds.Date — BW initial value 00000000 must be loaded as NULL`,
      );
    }

    elements[col] = el;
    columns.push({ bwField: f.name, infoObject: f.infoObject, column: col, role, bwType: describeBwType(f), dspType: describeDspType(t) });
  }

  const semanticUsage = hasMeasures ? 'ANALYTICAL_FACT' : 'DATA_STRUCTURE';
  const entity: CsnEntity = {
    kind: 'entity',
    '@EndUserText.label': adso.label,
    '@ObjectModel.modelingPattern': { '#': semanticUsage },
    '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
    elements,
  };

  // What a structure migration deliberately leaves out.
  manual.push('Data is not moved — load it with a replication flow (BW → ODP) or a transformation flow');
  const iobjs = adso.fields.filter((f) => f.infoObject && !f.isKeyFigure).map((f) => f.infoObject);
  if (iobjs.length) {
    manual.push(`Master data, texts and navigation attributes of ${iobjs.length} InfoObjects (${iobjs.join(', ')}) are not linked — associations to dimensions follow with the InfoObject converter`);
  }
  if (adso.flags.writeChangelog) {
    manual.push('aDSO writes a change log — enable delta capture on the local table if downstream flows need deltas');
  }
  if (adso.flags.planningMode) manual.push('aDSO is planning-enabled — planning has no Datasphere equivalent');

  return { technicalName, semanticUsage, csn: { definitions: { [technicalName]: entity } }, columns, warnings, manual };
}

function describeBwType(f: AdsoField): string {
  if (f.precision !== undefined) return `${f.dataType}(${f.precision},${f.scale ?? 0})`;
  return f.length !== undefined ? `${f.dataType}(${f.length})` : f.dataType;
}

function describeDspType(t: TypeMapping): string {
  const short = t.type.replace(/^cds\./, '');
  if (t.precision !== undefined) return `${short}(${t.precision},${t.scale ?? 0})`;
  return t.length !== undefined ? `${short}(${t.length})` : short;
}
