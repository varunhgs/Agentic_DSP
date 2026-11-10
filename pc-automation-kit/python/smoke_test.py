"""Connection smoke test. Read-only: changes nothing in SAP."""
from pyrfc import ABAPApplicationError, ABAPRuntimeError

from sap_conn import Sap, masked

FUNCTIONS = [
    "RSPC_API_CHAIN_START",
    "RSPC_API_CHAIN_GET_STATUS",
    "RSPC_API_CHAIN_GET_PROCESSES",
    "RSPC_API_CHAIN_RESTART",
    "RSPC_PROCESS_FINISH",
    "RFC_READ_TABLE",
]


def main() -> None:
    with Sap() as sap:
        print("Connecting with", masked(sap.params))
        sap.call("RFC_PING")
        print("RFC_PING ok")
        info = sap.call("RFC_SYSTEM_INFO")["RFCSI_EXPORT"]
        print(f"System {info['RFCSYSID']} host {info['RFCHOST']} release {info['RFCSAPRL']}")

        for fm in FUNCTIONS:
            try:
                sap.conn.get_function_description(fm)
                print(f"  OK       {fm} (remote-callable)")
            except (ABAPApplicationError, ABAPRuntimeError) as e:
                print(f"  MISSING  {fm}: {e}")
            except Exception as e:  # noqa: BLE001
                print(f"  ERROR    {fm}: {e}")


if __name__ == "__main__":
    main()
