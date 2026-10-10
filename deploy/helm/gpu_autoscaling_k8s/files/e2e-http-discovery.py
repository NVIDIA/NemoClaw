#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Remote HTTP helper. Each /u/N opens only that user's UI. No user list.

/clients never returns tokens, passwords, or API keys.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, urlsplit, urlunsplit

_SECRET_KEYS = {
    "token",
    "api_key",
    "apikey",
    "api_server_key",
    "password",
    "authorization",
    "secret",
    "htpasswd",
}


def publish_bind() -> str:
    raw = (os.environ.get("E2E_PUBLISH_BIND") or "127.0.0.1").strip()
    if raw in {"127.0.0.1", "0.0.0.0"}:
        return raw
    parts = raw.split(".")
    if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return raw
    return "127.0.0.1"


def _secret_key(name: str) -> bool:
    lowered = name.lower()
    if lowered in _SECRET_KEYS:
        return True
    return "token" in lowered or "password" in lowered or "secret" in lowered or "apikey" in lowered


def _strip_secret_url(value: str) -> str:
    if "#token=" in value or "token=" in value:
        parts = urlsplit(value)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return value


def redact_secrets(value: object) -> object:
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, item in value.items():
            if _secret_key(str(key)):
                continue
            out[str(key)] = redact_secrets(item)
        return out
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        return _strip_secret_url(value)
    return value


def _users(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    users = data.get("users") if isinstance(data, dict) else None
    return users if isinstance(users, list) else []


def _dashboard(path: Path, idx: int) -> str:
    users = _users(path)
    if idx < 0 or idx >= len(users):
        return ""
    row = users[idx]
    if not isinstance(row, dict):
        return ""
    return _strip_secret_url(str(row.get("dashboard_url") or "").strip())


def public_clients_bytes(path: Path) -> bytes:
    data = json.loads(path.read_text(encoding="utf-8"))
    return json.dumps(redact_secrets(data)).encode()


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: e2e-http-discovery.py <endpoints.json> <port>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    port = int(sys.argv[2])
    bind = publish_bind()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            route = urlparse(self.path).path.rstrip("/") or "/"
            if route == "/clients":
                try:
                    body = public_clients_bytes(path)
                except (OSError, json.JSONDecodeError):
                    self.send_error(500, "clients unavailable")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if route == "/hpa":
                ns = os.environ.get("NAMESPACE", "nemoclaw-gpu")
                name = os.environ.get("HPA_NAME", "nemoclaw-gpu-metrics-proxy")
                current, desired = 0, 0
                metric = ""
                try:
                    raw = subprocess.check_output(
                        [
                            "kubectl",
                            "get",
                            "hpa",
                            name,
                            "-n",
                            ns,
                            "-o",
                            "jsonpath={.status.currentReplicas} {.status.desiredReplicas} {.spec.metrics[0].pods.metric.name}",
                        ],
                        text=True,
                        timeout=5,
                        stderr=subprocess.DEVNULL,
                    )
                    parts = raw.split()
                    if parts and parts[0].isdigit():
                        current = int(parts[0])
                    if len(parts) > 1 and parts[1].isdigit():
                        desired = int(parts[1])
                    if len(parts) > 2:
                        metric = parts[2]
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
                    pass
                body = json.dumps(
                    {"current": current, "desired": desired, "metric": metric}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            dest = ""
            if route == "/ui":
                dest = _dashboard(path, 0)
            elif route.startswith("/u/"):
                raw = route[3:]
                if raw.isdigit():
                    dest = _dashboard(path, int(raw))
            if dest:
                self.send_response(302)
                self.send_header("Location", dest)
                self.end_headers()
                return
            if route in {"/ui"} or route.startswith("/u/"):
                self.send_error(404, "no dashboard for that user")
                return
            self.send_error(404)

        def log_message(self, fmt: str, *args: object) -> None:
            return

    ThreadingHTTPServer((bind, port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
