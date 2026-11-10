# SAP-side setup

What Basis / security must enable so every tool works. Give this page to Basis.

## 1. ICF services (transaction SICF)

| Service path | Needed for | Local system status |
|---|---|---|
| `/sap/bw/modeling` | session login + chain design tools | active |
| `/sap/bc/adt` | `bw_list_process_chain_log`, `bw_get_process_chain_steps` | active |
| **`/sap/bc/soap/rfc`** | `bw_check_rfc_connection`, `bw_get_process_chain_status`, `bw_start_process_chain`, `bw_restart_process_chain`, `bw_set_process_status`, `bw_interrupt_process_chain` | **inactive (HTTP 403)** — must be activated |
| `/sap/opu/odata/sap/RV_C_PCMLOG_CDS`, `BW4_PCM_SRV`, `RV_C_PCMPROCESSCHAIN_CDS` | BW/4HANA monitor tools only | BW/4HANA only |

**Activate `/sap/bc/soap/rfc`:** SICF → execute → path `default_host/sap/bc/soap/rfc` →
right-click `rfc` → *Activate Service* → *Yes*. Then run `bw_check_rfc_connection`
(or `npm run smoke`) — it must answer "SOAP-RFC connection OK".

> Some companies keep this service off by policy. Alternative: a small custom ICF/REST service
> that wraps the same 5 function modules (`RSPC_API_CHAIN_START`, `_GET_STATUS`, `_RESTART`,
> `_INTERRUPT`, `RSPC_PROCESS_FINISH`). Only `src/tools/rfc.ts` would change.

## 2. Function modules (all confirmed remote-enabled on the local system)

| Function module | Function group | Used by |
|---|---|---|
| RFC_PING, RFC_SYSTEM_INFO | SYST | `bw_check_rfc_connection` |
| RSPC_API_CHAIN_START | RSPC_API | `bw_start_process_chain` |
| RSPC_API_CHAIN_GET_STATUS | RSPC_API | `bw_get_process_chain_status` |
| RSPC_API_CHAIN_RESTART | RSPC_API | `bw_restart_process_chain` |
| RSPC_API_CHAIN_INTERRUPT | RSPC_API | `bw_interrupt_process_chain` |
| RSPC_PROCESS_FINISH | RSPC_BACKEND | `bw_set_process_status` |

On another system check in SE37 → Attributes → "Remote-Enabled Module".

## 3. User authorizations (PFCG)

| Object | Values | Why |
|---|---|---|
| `S_SERVICE` / ICF auth | the ICF services above | call the HTTP services |
| `S_RFC` | RFC_TYPE=FUGR, RFC_NAME = `RSPC_API`, `RSPC_BACKEND`, `SYST`; ACTVT=16 | SOAP-RFC calls |
| `S_RS_PC` | display (03) + execute/schedule (16) for the chains | read and run chains |
| `S_BTCH_JOB` / `S_BTCH_ADM` | release jobs | starting/restarting creates background jobs |
| `S_ADT_RES` | ADT resources (`/sap/bc/adt/datapreview/*`) | run log tools |
| `S_TABU_NAM` | RSPCLOGCHAIN, RSPCPROCESSLOG, RSPCCHAIN, TBTCO (ACTVT 03) | data preview reads |
| `S_RS_AUTH` / BW modeling auths | as for bw-modeling-mcp | chain design tools |
| `S_DEVELOP` / `S_TRANSPRT` | only for create/update/activate chain tools | design tools |

## 4. Network
- HTTPS port of the ICF server (local: `44300`) reachable from the PC running the server.
- No RFC port (33NN) needed — everything goes over HTTPS.
