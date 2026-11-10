import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { REPO_ROOT } from '../config.js';

/** One aDSO field, normalised from the BW modeling XML. */
export interface AdsoField {
  /** Field name in the aDSO (the InfoObject name for InfoObject-based fields). */
  name: string;
  /** Set when the field is based on an InfoObject. */
  infoObject?: string;
  label: string;
  /** ABAP/BW data type: CHAR, NUMC, DATS, TIMS, CURR, QUAN, CUKY, UNIT, DEC, INT4, ... */
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  isKey: boolean;
  isKeyFigure: boolean;
  /** BW aggregation behaviour of a key figure (SUM, MIN, MAX, NOP, ...). */
  aggregation?: string;
  /** For CURR/QUAN key figures: the field holding the currency or unit. */
  unitCurrencyField?: string;
  /** BW semantic type: amount, quantity, currencyCode, unitOfMeasure, date, ... */
  semanticType?: string;
  conversionRoutine?: string;
}

export interface AdsoDefinition {
  name: string;
  label: string;
  infoArea?: string;
  flags: Record<string, boolean>;
  /** Fields in key order first, then in the order BW lists the rest. */
  fields: AdsoField[];
  keyFields: string[];
}

const ref = (s: unknown): string => String(s ?? '').replace(/^#\/\/\//, '');
const num = (s: unknown): number | undefined => (s === undefined || s === '' ? undefined : Number(s));
const FLAGS = ['activateData', 'writeChangelog', 'directUpdate', 'cubeDeltaOnly', 'isReportingObject', 'planningMode', 'isNcum', 'snapShotScenario', 'uniqueDataRecords'];

export function parseAdsoXml(xml: string): AdsoDefinition {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (name) => name === 'element' || name === 'keyElement',
  });
  const doc = parser.parse(xml);
  const root = doc['adso:dataStore'];
  if (!root) throw new Error('not an aDSO document (no adso:dataStore root)');

  const keyFields: string[] = (root.keyElement ?? []).map(ref);
  const keySet = new Set(keyFields);

  const fields: AdsoField[] = (root.element ?? []).map((e: any): AdsoField => {
    const t = e.inlineType ?? {};
    const props = e.localProperties ?? {};
    const isKeyFigure =
      props['@_xsi:type'] === 'BwCore:LocalKeyfigureProperties' || e.consumptionViewProperties?.['@_objectType'] === 'KYF';
    return {
      name: e['@_name'],
      infoObject: e['@_infoObjectName'] || undefined,
      label: e.endUserTexts?.['@_label'] ?? props.descriptions?.['@_label'] ?? e['@_name'],
      dataType: t['@_name'],
      length: num(t['@_length']),
      precision: num(t['@_precision']),
      scale: num(t['@_scale']),
      isKey: keySet.has(e['@_name']),
      isKeyFigure,
      aggregation: isKeyFigure ? e['@_aggregationBehavior'] : undefined,
      unitCurrencyField: e.unitCurrencyElement ? ref(e.unitCurrencyElement) : undefined,
      semanticType: t['@_semanticType'] && t['@_semanticType'] !== 'empty' ? t['@_semanticType'] : undefined,
      conversionRoutine: e['@_conversionRoutine'] || undefined,
    };
  });

  const byName = new Map(fields.map((f) => [f.name, f]));
  const ordered = [...keyFields.map((k) => byName.get(k)!).filter(Boolean), ...fields.filter((f) => !f.isKey)];

  return {
    name: root['@_name'],
    label: root.endUserTexts?.['@_label'] ?? root['@_name'],
    infoArea: root.tlogoProperties?.infoArea,
    flags: Object.fromEntries(FLAGS.map((k) => [k, root[`@_${k}`] === 'true'])),
    fields: ordered,
    keyFields,
  };
}

/**
 * aDSO modelling type (standard, staging_*, datamart, direct_update), classified by the BW MCP's own
 * logic rather than a second copy of it. Returns the candidates in order of likelihood.
 */
export async function classifyAdso(xml: string): Promise<string[]> {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, 'dist', 'tools', 'adso.js')).href)) as {
    adsoTypeCandidates(xml: string): string[];
  };
  const rootTag = xml.match(/<adso:dataStore\b[^>]*>/)?.[0];
  if (!rootTag) throw new Error('not an aDSO document (no adso:dataStore root)');
  return mod.adsoTypeCandidates(rootTag);
}
