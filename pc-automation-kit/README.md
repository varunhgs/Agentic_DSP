# Process Chain Automation Kit

A self-contained starter kit for building the **SAP BW process chain auto-recovery tool**:
start chains, detect failed steps (including nested chains), rerun only the failed step
up to 3 times, and later raise a ServiceNow ticket.

Everything here was extracted from the `bw-modeling-mcp` project, keeping only what is
relevant to process chains and to connecting/authenticating to BW. Nothing about ADSOs,
queries, transformations etc. is included.

You can copy this folder anywhere (e.g. your Desktop). It does not depend on the MCP project.

---

## Folder contents

| Path | What it is |
|---|---|
| `README.md` | This file. Start here. |
| `docs/01-AUTHENTICATION.md` | How the MCP connects and authenticates to BW (Basic Auth, CSRF, cookies), and how the same is done in Python (HTTPS and PyRFC). Credential handling rules. |
| `docs/02-SAP-PROCESS-CHAIN-REFERENCE.md` | Status codes, tables, T-codes, function modules (verified signatures), repair vs repeat, request deletion, nested chains. |
| `docs/03-RECOVERY-DESIGN.md` | Phase 1 scope, recovery flow, retry rules, 12 test scenarios, open items. |
| `docs/04-WHAT-THE-MCP-HAS.md` | Which MCP process-chain features exist, what endpoints they use, and what does / does not carry over to BW 7.5. |
| `python/` | Runnable Python starter code (PyRFC = main path, HTTPS = alternative). |
| `reference-ts/` | Trimmed TypeScript extracts from the MCP (connection + process chain monitor), for reference only. |

---

## Chosen approach (Phase 1)

| Item | Decision |
|---|---|
| Language | **Python** |
| Connection to SAP | **PyRFC** (SAP NW RFC SDK already installed) — call SAP function modules directly |
| Alternative connection | HTTPS + Basic Auth + CSRF token (same as the MCP) — see `python/http_session.py` |
| Rerun logic | SAP standard `RSPC_API_CHAIN_RESTART` with `I_ONLY_RED = 'X'` (reruns only red steps — same as the Repeat button in RSPC) |
| Test system | Local system first (BW/4HANA), 2 test chains. Unity's BW 7.5 later. |
| Out of scope now | ServiceNow, front end, AI agent, end users |

---

## Quick start (step by step)

### 1. Prerequisites
- Python 3.10+
- SAP NW RFC SDK installed and on PATH (`SAPNWRFC_HOME` set) — already done on your machine
- `pip install -r python/requirements.txt`
- An SAP user with authorizations: `S_RFC` (for the RSPC_* function modules + RFC_READ_TABLE),
  `S_RS_PC` (display/execute process chains), `S_BTCH_JOB` (background jobs),
  `S_TABU_DIS` / `S_TABU_NAM` (read tables)
- Network access to the SAP application server RFC port: `33<NN>` where NN = system number (e.g. 3300)

### 2. Configure credentials
```
cd python
copy .env.example .env      (Windows)   |   cp .env.example .env   (Linux/Mac)
```
Edit `.env` and fill in host, system number, client, user, password.
**Never commit `.env`.** It is listed in `python/.gitignore`. See `docs/01-AUTHENTICATION.md`.

### 3. Smoke test the connection
```
python smoke_test.py
```
It runs `RFC_PING`, prints system info, and checks that the 5 key function modules exist
and are remote-callable.

### 4. Try the chain operations on a TEST chain
```
python cli.py status  <CHAIN>               # last run + every step with colour
python cli.py status  <CHAIN> <LOG_ID>      # a specific run
python cli.py start   <CHAIN>               # start a chain, prints LOG_ID
python cli.py restart <CHAIN> <LOG_ID>      # rerun only red steps of that run
python cli.py recover <CHAIN> <LOG_ID>      # full Phase-1 flow: nested drill-down + max 3 retries
```
`start`, `restart` and `recover` change things in SAP — use them only on test chains in the local system.

### 5. Hand it to Claude
Open this folder in Claude Code and say e.g.:
> "Read README.md and docs/. Implement the open TODOs in python/recovery.py and test against chain ZPC_TEST_1."

---

## Status of each piece

| Piece | Status |
|---|---|
| PyRFC connection from `.env` | Ready |
| HTTPS Basic Auth + CSRF session (alternative) | Ready |
| Start chain, get status, list steps, restart red steps | Ready (thin wrappers on SAP function modules) |
| Read log tables (RSPCLOGCHAIN, RSPCPROCESSLOG) via RFC_READ_TABLE | Ready |
| Nested chain drill-down | Implemented with a **to-verify** assumption (see `docs/03`, open item 1) |
| 3-retry loop + attempt log | Ready (JSON file log) |
| Stuck-step detection (dead job) | TODO skeleton |
| Delete failed request before repeat | TODO skeleton (function module not yet confirmed) |
| ServiceNow | Not started (later phase) — hook point marked in `recovery.py` |
