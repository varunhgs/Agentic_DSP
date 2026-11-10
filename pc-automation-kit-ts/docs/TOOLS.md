# Tool reference

Generated from the server tool list (`tools/list`). Scope = what the BTP HTTP transport requires; stdio has no scopes.

| Tool | Scope | Origin |
|---|---|---|
| [`bw_get_process_chain`](#bw_get_process_chain) | read | bw-modeling-mcp |
| [`bw_get_process_variant`](#bw_get_process_variant) | read | bw-modeling-mcp |
| [`bw_list_requests`](#bw_list_requests) | read | bw-modeling-mcp |
| [`bw_get_request`](#bw_get_request) | read | bw-modeling-mcp |
| [`bw_activate_request`](#bw_activate_request) | write | bw-modeling-mcp |
| [`bw_list_process_chain_runs`](#bw_list_process_chain_runs) | read | bw-modeling-mcp |
| [`bw_get_process_chain_run_detail`](#bw_get_process_chain_run_detail) | read | bw-modeling-mcp |
| [`bw_list_process_chain_last_status`](#bw_list_process_chain_last_status) | read | bw-modeling-mcp |
| [`bw_create_process_chain`](#bw_create_process_chain) | write | bw-modeling-mcp |
| [`bw_update_process_chain`](#bw_update_process_chain) | write | bw-modeling-mcp |
| [`bw_activate_process_chain`](#bw_activate_process_chain) | write | bw-modeling-mcp |
| [`bw_create_decision_variant`](#bw_create_decision_variant) | write | bw-modeling-mcp |
| [`bw_add_process_chain_error_links`](#bw_add_process_chain_error_links) | write | bw-modeling-mcp |
| [`bw_swap_process_chain_dtp`](#bw_swap_process_chain_dtp) | write | bw-modeling-mcp |
| [`bw_append_process_chain_dtp`](#bw_append_process_chain_dtp) | write | bw-modeling-mcp |
| [`bw_add_process_chain_program`](#bw_add_process_chain_program) | write | bw-modeling-mcp |
| [`bw_create_transport_task`](#bw_create_transport_task) | write | bw-modeling-mcp |
| [`bw_list_changeable_transports`](#bw_list_changeable_transports) | read | bw-modeling-mcp |
| [`bw_list_process_chain_log`](#bw_list_process_chain_log) | read | new |
| [`bw_get_process_chain_steps`](#bw_get_process_chain_steps) | read | new |
| [`bw_check_rfc_connection`](#bw_check_rfc_connection) | read | new |
| [`bw_get_process_chain_status`](#bw_get_process_chain_status) | write | new |
| [`bw_start_process_chain`](#bw_start_process_chain) | write | new |
| [`bw_restart_process_chain`](#bw_restart_process_chain) | write | new |
| [`bw_set_process_status`](#bw_set_process_status) | write | new |
| [`bw_interrupt_process_chain`](#bw_interrupt_process_chain) | write | new |

---

## bw_get_process_chain

Read a Process Chain (RSPC) definition — header metadata, scheduling and monitoring settings, all steps (nodes) with type, variant, and last execution status, step dependencies (edges) with branch conditions for DECISION nodes, and inline variant details. By default (include_variant_details=true), automatically fetches and embeds the full variant configuration for each step that has detail available. Steps without variant detail (DTP_LOAD, OR, AND, EXOR, CHAIN) are shown without extra detail — for DTP_LOAD use bw_get_dtp, for CHAIN use bw_get_process_chain recursively. Set include_variant_details=false for a faster structural overview without variant detail. Use bw_search with object_type=RSPC to find chain names first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `format` | string | no | Output format. "text" (default): compact human-readable summary. "raw": full parsed JSON. (one of: text, raw) |
| `include_variant_details` | boolean | no | If true (default), fetches variant configuration detail for each step automatically and includes it inline. Set to false to skip variant detail fetching for faster response on large chains. |

---

## bw_get_process_variant

Read the detail configuration of a single Process Variant from a Process Chain step. Covers all process types: ABAP (report name + selection variant), ADSOACT (aDSO activation), ADSOREM (request cleanup), PLSWITCHL/PLSWITCHP (planning mode switch), DTP_LOAD, DECISION, and any other type — oDetail is returned as indented JSON for unknown types. Get process_type and variant_name from bw_get_process_chain output (sProcessType and sProcessVariant fields). Use format="raw" to see the full unformatted JSON.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `process_type` | string | yes | Process type technical name from the chain step (e.g. "ABAP", "DTP_LOAD", "ADSOACT", "ADSOREM", "PLSWITCHL", "PLSWITCHP", "DECISION"). Case-insensitive. |
| `variant_name` | string | yes | Process variant technical name from the chain step (e.g. "ILV_...", "DTP_...", "DEL_..."). Case-insensitive. |
| `format` | string | no | Output format. "text" (default): readable summary with oDetail as indented JSON. "raw": full parsed JSON. (one of: text, raw) |

---

## bw_list_requests

List the recent load requests of an InfoProvider from the runtime request monitor, with decoded request status, record counts and timestamps. Returns one entry per request including the internal request TSN, which is the input for bw_get_request. Read-only. Use bw_search to find the target technical name first. Performance: listing cost scales with the number of returned rows because each row is enriched on the backend (a per-row cross-reference read). top bounds the result set; created_from and status only help by returning fewer rows, not by making a row cheaper. For providers with long load histories, use a narrow created_from window or a small top.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target` | string | yes | Target InfoProvider technical name (e.g. "OBJECT_NAME"). Case-insensitive. |
| `target_type` | string | no | Target object type (default "ADSO"). |
| `storage` | string | no | Comma-separated storage area codes (default "AQ,AX,AT"). |
| `status` | string | no | Comma-separated request status codes to include (default "N,GG,GR,YG,RR,YR,RG,U,Y,X"). |
| `created_from` | string | no | Optional server-side lower time bound, ISO 8601 with milliseconds and Z (24 chars, e.g. "YYYY-MM-DDTHH:MM:SS.000Z"). Returns only requests created at or after this time (open upper bound = now). Narrows the result set, which reduces per-row backend enrichment cost. Recommended for providers with long load histories. |
| `top` | number | no | Upper cap on the number of requests to return (default 3). Each returned row triggers an expensive per-row backend read, so keep this small; raise it only when needed. |

---

## bw_get_request

Full status analysis of one load request in a single call, bundling the request header, DTP information (including start, finish and duration), the process step chain and the message log. Read-only. The request TSN comes from bw_list_requests output.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_tsn` | string | yes | Internal request TSN from bw_list_requests output. |
| `storage` | string | no | Storage area code (default "AQ"). Take it from the "Storage" line of the bw_list_requests output — the code differs by target type (e.g. AQ inbound, AT/AX active data aDSO, ATTE active text table InfoObject). A wrong code 404s the header/DTP/process sections, but the message log is still returned. |
| `format` | string | no | Output format. "text" (default): readable summary. "raw": full parsed JSON of all four payloads. (one of: text, raw) |

---

## bw_activate_request

Activate loaded data (DSO request activation): move a finished load from the Inbound Table into the active data table and change log. This is the runtime request activation, NOT the modeling-object activation done by bw_activate. Only applies to aDSOs that have an activation step (not inbound-only staging aDSOs). Activates all previous loads up to the given request. Asynchronous: a successful call starts activation; monitor completion via bw_list_requests / bw_get_request.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `request_tsn` | string | yes | Load request TSN to activate (from bw_list_requests / bw_run_dtp output). |
| `storage` | string | no | Storage area code the request lives in (default "AQ"). |

---

## bw_list_process_chain_runs

List execution runs of one or all process chains from the process chain monitoring log. Each row represents one chain run with overall status, runtime deviation, start/end timestamps, and duration. Optionally filter by chain technical name, start date range, and status code. Returns the log_id of each run — pass chain_id + log_id into bw_get_process_chain_run_detail for step-level details. Ordered by start time descending. Default limit 20 runs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_name` | string | no | Optional process chain technical name to restrict to runs of a single chain (e.g. "CHAIN_NAME"). Omit for system-wide results. |
| `date_from` | string | no | Optional lower bound for run start date (ISO format, e.g. "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"). Maps to startDate ge datetime filter. |
| `date_to` | string | no | Optional upper bound for run start date (ISO format). Maps to startDate le datetime filter. |
| `status` | string | no | Optional status code filter (e.g. as returned by the status field of previous runs). Resolves to eq filter on the status field. |
| `limit` | number | no | Maximum number of runs to return (default 20). |

---

## bw_get_process_chain_run_detail

Read the execution detail of one process chain run — all process steps with type, variant, status, timestamps, and parent/child relationships (predecessor graph edges), plus the full message log. chain_id and log_id come from bw_list_process_chain_runs or bw_list_process_chain_last_status output. Use this to diagnose a failed run: the message log contains the actual error messages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). |
| `log_id` | string | yes | Run log ID from bw_list_process_chain_runs or bw_list_process_chain_last_status (logId field). |

---

## bw_list_process_chain_last_status

Read the latest execution status and scheduling state for every process chain in the system — one row per chain. Includes last run status, runtime deviation, scheduling status, next scheduled start, and the log_id of the most recent run (pass into bw_get_process_chain_run_detail to drill down). Chains that have never run appear here too. Optionally filter to chains whose last run has a specific status or whose last start date falls in a range.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | no | Optional filter on last run status code. Returns only chains whose most recent run matches this status. |
| `last_start_from` | string | no | Optional lower bound for last run start date (ISO format, e.g. "YYYY-MM-DD"). Maps to lastStartDate ge datetime filter. |
| `last_start_to` | string | no | Optional upper bound for last run start date (ISO format). Maps to lastStartDate le datetime filter. |
| `limit` | number | no | Optional maximum number of chains to return. Omit to return all. |

---

## bw_create_process_chain

Create a Process Chain (RSPC) via the BW/4HANA Cockpit REST API. Builds the chain model from a list of steps and edges, creates it with a trigger-only skeleton, then updates it with the full model in a single operation. Optionally activates after creation. The TRIGGER (Start) node is implicit (node index 0) and must not be listed in steps. DTP_LOAD and generic referenced steps use bIsReference=true; ADSOACT and ADSOREM use inline variants. Collectors (AND, OR, XOR) require no extra fields beyond their type. Edge status defaults: neutral for edges whose source is TRIGGER or a collector; positive for all others. For two-step DTP loading always use bw_create_dtp first; this tool builds the process chain around existing DTPs. Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. Other inline-configuration process types (for example program execution, OS command, attribute change run) are not supported in this version. Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. DECISION branch edges: set sub_status to the branch EVENTNO ("01"=THEN/JA, "02"=ELSE/NEIN) — such edges are always positive. Create the referenced decision variant first with bw_create_decision_variant. To start the chain on an event instead of immediately, pass trigger_event (start type "E").

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name, uppercase, max 30 characters (e.g. "CHAIN_NAME"). |
| `infoarea` | string | yes | InfoArea to file the chain under (e.g. "AREA_NAME"). |
| `description` | string | yes | Short description / label for the process chain. |
| `steps` | array of object | yes | Ordered list of steps. The TRIGGER (Start) node is implicit at index 0 — do not include it here. Each step has a caller-chosen id used for edge wiring. Step types: DTP_LOAD (requires dtp field), ADSOACT (requires datastores array), ADSOREM (requires remDatastores array), CHAIN (requires object = sub-chain name), DECISION (requires variant = decision variant name), AND / OR / XOR (collector, no extra fields), or any other BW process type (requires object field). |
| `edges` | array of object | yes | Directed edges connecting steps. Use the step id or the literal "TRIGGER" for the start node. Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive". |
| `trigger_event` | object | no | Optional event start-condition for the trigger (start type "E"). Omit for the default immediate start (start type "I"). |
| `activate` | boolean | no | If true, activate the chain immediately after creation. Default false. |

---

## bw_update_process_chain

Replace the step model (nodes and edges) of an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. Reads the current chain to obtain the ETag and preserve the existing trigger node (with its scheduling configuration) and the current header. Replaces only the steps and edges; the trigger is always preserved as-is. Optionally overrides description and infoarea in the header. Optionally activates after the update. A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly. Use bw_create_process_chain to create a new chain; use this tool to update an existing one. Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. Other inline-configuration process types (for example program execution, OS command, attribute change run) are not supported in this version. Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. DECISION branch edges: set sub_status to the branch EVENTNO ("01"/"02"); such edges are always positive. The trigger is preserved as-is unless trigger_event is passed (which sets an event start-condition); an existing event start-condition is preserved across updates.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `description` | string | no | Optional new description. If omitted, the existing chain description is kept. |
| `infoarea` | string | no | Optional new InfoArea. If omitted, the existing InfoArea is kept. |
| `steps` | array of object | yes | Complete replacement step list. The TRIGGER (Start) node is implicit at index 0 — do not include it here. Same shape as in bw_create_process_chain. |
| `edges` | array of object | yes | Complete replacement edge list. Use the step id or the literal "TRIGGER" for the start node. Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive". |
| `trigger_event` | object | no | Optional event start-condition for the trigger (start type "E"). When omitted, an existing event start-condition is preserved and a non-event trigger stays immediate. |
| `activate` | boolean | no | If true, activate the chain immediately after the update. Default false. |
| `transport_request` | string | no | Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. Ignored for $TMP (local) chains. |

---

## bw_activate_process_chain

Activate an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. Use this after bw_create_process_chain (with activate=false) or to re-activate a modified chain. Returns the top-level activation message, severity, and full log entries. Surfaces any log entries with severity "error" in a dedicated errors field.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |

---

## bw_create_decision_variant

Create a DECISION process variant (a standalone TLOGO object) for use as a branch/decision step in a Process Chain, via the BW/4HANA Cockpit REST API. The variant holds two branches indexed by position: THEN/first (EVENTNO "01" by default, label "JA") and ELSE/second (EVENTNO "02", label "NEIN"). The formula is the branch condition (e.g. "GET_SEGMENT( ) = ' 3'"); it is evaluated for the THEN branch, the ELSE branch is its complement. The variant is created AND activated (activation is mandatory — an inactive variant is not selectable in the chain variant picker). After creation, reference the variant from a DECISION step in bw_create_process_chain / bw_update_process_chain (variant=<this name>), and branch its out-edges with sub_status "01"/"02". Package/transport: $TMP is fine for visibility and picker selection; pass a transportable package (NOT $TMP) only if you need to transport the variant. For a transportable package a transport_request is used (auto-selected when exactly one changeable request is available; pass it to disambiguate).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Decision variant technical name, uppercase (e.g. "VARIANT_NAME"). This is the name a chain DECISION step references. |
| `description` | string | yes | Variant description / label. |
| `formula` | string | yes | Branch condition formula (BW decision formula syntax), e.g. "GET_SEGMENT( ) = ' 3'". |
| `package` | string | no | Target package. Defaults to $TMP, which is fine for visibility/picker selection. Pass a transportable package only if the variant must be transportable. |
| `transport_request` | string | no | Transport request to record the new variant into. Used only for a transportable package (auto-selected when exactly one changeable request is available; pass to disambiguate). |
| `then_label` | string | no | Label of the THEN/first branch. Default "JA". |
| `else_label` | string | no | Label of the ELSE/second branch. Default "NEIN". |
| `then_event_no` | string | no | EVENTNO of the THEN branch (referenced by chain branch edges via sub_status). Default "01". |
| `else_event_no` | string | no | EVENTNO of the ELSE branch. Default "02". |

---

## bw_add_process_chain_error_links

Add on-error (negative) links to an existing Process Chain (RSPC) by mirroring the existing on-success (positive) out-edges of its DTP load steps, via the BW/4HANA Cockpit REST API. In-place edit: reads the current model, appends the negative edges (skipping any that already exist), and PUTs it back. Optionally activates afterwards. Use dtps to restrict to specific steps; omit it to apply to every DTP load step. A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `dtps` | array of string | no | Optional. Restrict to these steps. Each entry is matched against a step's DTP name (exact) or as a substring of its step description (which contains the target object name). Omit to apply to all DTP load steps. |
| `activate` | boolean | no | If true, activate the chain immediately after the edit. Default false. |
| `transport_request` | string | no | Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. Ignored for $TMP (local) chains. |

---

## bw_swap_process_chain_dtp

Swap one DTP load variant for another in an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. In-place edit: reads the current model, replaces the matching DTP_LOAD node's variant, and PUTs it back — edges and all other nodes are preserved unchanged. Prefer this over bw_update_process_chain for a single-variant swap, since it does not require re-specifying the whole chain. Optionally activates afterwards. A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `old_dtp` | string | yes | DTP variant name currently in the chain (e.g. "DTP_NAME_OLD"). |
| `new_dtp` | string | yes | DTP variant name to set instead (e.g. "DTP_NAME_NEW"). |
| `refresh_description` | boolean | no | If true (default), pull the new variant's step description from its metadata. Cosmetic; the existing description is kept if metadata is unavailable. |
| `activate` | boolean | no | If true, activate the chain immediately after the edit. Default false. |
| `transport_request` | string | no | Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. Ignored for $TMP (local) chains. |

---

## bw_append_process_chain_dtp

Append one DTP load step (optionally followed by its own DSO activation step) to an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. In-place edit: reads the current model, appends the node(s)/edge(s)/inline variant, and PUTs it back — the caller does not supply the full model. By default it appends behind the strand end closest to the trigger (to keep strands balanced); pass predecessor to choose a node. edge_mode "both" (default) adds an on-success and an on-error edge per link ("always continue"); "success_only" adds only the on-success edge. Idempotent: if the DTP is already a node in the chain, it is skipped without writing. Optionally activates afterwards and then verifies that no collector was inserted and no extra strand appeared. A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `dtp` | string | yes | DTP variant name to append (e.g. "DTP_NAME"). |
| `adsoact` | string | no | Optional aDSO name (e.g. "ADSO_NAME"). When given, an ADSOACT step activating this aDSO is added right after the DTP (per-DTP activation). |
| `predecessor` | string | no | Node to append behind: a DTP variant name, an aDSO whose ADSOACT node holds it, or the literal "strand_end_auto" (default). For "strand_end_auto" the terminal node closest to the trigger is chosen (ties → first). |
| `edge_mode` | string | no | "both" (default): add an on-success and an on-error edge per link. "success_only": add only the on-success edge. (one of: both, success_only) |
| `activate` | boolean | no | If true, activate the chain immediately after the edit. Default false. |
| `transport_request` | string | no | Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. Ignored for $TMP (local) chains. |

---

## bw_add_process_chain_program

Add an "Execute ABAP Program" step (RSPC process type ABAP, "Programm ausführen") to an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. Runs an ABAP report, optionally with a named SE38 selection variant. In-place edit: reads the current model, inserts the node + its INLINE process variant (the program call is stored inline in the chain — there is no separate variant object), and PUTs it back. Positioning: pass "before" to run the program ahead of an existing step (the target's incoming edges are rerouted through the new step, e.g. Start → PROGRAM → DTP); pass "after" to run it between a step and its successors; pass neither (optionally with predecessor) to append behind the strand end closest to the trigger. edge_mode "both" (default) adds an on-success and an on-error edge per new link; "success_only" adds only the on-success edge. Idempotent: if an ABAP step already calls the same program (and variant), it is skipped without writing. Only the synchronous/local/program call configuration is verified; keep the defaults. A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive. |
| `program` | string | yes | ABAP program / report to execute (e.g. "REPORT_NAME"). |
| `variant` | string | no | Optional ABAP report (SE38) selection variant name (e.g. "VARIANT_NAME"). Omit to run the report without a variant. |
| `description` | string | no | Optional step description (cosmetic). |
| `before` | string | no | Insert the program step BEFORE this node (its DTP/variant name, or an aDSO held by an ADSOACT node). The target's incoming edges are rerouted through the new step. Mutually exclusive with "after". |
| `after` | string | no | Insert the program step AFTER this node — it runs between the target and its former successors. Mutually exclusive with "before". |
| `predecessor` | string | no | Used only when neither before nor after is given. Node to append behind (a DTP/variant name, an aDSO held by an ADSOACT node) or the literal "strand_end_auto" (default = terminal node closest to the trigger). |
| `edge_mode` | string | no | "both" (default): add an on-success and an on-error edge per new link. "success_only": add only the on-success edge. (one of: both, success_only) |
| `program_package` | string | no | Optional package of the report (cosmetic value-help enrichment; the server re-derives it when omitted). |
| `program_description` | string | no | Optional report description (cosmetic). |
| `variant_description` | string | no | Optional variant description (cosmetic). |
| `synchronous` | boolean | no | Call mode. true (default) runs the program synchronously (X_SYNCHRON). Only the default is verified. |
| `local` | boolean | no | Call location. true (default) runs the program on this system (X_LOCAL). Only the default is verified. |
| `activate` | boolean | no | If true, activate the chain immediately after the edit. Default false. |
| `transport_request` | string | no | Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. Ignored for $TMP (local) chains. |

---

## bw_create_transport_task

Add a task (sub-request) for a user to an existing workbench transport request. Single ADT call, no lock or activation. The parent request must be modifiable. Returns the created task number.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `transport_request` | string | yes | Parent workbench transport request number (e.g. DEVK900123). |
| `user` | string | yes | Target user the task is created for (task owner), e.g. "USERNAME". |

---

## bw_list_changeable_transports

List transport requests and their tasks via the BW transport state (cto/check). Defaults to the caller's modifiable requests. Use this to find an open request to assign an object to.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `own_only` | boolean | no | Only the caller's own requests (default true). false widens to all users. |
| `modifiable_only` | boolean | no | Only modifiable requests, i.e. status "D" (default true). false also returns released requests. |
| `include_objects` | boolean | no | Include the objects contained in each task (default false). |

---

## bw_list_process_chain_log

List process chain runs from the run log table RSPCLOGCHAIN (works on BW/4HANA and BW 7.5). Newest first. Each run shows its log ID, start time, status (G/F green, R/X/J red, A yellow) and, for sub-chain runs, the parent run that called it. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | no | Technical process chain name, e.g. "ZPC_TPM_BPO". Omit for all chains. |
| `status` | string | no | Filter by run status code, e.g. "R" for failed runs, "A" for active. |
| `date_from` | string | no | Only runs started on or after this date (YYYY-MM-DD, system date). |
| `limit` | number | no | Maximum runs to return (default 20, max 500). |

---

## bw_get_process_chain_steps

Show every step (process) of one process chain run with status, colour, start/end, runtime, instance and background job, read from RSPCPROCESSLOG (works on BW/4HANA and BW 7.5). Descends into sub-chains (TYPE=CHAIN) and lists the failed leaf steps with the chain_id/log_id to pass to bw_restart_process_chain. For active steps the background job status (TBTCO) is shown, which tells a running step from a stuck one. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Technical process chain name. |
| `log_id` | string | no | Run log ID. Omit for the latest run of the chain. |
| `recursive` | boolean | no | Descend into sub-chains (default true). |
| `include_job_status` | boolean | no | Look up the background job of active steps (default true). |

---

## bw_check_rfc_connection

Check that SAP function modules can be called over HTTPS via the SOAP-RFC service /sap/bc/soap/rfc (RFC_PING + RFC_SYSTEM_INFO). Required by bw_start_process_chain, bw_get_process_chain_status, bw_restart_process_chain, bw_set_process_status and bw_interrupt_process_chain. Read-only.

_No parameters._

---

## bw_get_process_chain_status

Overall status of one run via the SAP API RSPC_API_CHAIN_GET_STATUS (SOAP-RFC). By default the log is not updated (I_DONT_UPDATE=X). Read-only unless refresh=true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Technical process chain name. |
| `log_id` | string | yes | Run log ID. |
| `refresh` | boolean | no | Let SAP re-evaluate the run and update its log status (default false). |

---

## bw_start_process_chain

Start a process chain now via the SAP API RSPC_API_CHAIN_START (SOAP-RFC). Returns the new run log ID. The chain must be active. CHANGES SYSTEM STATE — loads data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Technical process chain name. |
| `synchronous` | boolean | no | Run synchronously in this call (default false). Only for short test chains. |

---

## bw_restart_process_chain

Rerun ONLY the failed steps of one run via the SAP API RSPC_API_CHAIN_RESTART with I_ONLY_RED=X — the same logic as the Repeat button in RSPC. SAP decides per step whether to repair (same instance/request) or repeat (new instance). The rest of the chain continues from there. For a failure inside a sub-chain, pass the sub-chain chain_id and its own log_id (shown by bw_get_process_chain_steps). Refuses while a step of the run is still active unless force=true. CHANGES SYSTEM STATE.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Chain that owns the failed step (the sub-chain, for nested failures). |
| `log_id` | string | yes | Run log ID of that chain. |
| `only_red` | boolean | no | Restart only failed (red) steps (default true). |
| `force` | boolean | no | Restart even if a step still shows active (default false). |

---

## bw_set_process_status

Manually set the status of one step via RSPC_PROCESS_FINISH (SOAP-RFC), e.g. mark a stuck step red (R) so it can be restarted, or green (G) to let a held chain continue. Does NOT execute the step. Take type, variant and instance from bw_get_process_chain_steps. CHANGES SYSTEM STATE.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Chain that owns the step. |
| `log_id` | string | yes | Run log ID of that chain. |
| `process_type` | string | yes | Process type, e.g. DTP_LOAD, ADSOACT, ABAP. |
| `variant` | string | yes | Process variant name. |
| `instance` | string | yes | Process instance. |
| `state` | string | yes | New state: R=error, G=success, F=completed, X=cancelled. (one of: R, G, F, X) |

---

## bw_interrupt_process_chain

Stop a process chain via RSPC_API_CHAIN_INTERRUPT (SOAP-RFC): removes its scheduled start; with kill=true running jobs are cancelled. The chain must be scheduled again afterwards. CHANGES SYSTEM STATE.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `chain_id` | string | yes | Technical process chain name. |
| `kill` | boolean | no | Also cancel running jobs (default false). |
