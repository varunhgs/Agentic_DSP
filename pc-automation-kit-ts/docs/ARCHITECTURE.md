# Architecture

Same design as bw-modeling-mcp, limited to process chains.

## 1. Request flow (stdio)

```
Claude Code ──JSON-RPC over stdin/stdout──► dist/stdio.js
   stdio.ts        startStdio(): StdioServerTransport + createServer()
   index.ts        createServer():
                     ListTools  → filterToolsByScope(TOOL_DEFINITIONS)   (stdio: no filtering)
                     CallTool   → handleToolCall(request, extra)
                       1. hasScope(...)  (HTTP only)
                       2. client = currentClient() ?? createClientFromEnv()   ← new BwClient per call
                       3. ensureMediaTypes(client)   (BW modeling discovery, once per process)
                       4. switch (name) → tools/<file>.ts → returns text
                       5. errors → { isError: true, text: "Error: …" }  (so the model sees SAP's message)
   tools/*.ts      build URLs/bodies, call BwClient, format plain text
   bw-client.ts    axios + cookie jar + CSRF → SAP ICF over HTTPS
```

All log output goes to **stderr**; stdout is reserved for the MCP protocol.

## 2. HTTP / BTP flow (optional)

`http.ts`: express app → XSUAA bearer check (`setupHttpAuth`) → per request: BwClient from the BTP
destination (`destination.ts`: shared basic user or principal propagation) → `runWithClient(client, …)`
(`request-context.ts`, AsyncLocalStorage) → fresh `createServer()` + `StreamableHTTPServerTransport`
(stateless) → same `handleToolCall`. `/health` for the platform. See AUTHENTICATION.md §5.

## 3. Files

| File | Role | Origin |
|---|---|---|
| `src/stdio.ts` | local entry point | verbatim |
| `src/http.ts` | BTP entry point | verbatim |
| `src/index.ts` | TOOL_DEFINITIONS, handleToolCall, createServer, startStdio | process-chain subset of the original, plus a NEW block |
| `src/bw-client.ts` | BwClient: auth, session, CSRF, HTTP helpers (`rawGet`, `postRaw`, `rawPost`, …) | verbatim (also contains modeling helpers not used here) |
| `src/destination.ts` | BTP destination → BwClient | verbatim |
| `src/request-context.ts` | per-request client for HTTP | verbatim |
| `src/scopes.ts` | read/write classification | READ_TOOLS adapted |
| `src/tools/processchain.ts` | `bw_get_process_chain` — GET `/sap/bw/modeling/rspc/<chain>/m` | verbatim |
| `src/tools/processchain_write.ts` | create/update/activate chains, DTP/program/decision steps | verbatim |
| `src/tools/process_chain_monitor.ts` | BW/4 OData monitor (RV_C_PCMLOG_CDS, BW4_PCM_SRV, RV_C_PCMPROCESSCHAIN_CDS) | verbatim |
| `src/tools/processvariant.ts` | `bw_get_process_variant` — `/sap/bw4/v1/modeling/processtypes/…` | verbatim |
| `src/tools/request_monitor.ts` | request list/detail/activate (BW/4 request monitor) | verbatim |
| `src/tools/transport.ts` | create transport task | verbatim |
| `src/tools/cto.ts` | list changeable transports (`/sap/bw/modeling/cto/check`) | extract |
| `src/tools/adt-sql.ts` | read-only SELECT via ADT data preview, allow-listed tables | adapted |
| `src/tools/rfc.ts` | SOAP-RFC client: envelope builder, response/fault parser | new |
| `src/tools/process_chain_control.ts` | run log, steps (recursive), start, status, restart, set status, interrupt | new |

## 4. BW/4HANA vs BW 7.5

| Tool group | Endpoint | BW/4HANA | BW 7.5 |
|---|---|---|---|
| `bw_list_process_chain_log`, `bw_get_process_chain_steps` | ADT data preview on RSPC tables | yes (tested) | expected yes (ADT data preview + same tables) — verify |
| start / status / restart / set status / interrupt | SOAP-RFC → RSPC_API_* | yes once SICF active | expected yes (same APIs; check `I_ONLY_RED` exists) |
| `bw_get_process_chain`, write tools | BW Modeling REST `/sap/bw/modeling/rspc` | yes | only if the BW Modeling Tools REST services exist on that release |
| `bw_list_process_chain_runs/_run_detail/_last_status` | BW/4 OData | yes | no |
| `bw_get_process_variant`, request tools | `/sap/bw4/v1/...` | yes | no |

## 5. Adding a tool (the pattern every tool follows)

1. Write `export async function bwDoSomething(client: BwClient, …): Promise<string>` in `src/tools/<file>.ts`.
   Use `client.rawGet` / `client.postRaw` / `adtSelect` / `callRfc`; return plain text.
2. In `src/index.ts`: import it, add an entry to `TOOL_DEFINITIONS` (`name`, `description`, `inputSchema`)
   and a `case 'bw_do_something':` in `handleToolCall`.
3. If it only reads, add its name to `READ_TOOLS` in `src/scopes.ts` (otherwise it requires `write` on BTP).
4. `npm run build`, restart the MCP server (in Claude Code: `/mcp` → reconnect).

Validate every input that is put into SQL or SOAP (see the `checked()` helpers in process_chain_control.ts).
