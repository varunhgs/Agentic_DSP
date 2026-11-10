# reference-ts

Read-only TypeScript extracts from the bw-modeling-mcp project. They are not meant to compile on their own.

| File | From | Why it's here |
|---|---|---|
| `bw-session.ts` | `src/bw-client.ts` | Exact Basic Auth + CSRF + cookie session logic (ported to Python in `python/http_session.py`) |
| `process-chain-monitor.ts` | `src/tools/process_chain_monitor.ts` | How the MCP reads chain runs/steps/messages via BW/4HANA OData (ideas for status/colour mapping) |
