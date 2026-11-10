/**
 * Object-name helpers shared by the read tools.
 *
 * BW modeling URLs encode a namespace slash as "%24" ($): /JBPB/IPLAN is served at
 * /sap/bw/modeling/adso/%24jbpb%24iplan/m (verified against BW/4HANA 2.0 SP17 and in the
 * atom:link hrefs BW itself returns). Lowercasing alone yields "/jbpb/iplan", which BW
 * answers with HTTP 404.
 */
export function encodeBwObjectName(name: string): string {
  return name.trim().toLowerCase().replace(/\//g, '%24');
}

/**
 * ADT repository URLs take the plain lowercase name with "/" percent-encoded (%2F),
 * e.g. /sap/bc/adt/oo/classes/%2Fbic%2Fabc_m/source/main.
 */
export function encodeAdtObjectName(name: string): string {
  return encodeURIComponent(name.trim().toLowerCase());
}

/**
 * Guard for names that are interpolated into ADT data-preview SQL. Only BW technical
 * names are accepted (letters, digits, underscore, namespace slashes; max 40 chars), so a
 * caller-supplied value can never change the statement.
 */
export function assertBwTechnicalName(name: string): string {
  const upper = name.trim().toUpperCase();
  if (!/^[A-Z0-9_/]{1,40}$/.test(upper)) {
    throw new Error(`Invalid BW technical name: "${name}"`);
  }
  return upper;
}
