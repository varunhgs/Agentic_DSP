# Authentication and connection

How this server (and the original `bw-modeling-mcp`) logs on to SAP BW, keeps a session and
handles credentials. The code is in `src/bw-client.ts` (verbatim copy of the original),
`src/destination.ts` and `src/http.ts`.

---

## 1. Overview

There are **two entry points** and **three credential modes**:

| Entry point | Who runs it | Where credentials come from | Modes |
|---|---|---|---|
| `dist/stdio.js` (local) | You / Claude Code on your PC | Environment variables (`.mcp.json` `env` or `.env`) | `basic`, `cookies` |
| `dist/http.js` (BTP) | SAP BTP Cloud Foundry app | BTP Destination service, per request | `basic` (shared technical user) or `pp` (principal propagation, per user) |

All modes end in the same object: a `BwClient` (axios HTTP client + cookie jar + CSRF token)
that every tool uses. Tools never see credentials.

For our use (local, Phase 1) only **stdio + basic** matters. The rest is documented so the
same code can later run on BTP.

---

## 2. Local mode (stdio) — how the client is created

`createClientFromEnv()` → `clientFromEnvironment()` in `bw-client.ts`:

```
BW_URL missing                      → error "Required environment variable missing: BW_URL"
BW_COOKIE_FILE set                  → cookie mode  (read cookies from file)
else BW_USER + BW_PASSWORD set      → basic mode
else                                → error "Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD"
BW_CLIENT                           → default '001' if unset  (set it! ours is 100)
BW_LANGUAGE                         → optional
```

Every tool call builds a **new client** (`handleToolCall`: `currentClient() ?? createClientFromEnv()`),
so each call opens its own short SAP session.

### Where the environment comes from

In Claude Code the MCP server is registered in `.mcp.json`; its `env` block becomes the
process environment of `node dist/stdio.js`:

```json
{
  "mcpServers": {
    "bw-pc-automation-mcp": {
      "command": "node",
      "args": ["C:/path/to/pc-automation-kit-ts/dist/stdio.js"],
      "env": {
        "BW_URL": "https://<host>:<https-port>",
        "BW_USER": "<sap user>",
        "BW_PASSWORD": "<password>",
        "BW_CLIENT": "100",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

This is exactly how bw-modeling-mcp is connected on our machine
(`BW_URL=https://btp.tli-usa.local:44300`, client `100`, user `VDVARAPU`).

---

## 3. The session handshake (basic mode)

`BwClient` constructor (axios instance):
- `baseURL = BW_URL`
- default headers: `sap-client: <BW_CLIENT>`, `X-sap-adt-sessiontype: stateful`, `sap-language` (if set)
- `httpsAgent: rejectUnauthorized: false` → self-signed certificates accepted
- `validateStatus: () => true` → the code checks status itself (`>= 400` → throw with body)
- Authorization header prepared: `Basic base64(user:password)`

**Step 1 — open session + fetch CSRF token** (`fetchCsrfToken`):
```
GET /sap/bw/modeling/repo/is/systeminfo
  Authorization: Basic …
  X-CSRF-Token: Fetch
  Accept: application/xml
```
SAP returns `x-csrf-token: <token>` and `Set-Cookie` (`SAP_SESSIONID_<SID>_<client>`,
`sap-usercontext`, …). The client stores the cookies in its own jar (`updateCookies`) and the token.
No token, or the literal `Fetch` back → error *"Failed to fetch CSRF token (HTTP n). Check BW_URL,
BW_USER, BW_PASSWORD, BW_CLIENT."*

**Step 2 — every later call** sends `X-CSRF-Token: <token>` + `Cookie: <jar>` and, for most methods,
**no Authorization header**. This is deliberate: re-sending Basic Auth on a PUT makes SAP open a
new stateless session and invalidates object locks.

| Methods | Credentials sent? |
|---|---|
| `fetchCsrfToken`, `loadMediaTypes` | yes (open the session) |
| `rawPost`, `rawPut`, `rawDelete` (clean axios instance, no defaults) | yes, plus cookies |
| `get`, `rawGet`, `postRaw`, `postWithCsrf`, `lock`, `create`, `put`, `activate`, … | no — cookie + token only |

**Step 3 — token refresh:** `ensureCsrf()` refetches the token when it is older than **4 minutes**
(`CSRF_TOKEN_TTL_MS`), because SAP sessions expire after ~5 minutes idle. `postRaw` and
`postWithCsrf` clear the token after each POST, so the next call fetches a fresh one.

**Cookie jar rules:** a `Set-Cookie` with `Max-Age<=0` or a past `Expires` deletes the cookie
(re-sending a stale `sap-contextid` causes "No Suitable Resource Found"). Cookies loaded from a
cookie file are frozen and never overwritten.

**Debug:** `BW_DEBUG_SESSION=1` prints every `Set-Cookie` and the jar to stderr.

### What the new tools use
| Tool group | Method | Path |
|---|---|---|
| Run log / steps | `postRaw` (cookie + token) | `POST /sap/bc/adt/datapreview/freestyle` with a SELECT on RSPCLOGCHAIN / RSPCPROCESSLOG / TBTCO |
| Start / restart / status / set status / interrupt | `postRaw` (cookie + token) | `POST /sap/bc/soap/rfc` with a SOAP envelope calling `RSPC_API_*` |

Same login, same session — nothing extra to configure except activating `/sap/bc/soap/rfc` once.

---

## 4. Cookie mode (SSO-only systems)

For systems behind SAML/OAuth where Basic Auth is not allowed (e.g. BW Bridge):
- Log on in a browser, export cookies (Netscape format, or `name=value` lines; `#` = comment).
- Set `BW_COOKIE_FILE=<path>`; leave `BW_USER`/`BW_PASSWORD` unset.
- In this mode `sap-client` and `X-sap-adt-sessiontype` are **not** sent as defaults.
- When cookies expire: *"Cookie mode in use — refresh cookies in BW_COOKIE_FILE and restart the MCP server."*

---

## 5. BTP mode (`dist/http.js`) — later, optional

Flow per request:
1. **XSUAA** (`@arc-mcp/xsuaa-auth` `setupHttpAuth`) validates the caller's JWT. Scopes `read` / `write`
   (`xs-security.json`, role collections "BW MCP Reader/Developer") decide which tools are listed
   and callable (`scopes.ts`; anything not in `READ_TOOLS` needs `write`).
2. **Destination** `BW_BTP_DESTINATION` is looked up:
   - `Authentication=BasicAuthentication` → `createSharedDestinationClient`: one technical user for everyone.
   - `Authentication=PrincipalPropagation` + `BW_PP_ENABLED=true` → `createPrincipalPropagationClient`:
     the caller's JWT is exchanged for `SAP-Connectivity-Authentication`; the Cloud Connector turns it
     into a short-lived X.509 certificate, so BW sees the real user. Fails closed — never falls back to
     a shared user. Startup refuses `BW_PP_ENABLED=true` together with `BW_USER/BW_PASSWORD/BW_COOKIE_FILE`.
3. **Cloud Connector** (on-premise BW): destination URL must be `http://` (virtual host); the proxy adds
   `Proxy-Authorization: Bearer <token>` and optional `SAP-Connectivity-SCC-Location_ID`.
4. The per-request `BwClient` is stored in AsyncLocalStorage (`request-context.ts`) so tools pick it up.

Env vars for BTP: `BW_BTP_DESTINATION`, `BW_PP_ENABLED`, `BW_CC_LOCATION_ID`, `BW_PUBLIC_URL`,
`BW_ALLOWED_ORIGINS`, `PORT`, plus bound services (xsuaa, destination, connectivity) — see `manifest.yml`.

> Note: `rawPost/rawPut/rawDelete` use a clean axios instance **without** the Cloud Connector proxy.
> The new tools use `postRaw`, which goes through the proxy, so they are BTP-compatible.

---

## 6. Credential handling rules

1. Never hard-code credentials. Only environment variables (`.mcp.json` `env`, `.env`, or BTP destination).
2. `.env` and `.mcp.json` are in `.gitignore`; commit only the `*.example` files.
   (In the original bw-modeling-mcp folder, `.mcp.json` holds the password in plain text and is **not**
   git-ignored — do not repeat that.)
3. Local POC: your personal SAP user is fine. Client systems: a dedicated technical user with only the
   authorizations in SETUP-SAP.md.
4. TLS: `rejectUnauthorized: false` is acceptable for a local self-signed system. For a client system,
   install their CA and change it to `true` (or set `NODE_EXTRA_CA_CERTS=<ca.pem>`) in `bw-client.ts`.
5. Errors may include SAP response bodies but never the password; `BW_DEBUG_SESSION` prints cookies — use
   it only locally.
6. Production: keep secrets in a vault (BTP destination, Windows Credential Manager, Azure Key Vault…).

---

## 7. SAP-side requirements for the connection

| Item | Why |
|---|---|
| HTTPS port reachable (`443NN`) | all calls |
| ICF `/sap/bw/modeling` active | session opening (`repo/is/systeminfo`) and chain design tools |
| ICF `/sap/bc/adt` active | run log / steps (data preview) |
| ICF `/sap/bc/soap/rfc` active | start / restart / status / set status / interrupt |
| ICF `/sap/opu/odata/sap/*` services active | BW/4HANA monitor tools only |
| User authorizations | see SETUP-SAP.md |
