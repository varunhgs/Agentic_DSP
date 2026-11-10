# Changelog

## [Unreleased]

### Added

- **Transformation extraction for migration** — `bw_get_transformation` with `format: "json"` reads the *active* version and returns every rule with its steps, formula, constant, routine reference and a deterministic conversion class (A direct / B needs semantic validation / C custom routine / E not assessed), key-figure aggregation (`MOV` overwrite vs `SUM`), and the runtime. It also reads the generated program (`GP…`, templates `RSTRAN_MASTER_TMPL` and `RSTRAN_MASTER_TMPL_EXPERT`): rule blocks by rule ID, steps that exist only in the generated code (`CONVERT`, `_INITIAL_VALUE_CHECK`, `IOBJ_ROUT`), the aggregation and record-mode handling, and the activated copy of each routine (`compute_<rule>_<step>`, `start_routine`, `end_routine`, `expert_routine`). Routine source is read from the editable class `/BIC/…_M` as well — the active XML points at the `_A` class, which ADT does not serve — and both copies are compared to expose unactivated changes. The result carries a completeness verdict and an issues list. Text and raw output are unchanged.
- **`bw_get_abap_source`** — read-only ADT source for classes, programs (incl. generated programs), includes and function modules (function group resolved automatically), whole or one method, with line windowing.
- **`bw_get_adso_loaders`** — loader census for one aDSO: transformations + DTPs (source kind ODP / file / aDSO / InfoSource), planning (ALVL on the aDSO or on a CompositeProvider containing it → planning functions with their type → sequences; file-upload planning functions reported as `FILE_UPLOAD`), direct-update API, write interface, ABAP programs calling the aDSO write APIs (ADT where-used) or run as process-chain steps, plus runtime evidence from `RSPMPROCESS` (DTP_LOAD, PLAN, SELDEL, DEL_REQ, MOV_REQ) read through the ADT data preview, restricted to the request-management tables. DTPs seen only at runtime are looked up directly; deleted ones are reported. Status is strict: `EXPLAINED` only when every evidence channel was checked, every runtime load is explained and the aDSO has no write path whose callers cannot be enumerated (direct update, write interface); otherwise `PARTIAL`; `UNRESOLVED` when the channels ran and found nothing; `NOT_ASSESSED` when the aDSO could not be read at all. The census script stops after three consecutive unreachable aDSOs and marks its output incomplete. Each result lists its evidence checks, open items, aDSO-specific residual risks and the system-wide blind spots.
- **`scripts/loader-census.mjs`** — runs the census over all aDSOs (credentials from the environment only), writes JSON and CSV to `census-out/` (git-ignored).
- **`bw_get_adso`** — `format: "json"` (parsed type, flags, keys, fields, tables) and `version: "active"`.

### Fixed

- **aDSO modelling type was misreported** — the summary classified data-mart (cube-like) aDSOs as "Staging — Nur Eingangs-Queue" and staging-with-reporting as "Daten komprimieren", contradicting the presets the server itself uses to create those types. Classification is now the exact inverse of the presets; unknown combinations are reported as such.
- **Namespaced aDSOs returned HTTP 404** — `/JBPB/IPLAN` was requested as `/jbpb/iplan`; BW expects `%24jbpb%24iplan`.

## [1.3.0] — 2026-08-04

### Added

- **CompositeProvider authoring** — `bw_create_composite_provider` creates a Union or Join node with its source providers attached, or copies an existing CompositeProvider (the template is named in the URL, not in the body, unlike aDSO). `bw_update_composite_provider` grew from two actions to eight: `add_input`, `remove_input`, `update_mapping`, `update_join`, `remove_join` and `update_settings` next to the existing `add_field` / `remove_field`. Field mappings resolve against each source's own metadata, so field-based and InfoObject-based providers both work; join conditions are set per input pair, which is how BW models an N-way join. Verified against a BW/4HANA system up to an activated CompositeProvider. Based on the traced payloads contributed in #20 by @JosephManu12, ported onto the current code base and extended.
- **Aggregation levels** — `bw_create_aggregation_level` and `bw_update_aggregation_level`, the first objects from the planning side the server can create, optionally with a subset of the provider's fields.
- **`bw_create_variable`** — BW variables for query authoring.

### Improved

- **Locks are released by the session that holds them** (#13) — a BW enqueue belongs to the ABAP session that took it, so `?action=unlock` from any other session answered HTTP 200 and released nothing, leaving objects locked until the ADT session timed out or SM12 was used. The client now tracks which session holds a lock, routes the release through it, and hands back the handle it already holds when the same caller locks again.
- **`bw_unlock` accepts `hcpr` and `alvl`** — previously there was no way to release those locks through the MCP.

### Fixed

- **`adtcore:masterSystem` no longer guessed from the URL host** (#13) — the host says nothing about the system behind a destination or a proxy, and with `BW_URL` unset the fallback produced `LOCALHOST`, which the backend rejects. It is read from the system's own logical system name now, once per process, with the old derivation as fallback. Affects transformation, DTP, query and DataSource creates.
- **CompositeProvider read served a stale model buffer** — it went through the calling client, so a read right after a write returned that session's pinned state and lost attributes the write had set. It uses a fresh session now, like the aDSO and transformation tools.
- **XML entity handling in labels** — labels were interpolated unescaped, so an `&` failed the request with HTTP 500, and entities were not decoded when reading. Decoding is shared in the client now and also applies to `bw_list_contents` and the aggregation level read.
- **Key figure detection in CompositeProviders** — derived from the element body instead of a `__KEYFIGURES` dimension, which a plain Union node does not have.

### Notes

- On the four remaining findings reported in #13: the transformation create buffer does not apply here, because lock and create already run on separate sessions; the stateless lock path is unreachable code; and the DTP `stateful_enqueue` behaviour could not be reproduced — on this landscape the enqueue survives the request, which points at the server's session configuration rather than the connector.

## [1.2.1] — 2026-08-03

### Fixed

- **Environment proxies are no longer disabled** (#22) — the HTTP client passed `proxy: false` whenever no explicit Cloud Connector hop was configured. In axios that does not mean "no proxy", it means "ignore proxy settings", which also switches off the `HTTP_PROXY` / `http_proxy` environment variables. Deployments whose only route to the BW host is a local or corporate proxy lost that route and failed with `ENOTFOUND`. An explicit Cloud Connector hop still takes precedence.
- **Media type discovery now reaches the wire** (#23) — two independent defects made every aDSO call fail with HTTP 415 on systems advertising a lower `adso` resource version than the compiled-in fallback:
  - `loadMediaTypes()` kept the fallback whenever it outranked the advertised version. Discovery states what the connected backend accepts, so it is now authoritative; where one document maps several collections to the same key, the highest version still wins.
  - `Accept` headers for aDSO, transformation and value-help requests were bound to module-level constants, evaluated at import time — before discovery had ever run. They are resolved per call now, so a discovered media type actually reaches the request.

### Notes

- Because environment proxies apply again, a globally set `HTTP_PROXY` now also covers BW hosts that were previously contacted directly. Use `NO_PROXY` to exclude them. This restores the behaviour of versions before v1.2.0.
- Regression tests cover both fixes against a local fake backend and a local proxy, so neither needs a BW system to reproduce: `npm test`.

## [1.2.0] — 2026-07-29

### Added

- **BTP Cloud Foundry Deployment** — the MCP server now runs centrally on SAP BTP Cloud Foundry as an HTTP server (`npm run start:http`) instead of only locally via stdio. Enables shared hosting, concurrent users, and enterprise authentication
- **XSUAA OAuth Authentication** — BTP integration with SAP XSUAA service for identity management and role-based access control. **Built on the same [@arc-mcp/xsuaa-auth](https://github.com/arc-mcp/xsuaa-auth) module as [ARC-1](https://github.com/arc-mcp/arc-1)** for consistency across NextLytics MCP ecosystem. Stateless Dynamic Client Registration (DCR) + callback proxy pattern ensures secure, session-independent auth. Supports both BasicAuthentication (Stage 1: shared technical user) and Principal Propagation (Stage 2: per-user identity)
- **Role-Based Access Control (RBAC)** — two role collections ship with xs-security.json:
  - `BW MCP Reader` — read-only access to the metadata and query tools (via `read` scope)
  - `BW MCP Developer` — full access including create/update/delete/activate (via `write` scope). Write scope implicitly grants read, following the principle of least surprise
- **Scope Enforcement** — new `src/scopes.ts` enforces which tools require which scopes; read-only tools are explicitly listed, all mutations default to `write`, ensuring new tools are safe by default (unavailable to read-only users until explicitly whitelisted)
- **Cloud Connector Integration** — BTP destinations route on-premise BW traffic via Cloud Connector; supports HTTP proxy type for transparent connectivity without exposing internal networks

### Improved

- **Security by Default** — the scopes system defaults new write tools to `write` scope rather than accidentally permitting them to read-only users. Classification comes from actual HTTP verbs (POST/PUT/DELETE usage, not tool name)
- **xs-security.json Structure** — three-layer authorization model (scopes → role-templates → role-collections) allows future granularity without code changes; documentation added for extending roles (query, monitor, metadata, data_push, admin scopes as examples)

### Fixed

- **stdio entrypoint compatibility** — `dist/index.js` again starts the stdio server when executed directly (`node dist/index.js`), via a run-as-main guard. The Cloud Foundry refactor had moved the bootstrap into `dist/stdio.js`, silently breaking existing local MCP client configurations that launch `dist/index.js`: the process started but exited within seconds without completing the MCP handshake. Both `dist/index.js` and the canonical `dist/stdio.js` bin now work; the guard does not fire when the module is imported, so the HTTP entrypoint never double-starts

### Notes

- **Shared technical user (Stage 1)** — `BasicAuthentication` via the BTP destination, tested and verified end-to-end
- **Principal propagation (Stage 2)** — per-user identity via Cloud Connector certificate propagation plus ABAP-side CERTRULE and ICM reverse-proxy trust, tested and verified end-to-end; setup documented in docs/CENTRAL-HOSTING-SETUP.md (Stage 2) and docs/CLOUD-FOUNDRY.md §3
- **stdio Mode Unchanged** — local stdio invocation (`npm run start`) continues to work without authentication, unchanged by this release. The HTTP server is additive; upgrading an existing local install is non-breaking
- **npm Package** — bw-modeling-mcp is now published to npm as both stdio (default `bin` entrypoint) and HTTP (via `npm run start:http`)

## [1.1.0] — 2026-07-23

### Added

- `bw_create_rkf` — create one reusable Restricted Key Figure (RKF, TLOGO ELEM) on an InfoProvider from a base key figure plus one or more characteristic restrictions (built for mass creation, one RKF per call); each restriction value is validated against the InfoProvider and mapped to its internal key, and the RKF is written consistent (no separate activation step). Media-type negotiation follows the working query path and the observed backend behaviour: the CREA lock on the shared `comp/enq` endpoint uses the query media type (that endpoint negotiates the same type for every ELEM component, Query and RKF alike), and the writes on the dedicated `/rkf/<name>/a` resource send `Accept` as a version range (the resource negotiates a lower version than the discovery-advertised collection — verified live: resource speaks `rkf-v1_9_0` while discovery advertises `rkf-v1_10_0`), so a single discovery-derived value is never pinned. Verified live on BW/4HANA
- `bw_add_process_chain_program` — add an "Execute ABAP Program" step (RSPC process type ABAP) to an existing Process Chain, optionally with a named SE38 selection variant. In-place edit: the program call is stored as an inline process variant inside the chain model (no separate variant object). Positioning via `before` / `after` / `predecessor` (default: strand end closest to the trigger); idempotent (an existing ABAP step for the same program/variant is skipped), with ETag concurrency and transport handling

### Improved

- `bw_create_process_chain` / `bw_update_process_chain` — new `ADSOREM` step type ("Delete Requests from DataStore Object" / DSO request cleanup) with an inline variant; one entry per aDSO carrying its cleanup action and request selection (all requests / keep last N / older than N days / package size)

### Fixed

- `bw_set_dtp_filter_routine` — the routine's inactive version is now syntax-checked before activation. Broken routine code (e.g. `i_r_request->get_dtp( )`, which does not exist on the request interface) is reported with the ABAP error messages and the DTP is left unchanged, instead of being silently reported as "activated". The generated program's EU (ADT) enqueue lock is now released on the error path too (no orphaned SM12 lock), and a genuine activation failure is surfaced instead of returning success
- Process chain transport check — a `validateobject` HTTP 404 caused by a stale stateful MCP session is now handled softly (the write proceeds without a transport header) instead of aborting. The previous hard abort wrongly blocked follow-up writes to local (`$TMP`) chains, which need no transport at all; a genuinely transportable object is still refused by the PUT with HTTP 403, at which point a transport request must be supplied

## [1.0.0] — 2026-07-17

The largest feature drop so far, and the release that takes the server to 1.0: a broad
wave of write tools turns what was already a solid read/write toolkit into full
BW/4HANA modeling coverage — query authoring, extended process chain authoring,
transport-request integration, and a hardened session model. No breaking API changes.

### Added

- Query authoring — the query object graduates from read-only to fully writable:
  - `bw_create_query` — create a new, consistent query (TLOGO ELEM) on an InfoProvider in package $TMP; with the new `copy_from` parameter the query is created as a full copy of an existing query (layout, filter, variables, key figures), deriving the InfoProvider from the source when none is given
  - `bw_update_query_layout` — rows, columns, structures, and free characteristics
  - `bw_update_query_filter` — query filter and restrictions
  - `bw_update_query_key_figures` — basic key figures, RKF/CKF references, and local formula members (recursive operator/operand tree), with exception aggregation, display properties, and member removal
  - `bw_update_query_settings` — query properties
  - all four update tools accept an optional `transport` request number for queries on a transportable package
  - query deletion via `bw_delete`
- Process chain authoring, extended:
  - `bw_append_process_chain_dtp` — append one DTP load step (optionally with its own DSO activation step) to an existing chain
  - `bw_swap_process_chain_dtp` — swap one DTP load variant for another in an existing chain
  - `bw_add_process_chain_error_links` — add on-error (negative) links by mirroring the existing success links
  - `bw_create_decision_variant` — create a DECISION process variant for use as a branch/decision step
- Transport lifecycle:
  - `bw_create_transport_task` — add a task (sub-request) for a user to an existing workbench transport request
  - `bw_list_changeable_transports` — list transport requests and their tasks via the BW transport state (`cto/check`)
- DataSource authoring:
  - `bw_change_datasource_delta` — change the delta process of a DataSource (full read-modify-write of `deltaProperties`)
  - `bw_set_datasource_fields` — set the transfer flag of DataSource fields and/or the segment `language_field`
- `bw_set_transformation_expert_routine` — write Start/End/Expert routine code into the transformation master so it survives activation and transport

### Improved

- `bw_create_dtp` — `target_object_subtype` (`ATTR` / `TEXT` / `HIER`) selects the InfoObject sub-object role for InfoObject targets, mapped to the correct DTP type code (`IOBJA` / `IOBJT` / `IOBJH`); previously only attribute targets were reachable
- `bw_update_query_key_figures` — `add_formula` documents the full BW analytic-engine operator catalog (basic, percentage, data, mathematical, trigonometric, and boolean operators plus ternary `IF`) and validates each operator's operand count before saving, so a malformed formula fails with a clear message instead of leaving the query saved in an inconsistent state; operator codes are now case-insensitive. `LEAF` (which BW encodes as a dedicated nullary token, not a prefix operator) is rejected client-side rather than producing an HTTP 500

### Fixed

- `bw_set_transformation_runtime` — runtime switches no longer report false `runtime_not_persisted` errors and no longer get silently reverted. Root cause was the server-side ADT session model buffer: a session that had previously read (or locked) the transformation keeps serving its stale model even with `forceCacheUpdate=true`, so (a) the post-activation verify read the OLD active version through the shared long-lived client and reported a persisted switch as failed, and (b) a later read-modify-write through the same session could resurrect the stale `HANARuntime` value and re-persist it. The switch attempt (lock → GET `/m?forceCacheUpdate=true` → PUT → activate → unlock) and every active-version read (initial `already_set` decision and verify) now each run in a fresh session, which always returns the database state. Verified live with an abap→hana round-trip and independent virgin-session confirmation; the failure mode is value-independent (`sapHANAExecutionPossible` `COULD` and `MUST_NOT` alike, matching a manual-GUI trace of the `COULD` case)
- Transformation write tools hardened against the same stale-session hazard: `bw_get_transformation`, `bw_update_transformation`, `bw_set_transformation_routine`, `bw_set_transformation_expert_routine`, `bw_set_transformation_routine_fields`, `bw_delete_transformation_routine`, and the post-create persistence check now read the transformation model through a fresh session with `forceCacheUpdate=true` (shared helper). Their previous pre-lock reads through the long-lived client could return a pinned stale model, and PUTting a model built on such a read silently resurrects old attribute values — the plausible mechanism behind observed runtime reversions. Lock ownership and the returned `lock_handle` contract are unchanged; verified live that the shared read path returns the database state through a deliberately dirtied session
- The same fresh-session read hardening applied across the other object types (shared `freshRead` helper in the BW client): all five aDSO update tools and `bw_get_adso` (their model reads ran before the lock, the hazardous pattern), the `bw_get_infosource` / `bw_get_infoobject` / `bw_get_dtp` / DTP-details readers (diagnostic reads must reflect the database, not a pinned session buffer — this also removes the known stale inactive-shadow behavior of `bw_get_dtp`), the InfoObject lookups inside aDSO field addition, and `bw_update_infosource`'s post-lock read now passes `forceCacheUpdate=true`. Update tools that already lock before reading (InfoObject, InfoSource, DTP) were left on the locking session, since the lock refreshes the session's model buffer (verified live)
- `bw_set_transformation_routine` — EXPERT routines on HANA-runtime transformations no longer generate a plain ABAP class instead of an AMDP class. The initial step is now sent bare (no `classNameM`, no `methodNameM`, no per-field target elementRefs, no `sourceSegment` on the group) so the server derives the class itself and generates a proper AMDP class (`interfaces IF_AMDP_MARKER_HDB`, method `BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT`); the server-generated class source is left untouched (the END-oriented SELECT skeleton no longer applies, since the EXPERT IN type follows source columns and OUT follows target columns). Verified against a native Eclipse BWMT trace
- `bw_set_transformation_routine` — creating a global routine on a transformation that has no existing rule group no longer throws. When no `<group id="1">` is present the new group is appended as the last child of `<trfn:transformation>` instead of requiring an existing group to insert before
- `bw_get_request` / `bw_list_requests` — the message log (the primary diagnostic source) no longer dies on a 404 from the storage-dependent header/DTP-info/process endpoints when the storage code is wrong; each section is now isolated via `Promise.allSettled` and reported independently

---

## [0.9.2] — 2026-07-02

### Added

- `bw_change_package` — reassigns an existing BW object to a different package (Development Class) and records the change on a transport request via the CTO write endpoint (`/sap/bw/modeling/cto/write`); a single write with no activation, so the object is left inactive and must be re-activated with `bw_activate` using the same transport; for `object_type` `RSDS` the source system is mandatory (compound key) and the applied package is verified by re-reading the DataSource, guarding against the orphan-TADIR case where `writeResult="S"` is returned but the real object's package stays unchanged; verified for `TRFN` and `RSDS`

### Improved

- `bw_create_transformation` — new `source_object_subtype` / `target_object_subtype` parameters (`TEXT` / `ATTR` / `HIER`) to select the InfoObject facet when a source or target is an InfoObject (`IOBJ`): text table, attributes / master data, or hierarchy; passed through to both the transient GET (`sourceobjectsubtype` / `targetobjectsubtype`) and the transformation XML (`subType`)

---

## [0.9.1] — 2026-06-27

### Fixed

- `bw_search` / `bw_get_process_chain` — corrected the TLOGO codes in the tool and `object_type` descriptions: InfoSource is `TRCS` (not `ISFS`) and Process Chain is `RSPC` (not `PRCH`); the wrong codes were passed straight to the search endpoint and caused an HTTP 500. Verified against the `RSTLOGO` domain (`DD07T`) and live `bw_search` calls

---

## [0.9.0] — 2026-06-27

### Added

- `bw_get_aggregation_level` — reads an Aggregation Level (ALVL): the planning-enabled view on top of an InfoProvider, with the complete element list — characteristics including type, length, conversion routine, base InfoObject, compounding, and dimension group; key figures including aggregation behavior, semantics (AMO/QUA/NUM), and unit/currency reference (unit characteristic, fixed unit, or fixed currency)
- `bw_get_planning_function` — reads a Planning Function (PLSE): function type, aggregation level, documentation, characteristic usage roles, conditions, and the full parameter tree with nested structure and values; for FORMULA functions the FOX code surfaces as the value of the FLINE parameter
- `bw_get_planning_sequence` — reads a Planning Sequence (PLSQ): ordered step list with type code, aggregation level, planning function, and filter name per step
- `bw_get_planning_properties` — reads the Planning Properties (PLCR) of a plan-enabled InfoProvider (real-time aDSO or CompositeProvider): key-date mode, maximum characteristic combinations, and save strategy (planning sequence and delta-read flag); data slices not yet included
- `bw_create_process_chain` — creates a Process Chain (RSPC) via the BW/4HANA Cockpit REST API; builds the chain model from a step and edge list, creates a trigger-only skeleton, then updates it with the full model in one operation; optionally activates after creation; supported step types: `DTP_LOAD`, `ADSOACT`, `CHAIN` (local sub-chain start, verified), and collectors `AND` / `OR` / `XOR`; inline-configured process types (ABAP programs, OS commands, attribute change runs, etc.) are not yet supported
- `bw_update_process_chain` — replaces the step model (nodes and edges) of an existing Process Chain; preserves the existing trigger node and scheduling configuration; optionally overrides description and InfoArea
- `bw_activate_process_chain` — activates an existing Process Chain; returns the top-level activation message, severity, and full log
- `bw_list_process_chain_runs` — lists execution runs of one or all process chains from the monitoring log; filterable by chain name, start date range, and status; ordered by start time descending; default limit 20
- `bw_get_process_chain_run_detail` — reads step-level and message-level detail of a single chain run, including error messages; chain_id and log_id come from `bw_list_process_chain_runs` or `bw_list_process_chain_last_status`
- `bw_list_process_chain_last_status` — last execution status and scheduling state for every chain in the system; one row per chain; includes log ID of the most recent run
- `bw_get_open_hub` — reads an Open Hub Destination (DEST): destination type, source object, DB table, InfoArea, package, status, the complete output field list with type/length, InfoObject binding, conversion routine, compounding, and key flag; file properties for FILE-type destinations
- `bw_list_remote_entities` — lists the remote entities (HANA views / virtual tables) a source system exposes as a DataSource basis; read-only discovery matching the Eclipse DataSource proposal page; the returned `technical_name` is exactly what binds into `bw_create_datasource`
- `bw_create_datasource` — creates a DataSource (RSDS) on top of a remote entity from the server's field proposal, leaving it inactive; the server derives the full segment and field structure from the remote entity; local objects only (`$TMP` in v1); activation is a separate step via `bw_activate` (object_type `rsds`)
- `bw_set_transformation_routine_fields` — edits the list of target fields a global END routine writes ("Felder setzen" in SAP GUI); accepts an explicit field list (`fields`) or an exclusion list (`exclude_fields`); requires an existing END routine; does not activate; returns lock_handle for `bw_activate`

### Improved

- `bw_activate` — now supports `hcpr` (CompositeProvider) as an activatable object type
- `bw_create_dtp` — new `IOBJ` target type for InfoObject attributes; the BW XML `type` attribute is correctly set to `IOBJA` (InfoObject Attribute DTP target role)
- `bw_update_transformation` — supports field-based direct mapping for targets without an underlying InfoObject; previously always attempted an InfoObject GET, which fails for plain aDSO/InfoSource field targets

### Notes

- `bw_get_planning_properties` reads `generalSettings` only; data slices (PLDS) are not yet included
- Process chain authoring uses the BW/4HANA Cockpit REST API (`/sap/bc/http/sap/bw4/v1/modeling/processchains`) — the same API consumed internally by the BW/4HANA Cockpit

---

## [0.8.0] — 2026-06-09

### Added

- `bw_run_dtp` — starts (executes) a DTP load via `POST /sap/bw/modeling/dtpa/executerun`; returns the new run request id from the `Location` header (an RSPM TSN usable directly with `bw_get_request`); runs in a fresh session to avoid stale-buffer and concurrency issues
- `bw_list_requests` — lists load requests for a target InfoProvider via the BW/4HANA `/sap/bc/http/sap/bw4/v1/manage/requests` API; shows status, last process status/action, record count, timestamp, user, and TSN
- `bw_get_request` — full status analysis of one load request in a single call: header, DTP information (start/finish/duration), process step chain, and message log; `format="raw"` returns the parsed JSON of all four payloads
- `bw_activate_request` — activates loaded data (DSO request activation): moves a finished load from the inbound table into the active data table + change log via `POST .../manage/requests/{tsn}/{storage}/activate`; runtime activation distinct from `bw_activate`; asynchronous
- Cookie-based authentication for SAML- or OAuth-fronted BW systems (e.g. BW Bridge on the SAP BTP ABAP stack): set `BW_COOKIE_FILE` to a browser-exported cookie file (Netscape or `name=value` format); `BW_USER` / `BW_PASSWORD` become optional; login and session handling analogous to vibing-steampunk
- `bw_create_adso` — new `template_type` (`ADSO` default / `RSDS`) and `source_system` parameters: propose aDSO fields from a DataSource, not only from another aDSO
- `bw_create_dtp` — new `source_system` parameter: use a DataSource as the DTP source (`source_type="RSDS"`)
- `bw_update_dtp` — new `extraction_mode` parameter (`full` / `delta`) to switch an existing DTP between Full (`extractionMode="F"`, `deltaSettingStatus="0"`) and Delta (`extractionMode="D"`, `deltaSettingStatus="2"`); switching modes has BW delta-init implications (a later delta load may require re-initialization)
- `bw_activate` — new object type `rsds` (with `source_system`) to activate a DataSource

### Improved

- `bw_get_request` / `bw_list_requests` — surface the last process status and last action alongside the request status, so a finished green load is no longer reported as "in process"
- Media-type handling is now fully discovery-driven: the discovery parser reads every `<app:accept>` per collection (previously only the first, so workspaces listing a `+json` variant first fell back to hardcoded media types) and selects the highest-versioned `+xml` type; the query read path leads with the discovered media type

### Fixed

- Query reads negotiate the backend content-type version correctly instead of failing with HTTP 415 when the backend returns a version outside the previously hardcoded Accept range (#11)
- DTP activation no longer fails with a false "transformation inactive" error — the pre-activation priming GET and the activation POST now share one fresh session
- Adding fields to staging / inbound aDSOs (which have no key elements) no longer produces an invalid element position that was rejected on activation
- Date (DATS) constants in transformation rules are written in the external date format so they survive activation
- Transformation rule editing selects the field's own rule (not the global start/end routine rule) on transformations that have a start/end routine

### Notes

- The runtime tools (`bw_run_dtp`, `bw_list_requests`, `bw_get_request`, `bw_activate_request`) use the BW/4HANA `/sap/bc/http/sap/bw4/v1/manage` API — the same API the BW/4HANA Cockpit uses — rather than the `/sap/bw/modeling` tool API
- `bw_activate_request` only applies to aDSOs that have an activation step (not inbound-only staging aDSOs)

---

## [0.7.0] — 2026-05-21

### Added

- `bw_get_process_chain` — reads a Process Chain (RSPC) definition via the BW/4HANA-specific endpoint (`/sap/bw/modeling/rspc/{name}/m`, Accept: `application/vnd.sap.bw4.modeling.processchain-v1_0_0+json`); returns header metadata (description, InfoArea, status, version), scheduling attributes (job priority, owner, server, streaming mode), monitoring settings (auto-monitored, error notification, keep-alive, auto-reset), all steps (nodes) with process type, variant, description, last execution status, DECISION branch labels with socket resolution, OR join annotations, and sub-chain references; edges with full conditional flow semantics (positive/negative/neutral, DECISION branch names resolved from socket descriptions); inline variant section; by default (`include_variant_details=true`) automatically fetches and embeds variant configuration for each step via internal calls to `/sap/bw4/v1/modeling/processtypes/{type}/variants/{name}/m` — deterministic, not prompt-driven; types with no variant schema (DTP_LOAD, CHAIN, OR, AND, EXOR, DTP_ADSO) are skipped; set `include_variant_details=false` for structural overview without variant detail; `format="raw"` returns full parsed JSON; use `bw_search` with `object_type=RSPC` to find chain names
- `bw_get_process_variant` — reads the detail configuration of a single Process Chain step variant from `/sap/bw4/v1/modeling/processtypes/{type}/variants/{name}/m`; generic across all 93 BW/4HANA process types; `oDetail` returned as indented JSON regardless of type — covers ABAP (program + selection variant), ADSOACT (aDSO + NOCONDENSE), ADSOREM (cleanup: days/requests), PLSWITCHL/PLSWITCHP (target aDSO), TRIGGER (full scheduling payload), DECISION (branch formula expressions), and any unknown type; `format="raw"` returns full parsed JSON; process_type and variant_name come from `bw_get_process_chain` output
- `bw_preview_datasource` — fetches a live data preview from a DataSource (RSDS) via the internal `rsdsint/dataprev` endpoint (`POST /sap/bw/modeling/rsdsint/dataprev/{source_system}/{datasource}?records={n}&external=true`); field names resolved automatically from a prior GET on the DataSource structure; renders a padded plain-text table with proper column alignment; `records` parameter configurable (default 20); handles field/column count mismatch with fallback to `COL_N` headers and warning

### Notes

- Process chain support uses the BW/4HANA-specific `/sap/bw4/` API namespace — the same API consumed internally by the BW/4HANA Cockpit (Fiori); `Accept: */*` is used to negotiate the correct media type automatically
- `bw_get_process_chain` with recursive sub-chain expansion: call the tool again on any CHAIN-type step's variant name to drill into the sub-chain

---

## [0.6.0] — 2026-05-10

### Added

- `bw_get_roles` _(Read only)_ — reads the complete BW role hierarchy as shown in the Eclipse BWMT "Publish to Role" dialog; returns ROLE and FOLDER nodes with technical names, descriptions, and nodeids; optional `role_filter` parameter limits output to roles whose name starts with the given prefix (e.g. `"BW:"`); endpoint: `GET /sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=false`
- `bw_get_role_queries` _(Read only)_ — lists all BW Queries published in the role hierarchy, grouped by role and folder; only `SAP_BW_QUERY` objects are returned — PFCG menu entries of other types (e.g. AFO workbooks added as transactions) are not included; uses `readleaves=true` on the same endpoint to retrieve `<leaf>` elements
- `bw_get_query_roles` _(Read only)_ — returns all roles and folders where a specific BW Query is currently published; uses the `ancof` (ancestor-of) parameter: `GET /sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=<QUERYNAME>`
- `bw_set_query_roles` — publishes or removes a BW Query from a role or folder; supports `action="add"` and `action="remove"`, `target_type="role"` or `target_type="folder"`; for role-level add operations the full role subtree (folders + nodeids) is fetched from `bw_get_roles` and sent as `state="unchanged"` children in the PUT body; uses `PUT /sap/bw/modeling/comp/roles?type=SAP_BW_QUERY&ancof=<QUERYNAME>`
- `BwClient.rawPut()` — new HTTP PUT helper on the shared BW client; sends a raw request body with caller-controlled headers using a fresh axios instance and the current session cookie; used by `bw_set_query_roles`

---

## [0.5.0] — 2026-05-03

### Added

- `bw_query_data` _(Read only)_ — executes a BEx Query or previews data from an InfoProvider (aDSO, CompositeProvider) via the BICS reporting endpoint (`/sap/bw/modeling/comp/reporting`); parameters: `comp_id`, `is_provider` (adds `!` prefix for direct provider access), `state` (axis layout — ROWS/COLUMNS/FREE — plus per-characteristic filters supporting EQ/BT/GT/LT/GE/LE operators, include/exclude, external key, internal GUID key with `presentationMode="INT"`, and hierarchy-node filters via `nodeId=1`), `variables` (fills query variables; name and id must be copied verbatim from the GET response as they are session-specific and may contain trailing spaces), `from_row`/`to_row` (pagination), `drill_operations` (expand or collapse hierarchy and structure nodes by 1-based tuple index: `drill_state=3` expands, `drill_state=2` collapses), `format` (`text` default — formatted table with hierarchy indentation; `raw` — XML); all reporting calls use `X-sap-adt-sessiontype: stateless`; CSRF retry: on HTTP 403 the cached token is cleared and the request is retried once automatically
- `bw_get_filter_values` _(Read only)_ — looks up valid characteristic values before setting filters or variables; returns both `CHAVL_EXT` (use for state filters, `presentationMode="EXT"`) and `CHAVL_INT` (use for variable inputs); supports wildcard search (`*` for all, prefix match e.g. `2022*`); parameters: `characteristic_name`, `search_string`, `info_provider` (optional, scopes values to a specific provider), `max_rows` (default 201)

### Improved

- `bw_get_query` — added `format` parameter: `text` (new default) renders a compact human-readable summary covering settings, variables, filter, layout (rows/columns/free characteristics), CKFs, RKFs, exceptions, and cell definitions; `raw` returns the full parsed JSON (previous behaviour)
- `BwClient` — added `rawGet()` helper (shared session GET with caller-controlled headers, used by all reporting calls); CSRF token TTL of 4 minutes so that `ensureCsrf()` proactively re-fetches the token before SAP's ~5-minute session idle timeout expires (prevents "CSRF token has expired" failures in environments with slow tool-call approval); `clearCsrfToken()` public method exposed for use by retry logic

---

## [0.4.0] — 2026-04-26

### Added

- `bw_get_dataflow` _(Read only)_ — reads the complete structural data flow of any BW object (ADSO, RSDS, HCPR, TRFN, DTPA, IOBJ, TRCS, LSYS) using the same transient dataflow graph that Eclipse BWMT renders; supports direction (upwards / downwards / both), configurable depth levels, and format "text" | "raw"; text output uses tree rendering for ≤ 30 nodes and flat table for larger graphs
- `bw_list_source_systems` — lists all logical source systems (LSYS) registered in BW, optionally filtered by type (ODP_BW, ODP_SAP, ODP_CDS, ODP, FILE); returns name, description, type, status, and `children_path`
- `bw_list_datasources` — recursively traverses the full APCO hierarchy under a source system and lists all DataSources with name, description, status, and APCO path; format: `text` (default table) or `raw` (XML feed bodies)
- `bw_get_source_system` — reads full metadata of a single LSYS including type, description, connection details (ODP context/destination, HANA remote source/schema/SDI adapter)
- `bw_get_datasource` — reads complete DataSource structure: all fields with type, length, precision/scale, transfer flag, key flag, position, selection options, conversion exit, unit/currency reference, and active adapter config; format: `text` (default) or `raw` (XML)

### Improved

- `bw_xref` — new optional `source_system` parameter; required when `object_type=RSDS`; correct space-padded 40-character objectName (datasource padded to 30 + source system) is built automatically; explicit error thrown if omitted for RSDS
- `bw_get_transformation` — `raw` boolean replaced by `format: "text" | "raw"` parameter; `format="raw"` returns clean XML without wrapper header lines
- `bw_get_datasource`, `bw_list_datasources`, `bw_get_transformation` — unified `format: "text" | "raw"` parameter pattern across all three tools
- `bw_xref` tool description — documents that `object_type=DTPA` returns the process chain(s) a DTP belongs to, preferred over `bw_get_dtp` when only the process chain is needed
- `bw_get_dtp` tool description — documents that `bw_xref` with `object_type=DTPA` is the faster alternative when only process chain membership is needed

---

## [0.3.0] — 2026-04-24

### Added

- `bw_get_composite_provider` _(Read only)_ — reads a CompositeProvider (HCPR) structure: view node type (Union/Join), source providers with input mapping counts, all fields with dimension classification, join conditions, and temporal join details (extended from v0.2.0: field-level detail and join conditions fully parsed)
- `bw_get_ckf` _(Read only)_ — reads a global Calculated Key Figure with recursively resolved human-readable formula and full dependency graph of all referenced CKF/RKF sub-components
- `bw_get_rkf` _(Read only)_ — reads a global Restricted Key Figure: base measure resolved by name, all characteristic restriction groups with field and value details, and metadata
- `bw_get_structure` _(Read only)_ — reads a global Structure: all members with Formula/Selection breakdown, referenced components, characteristic filters, optional child members, and metadata
- `bw_list_contents` _(Read only)_ — navigates the full BW repository tree (InfoArea → type folder → object → sub-folder), mirroring the Eclipse BWMT Project Explorer; each entry includes `children_path` for seamless drill-down

---

## [0.2.0] — 2026-04-19

### Added

- `bw_get_query` — new read-only tool for BW Queries
  - Reads active version (`/A`) with automatic fallback to inactive (`/M`)
  - Parses all subComponents: Variables, Calculated Key Figures (CKFs), Restricted Key Figures (RKFs)
  - CKF formulas recursively resolved to human-readable strings: InfoObject names, cross-references between CKFs/RKFs, variable references, `IF` / `NOERR` / `NODIM` operators
  - RKF selection conditions fully parsed: key figure restrictions, characteristic restrictions, component references
  - Full layout parsing: columns, rows, free characteristics — both simple Dimensions and CustomDimensions (reusable structures)
  - CustomDimension members fully parsed including nested `childMembers` — inline RKFs with selection conditions and inline formulas with local member name resolution
  - Filter area: fixed values, variable references, mixed selections (variable + fixed value on same InfoObject)
  - Exceptions with alert levels, thresholds, cell coordinates, and evaluation flags
  - Grid cells and help cells fully parsed (cross-table layout queries)
  - Query-level settings: zero suppression, planning mode, result position, RFC/OData/easyQuery flags, sign presentation

---

## [0.1.0] — 2026-04-17

### Added

- Initial public release as pre-release (v0.1.0)
- aDSO: create, update (fields, settings, keys, field properties), delete — including write-interface (`pushMode`)
- InfoObject: create CHA + KYF, update attributes (DIS/NAV), delete
- InfoArea: create, move objects
- InfoSource (TRCS): create with/without template, update fields, delete
- Transformation: create (all source/target types), update (direct mapping, formula, field routines ABAP+AMDP, start/end routines), activate
- DTP: create, update (description + value filter), set filter routine
- Push API: `bw_push_data`, `bw_get_push_schema`
- General: search (`bw_search`), activate (`bw_activate`), where-used/xref (`bw_xref`), release locks (`bw_unlock`), delete (`bw_delete`)
