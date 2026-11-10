import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** migration/ — one level above dist/ or src/. */
export const MIGRATION_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The bw-modeling-mcp repository the migration sits in. */
export const REPO_ROOT = join(MIGRATION_ROOT, '..');

let envLoaded = false;
function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = join(MIGRATION_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface DatasphereConfig {
  host: string;
  space: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export function loadDatasphereConfig(): DatasphereConfig {
  loadEnvFile();
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set (migration/.env or environment) — see migration/.env.example`);
    return v;
  };
  return {
    host: need('DSP_HOST').replace(/\/+$/, ''),
    space: need('DSP_SPACE'),
    clientId: need('DSP_CLIENT_ID'),
    clientSecret: need('DSP_CLIENT_SECRET'),
    tokenUrl: need('DSP_TOKEN_URL'),
  };
}

const BW_KEYS = ['BW_URL', 'BW_USER', 'BW_PASSWORD', 'BW_CLIENT', 'BW_LANGUAGE', 'BW_COOKIE_FILE', 'BW_PLATFORM', 'NODE_OPTIONS'];

/**
 * Environment for the BW MCP server. Explicit BW_* variables win; otherwise the env block of the
 * "bw-modeling" entry in the repository's .mcp.json is reused, so the server runs with exactly the
 * configuration the IDE already uses.
 */
export function loadBwEnv(): Record<string, string> {
  loadEnvFile();
  if (process.env.BW_URL) {
    return Object.fromEntries(BW_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));
  }
  const mcpJson = join(REPO_ROOT, '.mcp.json');
  if (!existsSync(mcpJson)) throw new Error('BW_URL is not set and no .mcp.json was found in the repository root');
  const servers = JSON.parse(readFileSync(mcpJson, 'utf8')).mcpServers ?? {};
  const entry = servers['bw-modeling'] ?? Object.values(servers)[0];
  if (!entry?.env?.BW_URL) throw new Error('.mcp.json has no bw-modeling server with BW_URL');
  return entry.env as Record<string, string>;
}
