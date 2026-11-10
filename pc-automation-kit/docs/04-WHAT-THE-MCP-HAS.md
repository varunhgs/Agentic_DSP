# 04 — Process-chain features in the bw-modeling-mcp project

What exists in the MCP project, which SAP endpoint each uses, and whether it is useful for the new tool.

## 1. Read / monitor tools

| MCP tool | Source file | SAP endpoint | Works on BW 7.5 classic? | Use for new tool |
|---|---|---|---|---|
| `bw_list_process_chain_runs` | `src/tools/process_chain_monitor.ts` | OData `/sap/opu/odata/sap/RV_C_PCMLOG_CDS/Rv_C_PcmLog` | **Likely no** (BW/4HANA CDS view) | Idea only — use RSPCLOGCHAIN instead |
| `bw_get_process_chain_run_detail` | same | OData `/sap/opu/odata/sap/BW4_PCM_SRV/ChainProcessSet` + `ChainProcessLogSet` | **No** (BW/4 service) | Idea only — use RSPC_API_CHAIN_GET_PROCESSES / RSPCPROCESSLOG |
| `bw_list_process_chain_last_status` | same | OData `/sap/opu/odata/sap/RV_C_PCMPROCESSCHAIN_CDS/Rv_C_PcmProcessChain` | **Likely no** | Idea only |
| `bw_get_process_chain` | `src/tools/processchain.ts` | `/sap/bw/modeling/rspc/<chain>/m` (JSON) | Only if BW Modeling Tools REST is available | Read chain structure (nodes, edges, sub-chains) |
| `bw_get_process_variant` | `src/tools/processvariant.ts` | `/sap/bw4/v1/modeling/processtypes/<type>/variants/<variant>/m` | No (bw4 path) | — |
| `bw_list_requests` / `bw_get_request` | `src/tools/request_monitor.ts` | BW/4 request monitor services | No on 7.5 | Idea for request check |

Useful details from `process_chain_monitor.ts`:
- OData V2 dates come as `/Date(1720667447000)/` → convert ms to ISO.
- Criticality codes (UI5): 0 neutral, 1 error/red, 2 warning/yellow, 3 ok/green.
- State texts come from value list `Rv_I_Rsvpcm_State`.

Trimmed copy: `reference-ts/process-chain-monitor.ts`.

## 2. Write tools (chain design — not needed for recovery)
`bw_create_process_chain`, `bw_update_process_chain`, `bw_append_process_chain_dtp`,
`bw_swap_process_chain_dtp`, `bw_add_process_chain_program`, `bw_add_process_chain_error_links`,
`bw_create_decision_variant`, `bw_activate_process_chain` (`src/tools/processchain_write.ts`).

These **design/activate** chains; none starts or restarts a run.
Useful for Phase 1 only to **build the 2 test chains** (e.g. add an ABAP program step that fails on purpose).

## 3. What the MCP does NOT have
- Start a chain run
- Restart / repeat / repair a step
- Set a step status
- Delete a request
- Any retry / escalation logic

→ These are what the new tool adds, via RSPC_API_* function modules.

## 4. Real example (local system, run of ZPC_JBPB_TEMP_TUCU_DSO)

| # | Type | Variant | Runtime | Status |
|---|---|---|---|---|
| 1-1 | Start | JBPB Temp TU/CU DSO | 1 s | Ok |
| 2-1 | Delete contents | Drop contents of TUCUNU DSO | 2 s | Ok |
| 3-1 | DTP | RSDS JBP_PRODUCT_TU_CU_LINK → /JBPB/TUCUNU | 9 s | Ok |
| 4-1 | Activate aDSO | /JBPB/TUCUNU | 2 s | Ok |
| 5-1 | DTP | /JBPB/TUCUNU → /JBPB/UCF | 6 s | Ok |
| 6-1 | Activate aDSO | /JBPB/UCF | 2 s | Ok |
| 7-1 | DTP | RSDS SALESORG_FISCV_MAP → /JBPB/SAFV_M | 5 s | Ok |
| 8-1 | Activate aDSO | /JBPB/SAFV_M | 2 s | Ok |

Lesson: all steps green while chain header still said "Active" → scenario 12 (report only).
