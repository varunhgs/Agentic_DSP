# BW/4HANA → SAP Datasphere Migration — Technical Guide

*Status as of 2026-10-23. Every claim below was checked against the code in this repository, the test runs, or a read-only call to BW/Datasphere made during the work. Where something is an interpretation or not yet verified, it says so.*

**How to read this guide:** each section starts with the plain-English idea, then the technical detail with file and function names. Labels used throughout:

- ✅ **Verified** — tested or observed on the real system.
- 🟡 **Implemented, not verified live** — code and unit tests exist, but it never ran against the real system.
- 🔶 **Partial**
- ⬜ **Not implemented**
- ⛔ **Blocked** — needs access or a decision from someone else.

---

## Contents

1. Executive summary
2. Business objective
3. Architecture diagram
4. Repository and module map
5. End-to-end execution walkthrough
6. BW MCP and BW authentication
7. Transformation extraction and generated ABAP
8. Intermediate representation and conversion logic
9. aDSO migration
10. Datasphere authentication, APIs and object creation
11. Technology stack
12. Commands, inputs and outputs
13. Tests and validation results
14. Completed vs. outstanding work
15. Security and credentials
16. Risks and mitigations
17. Alternative approaches
18. Question bank
19. Presentation scripts and demo
20. Next steps; questions for the BW and Datasphere teams

---

## 1. Executive summary

**Plain English.** We are building a tool that reads how a data flow is modelled in SAP BW/4HANA and rebuilds it as native objects in SAP Datasphere.

It has two halves:

- **BW reader.** An existing open-source server reads BW definitions over BW's own web APIs. We extended it.
- **Migration layer.** Our code turns those definitions into Datasphere definitions, checks them, and, for tables, creates them through Datasphere's REST API.

**What works today:**

- **aDSO → Datasphere local table, end to end.**
  - ✅ The structure of BW aDSO `ZAATM24` was created and deployed in Datasphere as `MIG_ZAATM24`.
  - ✅ Read-back validation passed 19/19 checks. That run was on 2026-10-06; `MIG_ZAATM24` still showed status `Deployed` when I checked on 2026-10-23.
- **Transformation → Datasphere transformation flow, as an offline proposal.**
  - The real transformation `0MGCDCTZGD79ZKMKR1IGUM4G3TMK9KLH` (`ZD_CRMFP → ZC_CRM12`, 36 rules) was read from BW.
  - It was converted into a proposed Datasphere transformation flow with SQL.
  - Every rule was checked against SAP's generated ABAP program. The calendar rules were also checked against the 279 rows BW actually stored.
  - The conversion has **no blocking rules** and passes offline validation. 🟡 Nothing has been created in Datasphere for it yet; that needs your approval.

**What does not exist yet:**

- data loading;
- comparing BW and Datasphere data (reconciliation);
- DTP and delta migration;
- migrating a complete multi-layer flow;
- retries and rate-limit handling in the migration layer.

---

## 2. Business objective

**Goal:** move complete BW data flows into Datasphere, preserving:

- the logic: transformations, routines and formulas;
- the structure: tables, keys, types and semantics;
- the order: dependencies and load sequence.

A BW flow is typically:

```
Source system → DataSource → Transformation + DTP → aDSO (staging)
              → Transformation + DTP → aDSO (reporting) → CompositeProvider → Query
```

**Scope so far:** prove two things on real objects.

1. An aDSO becomes a Datasphere table.
2. A transformation becomes a Datasphere transformation flow whose logic is explainable rule by rule.

The full-flow migration is designed for (a dependency graph and an IR with a reserved DTP slot) but not built yet.

---

## 3. Architecture diagram

```
                ┌──────────────────────────────────────────────────────────────┐
                │                 SAP BW/4HANA 2.0 (on-prem, via VPN)          │
                │  BW Modeling REST  /sap/bw/modeling/{type}/{name}/a|m        │
                │  ADT (ABAP dev)    /sap/bc/adt/programs|oo/classes|...       │
                │  ADT data preview  /sap/bc/adt/datapreview/freestyle (SQL)   │
                └───────────────▲──────────────────────────────────────────────┘
                                │ HTTPS · Basic Auth for CSRF fetch, then session cookie
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ BW Modeling MCP server  (repo root, TypeScript, v1.3.0 + our extensions)       │
│  src/bw-client.ts   BwClient (axios), createClientFromEnv, freshRead          │
│  src/index.ts       92 MCP tools (43 read / 49 write) over stdio or HTTP      │
│  src/tools/*.ts     adso, transformation, trfn_logic, abap_source, loaders…   │
└──────▲───────────────────────────────▲───────────────────────────────────────┘
       │ MCP over stdio                │ direct import of dist/*.js
       │ (aDSO path)                   │ (transformation parse, aDSO classifier)
┌──────┴───────────────────────────────┴───────────────────────────────────────┐
│ Migration layer  migration/  (TypeScript, Node ≥ 22)                         │
│  cli.ts  ── adso <NAME>  ───────────────► adso-parser → adso-to-local-table  │
│          │                                 → DatasphereClient → validate      │
│          └─ trfn --logic/--xml (dry run) ► trfn-source → transformation-ir    │
│                                            → trfn-to-transformation-flow      │
│                                            → validate/transformation-flow     │
│                                            → report/trfn-report               │
└──────────────────────┬───────────────────────────────────────────────────────┘
                       │ HTTPS · OAuth 2.0 client credentials → Bearer token
┌──────────────────────▼───────────────────────────────────────────────────────┐
│ SAP Datasphere  /dwaas-core/api/v1/spaces/{space}/localtables   (used)        │
│                 /dwaas-core/api/v1/spaces/{space}/transformationflows (only   │
│                 read so far; create not implemented)                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Stage by stage**

| # | Stage | In → Out | Where | Status |
|---|---|---|---|---|
| 1 | Entry point | CLI args → chosen command | `migration/src/cli.ts` `main()` | ✅ |
| 2 | Connect to BW | `BW_*` env → authenticated session | `src/bw-client.ts` `createClientFromEnv()` | ✅ |
| 3 | Retrieve metadata | object name → XML / ABAP text | MCP tools `bw_get_adso`, `bw_get_transformation`, `bw_get_abap_source`; `trfn_logic.ts` | ✅ |
| 4 | Parse | XML → typed objects | `migration/src/bw/adso-parser.ts`, `src/tools/trfn_logic.ts` `parseTransformationXml()` | ✅ |
| 5 | Classify + dependencies | parsed objects → type, dependency graph | `classifyAdso()`, `transformation-ir.ts` dependencies, `plan/graph.ts` `topoSort()` | 🔶 one transformation only |
| 6 | Normalise (IR) | parsed rules → IR v1 | `migration/src/ir/transformation-ir.ts` `buildTransformationIR()` | ✅ offline |
| 7 | Generate | IR → CSN / transformation-flow JSON + SQL | `adso-to-local-table.ts`, `trfn-to-transformation-flow.ts` | ✅ tables / 🟡 flows |
| 8 | Authenticate to Datasphere | client id/secret → bearer token | `migration/src/datasphere/client.ts` `accessToken()` | ✅ |
| 9 | Create / deploy | CSN → object in space | `createLocalTable()`, `updateLocalTable()` | ✅ tables / ⬜ flows |
| 10 | Validate | expected vs. read-back | `validate/local-table.ts`, `validate/transformation-flow.ts` | ✅ structural only |
| 11 | Report | results → files + console | `report.json` (aDSO), `mapping-report.md` etc. (trfn) | ✅ |

**These are five separate operations.** Don't let anyone merge them in the discussion.

| Operation | Meaning | Status |
|---|---|---|
| Metadata migration | Reading BW definitions | ✅ |
| Object-definition creation | Saving a definition in Datasphere (`deploy=false`) | ✅ tables |
| Deployment | Datasphere creates the real database object | ✅ tables |
| Data loading | Moving rows | ⬜ |
| Functional reconciliation | Proving Datasphere computes the same numbers as BW | ⬜ |

---

## 4. Repository and module map

**Which copy is the real one.** There are three copies on the machine; only one is a git repository.

| Location | Version | Role |
|---|---|---|
| `Downloads\bw-modeling-mcp-main\bw-modeling-mcp-main` | 1.3.0 | **The git repo** (1 commit `705eee3`; all our work is uncommitted). Primary from now on. |
| `…\bw-modeling-mcp-main (1)\…` | 1.4.0 | Unused copy |
| `…\bw-modeling-mcp-main (2)\…` | 1.7.1 | Not git. Where the aDSO migration was first built. Only its `migration/` folder was brought into the git repo, minus `.env`, `dist`, `output` and the PDF. |

Version 1.7.1 contains upstream features the git repo lacks, for example `bw_read_metadata_tables` and `bw_system_profile`. They were deliberately **not** merged; see §17.

**Repo root: the BW MCP server**

| Path | What it is | Who wrote it |
|---|---|---|
| `src/bw-client.ts` | HTTP client for BW: auth, CSRF, media types, `freshRead`, `postRaw` | upstream |
| `src/index.ts` | MCP server: registers 92 tools, input schemas, dispatch | upstream + our 2 new tools |
| `src/stdio.ts` / `src/http.ts` | MCP over stdio (IDE, CLI) / over HTTP (BTP Cloud Foundry) | upstream |
| `src/scopes.ts` | read vs. write tool scopes | upstream + ours |
| `src/tools/adso.ts` | aDSO read/create; **ours:** `classifyAdsoFlags`, `parseAdsoXml`, `adsoTypeCandidates`, json output | mixed |
| `src/tools/transformation.ts` | transformation read/write; **ours:** `format:"json"` branch | mixed |
| `src/tools/trfn_logic.ts` | **ours:** transformation XML parser, rule classes A/B/C/E, GP parser, routine source comparison | ours |
| `src/tools/abap_source.ts` | **ours:** read ABAP programs/classes/function modules via ADT | ours |
| `src/tools/adt-sql.ts` | **ours:** allow-listed read-only SQL (RSPMPROCESS/RSPMREQUEST only) | ours |
| `src/tools/bw-names.ts` | **ours:** URL encoding of namespaced names (`/` → `%24`) | ours |
| `src/tools/loaders.ts` + `scripts/loader-census.mjs` | **ours:** "what writes into this aDSO?" census | ours |
| `tests/*.test.mjs` | 42 tests | mixed |

**`migration/`: our migration layer**

| Path | Purpose |
|---|---|
| `src/cli.ts` | Commands `adso <NAME>` and `trfn --logic/--xml` |
| `src/config.ts` | Loads `migration/.env` / env vars; reuses `.mcp.json` BW env |
| `src/bw/mcp-source.ts` | `BwMcpSource`: starts the MCP server as a child process and calls tools |
| `src/bw/adso-parser.ts` | aDSO XML → `AdsoDefinition`; `classifyAdso()` |
| `src/bw/trfn-source.ts` | Transformation XML → parsed structure (reuses `trfn_logic.js`) |
| `src/converters/adso-to-local-table.ts` | aDSO → local table CSN; `mapType()`, `columnName()` |
| `src/ir/expr.ts` | Expression tree → SQL text and CQN |
| `src/ir/bw-formula.ts` | BW formula language subset → expression tree |
| `src/ir/transformation-ir.ts` | Builds the transformation IR |
| `src/plan/graph.ts` | Dependency ordering (`topoSort`) |
| `src/converters/trfn-to-transformation-flow.ts` | IR → `sap.dis.transformationflow` JSON + SQL |
| `src/datasphere/client.ts` | OAuth + Datasphere REST (local tables only) |
| `src/validate/local-table.ts` / `transformation-flow.ts` | Validators |
| `src/report/trfn-report.ts` | `mapping-report.md` |
| `tests/` | 37 tests; fixtures `ZAATM24.xml`, `TRFN_FPO_SANITIZED.xml`, `tf-reference-shape.json` |

**Ignored by git (never commit):**

- `.env` files;
- `dist/`, `migration/output/`;
- `census-out/`, which holds the real BW extracts and the dry-run output.

---

## 5. End-to-end execution walkthrough

### 5a. aDSO path (live, as run for ZAATM24)

`node migration/dist/cli.js adso ZAATM24`

1. `cli.ts main()` → `migrateAdso("ZAATM24", options)`.
2. `BwMcpSource.connect()` starts `node dist/stdio.js` as a child process. It passes the BW env from `.mcp.json` (via `config.ts loadBwEnv()`) and connects an MCP client over stdio.
3. `getAdsoXml()` calls the MCP tool `bw_get_adso {adso_name, format:"raw"}` and cuts the text before `<?xml`.
4. `parseAdsoXml()` turns it into an `AdsoDefinition`: fields, keys, flags. `classifyAdso()` imports the server's `adsoTypeCandidates()`, giving for example `standard`.
5. `convertAdsoToLocalTable()` produces CSN, the column mapping, warnings and a manual-work list.
6. `loadDatasphereConfig()` and `new DatasphereClient()`, then `localTableStatus()` checks whether the table exists. If it does, the run stops unless `--overwrite` is given.
7. `createLocalTable()` (POST) or `updateLocalTable()` (PUT) with `deploy=true|false`.
8. If deploying, `waitForLocalTable()` polls every 5 s for up to 180 s.
9. `getLocalTable(name, "design-time")` reads the table back, and `validateLocalTable()` runs the checks.
10. It writes `report.json` and prints SUCCESS or VALIDATION FAILED.

### 5b. Transformation path (offline dry run, as run for the real FPO transformation)

**Retrieval (read-only).** This is currently a helper script, `census-out/fetch-trfn2.mjs`. It's git-ignored and is not yet a CLI command.

1. `createClientFromEnv()` and `loadMediaTypes()`.
2. `freshRead('/sap/bw/modeling/trfn/<id>/a')` saves the raw XML.
3. `bwGetTransformationLogic()` (in `trfn_logic.ts`):
   - parses the XML;
   - reads the generated program via ADT;
   - matches GP rule blocks to XML rules;
   - looks for routine classes (none in this transformation);
   - writes `trfn.logic.json`.
4. `bwGetAdso(name, "raw", "active")` fetches the source and target aDSO XML.

**Conversion:**

`node migration/dist/cli.js trfn --logic …/trfn.logic.json --source-adso …/ZD_CRMFP.adso.xml --target-adso …/ZC_CRM12.adso.xml --out …/dryrun`

5. `proposeTransformation()` reads the JSON (or, with `--xml`, parses XML via `trfn-source.ts`).
6. `buildTransformationIR()` produces the IR: column types, one mapping per target, aggregation analysis, dependencies, diagnostics.
7. `tableOf()` converts the real aDSO XML with the **existing** aDSO converter, so the flow's target exactly matches the table we would create.
8. `convertIrToTransformationFlow(ir, {tables})` produces the flow JSON and SQL.
9. `validateTransformationFlow(ir, flow, {tables})` runs 25 checks.
10. It writes `ir.json`, `MIG_TF_ZC_CRM12.transformationflow.json`, `MIG_TF_ZC_CRM12.sql`, `dependencies.json`, `validation.json`, `issues.json` and `mapping-report.md`.

**Nothing is sent to Datasphere.**

---

## 6. BW MCP and BW authentication

**Plain English.** MCP (Model Context Protocol) is a standard way to expose "tools" to AI assistants and other programs. The BW Modeling MCP server wraps BW's modeling APIs as tools such as `bw_get_adso`. Claude in the IDE uses those same tools, and so does our CLI. So there's one BW integration, not two.

**How tools are called.**

- `src/index.ts` registers each tool with a name, a JSON input schema and a handler.
- A client sends `callTool({name, arguments})`; the result is text content plus an `isError` flag.
- In the migration layer, `BwMcpSource.callText()` turns `isError` into an exception carrying the tool's message.

**Sanitized example:**

```
→ callTool  name: "bw_get_adso"  arguments: { "adso_name": "ZAATM24", "format": "raw" }
← content[0].text: "…header lines…\n<?xml version=\"1.0\"…><adso:dataStore name=\"ZAATM24\" …>…"
```

**BW authentication** (`src/bw-client.ts`, `createClientFromEnv()`):

- **Variables:** `BW_URL`, `BW_USER`, `BW_PASSWORD`, `BW_CLIENT` and `BW_LANGUAGE`, or `BW_COOKIE_FILE`.
- **Basic Auth mode:** the user and password are sent only on the initial CSRF-token fetch. After that the **session cookie** is used, and `x-csrf-token` is added to write requests. `sap-client` is sent as a header.
- **Cookie mode:** for SSO-fronted systems such as BW Bridge, cookies are read from a file.
- **On BTP:** `src/http.ts` and the connectivity proxy (`Proxy-Authorization: Bearer`) with XSUAA. Not used in our migration runs.
- **Media types:** `loadMediaTypes()` reads BW's discovery document so each object type is requested in the version the system supports. Without it, bulk scripts got HTTP 415.
- **`freshRead()`:** reads with a new session, because a long-lived session can return a stale model buffer.

**Tools relevant to migration** (in this repo):

| Need | Tool | Complete? |
|---|---|---|
| aDSO definition | `bw_get_adso` (`text`/`raw`/`json`) | Full XML (`raw`) |
| Transformation | `bw_get_transformation` (`json` = rules + GP + routines) | Full; GP and `_M` class via ADT |
| ABAP source | `bw_get_abap_source` (PROG/CLAS/FUNC/INCL) | Full, windowed by line count |
| DTP | `bw_get_dtp`, `bw_get_dtps` | Header, filters, settings |
| DataSource | `bw_get_datasource` | Full |
| InfoObject | `bw_get_infoobject` | Full |
| CompositeProvider | `bw_get_composite_provider` | Full |
| Query | `bw_get_query` | Full |
| Process chain | `bw_get_process_chain`, `bw_get_process_variant` | Full |
| Lineage | `bw_xref`, `bw_get_dataflow` | Structural only — routine lookups are invisible |
| Writers into an aDSO | `bw_get_adso_loaders` (ours) | Evidence-based; see census doc |

**What cannot be retrieved, or is weak:**

- `_A` routine classes return HTTP 404; we read the `_M` class instead.
- The request monitor `/sap/bw4/v1/manage/requests` returns 403 (inactive service).
- A few objects return HTTP 500 in BW.
- Dynamic ABAP callers can't be found by where-used.

**Avoiding repeated calls:**

- The census uses a `CensusContext` cache, so each transformation, DTP and where-used result is read once per run.
- `trfn_logic` caches each routine class.
- The migration layer has **no** cross-run cache yet. The dry run re-uses saved files instead of calling BW again.

**Metadata ≠ migration.** Reading a definition tells you what BW has. Migrating means:

- building an equivalent Datasphere object;
- handling semantic differences;
- deploying it;
- loading data;
- proving the results match.

The reader is the first step of five.

---

## 7. Transformation extraction and generated ABAP

**Artifacts (verified present, in `census-out/fpo-trfn2/`, git-ignored):**

- `trfn.active.xml` (~136 KB)
- `trfn.logic.json`
- `GP7KSRM0CW2PGXXWRESQF4DSEB9.abap` (1,507 lines)
- `ZD_CRMFP.adso.xml`
- `ZC_CRM12.adso.xml`
- `dryrun/0MGCDCTZGD79ZKMKR1IGUM4G3TMK9KLH/`

### A. Metadata

- **Endpoint:** `GET /sap/bw/modeling/trfn/0mgcdctzgd79zkmkr1igum4g3tmk9klh/a`. `/a` is the active version; `/m` is the modified/inactive version.
- **Parsing:** `parseTransformationXml()` uses `fast-xml-parser` to read the source and target fields (type, length, key, aggregation) and the groups → rules → steps (`trfn:StepDirect`, `StepTime`, `StepConstant`, `StepFormula`, `StepRoutine`…), each with a rank of MAIN or MINOR.
- **Rule classes (`classifyRule()`):**

| Class | Meaning | Step types |
|---|---|---|
| A | Mechanical | direct, constant, initial, no-update |
| B | Needs semantic check | time, formula, read, unit, currency |
| C | Custom code | routines |
| E | Unknown | anything else |

- **Real result:**
  - 36 rules: 29 direct steps, 8 time steps, 1 constant. No formulas, no routines.
  - One rule group.
  - Runtime: `HANARuntime="true"`.

### B. The generated program (GP)

- **What it is.** When a transformation is activated, BW generates an ABAP program (`GP…`) from a template (`RSTRAN_MASTER_TMPL`) that implements every rule. In the **ABAP runtime** it *is* the code that runs. In the **HANA runtime**, which is the case here, HANA executes the rules and the GP is a faithful *reference*.
- **How we read it.** `readAbapSource(client, 'PROG', name)` calls the ADT endpoint `…/programs/programs/<name>/source/main`.
- **How we use it.** `parseGeneratedProgram()` splits it at the markers `*<<< Rule ID: 'n'.`, `* Step ID: 'k', Type: 'X'.` and `*>>>`. Each block is the executable code for exactly one rule. The rest is framework: data declarations, record loops, error handling, the `RECORDMODE` and aggregation scaffolding.
- **What it showed that the XML does not** (real examples):
  - **Rule 31 (`0CRMPOSTDAT → 0CALMONTH`).** If the date is blank or zero, BW clears the target. Otherwise it calls `RST_TOBJ_TO_DERIVED_TOBJ` with `i_timnm_from = '0CALDAY'`, and on error it **skips the record**.
  - **Rule 2 (`0BPARTNER`).** A hidden `CONVERT` step calls `CONVERSION_EXIT_ALPHA_INPUT` and raises a data error if the value changes, i.e. if it isn't in internal format.
  - **Rules 29/30.** The MAIN step assigns the amount and the MINOR step assigns `CURRENCY` from the same-named source field.
  - **Rule 36.** `RECORDMODE = ' '`.
- **Why both sources.** The XML is the authoritative *model*: what was configured. The GP shows the implicit *behaviour*: empty values, error handling, conversion exits, the actual time reference. Neither alone is enough.

---

## 8. Intermediate representation and conversion logic

### Why an IR

**Plain English.** Instead of jumping from BW XML straight to SQL, we first build a neutral, structured description of the transformation. That gives us:

1. **One place for semantics.** Decisions such as "empty date → `000000`" or "do rows collapse?" are made once.
2. **Several outputs from one source.** The SQL text *and* the CQN (Datasphere's parsed query) come from the same expression tree, so they can't disagree.
3. **Traceability.** Every target column remembers its rule id, step ids and BW formula or constant.
4. **Explicit gaps.** Anything untranslatable becomes a diagnostic with a code.
5. **Extensibility.** DTPs, lookups and routines can be added as new IR parts. `dtp` is already reserved.

### IR v1 (`TransformationIR` in `transformation-ir.ts`)

| Field | Contents |
|---|---|
| `source`, `target` | BW type/name, Datasphere table name, columns: BW type, CDS type, length/precision/scale, key, aggregation, technical flag |
| `mappings[]` | One per target column: `kind`, `sources`, `expr`, optional `aggregate`, `status` (`translated` · `needs_review` · `unsupported` · `technical`), `notes`, `trace` |
| `globalRoutines` | START / END / EXPERT routines, which always block |
| `aggregation` | `collapses`, `reason`, `groupBy` |
| `dependencies` + `creationOrder` | source table → target table → flow, ordered by `topoSort()` |
| `diagnostics[]` | severity, code, message, rule, field |

### One real rule through every stage (rule 31)

```
BW XML         <rule id="31"> source 0CRMPOSTDAT → target 0CALMONTH, step StepTime (MAIN)
GP evidence    IF CRMPOSTDAT CO ' 0' → CLEAR CALMONTH
               ELSE RST_TOBJ_TO_DERIVED_TOBJ(i_timnm_from='0CALDAY', i_timnm_to='0CALMONTH')
Parsed rule    {"id":"31","sourceFields":["0CRMPOSTDAT"],"targetFields":["0CALMONTH"],
                "steps":[{"kind":"TIME","rank":"MAIN"}],"conversionClass":"B"}
IR mapping     {"target":"CALMONTH","kind":"TIME","status":"needs_review",
                "notes":["time reference 0CALDAY taken from the generated program",
                         "0CALDAY → 0CALMONTH: initial or NULL date → 000000, as BW"],
                "expr":{"k":"func","name":"COALESCE","args":[{"k":"func","name":"TO_VARCHAR",
                        "args":[{"k":"ref","column":"CRMPOSTDAT"},{"k":"val","value":"YYYYMM"}]},
                        {"k":"val","value":"000000"}]}}
SQL            COALESCE(TO_VARCHAR(S."CRMPOSTDAT", 'YYYYMM'), '000000') AS "CALMONTH"
CQN            {"func":"COALESCE","args":[{"func":"TO_VARCHAR","args":[{"ref":["S","CRMPOSTDAT"]},
                {"val":"YYYYMM"}]},{"val":"000000"}],"as":"CALMONTH"}
Flow target    attributeMappings: {"source":"CALMONTH","target":"CALMONTH"}
```

### What the converter supports today

| Construct | Handling | Code |
|---|---|---|
| Direct mapping | Column reference; error if types differ; review if the target is shorter or has lower precision | `case 'DIRECT'` |
| Constant | Literal; error if it doesn't fit the type | `case 'CONSTANT'` |
| Initial / no update | BW initial value (`''`, zeros, `0`); no-update needs review; date or key → error | `initialValue()` |
| Formula | Subset: `IF`, `LEFT`, `RIGHT`, `CONCATENATE`, `+ − * /`, comparisons, `AND/OR/NOT`; anything else → `FORMULA_UNSUPPORTED` with the formula text | `bw-formula.ts translateBwFormula()` |
| Time conversions | From day: month, year, month-of-year, day, ISO week, half year. From month: year, month. Time reference taken from the GP. Empty date → BW initial value | `TIME_CONVERSIONS` |
| Fiscal conversions | Same InfoObject on both sides → copy (the GP shows a plain copy). Calendar → fiscal → `TIME_UNSUPPORTED` (needs the fiscal year variant) | — |
| Amount + currency (multi-target rule) | Same-name assignment per target, as in the GP; a repeated identical write is merged; differing writes → `CONFLICTING_RULES` | multi-target branch |
| Aggregation | If every source key reaches the target 1:1, no collapse. Otherwise `GROUP BY` the key expressions and `SUM/MIN/MAX` key figures; overwrite (MOV) → `ORDER_DEPENDENT_OVERWRITE` | aggregation block |
| `RECORDMODE`, `REQTSN`… | `technical`: not a table column | `TECHNICAL_FIELDS` |
| GP-only conversion-exit check | Marks the rule `needs_review` with the exit name | `gpConvert` block |
| Routines (field/start/end/expert) | `FIELD_ROUTINE` / `GLOBAL_ROUTINE` / `EXPERT_ROUTINE`: blocking | — |
| Lookups (StepRead), unit/currency conversion | `LOOKUP`, `CONVERSION_TYPE`: blocking | — |
| DataSource as source | `SOURCE_NOT_ADSO`: blocking | — |

**Rule of the converter:** an untranslated rule is **never** dropped silently. Its column is omitted, a diagnostic is recorded, and `deployable` becomes `false`.

### The generated flow (`trfn-to-transformation-flow.ts`)

- **Format:** `{"transformationflows": {"MIG_TF_ZC_CRM12": {kind: "sap.dis.transformationflow", contents: {…}}}}`.
- **Processes:** `sqltransform1` (`com.sap.dwc.sqltransform`) holds the SQL text (`@DataWarehouse.sqlEditor.query`) and its CQN (`query`). It connects `outTable → inTable` to `target1` (`com.sap.dwc.target`), which carries the `attributeMappings`.
- **Settings:** `loadType: INITIAL_ONLY` and `truncate: true` (full reload).
- **Where the structure comes from:** copied key for key from a flow the Datasphere editor saved in our space (`Tf_adj_qty`, read-only, 2026-10-23). The validator checks all 7 structural parts against it.

### Semantic differences we found (real examples)

| Topic | BW behaviour | Datasphere behaviour | How we handle it |
|---|---|---|---|
| Empty dates | `00000000` is a valid "initial" date | A date column holds NULL instead | The aDSO converter warns to load it as NULL; time rules `COALESCE(…, '000000')`, matching the GP's `CLEAR` |
| Invalid dates | GP skips the record | The load fails | Reported; needs a load-side decision |
| Trailing spaces | BW comparisons ignore trailing blanks | SQL `=` may not | Every formula comparison gets a review note |
| Partner number (ALPHA) | GP rejects values not in internal format | Copied unchecked | Rule 2 is `needs_review` |
| Aggregation | SUM key figures accumulate on every delta load | Flow reloads fully | Info diagnostic `SUM_DELTA_SEMANTICS` |
| Processing order | Overwrite keeps the *last* record | SQL has no row order | `ORDER_DEPENDENT_OVERWRITE` blocks it |
| Week numbering | BW stored ISO weeks (checked on 279 rows) | `ISOWEEK()` returns `YYYY-Www` | `REPLACE(ISOWEEK(d),'-W','')`; format to confirm on deploy |

### Real result for transformation 2

| Status | Rules |
|---|---|
| Translated, verified against GP / data | 1, 3–30, 33 (31 rules) |
| Translated, needs review | 2 (ALPHA), 31, 32, 34, 35 (time; checked on 279 stored rows, but the empty-date branch and year-boundary weeks are unseen in the data) |
| Technical | 36 (`RECORDMODE`) |
| Unsupported | none |

No rows collapse: all three source key fields (`0CRM_FMGUID`, `0CRM_FMITGU`, `0FISCVARNT`) reach the target. So no `GROUP BY` is needed.

---

## 9. aDSO migration

1. **Read:** `bw_get_adso` raw XML via MCP.
2. **Parse:** `parseAdsoXml()` reads the elements (`inlineType` name/length/precision/scale), `keyElement` list, InfoObject, aggregation, unit/currency reference, and the flags `activateData`, `writeChangelog` and so on.
3. **Type:** `classifyAdso()` → `adsoTypeCandidates()` → `classifyAdsoFlags()`, which inverts the server's own creation presets:

| Type | Flags | Meaning |
|---|---|---|
| standard | activate + change log | Semantic key; overwrite/aggregate on activation; change log for delta |
| data mart | activate + cube-delta-only | **No semantic key**. All characteristics form the aggregation key, like an InfoCube. Example: `ZC_CRM12` |
| staging (3 variants) | inbound queue only / compress / reporting | Staging layer |
| direct update | written by API, not DTPs | — |

4. **Map** (`convertAdsoToLocalTable()`):
   - **Type mapping (`mapType`):** `CHAR/NUMC/CUKY/UNIT → cds.String(n)` (NUMC stays a string because leading zeros matter), `DATS → cds.Date`, `TIMS → cds.Time`, `CURR/QUAN/DEC → cds.Decimal(p,s)`, `INT* → cds.Integer/Integer64`, `FLTP → cds.Double`. An unmapped type is an error.
   - **Column names (`columnName`):** `0CUSTOMER → CUSTOMER`; `/ABC/F → ABC_F`.
   - **Keys:** primary key = the aDSO key.
   - **Key figures:** become measures with `@Aggregation.default`, and are linked to their currency/unit column via `@Semantics.amount.currencyCode`. A table with measures becomes semantic usage `ANALYTICAL_FACT`, otherwise `DATA_STRUCTURE`.
   - **Manual-work list:** data load, InfoObject associations, change-log delta, planning.
5. **Create:** POST/PUT `localtables` (§10).
6. **Validate:** `validateLocalTable()` checks:
   - the table exists and is deployed;
   - semantic usage;
   - column count;
   - primary key;
   - per column: type, length, precision, scale, key and semantics annotations;
   - no extra columns.

   For ZAATM24 that was 19 checks.

**What 19/19 proves:** Datasphere stored exactly the structure we intended.

**What it doesn't prove:** that the data is there, that loads work, or that reports give the same numbers.

---

## 10. Datasphere authentication, APIs and object creation

**Configuration** (`migration/src/config.ts loadDatasphereConfig()`):

- **Variables:** `DSP_HOST`, `DSP_SPACE`, `DSP_CLIENT_ID`, `DSP_CLIENT_SECRET` and `DSP_TOKEN_URL`.
- **Where they come from:** the environment or `migration/.env` (git-ignored). The template is `.env.example`.
- **Location today:** the real `.env` exists only in the 1.7.1 copy; it was not copied into the git repo.

**OAuth** (`DatasphereClient.accessToken()`):

- **Flow:** OAuth 2.0 **client credentials**, using an OAuth client of purpose "Technical User".
- **Request:** `POST <DSP_TOKEN_URL>` with header `Authorization: Basic base64(id:secret)` and body `grant_type=client_credentials`.
- **Caching:** the token is cached in memory until `expires_in − 60 s`, then fetched again.
- **On API calls:** sent as `Authorization: Bearer <token>`.
- **Not implemented:** re-fetching after a 401 or retrying.

**Requests** (`request()`):

- URL `<host>/dwaas-core/api/v1<path>`, JSON body.
- On a non-2xx response it throws `DatasphereError` with the status, a short message and the **correlation id** from the `x-correlationid` header, for SAP support.
- **No timeout and no retry.**

**Endpoints.** The source is the official `datasphere` CLI's API description cached from the tenant (CLI version 2024.23.45). We call it with `fetch`; the CLI itself isn't needed at run time.

| Action | Call | In code? |
|---|---|---|
| Exists / status | `GET /spaces/{space}/localtables?technicalNames=X&select=technicalName,status` | ✅ `localTableStatus()` |
| Create | `POST /spaces/{space}/localtables?deploy=true\|false` + CSN | ✅ `createLocalTable()` |
| Replace | `PUT /spaces/{space}/localtables/{name}?deploy=…` | ✅ `updateLocalTable()` |
| Read back | `GET …/localtables/{name}` with `Accept: application/vnd.sap.datasphere.object.content.design-time+json` | ✅ `getLocalTable()` |
| Transformation flow CRUD | `POST/GET/PUT/DELETE /spaces/{space}/transformationflows[/{name}]`; query flags `deploy`, `saveAnyway`, `allowMissingDependencies` | ⬜ only read via a one-off script |
| Also available | `views`, `dataflows`, `taskchains`, `replicationflows`, `/tasks/chains/{space}/run/{object}`, task logs | ⬜ |

**Save vs. deploy.**

- **Save** (`deploy=false`) stores the definition only; status `NotDeployed`.
- **Deploy** has Datasphere create the real database object; it's asynchronous, so we poll.
- **Neither loads data.**

**Duplicate protection.** The table path stops if the name exists, unless `--overwrite` is given. For flows, the generated description carries the marker `Migrated from BW transformation …`, planned as an ownership check before any overwrite.

**Permission errors** (from the 2026-10-06 POC):

- An **empty 403** on space endpoints meant the technical user wasn't in a scoped role for `DEMO_SPACE_1`. The Datasphere admin fixed it.
- A 403 with `forbiddenOperationForTupOAuthClient` on `/users` and `/scopedroles` is by SAP design for technical users. We don't need those endpoints.

---

## 11. Technology stack (verified usage only)

| Technology | What / why | Where | Needed by | Essential? | Know for the meeting |
|---|---|---|---|---|---|
| **TypeScript** | Typed JavaScript; all source | `src/`, `migration/src/` | everything | yes | Compiled by `tsc` into `dist/`; we run the JS |
| **Node.js ≥ 22** | Runtime; `fetch`, `process.loadEnvFile`, `node:test` | everywhere | everything | yes | Version 22 needed by `migration/` |
| **JavaScript (.mjs)** | Tests and scripts | `tests/`, `scripts/` | tests, census | yes | — |
| **MCP** (`@modelcontextprotocol/sdk`) | Tool protocol (server and client) | `src/index.ts`, `migration/src/bw/mcp-source.ts` | BW reads | replaceable, but reuse is the point | One BW integration for AI and CLI |
| **axios** | HTTP client to BW | `src/bw-client.ts` | BW | replaceable | Cookie/CSRF handling |
| **fast-xml-parser** | XML → JS objects | `trfn_logic.ts`, `adso-parser.ts` | parsing | replaceable | BW modeling objects are XML |
| **express** + `@arc-mcp/xsuaa-auth` | MCP over HTTP on BTP with XSUAA | `src/http.ts` | central hosting only | not for migration | Not used in our runs |
| **SAP BW/4HANA 2.0** (DW4CORE 200 SP17) | Source system | — | — | — | Modeling REST + ADT |
| **BW Modeling REST / ADT** | Metadata and ABAP source APIs | `/sap/bw/modeling/*`, `/sap/bc/adt/*` | extraction | yes | Same APIs as Eclipse BWMT |
| **XML** | BW object format | BW responses | parsing | — | — |
| **ABAP** | Generated programs and routines (read, not written) | GP files | analysis | — | GP = executable rule logic |
| **SQL (HANA dialect)** | Generated view SQL; read-only BW SQL checks | `*.sql`, `adt-sql.ts` | conversion | yes | `TO_VARCHAR`, `ISOWEEK`, `COALESCE` |
| **JSON / CSN / CQN** | Datasphere object format and parsed query | converters | generation | yes | CSN = SAP's model format; CQN = query as JSON |
| **SAP Datasphere** | Target | REST `/dwaas-core/api/v1` | creation | yes | Spaces, local tables, transformation flows |
| **OAuth 2.0 client credentials** | Datasphere auth | `datasphere/client.ts` | creation | yes | Technical-user client; bearer token |
| **Datasphere CLI** | Used once to obtain the API description; not at run time | `~/.@sap/datasphere-cli/.cache` | — | no | Same API as the CLI |
| **node:test** | Test runner | `tests/`, `migration/tests/` | tests | yes | `npm test` |
| **Git** | Version control (1 commit; work uncommitted) | repo | — | yes | — |
| **Cloud Foundry** (`manifest.yml`, `xs-security.json`) | Optional hosting of the MCP server | root | not used in migration | no | — |

**Not used:** Python, Docker and SQLScript procedures. Don't claim them. SQLScript appears only as the possible language of HANA-runtime routines.

---

## 12. Commands, inputs and outputs

Run from the repository root unless stated otherwise. **R** = reads an external system, **W** = writes to one.

| Command | Purpose | External | Output |
|---|---|---|---|
| `npm install && npm run build` | Build the MCP server | — | `dist/` |
| `npm test` | Root suite (42) | — | console |
| `cd migration && npm run build && npm test` | Migration suite (37) | — | `migration/dist/`, console |
| `node scripts/loader-census.mjs --adso ZD_CRMFP,ZC_CRM12` (BW_* in env) | Who writes these aDSOs | **R BW** | `census-out/loader-census.json/.csv` |
| `node census-out/fetch-trfn2.mjs` | Fetch transformation 2, GP and aDSOs (helper, git-ignored) | **R BW** | `census-out/fpo-trfn2/*` |
| `node migration/dist/cli.js trfn --xml migration/tests/fixtures/TRFN_FPO_SANITIZED.xml --out census-out/demo` | Dry run on the sanitized fixture | — | 7 files |
| `node migration/dist/cli.js trfn --logic census-out/fpo-trfn2/trfn.logic.json --source-adso census-out/fpo-trfn2/ZD_CRMFP.adso.xml --target-adso census-out/fpo-trfn2/ZC_CRM12.adso.xml --out census-out/fpo-trfn2/dryrun` | Dry run on the **real** transformation | — | 7 files |
| `node migration/dist/cli.js adso ZAATM24 --dry-run` | aDSO → CSN only | **R BW** (via MCP) | `migration/output/ZAATM24/` |
| `node migration/dist/cli.js adso <NAME> --no-deploy` | ⚠️ Save the table in Datasphere | **R BW, W Datasphere** | table + `report.json` |
| `node migration/dist/cli.js adso <NAME> [--overwrite]` | ⚠️ Create/replace **and deploy** | **R BW, W Datasphere** | deployed table + `report.json` |

The `adso` commands need `migration/.env` (Datasphere) and the BW env (`.mcp.json` or `BW_*`).

**Exit codes:** 0 = success, 1 = validation failed or an error, 2 = usage.

**Dry-run output files** (`<out>/<TRANSFORMATION_ID>/`):

| File | Contents |
|---|---|
| `ir.json` | The full IR |
| `MIG_TF_*.transformationflow.json` | The proposed API body |
| `MIG_TF_*.sql` | Readable SQL |
| `dependencies.json` | Required objects and creation order |
| `validation.json` | Each check with ✔/✘ |
| `issues.json` | `deployable`, omitted columns, diagnostics |
| `mapping-report.md` | Rule-by-rule table — the best file to show people |

---

## 13. Tests and validation results

| Suite | Count | Result (2026-10-23) | Covers |
|---|---|---|---|
| Root `tests/` | 42 | ✅ 42/42 | Tool-surface counts, scopes, media types, proxy env, destination, 24 extraction tests (names, SQL guard, aDSO classification, transformation and GP parsing, routine normalisation, DTP parse, loader census statuses) |
| `migration/tests/adso-to-local-table` | 13 | ✅ | Parser, types, keys, semantics, warnings, validator |
| `migration/tests/transformation-flow` | 24 | ✅ | See below |

The 24 transformation-flow tests cover:

- direct, time, formula (IF, RIGHT argument order, invalid syntax, unknown field, unknown function);
- unsupported formula, SUM with `GROUP BY`, no-collapse, MOV refused;
- field/start routines, missing dependencies, tampered expressions, type mismatch, DataSource source;
- reference shape, determinism, dependency cycles;
- the 6 regressions from the real transformation: time reference from GP, ISO week and half-year, amount + currency, conflicting rules, GP conversion check, data-mart table keys.

**Live evidence:**

- **aDSO:** `MIG_ZAATM24` passed 19/19 checks (2026-10-06) and was still `Deployed` on 2026-10-23.
- **Transformation:** the real transformation 2 dry run has 0 errors and passes all 25 validation checks. Source and target columns match the real aDSO tables: 58/58 and 36/36.
- **BW data check (read-only SQL):** `CALWEEK`, `HALFYEAR1`, `CALMONTH`, `CALYEAR` and `CALDAY` match our intended logic in all 279 stored `ZC_CRM12` rows. The source has 0 empty posting dates.

**Not tested:**

- whether Datasphere accepts the flow;
- the SQL functions running in Datasphere;
- any data comparison;
- integration tests (there are none automated).

---

## 14. Completed vs. outstanding work

| Area | Status | Evidence |
|---|---|---|
| aDSO migration (structure) | ✅ Implemented and tested live (1 aDSO) | `MIG_ZAATM24`, 19/19 |
| Transformation extraction | ✅ | real transformation 2 |
| Generated ABAP analysis | ✅ | GP parsed, rule blocks matched |
| IR | ✅ offline | 37 tests |
| Transformation-flow generation | 🟡 not verified live | dry run only |
| SQL conversion | 🟡 | never executed in Datasphere |
| Datasphere object creation | ✅ tables / ⬜ flows | no flow methods in `client.ts` |
| Deployment | ✅ tables / ⬜ flows | — |
| Data loading | ⬜ / ⛔ | no BW→Datasphere data path; CRM destination invalid |
| DTP migration | ⬜ | IR slot reserved |
| Delta processing | ⬜ | full reload only |
| Dependency discovery | 🔶 | one transformation's 3 objects; census and xref exist on the BW side |
| Multi-layer orchestration | ⬜ | `topoSort` ready |
| Reconciliation | ⬜ | design only |
| Error handling / recovery | 🔶 | clear errors, correlation ids, census abort guard; no retries, timeouts, resume or rollback |
| Security / credentials | 🔶 ⚠️ | see §15 |

---

## 15. Security and credentials

| Secret | Where | Exposure | Action needed |
|---|---|---|---|
| BW password | `.mcp.json` (`BW_PASSWORD`) | ⚠️ **Tracked in git** (commit `705eee3`) | Rotate; `git rm --cached .mcp.json`; add to `.gitignore`; move to env/secret store; history keeps the old value until rewritten |
| Datasphere client secret | 1.7.1 copy `migration/.env` | Git-ignored there, but **pasted into an AI chat earlier** | Rotate the OAuth client secret |
| Datasphere CLI cache | `~/.@sap/datasphere-cli/.cache/secrets.json` | Local file | `datasphere logout` when no longer needed |
| BW extracts | `census-out/` | Git-ignored; contains real BW metadata and ABAP | Don't share outside the team |

**Safe practice now:**

- Scripts read credentials from the environment only.
- Helper scripts load `.mcp.json` at run time and never print it.
- Reports and fixtures contain no secrets; I scanned for them.

**Recommendation:** an OS secret store or BTP Credential Store, least-privilege roles, and separate technical users for read and write. Rotation needs the BW Basis team and the Datasphere admin. **Nothing has been rotated.**

---

## 16. Risks and mitigations

| Risk | Impact | Detect | Mitigation | Exists? |
|---|---|---|---|---|
| VPN/DNS outage | No BW reads | `ENOTFOUND` | Census aborts after 3 consecutive failures; work offline from saved files | ✅ partly |
| MCP limits (404 `_A`, 403 monitor, 500s) | Missing evidence | issues in the json | `_M` fallback; issues reported | ✅ |
| Large responses (136 KB XML, 1.5k-line GP) | Slow, token-heavy for AI | sizes | Deterministic code, not the AI, processes them; line windowing | ✅ |
| Rate limits / interrupted agent calls | Lost work | — | Deterministic CLI; saved artifacts; add retry with backoff | ⬜ retries |
| Incomplete metadata | Wrong IR | `completeness: partial` | Issues listed; dry run refuses | ✅ |
| ABAP routines | Unmigratable logic | `FIELD_ROUTINE`/`GLOBAL_ROUTINE` | Manual or AI-proposed translation **plus** verification | ⬜ |
| Currency/unit conversion | Wrong numbers | `CONVERSION_TYPE` | Datasphere currency conversion tables (TCUR*) | ⬜ |
| Fiscal calendars | Wrong periods | `TIME_UNSUPPORTED` | Bring the fiscal variant tables (T009/T009B) | ⬜ |
| Empty/invalid values | Load failures, differences | aDSO warnings | NULL mapping in load; invalid-date policy | 🔶 |
| Delta / change log | Different history | `SUM_DELTA_SEMANTICS` | Full reload first; delta design later | ⬜ |
| Dependency cycles | Endless or blocked plan | `DEPENDENCY_CYCLE` | `topoSort` reports the cycle | ✅ |
| API compatibility | Rejected flow | deploy error | Shape copied from the tenant; deploy with `deploy=false` first | 🟡 |
| Space permissions | 403 | empty 403 | Scoped role (fixed before) | ✅ |
| Duplicate names | Overwriting others' objects | status check | `MIG_` prefix; refuse unless `--overwrite`; ownership marker | ✅ tables |
| Auth failure | Stops | 401 | Clear error; no 401 retry | 🔶 |
| Partial creation | Leftover objects | report | Ordered creation; add resume and cleanup | ⬜ |
| API volume | Slowness | timings | Caching in census; batch later | 🔶 |
| Sensitive metadata | Leaks | — | `census-out/` ignored | ✅ |

---

## 17. Alternative approaches

| Alternative | Pros | Cons | When it makes sense |
|---|---|---|---|
| Custom extraction API instead of MCP tools | Tailored payloads | New ABAP code in BW, transports, maintenance | Only for gaps the APIs can't fill |
| Merge upstream 1.7.1 now | Newer tools (e.g. `bw_read_metadata_tables`) | Large merge, conflicts with our changes, risk | After our changes are committed, as its own task |
| GP only, or XML only | Simpler | XML misses implicit behaviour; GP misses intent and is reference-only in the HANA runtime | Use both (current) |
| AI-assisted conversion | Handles routines | Non-deterministic; needs verification | Only for routines, with tests and reconciliation as the gate |
| Datasphere CLI instead of REST | Official tool | Extra install, shell parsing | Ops scripts; REST is better inside code |
| Remote tables / BW Model Transfer | Fast, SAP-supported | Still depends on BW at run time | Interim reporting, not decommissioning |
| Replication flow (ODP) for data | Native, supports delta | Needs a connection to BW or CRM | The likely load path |
| Full reload vs. delta | Simple and verifiable | Volume, history | Start full; add delta per object |
| Sequential vs. dependency-aware | Simple | Wrong order | Dependency-aware (`topoSort`) for flows |

---

## 18. Question bank (with honest answers)

### 1. Business and architecture

**What did we build?** A deterministic pipeline: BW metadata → IR → Datasphere definitions → validation. Plus an extended BW reader. Tables are created live; transformations are proposed offline.

**Why not just use SAP's BW Bridge or Model Transfer?** Model Transfer creates remote objects that keep reading BW. We aim for a native rebuild that can run after BW is switched off.

### 2. BW and MCP

**Why MCP?** One BW integration serves both AI assistants and our CLI. The migration layer calls the same tools a user would.

**How do we authenticate to BW?** Basic Auth only to obtain the CSRF token and session, then the session cookie. Credentials come from env vars.

### 3. Transformations and generated ABAP

**Why do we need the generated program if the metadata exists?**
- It shows behaviour the XML leaves implicit: empty-date handling, record skipping on errors, ALPHA checks, the real time reference.
- In the ABAP runtime it is the executed code itself.

**What if a routine can't be translated?** The column is omitted, a blocking diagnostic is recorded, and the flow is marked not deployable. Nothing is silently dropped.

**A rule that writes several target fields?** For amount + currency, the GP shows same-name assignments, so we map each target separately and merge identical repeated writes. Anything else is `MULTI_TARGET_RULE`, which blocks.

### 4. IR and SQL

**How do we know the SQL preserves BW behaviour?** Three evidence levels, and I'd be precise about which we have:
1. ✅ Each rule matches the GP code.
2. ✅ Calendar logic matches BW's 279 stored rows.
3. ⬜ Running the flow on the same data and reconciling totals and keys. That's still to do; until then we don't claim equivalence.

**Aggregation and non-unique target keys?**
- The IR checks whether every source key reaches the target key. If so, there's no collapse.
- Otherwise it generates `GROUP BY` with SUM/MIN/MAX.
- Overwrite (MOV) depends on processing order, so it's refused.

### 5. aDSO

**Standard vs. data mart?** A standard aDSO has a semantic key and a change log. A data mart has no semantic key and aggregates over all characteristics, like a cube. The flow takes its keys from the real table for that reason.

### 6. Datasphere auth and APIs

**How are OAuth credentials managed?** Client credentials grant; the secret is read from the environment or a git-ignored `.env`; the token is cached in memory. Weak spots: one secret was pasted into a chat and must be rotated, and there's no secret store yet.

**Why doesn't creating an object mean migration is complete?** Creation proves structure. Data loading, delta and result reconciliation are separate steps, and they aren't built.

### 7. Data movement and delta

**How will data move?** Not implemented. The likely path is a replication flow from BW (ODP) or from CRM. That needs a connection set up by Basis and the Datasphere admin. The CRM destination currently shows as invalid.

**Delta?** Today the flow is a full reload (`truncate: true`). BW's SUM accumulation over delta loads is documented as a difference.

### 8. Dependencies and multi-layer flows

**How will a full multi-layer flow be migrated?**
1. Walk the lineage with `bw_xref` / `bw_get_dataflow`.
2. Build one graph of tables and flows.
3. `topoSort` gives the creation order; cycles are reported.
4. Create bottom-up, then add task chains for run order.

Only the single-transformation case exists today.

### 9. Testing and reconciliation

**How do we measure correctness?**
- Per object: row counts, key sets, sums per key figure and grouping, and null and date checks between BW and Datasphere.
- Performance: run duration and API call counts.

None of this is built yet.

### 10. Security, reliability, performance

**How do we recover after a partial migration?** Creation is ordered and idempotent for tables: a run stops if the object exists. There's no automatic resume or rollback yet; it's on the list.

**How do we prevent duplicates?**
- The `MIG_` prefix.
- An existence check before create.
- An explicit `--overwrite`.
- A planned ownership marker for flows.

### 11. Roadmap

**Biggest current risk?** The data path. Without a BW or CRM connection into Datasphere we can't load or reconcile, so behaviour equivalence stays unproven. Close second: credential hygiene.

---

## 19. Presentation scripts and demo

### 30-second summary

> "We're automating the move from SAP BW to Datasphere. A tool reads how BW objects are built and rebuilds them as native Datasphere objects. We've already created a real BW table structure in Datasphere and checked it field by field. We've also converted a real 36-rule BW transformation into a Datasphere transformation flow and checked every rule against SAP's own generated code. The next steps are creating that flow in Datasphere, then loading data and proving the numbers match."

### 2-minute overview

> "There are two halves. The BW side is an MCP server, a TypeScript tool layer over BW's modeling and ABAP development APIs. It's the same interface our AI assistant uses, and we extended it to read transformation logic and SAP's generated ABAP programs.
>
> The migration side is our own TypeScript module. For tables, it maps BW types and keys to Datasphere's CSN format and creates the table through Datasphere's REST API, using OAuth client credentials. That's done end to end: ZAATM24 passed 19 of 19 structural checks.
>
> For transformations, we convert the BW rules into a neutral intermediate representation. From that we generate the SQL and the exact JSON structure Datasphere uses for transformation flows. Wherever the XML is ambiguous, we use SAP's generated program to see the real behaviour, for example how empty dates or partner numbers are handled. On our real CRM fund-posting transformation, all 36 rules are converted or flagged, and nothing blocks.
>
> Anything we can't translate, such as routines, lookups or fiscal conversions, is reported as a blocking issue, never silently dropped.
>
> What's left: creating the flow in Datasphere, a data path from BW or CRM, reconciliation, delta, and multi-layer orchestration."

### 10-minute walkthrough (outline to speak from)

1. **Goal and scope (1 min).** A native rebuild. Five separate stages: metadata → definition → deploy → data → reconciliation.
2. **Architecture (1.5 min).** Show the diagram in §3. MCP server, migration layer, Datasphere REST.
3. **BW access (1 min).** `bw-client.ts`: CSRF, cookie, `loadMediaTypes`; the tools in §6.
4. **aDSO path (1.5 min).** `cli.ts migrateAdso` → `mapType` → `createLocalTable` → `validateLocalTable`; ZAATM24 result.
5. **Transformation extraction (1.5 min).** XML plus GP; open the GP and show the rule 31 block.
6. **IR and generation (1.5 min).** Walk rule 31 through §8. Show `MIG_TF_ZC_CRM12.sql` and the flow JSON.
7. **Semantic differences (1 min).** Empty dates, ALPHA, ISO week checked on 279 rows, data mart without key.
8. **Tests and status (0.5 min).** 42 + 37 tests; the status matrix in §14.
9. **Risks and next steps (0.5 min).** Data path, credentials, flow creation awaiting approval.

### Live demo sequence (no live writes)

1. `npm test` and `cd migration && npm test`: all green.
2. Open `census-out/fpo-trfn2/GP7KSRM0CW2PGXXWRESQF4DSEB9.abap` and search `Rule ID: '31'`.
3. Run the real dry-run command from §12.
4. Open `mapping-report.md`, then `MIG_TF_ZC_CRM12.sql`, then `validation.json`.
5. Open `migration/src/ir/transformation-ir.ts` at `TIME_CONVERSIONS` and explain the rule.
6. Open `migration/output/ZAATM24/report.json` from the 1.7.1 copy for the historic 19/19 run.

---

## 20. Next steps; questions for other teams

**Next engineering steps (in order):**

1. **Commit the work** on a branch (nothing is committed), and rotate the credentials (§15).
2. **With approval:**
   - add `transformationflows` methods to `DatasphereClient`;
   - create `MIG_ZD_CRMFP` and `MIG_ZC_CRM12` (`deploy=false`), then `MIG_TF_ZC_CRM12`;
   - read them back, validate, then deploy.
3. **Retries in the Datasphere client:** timeout and bounded retry with backoff for 429/5xx; no retry on 4xx.
4. **Load path:**
   - decide replication flow from BW (ODP) vs. CRM;
   - load `ZD_CRMFP`, run the flow;
   - **reconcile** against BW's 279 rows: counts, keys, sums of `0CRM_FMFPA` and `0CRM_FMAMOT`.
5. **Live transformation read** as a CLI command, replacing the helper script.
6. **Next constructs:** lookups, fiscal periods, then routines (AI-proposed and verified).
7. **DTP IR and delta,** then multi-layer orchestration with task chains.

**Ask the BW team:**
- Is `0CALWEEK` ISO-8601 on this system, and do any data or reports depend on week 53 or year-boundary cases?
- How should invalid dates be treated?
- Is the ALPHA check on `0BPARTNER` relevant to the data?
- Who will rotate the BW password?

**Ask the Datasphere / Basis team:**
- Is the connection from Datasphere to BW (ODP via Cloud Connector) or to CRM available, given the CRM destination shows invalid?
- Is a key-less fact local table acceptable?
- Can `DEMO_SPACE_1` be used for `MIG_` objects, or should we have a dedicated space?
- Please rotate the OAuth client secret.
