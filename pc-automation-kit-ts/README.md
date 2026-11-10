# BW Process Chain Automation MCP (TypeScript)

An MCP server for **SAP BW process chains**, built with the same architecture, authentication
and code as `bw-modeling-mcp`, cut down to process chains only. On top of the process-chain
tools from that project it adds **run control**: list runs, show every step (including
sub-chains), start, check status, restart only failed steps, set a step's status, interrupt.

This folder is self-contained. Copy it anywhere, run `npm install`, and it works on its own.

---

## 1. What you get

| Group | Tools | Source |
|---|---|---|
| Read chain design | `bw_get_process_chain`, `bw_get_process_variant` | copied from bw-modeling-mcp |
| Monitor (BW/4HANA OData) | `bw_list_process_chain_runs`, `bw_get_process_chain_run_detail`, `bw_list_process_chain_last_status` | copied |
| Requests | `bw_list_requests`, `bw_get_request`, `bw_activate_request` | copied |
| Build / change chains | `bw_create_process_chain`, `bw_update_process_chain`, `bw_activate_process_chain`, `bw_create_decision_variant`, `bw_add_process_chain_error_links`, `bw_swap_process_chain_dtp`, `bw_append_process_chain_dtp`, `bw_add_process_chain_program` | copied |
| Transports | `bw_list_changeable_transports`, `bw_create_transport_task` | copied |
| **Run log (works on BW 7.5 too)** | `bw_list_process_chain_log`, `bw_get_process_chain_steps` | **new** — reads RSPCLOGCHAIN / RSPCPROCESSLOG / TBTCO |
| **Run control** | `bw_check_rfc_connection`, `bw_get_process_chain_status`, `bw_start_process_chain`, `bw_restart_process_chain`, `bw_set_process_status`, `bw_interrupt_process_chain` | **new** — calls SAP `RSPC_API_*` function modules |

Full tool reference: [docs/TOOLS.md](docs/TOOLS.md).

### What works today on our local system (tested)

| Feature | Status |
|---|---|
| Login (Basic Auth + CSRF + session cookie) | ✅ works |
| All read tools (chain definition, run log, steps with sub-chains, monitor, requests) | ✅ works |
| Start / status / restart / set status / interrupt | ⛔ needs ICF service `/sap/bc/soap/rfc` activated in SICF (currently HTTP 403). One-time Basis task — see [docs/SETUP-SAP.md](docs/SETUP-SAP.md). The function modules themselves are confirmed remote-enabled. |

---

## 2. Prerequisites

| Item | Version / detail |
|---|---|
| Node.js | **22 or newer** (`node --version`) |
| npm | comes with Node |
| SAP user | user + password for the BW system, with the authorizations in [docs/SETUP-SAP.md](docs/SETUP-SAP.md) |
| Network | HTTPS access from your PC to the BW ICF port (e.g. `https://<host>:44300`) |
| Claude Code (optional) | to use the tools from chat |

---

## 3. Install and build

```bash
# 1. copy this folder anywhere, e.g. Desktop, then:
cd pc-automation-kit-ts

# 2. install dependencies
npm install

# 3. compile TypeScript -> dist/
npm run build
```

`npm run typecheck` checks types without writing files.

---

## 4. Configure your credentials

The server reads **environment variables** (exactly like bw-modeling-mcp). You can provide them
in two places — use one:

**A. For Claude Code / any MCP client:** `.mcp.json` (recommended)
```bash
copy .mcp.json.example .mcp.json      # Windows
cp .mcp.json.example .mcp.json        # macOS / Linux
```
Edit `.mcp.json`: set the **absolute path** to `dist/stdio.js` and your `BW_URL`, `BW_USER`,
`BW_PASSWORD`, `BW_CLIENT`, `BW_LANGUAGE`.

**B. For the smoke test script:** `.env`
```bash
copy .env.example .env      # Windows
cp .env.example .env        # macOS / Linux
```

| Variable | Example | Required |
|---|---|---|
| `BW_URL` | `https://btp.tli-usa.local:44300` | yes |
| `BW_USER` | `VDVARAPU` | yes (Basic Auth mode) |
| `BW_PASSWORD` | your password | yes (Basic Auth mode) |
| `BW_CLIENT` | `100` | yes (code default is `001`) |
| `BW_LANGUAGE` | `EN` | no |
| `BW_COOKIE_FILE` | path to exported browser cookies | only for SSO-only systems, instead of user/password |
| `BW_DEBUG_SESSION` | `1` | no — logs cookie/session details to stderr |

> `.env` and `.mcp.json` are in `.gitignore`. Never commit them. Details and alternatives
> (cookies, BTP destination, principal propagation): [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

---

## 5. Test it (read-only)

```bash
npm run smoke                     # latest run of any chain
npm run smoke -- ZPC_TPM_BPO      # a specific chain
```

The smoke test starts the server exactly as an MCP client would, lists the tools and calls
`bw_list_process_chain_log`, `bw_get_process_chain_steps`, `bw_get_process_chain` and
`bw_check_rfc_connection`. It changes nothing in SAP.

Expected: run list, step list with green/red/yellow, chain definition, and either
"SOAP-RFC connection OK" or a clear message that `/sap/bc/soap/rfc` must be activated.

---

## 6. Use it from Claude Code

1. Build (section 3) and create `.mcp.json` (section 4A) **in the folder where you open Claude Code**.
2. Open that folder in VS Code / Claude Code. Approve the `bw-pc-automation-mcp` server when asked
   (or run `/mcp` to check it is connected).
3. Ask, for example:
   - "Show the last 5 runs of process chain ZPC_TPM_BPO"
   - "Show all steps of the latest run of ZPC_TPM_BPO with runtimes"
   - "Which process chains failed since 2024-07-01?"
   - "Restart only the failed steps of ZPC_TPM_BPO run 8SYIAU6KFPYR8R4V0HBQQ76TE" *(needs SOAP-RFC)*

Run it directly without a client: `npm start` (stdio — waits for MCP messages on stdin).

---

## 7. How it is built (same as bw-modeling-mcp)

```
MCP client (Claude Code)  ──stdio──►  dist/stdio.js ─► index.ts  createServer()
                                                     │   ListTools  → TOOL_DEFINITIONS (filtered by scope)
                                                     │   CallTool   → handleToolCall → switch(name) → tools/*.ts
                                                     ▼
                                       bw-client.ts  BwClient (axios)
                                         Basic Auth + X-CSRF-Token: Fetch  → session cookies + token
                                         later calls: cookie + token only, token refreshed after 4 min
                                                     ▼  HTTPS
                                       SAP BW ICF:  /sap/bw/modeling/*  (chain design, BW/4 REST)
                                                    /sap/opu/odata/sap/* (BW/4 monitor)
                                                    /sap/bc/adt/datapreview/freestyle (log tables) ← new
                                                    /sap/bc/soap/rfc  (RSPC_API_* function modules) ← new
```

Optional second entry point `dist/http.js` = the same tools over HTTP for SAP BTP Cloud Foundry
(XSUAA login, BTP destination, principal propagation) — copied unchanged. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Folder structure
```
pc-automation-kit-ts/
├─ README.md                 ← this guide
├─ CLAUDE.md                 ← orientation for Claude Code
├─ package.json / tsconfig.json
├─ .env.example / .mcp.json.example / .gitignore
├─ manifest.yml / xs-security.json   ← only for BTP Cloud Foundry deployment
├─ scripts/smoke-test.mjs    ← read-only end-to-end test
├─ docs/
│  ├─ AUTHENTICATION.md      ← every auth mode, the session handshake, credential rules
│  ├─ ARCHITECTURE.md        ← request flow, files, how to add a tool
│  ├─ SETUP-SAP.md           ← what Basis must enable (SICF, authorizations)
│  ├─ SAP-REFERENCE.md       ← status codes, tables, function modules (verified signatures)
│  └─ TOOLS.md               ← every tool with parameters
└─ src/
   ├─ stdio.ts               ← entry point (local)            [verbatim copy]
   ├─ http.ts                ← entry point (BTP)              [verbatim copy]
   ├─ index.ts               ← tool definitions + dispatcher  [process-chain subset + new tools]
   ├─ bw-client.ts           ← HTTP session, auth, CSRF       [verbatim copy]
   ├─ destination.ts         ← BTP destination → BwClient     [verbatim copy]
   ├─ request-context.ts     ← per-request client (HTTP)      [verbatim copy]
   ├─ scopes.ts              ← read/write scopes (HTTP)       [tool list adapted]
   └─ tools/
      ├─ processchain.ts, processchain_write.ts, process_chain_monitor.ts,
      │  processvariant.ts, request_monitor.ts, transport.ts              [verbatim copies]
      ├─ cto.ts              ← list changeable transports     [extract]
      ├─ adt-sql.ts          ← read-only table access via ADT [adapted allow-list]
      ├─ rfc.ts              ← SOAP-RFC caller                [new]
      └─ process_chain_control.ts ← run log, start, restart…  [new]
```

---

## 8. Next steps (outside this kit)

1. Basis: activate `/sap/bc/soap/rfc` on the local system → `bw_check_rfc_connection` turns green.
2. Build 2 test chains (one simple, one nested) with a step that fails on purpose.
3. Verify sub-chain linking (`RSPCLOGCHAIN-META_LOG`) on the nested chain — see docs/SAP-REFERENCE.md §6.
4. Add the 3-retry recovery loop and, later, ServiceNow on top of these tools.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD` | env not passed — check `.mcp.json` `env` block or `.env` |
| `Failed to fetch CSRF token (HTTP 401)` | wrong user/password/client |
| `Failed to fetch CSRF token (HTTP 403/404)` | BW Modeling ICF service `/sap/bw/modeling` not active, or wrong URL/port |
| `SOAP-RFC service /sap/bc/soap/rfc is not active (HTTP 403)` | activate it in SICF (docs/SETUP-SAP.md) |
| `adtSelect … HTTP 403` | user lacks `S_ADT_RES` / table display authorization (`S_TABU_NAM`) |
| `bw_list_process_chain_runs` fails on BW 7.5 | expected — BW/4HANA-only OData; use `bw_list_process_chain_log` |
| self-signed certificate errors | the client already accepts self-signed certs (`rejectUnauthorized: false`) — see AUTHENTICATION.md §6 for production |
