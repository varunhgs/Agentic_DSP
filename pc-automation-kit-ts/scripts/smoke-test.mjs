#!/usr/bin/env node
/**
 * Read-only smoke test. Starts the MCP server (dist/stdio.js) exactly as an MCP client
 * would, lists the tools and calls a few READ tools. Changes nothing in SAP.
 *
 *   npm run build
 *   npm run smoke                      # uses the latest run of any chain
 *   npm run smoke -- ZPC_MY_CHAIN      # a specific chain
 *
 * Credentials come from the environment or from a .env file in the project root
 * (BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT, BW_LANGUAGE). Never commit .env.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const env = { ...loadDotEnv(), ...process.env };
for (const k of ['BW_URL', 'BW_USER', 'BW_PASSWORD']) {
  if (!env[k] && !env.BW_COOKIE_FILE) {
    console.error(`Missing ${k}. Fill .env (copy .env.example) or set it in the environment.`);
    process.exit(1);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'stdio.js')],
  env,
  stderr: 'ignore',
});
const client = new Client({ name: 'pc-kit-smoke', version: '0.1.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text).join('\n') ?? '';
  console.log(`\n===== ${name} ${JSON.stringify(args)} ${res.isError ? '(ERROR)' : ''}`);
  console.log(text.split('\n').slice(0, 40).join('\n'));
  return text;
}

const { tools } = await client.listTools();
console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

const log = await call('bw_list_process_chain_log', { ...(process.argv[2] ? { chain_id: process.argv[2] } : {}), limit: 3 });
const chain = process.argv[2] ?? /Chain:\s+(\S+)/.exec(log)?.[1];
if (chain) {
  await call('bw_get_process_chain_steps', { chain_id: chain });
  await call('bw_get_process_chain', { chain_name: chain, include_variant_details: false });
}
await call('bw_check_rfc_connection');

await client.close();
