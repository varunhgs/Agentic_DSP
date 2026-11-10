# 02 — SAP process chain reference

Everything SAP-side you need to monitor and recover process chains.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| Process chain | Sequence of steps that loads/prepares data, usually scheduled daily |
| Step (process) | One unit of work: DTP load, activation, delete, ABAP program, ... Identified by **TYPE + VARIANT + INSTANCE** |
| Nested chain (sub-chain) | A step of type `CHAIN` that runs another chain; that chain has its **own LOG_ID** |
| LOG_ID | Identifies one run of one chain |
| Request | Package of data written by a load step into a target, with its own ID and status |
| Repair | SAP re-processes the **same** failed instance (same request) → no double data |
| Repeat | SAP runs the step again as a **new** instance → for loads, a new request is created |
| Collector (AND / OR / EXOR) | Waits for parallel branches |

## 2. Status codes (field `STATE` / `ANALYZED_STATUS`)

| Code | Meaning | Colour | Tool action |
|---|---|---|---|
| G | Successfully completed | Green | none |
| F | Completed | Green | none |
| R | Ended with errors | Red | recover |
| X | Cancelled | Red | recover |
| J | Framework error | Red | recover (RESTART handles J) |
| A | Active | Yellow | wait; if job dead → stuck |
| P | Planned | Yellow | wait |
| Y | Ready | Yellow | wait |
| Q | Released | Yellow | wait |
| S | Skipped | Grey | none |

Verify the full list on your system: SE11 → domain `RSPC_STATE` → Value Range.

## 3. T-codes

| T-code | Use |
|---|---|
| RSPC | Chain maintenance + log view; right-click red step → Repeat / Repair |
| RSPC1 | Open a chain directly |
| RSPCM | Daily monitor of chosen chains |
| SM37 | Background jobs (steps run as jobs named `BI_PROCESS_<TYPE>`) |
| ST22 | Short dumps |
| SLG1 | Application log |
| SE37 | Display / test function modules, check "Remote-Enabled" |
| SE16 / SE11 | Read tables / table definitions |
| SM12 | Lock entries |
| RSA1 → target → Manage | See / delete requests (BW 7.5 classic) |

## 4. Tables

| Table | Contents | Key fields (verify in SE11) |
|---|---|---|
| `RSPCLOGCHAIN` | One row per chain run | `CHAIN_ID`, `LOG_ID`, `DATUM`, `ZEIT`, `ANALYZED_STATUS` |
| `RSPCPROCESSLOG` | One row per step per run | `LOG_ID`, `TYPE`, `VARIANTE`, `INSTANCE`, `STATE`, `STARTTIMESTAMP`, `ENDTIMESTAMP`, `JOBCOUNT` |
| `RSPCCHAIN` | Chain definition (steps + links) | `CHAIN_ID`, `OBJVERS`, `TYPE`, `VARIANTE`, `EVENT_START`, `EVENT_END` |
| `RSPCVARIANT` | Step variant parameters | `TYPE`, `VARIANTE` |
| `RSPROCESSTYPES` | Per step type: repeatable? repairable? | `TYPE` |
| `RSBKREQUEST` | DTP requests and status | `REQUID`, `DTP`, `USTATE`, `TSTATE` |
| `RSPMREQUEST` | Request management (BW/4HANA aDSO) | — |
| `RSICCONT` | Requests in InfoCubes/DSOs (BW 7.5 classic) | — |
| `TBTCO` | Background job header | `JOBNAME`, `JOBCOUNT`, `STATUS` (R=running, F=finished, A=cancelled, S=scheduled) |

Tables are read via `RFC_READ_TABLE` (see `python/chain_api.py → read_table`). Note: RFC_READ_TABLE has a 512-char row width limit — always request only the fields you need.

## 5. Function modules (signatures verified on the local system)

### RSPC_API_CHAIN_START — start a chain
```
IMPORTING  I_CHAIN TYPE RSPC_CHAIN
           I_T_FOR_PROCESS TYPE RSPC_T_VARIANTE      (optional)
           I_T_VARIABLES   TYPE RSPC_T_VARIABLES     (optional)
           I_SYNCHRONOUS   TYPE RSPC_SYNCHRONOUS     (optional)
           I_SIMULATE      TYPE RSPC_SIMULATION      (optional)
           I_NOPLAN        TYPE RS_BOOL              (optional)
           I_DONT_WAIT     TYPE RS_BOOL              (optional)
           I_POLL          TYPE RS_BOOL              (optional)
           I_GUI           TYPE CHAR1                (optional)
EXPORTING  E_LOGID TYPE RSPC_LOGID
           E_T_PROCESS_FAILED TYPE RSPC_T_VARIANTE
EXCEPTIONS FAILED
```

### RSPC_API_CHAIN_GET_STATUS — overall status of a run
```
IMPORTING  I_CHAIN, I_LOGID, I_DONT_UPDATE (opt), I_DONT_POLL (opt)
EXPORTING  E_STATUS TYPE RSPC_STATE, E_MANUAL_ABORT, E_MESSAGE TYPE SO_TEXT255, E_S_MESSAGE TYPE RSPC_S_MSG
```

### RSPC_API_CHAIN_GET_PROCESSES — every step of a run
```
EXPORTING  I_CHAIN, I_LOGID
TABLES     E_T_PROCESSLIST  (TYPE, VARIANTE, INSTANCE, STATE, ACTUAL_STATE, EVENT_START, EVENTP_START, EVENTP_END, STARTTIMESTAMP, ...)
EXCEPTIONS FAILED
```
(Called internally by RSPC_API_CHAIN_RESTART. Check its exact field list in SE37 before relying on field names.)

### RSPC_API_CHAIN_RESTART — rerun ONLY failed steps  ★ core of Phase 1
```
IMPORTING  I_CHAIN TYPE RSPC_CHAIN
           I_LOGID TYPE RSPC_LOGID
           I_ONLY_RED     TYPE RS_BOOL       (optional)  → pass 'X'
           I_DONT_POLL    TYPE RS_BOOL       (optional)
           I_POLL_TIMEOUT TYPE RSPC_SECONDS  default 600
EXPORTING  E_S_SUCCESSMSG TYPE RSPC_S_MSG
EXCEPTIONS FAILED
```
What it does (read from its source):
1. Reads the process list of the run (`RSPC_API_CHAIN_GET_PROCESSES`).
2. For each step calls `RSPC_PROCESS_RESTARTABLE` → decides **restartable (repeat)** or **repairable (repair)**. With `I_ONLY_RED='X'` only red steps qualify.
3. Calls `CL_RSPC_FRONTEND=>RESTART` — the same code as the RSPC "Repeat" button.
4. Steps in state `J` (framework error) are re-finished so the chain can continue.
5. Polls until the process list changes (or `I_POLL_TIMEOUT` seconds). Pass `I_DONT_POLL='X'` to return immediately.

**Important:** it works on ONE log ID. For a failure inside a sub-chain, call it with the **sub-chain's** CHAIN + LOG_ID.

### RSPC_PROCESS_FINISH — set a step's status manually (stuck / held steps)
```
IMPORTING  I_LOGID, I_CHAIN (opt), I_TYPE, I_VARIANT, I_INSTANCE,
           I_STATE (opt), I_EVENTNO (opt), I_HOLD (opt), I_JOB_COUNT (opt),
           I_BATCHDATE (opt), I_BATCHTIME (opt), I_DUMP_AT_ERROR (opt), I_ENTITIES (opt)
```
Setting a step green does **not** execute it — the chain just proceeds. Use only for:
- a step stuck in `A` whose job is confirmed dead → set `R`, then RESTART
- a held step the business wants to skip → set `G`

### RSPC_API_CHAIN_INTERRUPT — stop a chain
`I_CHAIN`, `I_KILL` (verify in SE37).

### Request handling (to verify)
| FM / method | Purpose | Status |
|---|---|---|
| `RSBM_GUI_CHANGE_USTATE` | Change DTP request user status (set red before delete) | Referenced by bw_toolbox; verify |
| `IF_RSBK_REQUEST~DELETE2` | DTP request deletion (class method, not RFC) | Would need a Z RFC wrapper |
| `RSSM_DELETE_REQUEST` | Classic request deletion (BW 7.x) | Unverified |

Never delete by updating `RSBKREQUEST`/`RSPMREQUEST` directly.

## 6. Repair vs repeat and double data

| Failed step | Before rerun |
|---|---|
| DTP load (full) | If SAP **repeats**: delete red request first. If SAP **repairs**: nothing. |
| DTP load (delta) | Same — mandatory, otherwise delta data lost/doubled |
| InfoPackage (BW 7.5) | Delete red request from PSA/target; delta → repeat delta |
| Activation (DSO/aDSO) | Nothing; rerun only |
| Delete contents | Nothing; rerun only |
| ABAP program | Rerun as-is; check per program |
| Sub-chain (TYPE = CHAIN) | Go inside, apply this table to the real failed step |

Many DTPs have a setting "automatically delete erroneous request on repeat" — check the 2 test DTPs.

## 7. Nested chains

- A sub-chain step in the parent has `TYPE = 'CHAIN'`, `VARIANTE = <sub-chain id>`.
- The sub-chain run has its own row in `RSPCLOGCHAIN` with its own `LOG_ID`.
- **To verify (open item 1):** which field links them. Working assumption used in the code:
  the parent step's `INSTANCE` holds the sub-chain's LOG_ID; fallback = latest `RSPCLOGCHAIN`
  row for the sub-chain started at/after the parent step's start time.
  Verify by running a nested test chain and comparing in SE16.

## 8. Useful external references
- SAP Help — Repeating Terminated Processes (repair vs repeat)
- SAP Help — Monitoring Process Chain Runs (RSPCM)
- github.com/pawelwiejkut/bw_toolbox — ABAP utilities using RSPC_API_CHAIN_START, RSPC_PROCESS_FINISH, RSBM_GUI_CHANGE_USTATE (reference only)
- SAP Community: "Deleting DTP requests when the DTP step is hanged"
