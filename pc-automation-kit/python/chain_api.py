"""Process chain operations on top of SAP standard function modules.

Signatures: see docs/02-SAP-PROCESS-CHAIN-REFERENCE.md.
"""
from dataclasses import dataclass

from sap_conn import Sap

RED = {"R", "X", "J"}
GREEN = {"G", "F"}
RUNNING = {"A", "P", "Y", "Q"}
COLOUR = {**{s: "red" for s in RED}, **{s: "green" for s in GREEN}, **{s: "yellow" for s in RUNNING}, "S": "grey"}


@dataclass
class Step:
    type: str
    variant: str
    instance: str
    state: str
    start: str = ""
    end: str = ""

    @property
    def colour(self) -> str:
        return COLOUR.get(self.state, "unknown")

    @property
    def is_subchain(self) -> bool:
        return self.type == "CHAIN"


# ── generic table reader ────────────────────────────────────────────────────

def read_table(sap: Sap, table: str, fields: list[str], where: list[str] | None = None, rowcount: int = 0) -> list[dict]:
    """RFC_READ_TABLE, parsed by field offsets. Each WHERE line must be <= 72 chars."""
    res = sap.call(
        "RFC_READ_TABLE",
        QUERY_TABLE=table,
        FIELDS=[{"FIELDNAME": f} for f in fields],
        OPTIONS=[{"TEXT": w} for w in (where or [])],
        ROWCOUNT=rowcount,
    )
    layout = [(f["FIELDNAME"], int(f["OFFSET"]), int(f["LENGTH"])) for f in res["FIELDS"]]
    rows = []
    for line in res["DATA"]:
        wa = line["WA"]
        rows.append({name: wa[off:off + length].strip() for name, off, length in layout})
    return rows


# ── chain operations ────────────────────────────────────────────────────────

def start_chain(sap: Sap, chain: str) -> str:
    res = sap.call("RSPC_API_CHAIN_START", I_CHAIN=chain)
    return res["E_LOGID"]


def get_status(sap: Sap, chain: str, log_id: str) -> dict:
    res = sap.call("RSPC_API_CHAIN_GET_STATUS", I_CHAIN=chain, I_LOGID=log_id, I_DONT_UPDATE="X")
    return {"status": res["E_STATUS"], "message": res.get("E_MESSAGE", "")}


def get_steps(sap: Sap, chain: str, log_id: str) -> list[Step]:
    """Steps of one run via RSPC_API_CHAIN_GET_PROCESSES.

    Field names of E_T_PROCESSLIST: verify in SE37. ACTUAL_STATE is preferred over STATE when filled.
    """
    res = sap.call("RSPC_API_CHAIN_GET_PROCESSES", I_CHAIN=chain, I_LOGID=log_id)
    steps = []
    for p in res["E_T_PROCESSLIST"]:
        steps.append(Step(
            type=p.get("TYPE", ""),
            variant=p.get("VARIANTE", ""),
            instance=p.get("INSTANCE", ""),
            state=p.get("ACTUAL_STATE") or p.get("STATE", ""),
            start=str(p.get("STARTTIMESTAMP", "")),
            end=str(p.get("ENDTIMESTAMP", "")),
        ))
    return steps


def latest_log_id(sap: Sap, chain: str) -> str | None:
    rows = read_table(sap, "RSPCLOGCHAIN", ["LOG_ID", "DATUM", "ZEIT"], [f"CHAIN_ID = '{chain}'"])
    if not rows:
        return None
    rows.sort(key=lambda r: (r["DATUM"], r["ZEIT"]), reverse=True)
    return rows[0]["LOG_ID"]


def subchain_log_id(sap: Sap, parent_step: Step) -> str | None:
    """Resolve the LOG_ID of the sub-chain run started by a CHAIN step.

    OPEN ITEM 1 (docs/03): the linking field is not yet verified.
    Assumption A: the CHAIN step's INSTANCE is the sub-chain's LOG_ID.
    Fallback B: the latest run of the sub-chain.
    """
    sub_chain = parent_step.variant
    if parent_step.instance:
        hit = read_table(sap, "RSPCLOGCHAIN", ["LOG_ID"],
                         [f"CHAIN_ID = '{sub_chain}' AND LOG_ID = '{parent_step.instance}'"], rowcount=1)
        if hit:
            return hit[0]["LOG_ID"]
    return latest_log_id(sap, sub_chain)


def restart_failed(sap: Sap, chain: str, log_id: str) -> dict:
    """Rerun only red steps of this run (same as RSPC 'Repeat'). SAP chooses repair vs repeat."""
    res = sap.call("RSPC_API_CHAIN_RESTART", I_CHAIN=chain, I_LOGID=log_id, I_ONLY_RED="X", I_DONT_POLL="X")
    return res.get("E_S_SUCCESSMSG", {})


def set_step_state(sap: Sap, chain: str, log_id: str, step: Step, state: str) -> None:
    """Manually set a step's state (e.g. 'R' for a dead stuck step). Does NOT execute the step."""
    sap.call("RSPC_PROCESS_FINISH", I_LOGID=log_id, I_CHAIN=chain, I_TYPE=step.type,
             I_VARIANT=step.variant, I_INSTANCE=step.instance, I_STATE=state)
