# BW/4HANA → SAP Datasphere Migration — Status Report

*As of 26 Oct 2026 · Datasphere space `DEMO_SPACE_1` · BW system BTP*

---

## In one paragraph

We can now take a real BW transformation, convert its business logic automatically, and run it in Datasphere. Run on real BW data, it produced **exactly the same results as BW: all 279 records, every field, matching amount totals**.

What does **not** work yet is the *automatic transport* of data from BW into Datasphere. Datasphere's replication from on-premise systems is currently broken for the whole tenant, not only for us. For the test, we copied BW's real records into Datasphere through a controlled workaround. Once the infrastructure team fixes replication, the same pipeline runs with live data.

---

## 1. What I worked on

**The problem.** The business logic in BW (how data is cleaned, derived and stored) has to be rebuilt in Datasphere. Rebuilding it by hand is slow and error-prone: every field rule must be re-coded, then proven to give the same numbers. The aim is a tool that does this largely automatically, and proves the result.

**What the BW process does** (the flow we migrated, *CRM Fund Postings*):

```
CRM system ──► DataSource 0CRM_FM_FPO ──► aDSO ZD_CRMFP ──► transformation ──► aDSO ZC_CRM12
               (extracts postings)         (stores postings)   (36 field rules)    (reporting layer)
```

The transformation copies the posting details and amounts, and derives reporting fields from the posting date: calendar day, month, year, week and half-year. It stores the result in `ZC_CRM12`, which reports use.

**What we're rebuilding in Datasphere:** the same chain as Datasphere tables plus a *transformation flow*, Datasphere's equivalent of a BW transformation, with BW's logic converted into SQL.

**What I built:**
- **BW reader.** An extension of our BW connector that reads object definitions, the transformation rules, and the ABAP code SAP generates for each transformation.
- **Converter.** Turns BW definitions into Datasphere objects: tables, transformation flows, replication flows, task chains.
- **Datasphere integration.** Creates, deploys and runs those objects through Datasphere's official API.
- **Reconciliation.** Compares Datasphere output with BW's own data, record by record.
- **One command that ties it together:** plan → create → deploy → run → compare.

---

## 2. How the data is supposed to move

```
 BW                                     DATASPHERE (DEMO_SPACE_1)

 ① ZD_CRMFP (source aDSO, 279 records)
        │
        │ ② Replication over SAP ODP             ⛔ BLOCKED (tenant infrastructure)
        ├────── MIG_RF_ZD_CRMFP ─────────────────► MIG_ZD_CRMFP_ODP
        │
        │ ②b Test workaround: real BW records    ✅ WORKING (test only)
        └────── MIG_V_SEED_ZD_CRMFP + MIG_TF_SEED_ZD_CRMFP ──► MIG_ZD_CRMFP   ✅ 279 records
                                                                    │
                                     ③ Migrated BW logic            │       ✅ WORKING
                                        MIG_TF_ZC_CRM12  ◄──────────┘
                                                                    │
                                     ④ Target table                 ▼       ✅ 279 records
                                        MIG_ZC_CRM12
                                                                    │
 ⑤ ZC_CRM12 (BW's own result) ◄────── comparison ─────────────────────┘     ✅ IDENTICAL
                                        (via MIG_V_ZC_CRM12)

 ⑥ MIG_TC_ZC_CRM12 runs ②b → ③ in order, as one job                        ✅ WORKING
```

| Step | What happens | Status |
|---|---|---|
| 0 | CRM → DataSource `0CRM_FM_FPO` → `ZD_CRMFP` (the first BW layer) | ⛔ Not in scope yet: the CRM connection is invalid |
| ① | Read BW source data and definitions | ✅ Working |
| ② | Automatic replication of `ZD_CRMFP` into Datasphere | ⛔ Blocked: built and deployed, but the run fails on the tenant |
| ②b | Same BW records loaded through a test workaround | ✅ Working (test substitute, not production) |
| ③ | Migrated transformation runs in Datasphere | ✅ Working |
| ④ | Target table filled | ✅ Working |
| ⑤ | Result compared with BW | ✅ Identical |
| ⑥ | Steps run automatically as one job | ✅ Working (for this flow) |

**So:** everything from the moment data is in Datasphere through to the final result is working and proven. The automatic transport from BW into Datasphere (step ②) is the missing link.

---

## 3. What has been achieved

| Capability | Status | Evidence |
|---|---|---|
| Read BW object definitions (aDSOs, transformations, DTPs, process chains…) | ✅ Working | Read live from BW for `ZD_CRMFP`, `ZC_CRM12` and transformation `0MGCDCTZGD79ZKMKR1IGUM4G3TMK9KLH` |
| Read the business logic of a transformation (all 36 rules plus SAP's generated ABAP code) | ✅ Working | Every rule checked against SAP's own code; the date logic also checked against BW's stored results |
| Read real BW data | ✅ Working | 279 records each from `ZD_CRMFP` and `ZC_CRM12` (read-only) |
| Convert BW logic into Datasphere SQL automatically | ✅ Working for this flow | 36 of 36 rules handled; 5 marked "review" for known BW/SQL differences, all of which matched in the end |
| Create Datasphere tables from BW aDSOs | ✅ Working | `MIG_ZD_CRMFP`, `MIG_ZC_CRM12`, plus `MIG_ZAATM24` (earlier) |
| Create and deploy a transformation flow | ✅ Working | `MIG_TF_ZC_CRM12` deployed |
| Execute the transformation in Datasphere | ✅ Working | Job run 63582 completed successfully |
| Move real BW data into Datasphere **automatically** | ⛔ Blocked | Replication flow `MIG_RF_ZD_CRMFP` deployed; runs fail (tenant-wide issue) |
| Move real BW data into Datasphere **via test workaround** | ✅ Working | 279 BW records loaded into `MIG_ZD_CRMFP` |
| Target result matches BW | ✅ Proven for this flow | 279 = 279 records, all 36 fields equal; amounts total **83,538,402.43** on both sides |
| Run the steps automatically as one job | ✅ Working | Task chain `MIG_TC_ZC_CRM12` |
| Migrate the first layer (CRM DataSource → `ZD_CRMFP`) | ⛔ Blocked / not started | CRM connection to BW is invalid |
| Delta (incremental) loads | ❌ Not implemented | Full reload only today |
| Routines, lookups, currency and fiscal conversions | ❌ Not implemented | Detected and reported, not converted; none occur in this flow |
| Multi-layer flows | ❌ Not implemented | Designed for; one layer done |

---

## 4. The strongest working example

**Source:** BW aDSO `ZD_CRMFP` (CRM fund postings), transformation `0MGCDCTZGD79ZKMKR1IGUM4G3TMK9KLH`, target aDSO `ZC_CRM12`.

**What was extracted:**
- the structure of both aDSOs (58 and 36 fields);
- all 36 transformation rules;
- SAP's generated ABAP for those rules;
- the 279 real records in each aDSO.

**What was created in Datasphere:**
- the two tables;
- the migrated transformation flow;
- a job (task chain) that runs it;
- the views used for comparison.

All are deployed.

**Data movement:**
- **Into Datasphere:** the 279 *real* BW records were loaded, but through a test workaround. They were read from BW and inserted via a generated view, **not** by replication. Replication is built but blocked.
- **Inside Datasphere:** the migrated transformation **ran for real** on that data and filled `MIG_ZC_CRM12`.

**Comparison with BW:** every one of the 279 output records was compared with BW's own `ZC_CRM12`. All fields match: dates, weeks, half-years, currencies and amounts.

**What this proves:**
- The tool can read a BW transformation, convert its logic, and produce Datasphere objects that Datasphere accepts and runs.
- On real BW data, the migrated logic gives **exactly BW's business result**.

**What it does not prove yet:**
- That data can flow *automatically* from BW into Datasphere. That's step ②, blocked.
- Behaviour for delta loads, or for transformations containing ABAP routines or lookups.
- The first layer (CRM → BW DataSource).

| Kind of test | Done? |
|---|---|
| Object-creation test (objects accepted and deployed) | ✅ Yes |
| Real-data test with a substitute transport (real BW records, real execution, compared with BW) | ✅ Yes, the main result |
| Genuine BW → Datasphere automatic data movement | ⛔ Not yet; blocked by replication |

---

## 5. Blockers and dependencies

### Infrastructure (needs other teams)

**1. Replication from on-premise systems fails tenant-wide. This is the main blocker.**
- **Evidence:**
  - Every replication flow in `DEMO_SPACE_1` that reads from an on-premise system is failing or retrying: BW, S/4HANA and ECC. The last successful transfers were June–August 2026.
  - Both BW connections show their agent as "disconnected".
  - An exact copy of an existing, previously working BW replication flow fails the same way.
  - BW's own logs show no request ever arrived.
- **Impact:** no automatic data movement from BW (or S/4, ECC) into Datasphere.
- **Action:** check and repair the Cloud Connector / replication runtime / agent connection, and confirm `BTP_Connection` can replicate.
- **Who:** Datasphere administrator and Basis / infrastructure team.

**2. CRM connection is invalid.**
- **Impact:** the first layer (CRM → DataSource `0CRM_FM_FPO` → `ZD_CRMFP`) can't be tested with live CRM data.
- **Action:** repair the BW-to-CRM destination, or connect CRM directly to Datasphere. A decision is needed on which.
- **Who:** BW / Basis team.

**3. Credential hygiene.**
- **Impact:** a security risk, not a functional blocker.
- **Action:** rotate the BW password (stored in a project file under version control) and the Datasphere technical-user secret.
- **Who:** Basis and the Datasphere admin.

### Development work (mine)

| Item | Why it matters | Effort |
|---|---|---|
| Date conversion after replication | Replication delivers BW dates as text; a small conversion step from `MIG_ZD_CRMFP_ODP` into `MIG_ZD_CRMFP` is needed | Small; can start once replication works |
| Delta (incremental) loads | BW loads `ZC_CRM12` incrementally; we do full reloads (valid for this test, since the source had a single load) | Medium |
| DTP filters, ABAP routines, lookups, currency and fiscal conversions | Common in other flows; today they're detected and flagged, not converted | Medium–large, flow by flow |
| Multi-layer orchestration | Real flows have several layers | Medium |
| First-layer source (DataSource) | Needed for the full chain | Depends on blocker 2 |

---

## 6. Today vs. the final goal

| Capability | Current state | What is still required |
|---|---|---|
| Read BW objects and metadata | ✅ Working | — |
| Extract transformation logic | ✅ Working (incl. SAP-generated code) | Routines/lookups: read but not yet converted |
| Generate Datasphere objects | ✅ Working (tables, transformation flow, replication flow, job, views) | More object types as flows require |
| Replicate or move actual BW data | ⛔ Blocked automatically; ✅ via test workaround | Infrastructure fix, then a date-conversion step |
| Execute transformations | ✅ Working (`MIG_TF_ZC_CRM12`, run 63582) | — |
| Load the target successfully | ✅ Working (`MIG_ZC_CRM12`, 279 records) | — |
| Reconcile source and target | ✅ Working: identical to BW | Repeat on live-replicated data |
| Automate the complete migration | 🟡 Partial: one command runs plan → create → deploy → run → compare for one flow | Live ingestion; multi-layer flows |
| Delta loads and complex BW logic | ❌ Not implemented | Development (see §5) |

---

## 7. Next steps (in order)

| # | Step | Why | Who | Done when | Gate to next step |
|---|---|---|---|---|---|
| 1 | Fix on-premise replication on the tenant | Only missing link for automatic data movement | Datasphere admin + Basis | An existing BW replication flow (e.g. `BW_POC`) runs successfully again | Must be done first |
| 2 | Run `MIG_RF_ZD_CRMFP` (BW `ZD_CRMFP` → Datasphere) | Real automatic transport | Me | 279 records arrive in `MIG_ZD_CRMFP_ODP` | Records arrive |
| 3 | Add the date-conversion step into `MIG_ZD_CRMFP`, then remove the test workaround | Replace the substitute with the real path | Me (small) | Job loads from replication instead of the seed | Seed objects deleted |
| 4 | Re-run job and comparison | Prove true end-to-end movement | Me | Again 279 = 279, all fields equal | **First genuine end-to-end success** |
| 5 | Delta loads | Production loads are incremental | Me | A new BW posting appears correctly in Datasphere after a delta run | Delta reconciliation passes |
| 6 | First layer: CRM DataSource → `ZD_CRMFP` | Complete the full BW chain | BW/Basis decision + me | CRM data reaches `MIG_ZD_CRMFP` directly | Full chain reconciles |
| 7 | Second flow with routines/lookups/filters | Widen coverage | Me | Next flow converts and reconciles | Repeat per flow |
| 8 | Multi-layer, multi-flow automation | Scale | Me | Several flows migrated in dependency order with one command | — |

---

## 8. Manager-ready material

### A. 60–90 second verbal update

> "The goal is to automatically rebuild our BW data flows in Datasphere, with the same business results.
>
> I took a real flow, CRM fund postings, from `ZD_CRMFP` into `ZC_CRM12`. My tool reads the BW definitions and all 36 transformation rules, including the code SAP generates behind them, and converts that logic into a Datasphere transformation flow automatically. It created the tables, the flow and a job in Datasphere, and the job ran successfully.
>
> I then ran it on BW's real data, 279 posting records, and compared the output with BW's own result. Every record and every field matched, including the amount totals of about 83.5 million.
>
> What we can't do yet is move the data from BW into Datasphere automatically. Replication from all our on-premise systems — BW, S/4 and ECC — is currently failing across the whole Datasphere tenant. For the test I loaded the same BW records through a controlled workaround. The replication flow for our data is already built and deployed.
>
> So the next step is for the Datasphere admin and Basis team to fix replication. Then I switch the pipeline to live data, re-run the comparison, and we'll have a genuine end-to-end migration. After that comes delta loading and more complex flows."

### B. Written status update

**Objective.** Automatically migrate BW data flows into SAP Datasphere so that real data moves through the pipeline and produces the same business results as BW.

**Work completed.**
- A tool that reads BW objects, transformation rules and SAP-generated code.
- A converter that creates Datasphere tables, transformation flows, replication flows and jobs.
- Automated creation, deployment, execution and comparison against BW.

**Current capability.** For the CRM fund-posting flow (`ZD_CRMFP → ZC_CRM12`), the migrated logic runs in Datasphere (`MIG_TF_ZC_CRM12`). On BW's real 279 records it produces results identical to BW. The data was brought in through a test workaround, not live replication.

**Main blocker.** Replication from on-premise systems (BW, S/4, ECC) fails tenant-wide in Datasphere, so data can't yet move automatically from BW. This needs the Datasphere admin and Basis team (Cloud Connector / replication agent). Secondary: the CRM connection is invalid, which blocks the first BW layer.

**Next steps.**
1. Infrastructure team repairs replication.
2. I run the prepared replication flow `MIG_RF_ZD_CRMFP` and switch the job to live data.
3. Re-run the comparison for a genuine end-to-end proof.
4. Add delta loads.
5. Extend to the CRM layer and to flows with routines and lookups.

**Expected outcome.** A first fully automatic, reconciled BW → Datasphere flow within a short time after replication is restored. Then a repeatable process for further flows.

### C. Architecture and progress at a glance

```
 CRM ──► 0CRM_FM_FPO ──► ZD_CRMFP ══(replication)══► Datasphere ──► MIG_TF_ZC_CRM12 ──► MIG_ZC_CRM12 ──► compare with BW ZC_CRM12
  ⛔ CRM link invalid     ✅ read     ⛔ tenant-wide      ✅ tables       ✅ runs               ✅ 279 rows       ✅ identical
                                     (✅ test workaround
                                      with real BW data)
 Automation: ✅ one job / one command for this flow · Delta: ❌ · Routines/lookups: ❌ · Multi-layer: ❌
```

Legend: ✅ working · 🟡 partial · ⛔ blocked · ❌ not implemented

---

### Notes for questions you may get

- **"Did real data move?"** Real BW records, yes, through a test workaround: read from BW and inserted. Not through replication; that's the blocked part.
- **"Is the transformation really executed in Datasphere?"** Yes. Task chain `MIG_TC_ZC_CRM12`, run 63582, completed. The migrated flow filled `MIG_ZC_CRM12`.
- **"How do we know it's right?"** We compared every record with BW's own output: 279 of 279 identical. The only allowed difference is that empty BW dates (`00000000`) are blank in Datasphere.
- **"What's needed from others?"**
  - Datasphere admin / Basis: fix replication; repair or decide the CRM connection; rotate credentials.
- **Cleanup:** the test workaround objects (`MIG_V_SEED_ZD_CRMFP`, `MIG_TF_SEED_ZD_CRMFP`) hold copies of BW data and should be deleted once live replication works.
