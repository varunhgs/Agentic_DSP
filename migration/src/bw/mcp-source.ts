import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT, loadBwEnv } from '../config.js';

/**
 * The inbound side: the existing bw-modeling-mcp server, started over stdio and called through its
 * public tools — the same way an AI client uses it. Nothing of the server is reimplemented here.
 */
export class BwMcpSource {
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<BwMcpSource> {
    const server = join(REPO_ROOT, 'dist', 'stdio.js');
    if (!existsSync(server)) throw new Error(`BW MCP server not built: ${server} (run "npm run build" in the repository root)`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...getDefaultEnvironment(), ...loadBwEnv() },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'bw-datasphere-migration', version: '0.1.0' });
    await client.connect(transport);
    return new BwMcpSource(client);
  }

  async callText(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name: tool, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(`${tool} failed: ${text}`);
    return text;
  }

  /** The aDSO definition as BW returns it — the raw XML document, without the tool's header lines. */
  async getAdsoXml(name: string): Promise<string> {
    const text = await this.callText('bw_get_adso', { adso_name: name, format: 'raw' });
    const start = text.indexOf('<?xml');
    if (start < 0) throw new Error(`bw_get_adso returned no XML for ${name}: ${text.slice(0, 300)}`);
    return text.slice(start);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
