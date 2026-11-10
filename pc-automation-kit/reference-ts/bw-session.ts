// REFERENCE ONLY — trimmed extract of src/bw-client.ts (bw-modeling-mcp).
// Shows: auth modes, axios setup, cookie jar, CSRF fetch/refresh, rawGet, createClientFromEnv.
// Lock registry, BW object media types and modeling write methods were removed.

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { currentClient } from './request-context.js';

/** Cloud Connector hop. The token expires, so it is resolved per request. */
export interface BwProxyConfig {
  host: string;
  port: number;
  /** Connectivity-service token, sent as `Proxy-Authorization: Bearer …`. */
  token: string;
  /** `SAP-Connectivity-SCC-Location_ID`, when several Cloud Connectors serve the subaccount. */
  locationId?: string;
}

/**
 * How a client authenticates to BW.
 *
 * `pp` is BTP principal propagation: the Destination service returns a value that the
 * Cloud Connector converts into a short-lived X.509 certificate for the calling user.
 * It is deliberately a separate variant rather than an extra optional field, so a
 * per-user client cannot also carry a shared credential.
 */
export type BwAuth =
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'cookies'; cookies: Record<string, string> }
  | { kind: 'pp'; connectivityAuth: string };

export interface BwClientOptions {
  url: string;
  auth: BwAuth;
  client?: string;
  language?: string;
  proxy?: BwProxyConfig;
  /**
   * Stable identity of the caller, used to scope the lock registry below. Set it wherever
   * the credential itself is not stable per user — principal propagation hands out a fresh
   * connectivity token per request, so without this every request would look like a
   * different identity and no lock could ever be matched to its session.
   */
  identity?: string;
}
export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfTokenFetchedAt: number = 0;
  // SAP sessions time out after ~5 minutes of inactivity; refresh the token before that.
  private static readonly CSRF_TOKEN_TTL_MS = 4 * 60 * 1000;
  private cookies: Map<string, string> = new Map();
  // Basic Auth is only sent during the initial CSRF fetch to establish the session.
  // All subsequent requests use the session cookie only — sending Basic Auth on PUT
  // causes SAP to create a new stateless session, invalidating the lock handle.
  private readonly basicAuth: string | null;
  private readonly frozenCookies: Set<string> = new Set();
  // Temporary session diagnostics — enable with BW_DEBUG_SESSION=1 (or "true").
  // All debug output goes to stderr so it never corrupts the MCP stdio protocol.
  private readonly sessionDebug: boolean =
    process.env.BW_DEBUG_SESSION === '1' || process.env.BW_DEBUG_SESSION === 'true';

  private readonly opts: BwClientOptions;

  constructor(opts: BwClientOptions) {
    this.opts = opts;
    this.basicAuth = opts.auth.kind === 'basic'
      ? 'Basic ' + Buffer.from(`${opts.auth.user}:${opts.auth.password}`).toString('base64')
      : null;

    // In cookie mode (e.g. BW Bridge): do not send sap-client and X-sap-adt-sessiontype
    // as global defaults. BW Bridge rejects stateful requests with 401 when no
    // pre-established backend session exists on the app instance pointed to by __VCAP_ID__.
    const isCookieMode = opts.auth.kind === 'cookies';
    this.http = axios.create({
      baseURL: opts.url,
      // Cloud Connector: standard absolute-URI proxying. Note the destination URL must
      // be http:// — an https:// target makes axios tunnel with CONNECT, which drops the
      // Proxy-Authorization and SAP-Connectivity-Authentication headers, and the
      // connectivity proxy answers 405.
      // `undefined`, never `false`: false would also disable the HTTP_PROXY/http_proxy
      // environment variables, and some hosts are reachable only through that proxy —
      // it resolves the host and performs the destination lookup itself.
      proxy: opts.proxy
        ? { host: opts.proxy.host, port: opts.proxy.port, protocol: 'http' }
        : undefined,
      headers: {
        ...(isCookieMode ? {} : {
          ...(opts.client ? { 'sap-client': opts.client } : {}),
          'X-sap-adt-sessiontype': 'stateful',
        }),
        ...(opts.language ? { 'sap-language': opts.language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];

    // Proxy credentials belong on every request, unlike the identity header — the
    // connectivity proxy authorizes each hop individually. An interceptor keeps that
    // out of the ~20 individual request methods.
    if (opts.proxy) {
      const proxy = opts.proxy;
      this.http.interceptors.request.use((config) => {
        config.headers.set('Proxy-Authorization', `Bearer ${proxy.token}`);
        if (proxy.locationId) config.headers.set('SAP-Connectivity-SCC-Location_ID', proxy.locationId);
        return config;
      });
    }

    // Cookie mode: pre-populate cookie store from caller. Used for SAML/OAuth-fronted
    // systems where Basic Auth is not available and cookies are exported from a browser.
    if (opts.auth.kind === 'cookies') {
      for (const [name, value] of Object.entries(opts.auth.cookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
  }
  /**
   * The identity credential, applied exactly where this client already sent Basic Auth
   * — i.e. only on the session-establishing CSRF fetch.
   *
   * That placement is deliberate and load-bearing: re-sending a credential on a PUT
   * makes SAP open a new stateless session and invalidates the lock handle (see the
   * note on `basicAuth`). Principal propagation follows the same rule, so
   * `SAP-Connectivity-Authentication` establishes the session and the session cookie
   * carries it from there.
   *
   * `Authorization` is never sent under principal propagation — SAP reserves it for
   * basic auth to the backend, and sending it breaks identity propagation.
   */
  private authHeaders(): Record<string, string> {
    if (this.basicAuth) return { Authorization: this.basicAuth };
    if (this.opts.auth.kind === 'pp') {
      return { 'SAP-Connectivity-Authentication': this.opts.auth.connectivityAuth };
    }
    return {};
  }

  // ── Session info (debug) ──────────────────────────────────────────────────

  /** Returns a snapshot of the current session cookies — for debug assertions only. */
  public sessionInfo(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  // ── Cookie management ──────────────────────────────────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    if (this.sessionDebug) {
      console.error(`[bw-session] Set-Cookie received: ${JSON.stringify(setCookies)}`);
    }
    for (const c of setCookies) {
      const attrs = c.split(';');
      const part = attrs[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = part.substring(0, eqIdx).trim();
      if (this.frozenCookies.has(name)) continue;
      const value = part.substring(eqIdx + 1).trim();
      // Honour explicit cookie deletions (Max-Age<=0 or Expires in the past): drop the
      // cookie from the jar instead of re-sending a stale value. Re-sending a session
      // cookie (e.g. sap-contextid) that the server has already rolled out is a likely
      // cause of intermittent "No Suitable Resource Found" errors on stateful calls.
      if (this.isCookieDeletion(attrs)) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
    }
    if (this.sessionDebug) {
      console.error(`[bw-session] cookie jar now: ${JSON.stringify(Object.fromEntries(this.cookies.entries()))}`);
    }
  }

  // A Set-Cookie is a deletion when Max-Age is <= 0 or Expires is in the past.
  private isCookieDeletion(attrs: string[]): boolean {
    for (const a of attrs.slice(1)) {
      const eq = a.indexOf('=');
      const key = (eq >= 0 ? a.slice(0, eq) : a).trim().toLowerCase();
      const val = eq >= 0 ? a.slice(eq + 1).trim() : '';
      if (key === 'max-age') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n <= 0) return true;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (Number.isFinite(t) && t <= Date.now()) return true;
      }
    }
    return false;
  }

  // ── CSRF token ─────────────────────────────────────────────────────────────

  private async fetchCsrfToken(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        ...this.authHeaders(),
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      if (this.basicAuth) {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.`
        );
      } else {
        throw new Error(
          `Failed to fetch CSRF token (HTTP ${response.status}). ` +
          `Cookie mode in use — refresh cookies in BW_COOKIE_FILE and restart the MCP server.`
        );
      }
    }
    this.csrfToken = token;
    this.csrfTokenFetchedAt = Date.now();
  }

  private async ensureCsrf(): Promise<void> {
    const stale = !this.csrfToken ||
      (Date.now() - this.csrfTokenFetchedAt) > BwClient.CSRF_TOKEN_TTL_MS;
    if (stale) {
      await this.fetchCsrfToken();
    }
  }

  public clearCsrfToken(): void {
    this.csrfToken = null;
  }

  private cookieHeaders(): Record<string, string> {
    const hdr = this.cookieHeader();
    return hdr ? { Cookie: hdr } : {};
  }

  // ── Public HTTP helpers ────────────────────────────────────────────────────
  async rawGet(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    await this.ensureCsrf();
    const response = await this.http.get(url, {
      headers: {
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
        ...headers,
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }
  // ... (other methods removed) ...
}

 * Keeping the signature means no tool file had to be touched for principal propagation.
 */
export function createClientFromEnv(): BwClient {
  const active = currentClient();
  if (active) return active.freshSession();
  return clientFromEnvironment();
}

function clientFromEnvironment(): BwClient {
  const url = process.env.BW_URL;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  const cookieFile = process.env.BW_COOKIE_FILE;

  if (!url) {
    throw new Error('Required environment variable missing: BW_URL');
  }

  // Cookie mode: BW Bridge or other SAML/OAuth-fronted BW systems where Basic Auth
  // is not available. Cookies are exported from an authenticated browser session.
  // File format (vsp-compatible): Netscape (7 tab-separated fields) or simple
  // "name=value" lines. Lines starting with # are comments.
  if (cookieFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(cookieFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read BW_COOKIE_FILE at ${cookieFile}: ${(err as Error).message}`
      );
    }
    const cookies: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        cookies[parts[5]] = parts[6];
      } else {
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
      }
    }
    if (Object.keys(cookies).length === 0) {
      throw new Error(
        `BW_COOKIE_FILE at ${cookieFile} contains no parseable cookies (expected Netscape or name=value format).`
      );
    }
    return new BwClient({ url, client, language, auth: { kind: 'cookies', cookies } });
  }

  // Basic Auth mode: classic on-premise BW/4HANA — unchanged from previous behavior.
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient({ url, client, language, auth: { kind: 'basic', user, password } });
}
