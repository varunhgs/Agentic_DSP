import type { AdsoField } from '../bw/adso-parser.js';
import { mapType } from './adso-to-local-table.js';

/**
 * BW DataSource (RSDS) → Datasphere local table holding the DataSource's records: the landing
 * table a replication flow from the source system fills, and the source of the migrated
 * DataSource → aDSO transformation. One column per transferred DataSource field (fields with
 * transfer="false", such as the ODQ_* technical fields, are left out), named as in BW. A
 * DataSource declares no semantic key, so the table has none.
 */

export interface DataSourceField {
  name: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  label?: string;
  transfer: boolean;
}

export interface ParsedDataSource {
  name: string;
  sourceSystem: string;
  label?: string;
  fields: DataSourceField[];
}

const num = (s?: string) => (s === undefined || s === '' ? undefined : Number(s));
const attr = (src: string, n: string) => src.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];

export function parseDataSourceXml(xml: string): ParsedDataSource {
  const root = xml.match(/<rsds:dataSource\b[^>]*>/)?.[0];
  if (!root) throw new Error('not a DataSource document (no rsds:dataSource root)');
  const fields = [...xml.matchAll(/<field name="([^"]+)"[^>]*>([\s\S]*?)<\/field>/g)].map(([, name, body]) => {
    const t = body.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
    return {
      name,
      dataType: attr(t, 'name') ?? '',
      length: num(attr(t, 'length')),
      precision: num(attr(t, 'precision')),
      scale: num(attr(t, 'scale')),
      label: body.match(/<description\b[^>]*label="([^"]*)"/)?.[1],
      transfer: attr(body, 'transfer') !== 'false',
    };
  });
  return { name: attr(root, 'name') ?? '', sourceSystem: attr(root, 'sourceSystemName') ?? '', label: xml.match(/<endUserTexts label="([^"]*)"/)?.[1], fields };
}

export function convertDataSourceToLocalTable(ds: ParsedDataSource, opts: { prefix: string }): { technicalName: string; csn: { definitions: Record<string, any> }; skipped: string[] } {
  const technicalName = `${opts.prefix}DS_${ds.name.replace(/^\//, '').replace(/\//g, '_')}`;
  const elements: Record<string, any> = {};
  const skipped: string[] = [];
  for (const f of ds.fields) {
    if (!f.transfer) {
      skipped.push(f.name);
      continue;
    }
    // DEC without precision in the DataSource XML carries its digits in "length".
    const t = mapType({ name: f.name, dataType: f.dataType, length: f.length, precision: f.precision ?? (f.dataType === 'DEC' ? f.length : undefined), scale: f.scale } as AdsoField);
    if (!t) throw new Error(`DataSource field ${f.name}: type ${f.dataType} has no mapping`);
    elements[f.name] = { '@EndUserText.label': f.label ?? f.name, ...t };
  }
  return {
    technicalName,
    csn: {
      definitions: {
        [technicalName]: {
          kind: 'entity',
          '@EndUserText.label': `DataSource ${ds.name} (${ds.sourceSystem})`,
          '@ObjectModel.modelingPattern': { '#': 'DATA_STRUCTURE' },
          '@ObjectModel.supportedCapabilities': [{ '#': 'DATA_STRUCTURE' }],
          elements,
        },
      },
    },
    skipped,
  };
}
