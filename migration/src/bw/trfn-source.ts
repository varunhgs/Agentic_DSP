import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../config.js';
import type { BwTransformation } from '../ir/transformation-ir.js';

/**
 * Transformation XML → parsed structure, with the BW MCP's own parser (src/tools/trfn_logic.ts)
 * rather than a second copy of it. The same structure is what `bw_get_transformation`
 * (format "json") returns live, so the IR builder accepts either.
 */
export async function parseTransformationXml(xml: string): Promise<BwTransformation> {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, 'dist', 'tools', 'trfn_logic.js')).href)) as {
    parseTransformationXml(xml: string): BwTransformation;
  };
  return mod.parseTransformationXml(xml);
}
