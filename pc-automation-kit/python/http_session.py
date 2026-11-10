"""ALTERNATIVE connection: HTTPS + Basic Auth + CSRF token — the same handshake the MCP uses
(src/bw-client.ts). Use this if RFC is not possible and HTTP endpoints are used instead
(e.g. /sap/bc/soap/rfc or a custom Z REST service).

Env: BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT, BW_LANGUAGE, optional SAP_CA_BUNDLE.
"""
import os
import time

import requests

from sap_conn import _load_dotenv

CSRF_TTL_SECONDS = 4 * 60  # SAP sessions time out after ~5 min idle
TOKEN_PATH = "/sap/bw/modeling/repo/is/systeminfo"  # any stateful GET works; this is what the MCP uses


class BwHttpSession:
    def __init__(self) -> None:
        _load_dotenv()
        self.base = os.environ["BW_URL"].rstrip("/")
        self.user = os.environ["BW_USER"]
        self.password = os.environ["BW_PASSWORD"]
        self.s = requests.Session()  # keeps SAP session cookies automatically
        self.s.verify = os.environ.get("SAP_CA_BUNDLE", False)  # False only for local self-signed
        self.s.headers.update({
            "sap-client": os.environ.get("BW_CLIENT", "100"),
            "sap-language": os.environ.get("BW_LANGUAGE", "EN"),
            "X-sap-adt-sessiontype": "stateful",
        })
        self.token: str | None = None
        self.token_at = 0.0

    def _fetch_token(self) -> None:
        # Basic Auth only on this first call; afterwards the session cookie carries the login.
        r = self.s.get(self.base + TOKEN_PATH, auth=(self.user, self.password),
                       headers={"X-CSRF-Token": "Fetch", "Accept": "application/xml"})
        token = r.headers.get("x-csrf-token")
        if not token or token.lower() == "fetch":
            raise RuntimeError(f"CSRF token fetch failed (HTTP {r.status_code}). Check BW_URL/USER/PASSWORD/CLIENT.")
        self.token, self.token_at = token, time.time()

    def _ensure(self) -> None:
        if not self.token or time.time() - self.token_at > CSRF_TTL_SECONDS:
            self._fetch_token()

    def get(self, path: str, accept: str = "application/json") -> requests.Response:
        self._ensure()
        r = self.s.get(self.base + path, headers={"X-CSRF-Token": self.token, "Accept": accept})
        r.raise_for_status()
        return r

    def post(self, path: str, body: str = "", content_type: str = "application/json") -> requests.Response:
        self._ensure()
        r = self.s.post(self.base + path, data=body,
                        headers={"X-CSRF-Token": self.token, "Content-Type": content_type})
        if r.status_code == 403 and "csrf" in r.text.lower():
            self._fetch_token()  # token expired → refresh once
            r = self.s.post(self.base + path, data=body,
                            headers={"X-CSRF-Token": self.token, "Content-Type": content_type})
        r.raise_for_status()
        return r


if __name__ == "__main__":
    sess = BwHttpSession()
    sess._fetch_token()
    print("HTTPS login + CSRF ok")
