#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Public OpenClaw port: GET /u/0 redirects with #token=; everything else is proxied."""

from __future__ import annotations

import socket
import sys
import threading


SHORTCUTS = {b"/u/0", b"/u/0/", b"/ui", b"/ui/"}


def _is_shortcut(first_line: bytes) -> bool:
    parts = first_line.split()
    if len(parts) < 2 or parts[0] not in {b"GET", b"HEAD"}:
        return False
    path = parts[1].split(b"?", 1)[0]
    return path in SHORTCUTS


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
            loc = f"/#token={token}".encode("ascii", "replace")
            client.sendall(
                b"HTTP/1.1 302 Found\r\n"
                b"Location: " + loc + b"\r\n"
                b"Cache-Control: no-store\r\n"
                b"Content-Length: 0\r\n"
                b"Connection: close\r\n\r\n"
            )
            return
        backend = socket.create_connection((backend_host, backend_port), timeout=10)
        backend.sendall(peeked)
        up = threading.Thread(target=_pump, args=(backend, client), daemon=True)
        up.start()
        _pump(client, backend)
        up.join(timeout=120)
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
    if len(sys.argv) < 5:
        print(
            "usage: e2e-openclaw-ui-shortcut.py <listen-port> <backend-host> <backend-port> <token>",
            file=sys.stderr,
        )
        return 2
    listen_port = int(sys.argv[1])
    backend_host = sys.argv[2]
    backend_port = int(sys.argv[3])
    token = sys.argv[4]
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", listen_port))
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
