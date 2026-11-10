# 01 — Authentication and connection to SAP BW

This explains exactly how the `bw-modeling-mcp` project connects to BW today, and how to
do the same (or the RFC equivalent) in the new Python tool.

---

## 1. How the MCP connects today

Source: `src/bw-client.ts` (class `BwClient`, function `createClientFromEnv`).
A trimmed copy is in `reference-ts/bw-session.ts`.

### 1.1 Protocol
- Plain **HTTPS REST** calls to the SAP ICF web server (ADT / BW Modeling / OData services).
- No SAP GUI, no RFC SDK.
- Library: `axios` (Node.js).

### 1.2 Configuration (environment variables)

| Variable | Example (local system) | Meaning |
|---|---|---|
| `BW_URL` | `https://btp.tli-usa.local:44300` | Base URL of the SAP ICF server (HTTPS port) |
| `BW_USER` | `VDVARAPU` | SAP user |
| `BW_PASSWORD` | *(secret)* | SAP password |
| `BW_CLIENT` | `100` | SAP client (mandant). Default in code: `001` |
| `BW_LANGUAGE` | `EN` | Logon language (optional) |
| `BW_COOKIE_FILE` | *(optional)* | Path to exported browser cookies — only for SSO/SAML systems |

In this project the values are passed through `.mcp.json` → `mcpServers.bw-modeling-mcp.env`.

### 1.3 The three auth modes in the code

| Mode | When used | How |
|---|---|---|
| **basic** (used on our local system) | `BW_USER` + `BW_PASSWORD` set | `Authorization: Basic base64(user:password)` |
| cookies | `BW_COOKIE_FILE` set | Cookies copied from a logged-in browser (SAML/SSO systems, e.g. BW Bridge) |
| pp (principal propagation) | Running on SAP BTP with a Destination + Cloud Connector | Per-user X.509 via `SAP-Connectivity-Authentication` header |

For the process chain tool we need only **basic** (or RFC, below).

### 1.4 Session handshake (Basic Auth + CSRF) — step by step

1. **First request = token fetch.** `GET /sap/bw/modeling/repo/is/systeminfo` with headers:
   - `Authorization: Basic <base64(user:password)>`
   - `X-CSRF-Token: Fetch`
   - `sap-client: 100`, `sap-language: EN`
   - `X-sap-adt-sessiontype: stateful`
2. SAP answers with:
   - header `x-csrf-token: <token>`
   - `Set-Cookie` headers: `SAP_SESSIONID_<SID>_<CLIENT>`, `sap-usercontext`, `MYSAPSSO2` (depending on system)
3. The client stores the cookies in its own cookie jar and stores the token.
4. **All later requests** send:
   - `X-CSRF-Token: <token>`
   - `Cookie: <all stored cookies>`
   - **No** `Authorization` header (deliberate — re-sending Basic Auth makes SAP open a new
     stateless session, which breaks locks/stateful work).
5. **Token refresh:** the token is re-fetched after **4 minutes** (`CSRF_TOKEN_TTL_MS`),
   because SAP sessions time out after ~5 minutes idle.
6. Cookies that SAP deletes (`Max-Age<=0` or `Expires` in the past) are removed from the jar.
7. **TLS:** self-signed certificates are accepted (`rejectUnauthorized: false`).
   OK for the local system; for a client system use their CA certificate instead.
8. Error handling: HTTP status ≥ 400 → throw with the response body; token missing →
   "Failed to fetch CSRF token … Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT".

Python equivalent: `python/http_session.py` (same steps with `requests.Session`).

### 1.5 What the MCP needs from the SAP system
- HTTPS port reachable (here `44300`)
- ICF services active: `/sap/bw/modeling/*` (BW Modeling Tools), `/sap/opu/odata/sap/*` (OData), `/sap/bc/adt/*`
- A dialog/service user with the authorizations for those services

---

## 2. How the new Python tool connects (chosen: PyRFC)

We call SAP **function modules** (RSPC_API_*) directly over RFC. PyRFC + SAP NW RFC SDK are already installed.

### 2.1 Configuration (`python/.env`)

| Variable | Example | Meaning |
|---|---|---|
| `SAP_ASHOST` | `btp.tli-usa.local` | Application server host (no https://, no port) |
| `SAP_SYSNR` | `00` | System number (2 digits). RFC port = `33` + SYSNR |
| `SAP_CLIENT` | `100` | Client |
| `SAP_USER` | `VDVARAPU` | SAP user |
| `SAP_PASSWD` | *(secret)* | Password |
| `SAP_LANG` | `EN` | Language |
| `SAP_SAPROUTER` | *(optional)* | SAProuter string if the system is behind one |
| `SAP_MSHOST`, `SAP_GROUP`, `SAP_SYSID` | *(optional)* | Use instead of ASHOST/SYSNR for load-balanced logon |

**Finding SYSNR:** in SAP GUI → System → Status, or from the HTTPS port: `443NN` → NN is usually the system number (`44300` → `00`). Confirm with Basis.

### 2.2 Code
```python
from pyrfc import Connection
conn = Connection(ashost=..., sysnr="00", client="100", user=..., passwd=..., lang="EN")
conn.call("RFC_PING")
r = conn.call("RSPC_API_CHAIN_START", I_CHAIN="ZPC_TEST_1")
```
See `python/sap_conn.py`.

### 2.3 Differences vs the MCP

| | MCP (HTTPS) | Python tool (RFC) |
|---|---|---|
| Transport | HTTPS port 443NN | RFC gateway port 33NN |
| Login | Basic Auth once, then session cookie | User/password at connection open |
| CSRF token | Required for every call | **Not used** in RFC |
| Session timeout | ~5 min idle, refresh token at 4 min | Connection may drop when idle → reopen on `CommunicationError` (handled in `sap_conn.py`) |
| SICF services needed | Yes | **No** |
| Authorization | S_SERVICE / ICF + BW auths | **S_RFC** for each function group + BW auths |

### 2.4 SAP-side requirements for RFC
| # | Requirement | Where |
|---|---|---|
| 1 | RFC port 33NN reachable from your PC | Network / Basis |
| 2 | User type Dialog or System/Service | SU01 |
| 3 | `S_RFC` for function groups `RSPC_API`, `RSPC_BACKEND`, `SDTX` (RFC_READ_TABLE), `SYST` (RFC_PING) | PFCG |
| 4 | `S_RS_PC` (display + execute chains), `S_BTCH_JOB`, `S_TABU_DIS`/`S_TABU_NAM` | PFCG |
| 5 | Function modules are **remote-enabled** (SE37 → Attributes → "Remote-Enabled Module") | SE37 |

If a needed function module is not remote-enabled, write a small Z wrapper function module (remote-enabled) that calls it.

---

## 3. Credential handling rules

1. **Never hard-code** user/password in code. Read them from environment variables / `.env`.
2. **Never commit** `.env`. `python/.gitignore` excludes it. Commit only `.env.example`.
3. **Note:** in the MCP project, `.mcp.json` contains the password in plain text and is **not**
   in `.gitignore`. Do not copy that pattern. Consider adding `.mcp.json` to `.gitignore` there.
4. Use a dedicated **technical (system/service) user** for automation on client systems, not a personal user. Personal user is fine for the local POC.
5. Give the technical user only the authorizations listed above (least privilege).
6. Do not print passwords or full connection params in logs. `sap_conn.py` masks them.
7. For a later server deployment: move secrets to a vault (Windows Credential Manager via `keyring`, Azure Key Vault, HashiCorp Vault, etc.).
8. TLS (HTTPS alternative): `verify=False` only for the local self-signed system. For client systems set `SAP_CA_BUNDLE` to their certificate.
