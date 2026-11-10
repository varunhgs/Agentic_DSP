"""Command line: start / status / restart / recover.

  python cli.py status  <CHAIN> [LOG_ID]
  python cli.py start   <CHAIN>
  python cli.py restart <CHAIN> <LOG_ID>
  python cli.py recover <CHAIN> <LOG_ID>
"""
import sys

import chain_api as api
from recovery import recover
from sap_conn import Sap


def print_steps(sap: Sap, chain: str, log_id: str, indent: str = "") -> None:
    for s in api.get_steps(sap, chain, log_id):
        print(f"{indent}{s.colour:7} {s.state:2} {s.type:12} {s.variant:40} {s.start} -> {s.end}")
        if s.is_subchain:
            sub = api.subchain_log_id(sap, s)
            if sub:
                print(f"{indent}  └ sub-chain {s.variant} run {sub}")
                print_steps(sap, s.variant, sub, indent + "    ")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, chain = argv[0], argv[1]
    log_id = argv[2] if len(argv) > 2 else None

    if cmd == "recover":
        if not log_id:
            print("recover needs LOG_ID")
            return 1
        print(recover(chain, log_id))
        return 0

    with Sap() as sap:
        if cmd == "start":
            print(api.start_chain(sap, chain))
        elif cmd == "status":
            log_id = log_id or api.latest_log_id(sap, chain)
            if not log_id:
                print("no runs found")
                return 1
            print(f"Chain {chain} run {log_id}: {api.get_status(sap, chain, log_id)}")
            print_steps(sap, chain, log_id)
        elif cmd == "restart":
            if not log_id:
                print("restart needs LOG_ID")
                return 1
            print(api.restart_failed(sap, chain, log_id))
        else:
            print(__doc__)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
