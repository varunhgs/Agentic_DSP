"""PyRFC connection to SAP, configured from environment variables / .env.

Credentials are never hard-coded and never logged. See docs/01-AUTHENTICATION.md.
"""
import os
from pathlib import Path

from pyrfc import Connection, CommunicationError


def _load_dotenv() -> None:
    """Minimal .env loader (no extra dependency). Existing env vars win."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def connection_params() -> dict:
    _load_dotenv()
    params = {
        "client": os.environ.get("SAP_CLIENT", "100"),
        "user": os.environ.get("SAP_USER"),
        "passwd": os.environ.get("SAP_PASSWD"),
        "lang": os.environ.get("SAP_LANG", "EN"),
    }
    if os.environ.get("SAP_MSHOST"):
        # Load-balanced logon via message server
        params.update(
            mshost=os.environ["SAP_MSHOST"],
            sysid=os.environ.get("SAP_SYSID"),
            group=os.environ.get("SAP_GROUP", "PUBLIC"),
        )
    else:
        params.update(ashost=os.environ.get("SAP_ASHOST"), sysnr=os.environ.get("SAP_SYSNR", "00"))
    if os.environ.get("SAP_SAPROUTER"):
        params["saprouter"] = os.environ["SAP_SAPROUTER"]

    missing = [k for k in ("user", "passwd") if not params.get(k)]
    if not params.get("ashost") and not params.get("mshost"):
        missing.append("ashost/mshost")
    if missing:
        raise RuntimeError(f"Missing SAP connection settings: {', '.join(missing)}. Fill python/.env.")
    return {k: v for k, v in params.items() if v}


def masked(params: dict) -> dict:
    return {k: ("***" if k == "passwd" else v) for k, v in params.items()}


class Sap:
    """Thin wrapper: one connection, reopened once on a dropped link."""

    def __init__(self) -> None:
        self.params = connection_params()
        self.conn = Connection(**self.params)

    def call(self, fm: str, **kwargs):
        try:
            return self.conn.call(fm, **kwargs)
        except CommunicationError:
            # Idle connections can be dropped by the gateway; reopen once and retry.
            self.conn = Connection(**self.params)
            return self.conn.call(fm, **kwargs)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
