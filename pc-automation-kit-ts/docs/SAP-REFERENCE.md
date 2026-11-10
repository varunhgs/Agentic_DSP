# SAP process chain reference

Facts the code relies on. Items marked **verified** were read from the local system
(BW/4HANA, client 100) via ADT on 2026-10-28.

## 1. Status codes (domain RSPC_STATE)

| Code | Meaning | Colour | Treated as |
|---|---|---|---|
| G | Successfully completed | green | done |
| F | Completed | green | done |
| R | Ended with errors | red | failed |
| X | Cancelled | red | failed |
| J | Framework error | red | failed (RSPC_API_CHAIN_RESTART handles J) |
| A | Active | yellow | running — check the job |
| P | Planned | yellow | waiting |
| Y | Ready | yellow | waiting |
| Q | Released | yellow | waiting |
| S | Skipped | grey | — |

Seen in the local log table: F, G, R, S. Full list: SE11 → domain `RSPC_STATE`.

## 2. Tables (verified definitions)

**RSPCLOGCHAIN** — one row per chain run
`CHAIN_ID` (key), `LOG_ID` (key), `DATUM`, `ZEIT`, `ANALYZED`, `ANALYZED_STATUS`,
**`META_LOG`** (log id of the calling chain run → sub-chain link), `REPORTED_STATUS`, `MANUAL_ABORT`, `SYNCHRONOUS`, …

**RSPCPROCESSLOG** — one row per step execution
`LOG_ID`, `TYPE`, `EVENT_START`, `EVENTP_START`, `JOB_COUNT`, `BATCHDATE`, `BATCHTIME` (keys),
`VARIANTE`, `INSTANCE`, `STATE`, `ACTUAL_STATE`, `EVENT_END`, `EVENTP_END`,
`STARTTIMESTAMP`, `ENDTIMESTAMP` (UTC, `YYYYMMDDhhmmss.fffffff`), `OTHERJOBNAME`, `OTHERJOBCOUNT`, `UPDATETIMESTAMP`

**RSPC_S_PROCESSLIST** (rows of RSPC_API_CHAIN_GET_PROCESSES)
`CHAIN_ID`, `EVENT_START`, `EVENTP_START`, `EVENTNO_START`, `TYPE`, `VARIANTE`, `PREDECESSOR`,
`INSTANCE`, `STATE`, `ACTUAL_STATE`, `EVENT_END`, `EVENTP_END`, `EVENT_GREEN`, `EVENT_RED`, …,
`STARTTIMESTAMP`, `ENDTIMESTAMP`, `JOB_COUNT`, `LOG_ID`

**TBTCO** — background jobs: `JOBNAME` (steps run as `BI_PROCESS_<TYPE>`), `JOBCOUNT`, `STATUS`
(R running, F finished, A cancelled, S scheduled, Y ready, P planned, Z released/suspended)

Others: `RSPCCHAIN` (chain definition), `RSPCVARIANT` (variants), `RSPROCESSTYPES` (repeatable / repairable per type),
`RSBKREQUEST` (DTP requests).

Example (real, local): run `8SYIAU6KFPYR8R4V0HBQQ76TE` of `ZPC_TPM_BPO` → TRIGGER F, DTP_LOAD G (8 s), ADSOACT `ZD_CRMBP_ACTIVATE` **R** (40 s).

## 3. Function modules (verified signatures, all remote-enabled)

```
RSPC_API_CHAIN_START
  IMPORTING I_CHAIN, I_T_FOR_PROCESS, I_T_VARIABLES, I_SYNCHRONOUS, I_SIMULATE, I_NOPLAN,
            I_DONT_WAIT, I_POLL, I_GUI                      (all optional)
  EXPORTING E_LOGID, E_T_PROCESS_FAILED
  EXCEPTIONS FAILED

RSPC_API_CHAIN_GET_STATUS
  IMPORTING I_CHAIN, I_LOGID, I_DONT_UPDATE (opt), I_DONT_POLL (opt)
  EXPORTING E_STATUS, E_MANUAL_ABORT, E_MESSAGE, E_S_MESSAGE

RSPC_API_CHAIN_GET_PROCESSES
  IMPORTING I_CHAIN, I_LOGID (opt), I_DONT_POLL (default 'X')
  TABLES    E_T_PROCESSLIST LIKE RSPC_S_PROCESSLIST
  EXCEPTIONS FAILED

RSPC_API_CHAIN_RESTART
  IMPORTING I_CHAIN, I_LOGID, I_ONLY_RED (opt), I_DONT_POLL (opt), I_POLL_TIMEOUT (default 600)
  EXPORTING E_S_SUCCESSMSG
  EXCEPTIONS FAILED

RSPC_API_CHAIN_INTERRUPT
  IMPORTING I_CHAIN, I_KILL (opt)
  EXCEPTIONS FAILED

RSPC_PROCESS_FINISH
  IMPORTING I_LOGID, I_CHAIN (opt), I_TYPE, I_VARIANT, I_INSTANCE, I_STATE (opt),
            I_EVENTNO, I_HOLD, I_JOB_COUNT, I_BATCHDATE, I_BATCHTIME, I_DUMP_AT_ERROR, I_ENTITIES (opt)
```

## 4. What RSPC_API_CHAIN_RESTART does (read from its source)

1. Reads the run's process list (RSPC_API_CHAIN_GET_PROCESSES).
2. For each step calls `RSPC_PROCESS_RESTARTABLE` → restartable (**repeat**, new instance) or repairable
   (**repair**, same instance). With `I_ONLY_RED='X'` only red steps qualify.
3. Calls `CL_RSPC_FRONTEND=>RESTART` — the code behind the RSPC "Repeat" button.
4. Steps in state `J` are finished again so the chain continues.
5. Unless `I_DONT_POLL='X'`, waits until the process list changes (max `I_POLL_TIMEOUT` s).
   Success message RSPC 173: MSGV1 = repeated, MSGV2 = repaired.

It works on **one** log ID → for a failure inside a sub-chain, call it on the sub-chain and its own log ID.

`RSPC_API_CHAIN_INTERRUPT` calls `CL_RSPC_CHAIN->REMOVE_FROM_BATCH` (deschedules; `I_KILL` cancels jobs).

## 5. Repair vs repeat and duplicate data

| Failed step | Before restart |
|---|---|
| DTP load | If SAP **repeats**, the red request must be deleted first (many DTPs do this automatically on repeat). If SAP **repairs**, nothing. |
| DTP delta | Same — mandatory, otherwise delta data is lost or doubled |
| InfoPackage (BW 7.5) | Delete red request from PSA/target |
| Activation / delete contents | Nothing |
| ABAP program | Check per program |
| Sub-chain | Go inside, apply this table to the real failed step |

Request deletion is **not** implemented yet (no verified API). Do not update RSBKREQUEST/RSPMREQUEST directly.

## 6. Nested chains

- A sub-chain step has `TYPE = 'CHAIN'`, `VARIANTE = <sub-chain id>`.
- The sub-chain run is its own row in RSPCLOGCHAIN; its **`META_LOG`** = the parent run's LOG_ID.
  `bw_get_process_chain_steps` uses this link.
- **To verify:** the local system has no nested chains (no CHAIN steps in RSPCPROCESSLOG, no runs with META_LOG).
  Build a nested test chain, run it, and confirm with:
  `SELECT CHAIN_ID, LOG_ID, META_LOG FROM RSPCLOGCHAIN WHERE META_LOG <> ' '`.

## 7. T-codes
RSPC (chains, Repeat/Repair), RSPCM (daily monitor), SM37 (jobs `BI_PROCESS_*`), ST22 (dumps),
SLG1 (app log), SE37 (function modules), SE11/SE16 (tables), SICF (ICF services), SM12 (locks).
