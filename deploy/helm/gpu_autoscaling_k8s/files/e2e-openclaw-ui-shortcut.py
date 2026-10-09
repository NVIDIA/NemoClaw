#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Public OpenClaw port: GET /u/0 redirects to / with no token. Other paths are proxied.

The gateway token stays on this host. It is read from a file or env, never
from argv, HTTP, or the Location header. WebSocket connect frames get the
token on the backend hop only.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
import threading
from pathlib import Path


def publish_bind() -> str:
    raw = (os.environ.get("E2E_PUBLISH_BIND") or "127.0.0.1").strip()
    if raw in {"127.0.0.1", "0.0.0.0"}:
        return raw
    parts = raw.split(".")
    if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return raw
    return "127.0.0.1"


def gateway_token() -> str:
    path = (os.environ.get("E2E_OPENCLAW_GATEWAY_TOKEN_FILE") or "").strip()
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return (os.environ.get("E2E_OPENCLAW_GATEWAY_TOKEN") or "").strip()


SHORTCUTS = {b"/u/0", b"/u/0/", b"/ui", b"/ui/"}


def _is_shortcut(first_line: bytes) -> bool:
    parts = first_line.split()
    if len(parts) < 2 or parts[0] not in {b"GET", b"HEAD"}:
        return False
    path = parts[1].split(b"?", 1)[0]
    return path in SHORTCUTS


def inject_connect_token(payload: bytes, token: str) -> bytes:
    if not token:
        return payload
    try:
        msg = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return payload
    if not isinstance(msg, dict) or msg.get("method") != "connect":
        return payload
    params = msg.get("params")
    if not isinstance(params, dict):
        return payload
    auth = params.get("auth")
    if not isinstance(auth, dict):
        auth = {}
        params["auth"] = auth
    auth["token"] = token
    return json.dumps(msg, separators=(",", ":")).encode("utf-8")


def _mask_ws_frame(payload: bytes, opcode: int = 1) -> bytes:
    key = os.urandom(4)
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", n))
    header.extend(key)
    return bytes(header) + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def _client_ws_frame(buf: bytes) -> tuple[int, bytes, bytes] | None:
    if len(buf) < 2:
        return None
    b1, b2 = buf[0], buf[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    n = b2 & 0x7F
    idx = 2
    if n == 126:
        if len(buf) < 4:
            return None
        n = struct.unpack("!H", buf[2:4])[0]
        idx = 4
    elif n == 127:
        if len(buf) < 10:
            return None
        n = struct.unpack("!Q", buf[2:10])[0]
        idx = 10
    need = idx + (4 if masked else 0) + n
    if len(buf) < need:
        return None
    if masked:
        key = buf[idx : idx + 4]
        idx += 4
        payload = bytes(buf[idx + i] ^ key[i % 4] for i in range(n))
    else:
        payload = bytes(buf[idx : idx + n])
    return opcode, payload, buf[need:]


def _pump(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        return
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            return


def _pump_inject_token(
    src: socket.socket,
    dst: socket.socket,
    token: str,
    extra: bytes = b"",
) -> None:
    pending = bytearray(extra)
    injected = not bool(token)
    try:
        while True:
            if not injected and pending:
                parsed = _client_ws_frame(bytes(pending))
                if parsed is not None:
                    opcode, payload, rest = parsed
                    if opcode == 1:
                        payload = inject_connect_token(payload, token)
                        injected = True
                    dst.sendall(_mask_ws_frame(payload, opcode))
                    pending = bytearray(rest)
                    continue
            chunk = src.recv(65536)
            if not chunk:
                if pending:
                    dst.sendall(bytes(pending))
                break
            if injected:
                if pending:
                    dst.sendall(bytes(pending))
                    pending.clear()
                dst.sendall(chunk)
                continue
            pending.extend(chunk)
    except OSError:
        return
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            return


def _handle(
    client: socket.socket,
    backend_host: str,
    backend_port: int,
    token: str,
) -> None:
    backend = None
    try:
        peeked = client.recv(65536)
        if not peeked:
            return
        first = peeked.split(b"\r\n", 1)[0]
        if _is_shortcut(first):
            client.sendall(
                b"HTTP/1.1 302 Found\r\n"
                b"Location: /\r\n"
                b"Cache-Control: no-store\r\n"
                b"Content-Length: 0\r\n"
                b"Connection: close\r\n\r\n"
            )
            return
        backend = socket.create_connection((backend_host, backend_port), timeout=10)
        backend.settimeout(None)
        client.settimeout(None)
        if b"\r\n\r\n" in peeked:
            head, extra = peeked.split(b"\r\n\r\n", 1)
            backend.sendall(head + b"\r\n\r\n")
        else:
            extra = b""
            backend.sendall(peeked)
        up = threading.Thread(target=_pump, args=(backend, client), daemon=True)
        up.start()
        _pump_inject_token(client, backend, token, extra)
        up.join()
    except OSError:
        return
    finally:
        if backend is not None:
            try:
                backend.close()
            except OSError:
                pass
        try:
            client.close()
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: e2e-openclaw-ui-shortcut.py <listen-port> <backend-host> <backend-port>",
            file=sys.stderr,
        )
        return 2
    listen_port = int(sys.argv[1])
    backend_host = sys.argv[2]
    backend_port = int(sys.argv[3])
    token = gateway_token()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((publish_bind(), listen_port))
    sock.listen(64)
    while True:
        client, _addr = sock.accept()
        threading.Thread(
            target=_handle,
            args=(client, backend_host, backend_port, token),
            daemon=True,
        ).start()


if __name__ == "__main__":
    raise SystemExit(main())
