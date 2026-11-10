import type { DatasphereConfig } from '../config.js';

/**
 * The outbound side: SAP Datasphere's modeling API (/dwaas-core/api/v1), the same REST API the
 * official `datasphere` CLI calls, authenticated with an OAuth client of purpose "Technical User"
 * (client_credentials). Only what the current object types need is implemented.
 */

export type ContentFlavour = 'design-time' | 'run-time' | 'simplified' | 'all';

export interface ObjectStatus {
  technicalName: string;
  status?: string;
}

export class DatasphereError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly correlationId?: string,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** Status codes worth retrying: throttling and transient gateway/server errors. Other 4xx are permanent. */
const RETRYABLE = new Set([429, 502, 503, 504]);

export interface ClientOptions {
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Base delay of the exponential backoff (ms). */
  backoffMs?: number;
}

export class DatasphereClient {
  private token?: { value: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(readonly config: DatasphereConfig, opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.backoffMs = opts.backoffMs ?? 1000;
  }

  get space(): string {
    return this.config.space;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(this.config.tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new DatasphereError(`token request failed: HTTP ${res.status}`, res.status, undefined, await res.text());
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; accept?: string; base?: string } = {},
  ): Promise<T> {
    const url = new URL(`${this.config.host}${opts.base ?? '/dwaas-core/api/v1'}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.accessToken()}`,
            Accept: opts.accept ?? 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network error or timeout: transient. Creates are guarded by an existence check in the
        // caller, so a retried POST that had already succeeded fails with a conflict instead of
        // creating a duplicate.
        if (attempt >= this.maxAttempts) throw new DatasphereError(`${method} ${url.pathname}: ${(err as Error).message}`, 0);
        await this.sleep(attempt);
        continue;
      }
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
      // A create that was retried after a timeout/5xx can find its own object: the first attempt
      // succeeded server-side. That is success, not a conflict (seen live 2026-10-26).
      if (method === 'POST' && attempt > 1 && res.status === 409 && /ObjectAlreadyExists/.test(text)) return undefined as T;
      if (res.status === 401 && !refreshed) {
        // Token expired or revoked early: fetch a new one once; never loop on bad credentials.
        refreshed = true;
        this.token = undefined;
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
        await this.sleep(attempt, Number(res.headers.get('retry-after')) || undefined);
        continue;
      }
      const cid = res.headers.get('x-correlationid') ?? res.headers.get('x-correlation-id') ?? undefined;
      throw new DatasphereError(`${method} ${url.pathname}: HTTP ${res.status} ${summarise(text)}`, res.status, cid, text);
    }
  }

  /** Exponential backoff with full jitter; honours Retry-After (seconds) when the server sends it. */
  private sleep(attempt: number, retryAfterS?: number): Promise<void> {
    const ms = retryAfterS ? retryAfterS * 1000 : Math.random() * this.backoffMs * 2 ** (attempt - 1);
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── any repository object (views, transformationflows, replicationflows, taskchains, …) ──

  async objectStatus(collection: string, name: string): Promise<ObjectStatus | undefined> {
    const rows = await this.request<ObjectStatus[]>('GET', this.spacePath(collection), {
      query: { technicalNames: name, select: 'technicalName,status' },
    });
    return rows.find((r) => r.technicalName === name);
  }

  async getObject(collection: string, name: string, flavour: ContentFlavour = 'design-time'): Promise<any> {
    const accept = flavour === 'all' ? 'application/vnd.sap.datasphere.object.content+json' : `application/vnd.sap.datasphere.object.content.${flavour}+json`;
    return this.request('GET', this.spacePath(collection, name), { accept });
  }

  /** allowMissingDependencies: documented flag, needed when a query reads a database object outside the repository (e.g. DUMMY). */
  async createObject(collection: string, body: unknown, opts: { deploy: boolean; allowMissingDependencies?: boolean }): Promise<void> {
    await this.request('POST', this.spacePath(collection), { query: { deploy: opts.deploy, allowMissingDependencies: opts.allowMissingDependencies }, body });
  }

  async updateObject(collection: string, name: string, body: unknown, opts: { deploy: boolean; allowMissingDependencies?: boolean }): Promise<void> {
    await this.request('PUT', this.spacePath(collection, name), { query: { deploy: opts.deploy, allowMissingDependencies: opts.allowMissingDependencies }, body });
  }

  /** Deletes only objects of this migration (MIG_ prefix), never anything else in a shared space. */
  async deleteMigrationObject(collection: string, name: string): Promise<void> {
    if (!/^MIG_/.test(name)) throw new Error(`refusing to delete ${name}: only MIG_ objects may be deleted`);
    await this.request('DELETE', this.spacePath(collection, name));
  }

  async waitForObject(collection: string, name: string, timeoutMs = 300_000): Promise<ObjectStatus | undefined> {
    const until = Date.now() + timeoutMs;
    let last: ObjectStatus | undefined;
    while (Date.now() < until) {
      last = await this.objectStatus(collection, name);
      if (last?.status && !/pending|progress|deploying|running/i.test(last.status)) return last;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return last;
  }

  // ── execution ──────────────────────────────────────────────────────────

  async startReplicationFlow(name: string): Promise<unknown> {
    return this.request('POST', `/spaces/${encodeURIComponent(this.space)}/replication-flows/${encodeURIComponent(name)}/start`);
  }

  async replicationFlowStatus(name: string): Promise<any> {
    return this.request('GET', `/spaces/${encodeURIComponent(this.space)}/replication-flows/${encodeURIComponent(name)}/status`);
  }

  async runTaskChain(name: string): Promise<any> {
    return this.request('POST', `/tasks/chains/${encodeURIComponent(this.space)}/run/${encodeURIComponent(name)}`);
  }

  async taskLogs(objectName: string): Promise<any> {
    return this.request('GET', `/tasks/logs/${encodeURIComponent(this.space)}/objects/${encodeURIComponent(objectName)}`);
  }

  async taskLog(logId: string | number): Promise<any> {
    return this.request('GET', `/tasks/logs/${encodeURIComponent(this.space)}/${encodeURIComponent(String(logId))}`);
  }

  // ── data: consumption API (read-only; views exposed for consumption) ─────

  async readView(name: string, query: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const top = 1000;
    for (let skip = 0; ; skip += top) {
      const page = await this.request<{ value: Record<string, unknown>[] }>(
        'GET',
        `/${encodeURIComponent(this.space)}/${encodeURIComponent(name)}/${encodeURIComponent(name)}`,
        { base: '/api/v1/dwc/consumption/relational', query: { ...query, $top: top, $skip: skip } },
      );
      rows.push(...page.value);
      if (page.value.length < top) return rows;
    }
  }

  private spacePath(collection: string, name?: string): string {
    const base = `/spaces/${encodeURIComponent(this.space)}/${collection}`;
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  // ── local tables ────────────────────────────────────────────────────────

  async localTableStatus(name: string): Promise<ObjectStatus | undefined> {
    const rows = await this.request<ObjectStatus[]>('GET', this.spacePath('localtables'), {
      query: { technicalNames: name, select: 'technicalName,status' },
    });
    return rows.find((r) => r.technicalName === name);
  }

  async getLocalTable(name: string, flavour: ContentFlavour = 'design-time'): Promise<{ definitions: Record<string, any> }> {
    const accept =
      flavour === 'all'
        ? 'application/vnd.sap.datasphere.object.content+json'
        : `application/vnd.sap.datasphere.object.content.${flavour}+json`;
    return this.request('GET', this.spacePath('localtables', name), { accept });
  }

  async createLocalTable(csn: unknown, opts: { deploy: boolean }): Promise<void> {
    await this.request('POST', this.spacePath('localtables'), { query: { deploy: opts.deploy }, body: csn });
  }

  async updateLocalTable(name: string, csn: unknown, opts: { deploy: boolean }): Promise<void> {
    await this.request('PUT', this.spacePath('localtables', name), { query: { deploy: opts.deploy }, body: csn });
  }

  /** Polls the object status until it leaves the transient states or the timeout passes. */
  async waitForLocalTable(name: string, timeoutMs = 180_000): Promise<ObjectStatus | undefined> {
    const until = Date.now() + timeoutMs;
    let last: ObjectStatus | undefined;
    while (Date.now() < until) {
      last = await this.localTableStatus(name);
      if (last?.status && !/pending|progress|deploying|running/i.test(last.status)) return last;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return last;
  }
}

function summarise(body: string): string {
  try {
    const j = JSON.parse(body);
    const msg = j.message ?? j.error?.message ?? j.details?.message ?? j.code;
    return msg ? `— ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : `— ${body.slice(0, 400)}`;
  } catch {
    return body ? `— ${body.slice(0, 400)}` : '';
  }
}
