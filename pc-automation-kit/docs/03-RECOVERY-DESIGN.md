# 03 — Phase 1 recovery design

## 1. Scope

| In scope (Phase 1) | Later |
|---|---|
| Local system, 2 test chains | Unity's BW 7.5 system |
| Start a chain | ServiceNow ticket after 3 failed retries |
| Read every step's status (incl. sub-chains) | Front-end dashboard |
| Rerun **only the failed step**, never the whole chain | AI agent |
| Failed steps inside nested chains at any depth | Users / roles / logins |
| Resume stuck or held steps | Notifications |
| Delete failed request before a load is repeated | |
| Max 3 retries per step, then "manual action needed" | |
| Log every attempt | |

**Done when** all 12 scenarios below pass.

## 2. Recovery flow (one pass per poll)

```
read all steps of the run (RSPC_API_CHAIN_GET_PROCESSES / RSPCPROCESSLOG)
  │  step 'A' but its job is dead (TBTCO) → set it red (RSPC_PROCESS_FINISH)
  ▼
any red step (R / X / J)?
  ├─ no  → chain finished or still running → wait, poll again
  └─ yes
       ▼
     is the red step a sub-chain (TYPE = CHAIN)?
       ├─ yes → resolve sub-chain LOG_ID → repeat this flow inside it
       └─ no
            ▼
          attempts < 3 AND step type repeatable?
            ├─ no  → mark "MANUAL ACTION NEEDED"   (later: create ServiceNow ticket)
            └─ yes
                 ▼
               load step that SAP will REPEAT? → delete red request first
                 ▼
               RSPC_API_CHAIN_RESTART(chain, log_id, I_ONLY_RED='X')
                 ▼
               record attempt (time, chain, log_id, step, attempt n, result) → wait → poll again
```

## 3. Retry rules
- Max **3** attempts per failed step, counted per (chain, log_id, type, variant).
- Wait between attempts (default 5 min, configurable `RETRY_WAIT_SECONDS`).
- Never restart while any step of that run is still `A` (active) with a live job.
- Restart is called on the **deepest** chain that holds the red step; the parent continues automatically once the sub-chain finishes.
- Every attempt is appended to `attempts.jsonl`.

## 4. Test chains

| Chain | Shape | Failure |
|---|---|---|
| Chain 1 (simple) | 1 level, ~5 steps | Middle step fails |
| Chain 2 (nested) | main → sub → sub-sub, one parallel branch | Step in the deepest sub-chain fails |

Ways to force a failure: an ABAP program step that raises an error message type E/A,
a DTP with a bad filter, or cancel the step's job in SM37.

## 5. Test scenarios

| # | Scenario | Expected |
|---|---|---|
| 1 | Middle step fails in main chain | Only that step reruns; chain continues |
| 2 | Step fails inside a sub-chain | Drill into sub-chain, rerun there; parent continues |
| 3 | Step fails in a sub-sub-chain | Same, every level |
| 4 | One of two parallel steps fails | Only that branch reruns; collector continues |
| 5 | Two parallel steps fail | Both rerun; 3 retries counted per step |
| 6 | Step stuck (A, job dead) | Set red, then rerun |
| 7 | Step on hold | Released so next step starts |
| 8 | Load step that SAP repeats | Red request deleted first; no double data |
| 9 | Step type not repeatable | No retry; manual action needed |
| 10 | Still failing after 3 retries | Stop; manual action needed |
| 11 | Restart requested while running | Blocked |
| 12 | All steps green but chain "Active" | Report only |

## 6. Open items

| # | Item | How to close |
|---|---|---|
| 1 | Field linking a CHAIN step to the sub-chain's LOG_ID | Run nested test chain; compare RSPCPROCESSLOG (parent) vs RSPCLOGCHAIN (sub) in SE16 |
| 2 | Safe request-deletion function | Test on local; Z RFC wrapper if needed |
| 3 | Dead vs slow job | Cross-check RSPCPROCESSLOG.JOBCOUNT with TBTCO.STATUS |
| 4 | Local is BW/4HANA, client is BW 7.5 | Use only RSPC_API_* + tables; check `I_ONLY_RED` exists on 7.5 |
| 5 | Function modules remote-enabled? | `python smoke_test.py` + SE37 |

## 7. Later phases (hook points)
- **ServiceNow:** in `recovery.py → escalate()`. REST: `POST https://<instance>.service-now.com/api/now/table/incident` with OAuth or basic auth; use `correlation_id = <chain>:<log_id>:<variant>` to avoid duplicates.
- **Dashboard:** wrap `chain_api.py` in FastAPI.
- **AI agent:** expose `start / status / recover` as MCP tools; AI summarises logs and drafts ticket text. Restart decisions stay in plain code.
