"""Phase 1 recovery flow: find the deepest red step, rerun only it, max 3 attempts.

See docs/03-RECOVERY-DESIGN.md for the flow and scenarios.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import chain_api as api
from sap_conn import Sap

MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
RETRY_WAIT_SECONDS = int(os.environ.get("RETRY_WAIT_SECONDS", "300"))
ATTEMPT_LOG = Path(__file__).with_name("attempts.jsonl")


# ── attempt log ─────────────────────────────────────────────────────────────

def _key(chain: str, log_id: str, step: api.Step) -> str:
    return f"{chain}|{log_id}|{step.type}|{step.variant}"


def attempts_so_far(key: str) -> int:
    if not ATTEMPT_LOG.exists():
        return 0
    with ATTEMPT_LOG.open(encoding="utf-8") as f:
        return sum(1 for line in f if json.loads(line).get("key") == key and json.loads(line).get("action") == "restart")


def log_attempt(key: str, action: str, detail: str = "") -> None:
    entry = {"time": datetime.now(timezone.utc).isoformat(), "key": key, "action": action, "detail": detail}
    with ATTEMPT_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"[{entry['time']}] {action}: {key} {detail}")


# ── TODO pieces ─────────────────────────────────────────────────────────────

def job_is_dead(sap: Sap, step: api.Step) -> bool:
    """TODO (open item 3): find the step's background job and check TBTCO.STATUS.

    Idea: RSPCPROCESSLOG has the job count for the step (verify field name in SE11),
    job name is BI_PROCESS_<TYPE>. TBTCO.STATUS: R=running, F=finished, A=cancelled.
    Return True only when the job is definitely not running.
    """
    return False


def delete_failed_request_if_needed(sap: Sap, chain: str, log_id: str, step: api.Step) -> None:
    """TODO (open item 2): for DTP / InfoPackage steps that SAP will REPEAT (not repair),
    delete the red request before restarting. Function module not yet confirmed — see docs/02 §5.
    """
    return None


def is_repeatable(sap: Sap, step: api.Step) -> bool:
    """TODO: check RSPROCESSTYPES for the step type. RSPC_API_CHAIN_RESTART already skips
    non-restartable steps, so for now we rely on that and treat everything as repeatable."""
    return True


def escalate(chain: str, log_id: str, step: api.Step, reason: str) -> None:
    """Phase 1: log only. Later phase: create a ServiceNow incident here."""
    log_attempt(_key(chain, log_id, step), "MANUAL_ACTION_NEEDED", reason)


# ── core flow ───────────────────────────────────────────────────────────────

def find_red_steps(sap: Sap, chain: str, log_id: str, depth: int = 0) -> list[tuple[str, str, api.Step]]:
    """Return (chain, log_id, step) for every red leaf step, drilling into sub-chains."""
    found = []
    for step in api.get_steps(sap, chain, log_id):
        if step.state == "A" and job_is_dead(sap, step):
            api.set_step_state(sap, chain, log_id, step, "R")
            step.state = "R"
        if step.state not in api.RED:
            continue
        if step.is_subchain and depth < 10:
            sub_log = api.subchain_log_id(sap, step)
            if sub_log:
                inner = find_red_steps(sap, step.variant, sub_log, depth + 1)
                if inner:
                    found.extend(inner)
                    continue
        found.append((chain, log_id, step))
    return found


def recover_once(sap: Sap, chain: str, log_id: str) -> str:
    """One pass. Returns 'ok', 'running', 'restarted' or 'manual'."""
    steps = api.get_steps(sap, chain, log_id)
    red = find_red_steps(sap, chain, log_id)
    if not red:
        return "running" if any(s.state in api.RUNNING for s in steps) else "ok"

    # restart each affected (chain, log_id) once; RESTART reruns all red steps of that run
    result = "restarted"
    done_runs = set()
    for c, l, step in red:
        key = _key(c, l, step)
        n = attempts_so_far(key)
        if n >= MAX_ATTEMPTS or not is_repeatable(sap, step):
            escalate(c, l, step, f"attempts={n}")
            result = "manual"
            continue
        if (c, l) in done_runs:
            continue
        delete_failed_request_if_needed(sap, c, l, step)
        msg = api.restart_failed(sap, c, l)
        log_attempt(key, "restart", f"attempt {n + 1}/{MAX_ATTEMPTS} msg={msg}")
        done_runs.add((c, l))
    return result


def recover(chain: str, log_id: str, max_passes: int = MAX_ATTEMPTS + 1) -> str:
    with Sap() as sap:
        status = "ok"
        for _ in range(max_passes):
            status = recover_once(sap, chain, log_id)
            print(f"pass result: {status}")
            if status in ("ok", "manual"):
                return status
            time.sleep(RETRY_WAIT_SECONDS)
        return status
