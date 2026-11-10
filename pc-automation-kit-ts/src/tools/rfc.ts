import { XMLParser } from 'fast-xml-parser';
import { BwClient } from '../bw-client.js';

/**
 * Call a remote-enabled ABAP function module over HTTPS through the standard
 * SOAP-RFC service /sap/bc/soap/rfc.
 *
 * Uses the same BwClient session as every other tool (Basic Auth on the session-opening
 * request, then session cookie + CSRF token), so no RFC SDK and no extra credentials.
 *
 * Prerequisite on the SAP side: ICF service /sap/bc/soap/rfc must be active (SICF).
 * When it is not, SAP answers HTTP 403 "Service cannot be reached" — see docs/SETUP-SAP.md.
 *
 * Wire format (SAP SOAP-RFC):
 *   request : <urn:FM_NAME><PARAM>value</PARAM><TABLE_PARAM><item>…</item></TABLE_PARAM></urn:FM_NAME>
 *   response: <rfc:FM_NAME.Response><PARAM>…</PARAM><TABLE_PARAM><item>…</item></TABLE_PARAM></…>
 * A TABLES parameter is only returned when it is present in the request, so pass every
 * table you want back (an empty array sends an empty element).
 */

const SOAP_PATH = '/sap/bc/soap/rfc';
const RFC_NS = 'urn:sap-com:document:sap:rfc:functions';

export type RfcValue = string | number | boolean | RfcStructure | RfcStructure[];
export interface RfcStructure { [field: string]: RfcValue }
export type RfcResult = Record<string, unknown>;

export class RfcError extends Error {
  constructor(message: string, readonly exception?: string) {
    super(message);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(name: string, value: RfcValue): string {
  if (Array.isArray(value)) {
    return `<${name}>${value.map((row) => toXml('item', row)).join('')}</${name}>`;
  }
  if (typeof value === 'object') {
    return `<${name}>${Object.entries(value).map(([k, v]) => toXml(k, v)).join('')}</${name}>`;
  }
  if (typeof value === 'boolean') {
    return `<${name}>${value ? 'X' : ''}</${name}>`;
  }
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

export function buildEnvelope(fm: string, params: Record<string, RfcValue>): string {
  const body = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => toXml(k, v))
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${RFC_NS}">` +
    `<soapenv:Body><urn:${fm}>${body}</urn:${fm}></soapenv:Body></soapenv:Envelope>`
  );
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Keep every value a string: LOG_IDs, job counts and NUMC fields have leading zeros.
  parseTagValue: false,
  // Table rows are always arrays, even when SAP returns a single row.
  isArray: (name) => name === 'item',
});

export function parseResponse(fm: string, xml: string): RfcResult {
  const doc = parser.parse(xml) as Record<string, any>;
  const body = doc?.Envelope?.Body ?? {};
  if (body.Fault) {
    const fault = body.Fault;
    const detail = fault.detail ?? {};
    const exceptionNode = Object.values(detail)[0] as Record<string, unknown> | undefined;
    // Exception detail: <Name>FAILED</Name><Text>…</Text><Message><ID>RSPC</ID><Number>001</Number></Message>
    const exception = (exceptionNode?.Name as string | undefined) ?? undefined;
    const msg = exceptionNode?.Message as { ID?: string; Number?: string } | undefined;
    const text = (exceptionNode?.Text as string | undefined) ?? String(fault.faultstring ?? 'SOAP fault');
    const msgRef = msg?.ID ? ` (message ${msg.ID} ${msg.Number ?? ''})` : '';
    throw new RfcError(`${fm} raised ${exception ?? 'a fault'}: ${text}${msgRef}`, exception);
  }
  const response = body[`${fm}.Response`];
  if (response === undefined) {
    throw new RfcError(`${fm}: unexpected SOAP response\n${xml.slice(0, 500)}`);
  }
  // An empty response element parses to '' — normalise to an object.
  return typeof response === 'object' && response !== null ? response : {};
}

/** Rows of a TABLES parameter (always an array). */
export function tableRows(result: RfcResult, table: string): Record<string, string>[] {
  const node = result[table] as { item?: Record<string, string>[] } | '' | undefined;
  return node && typeof node === 'object' ? node.item ?? [] : [];
}

export async function callRfc(
  client: BwClient,
  fm: string,
  params: Record<string, RfcValue> = {},
): Promise<RfcResult> {
  const envelope = buildEnvelope(fm, params);
  let body: string;
  try {
    body = await client.postRaw(SOAP_PATH, envelope, 'text/xml; charset=utf-8', {
      SOAPAction: RFC_NS,
      Accept: 'text/xml',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A SOAP fault arrives as HTTP 500 with the fault envelope as body.
    const xmlStart = message.indexOf('<');
    if (/HTTP 500/.test(message) && xmlStart >= 0) {
      return parseResponse(fm, message.slice(xmlStart));
    }
    if (/HTTP 403/.test(message) && /Service cannot be reached/i.test(message)) {
      throw new RfcError(
        `SOAP-RFC service ${SOAP_PATH} is not active on this system (HTTP 403). ` +
          'Ask Basis to activate it in transaction SICF (default_host/sap/bc/soap/rfc). See docs/SETUP-SAP.md.',
      );
    }
    throw err;
  }
  return parseResponse(fm, body);
}
