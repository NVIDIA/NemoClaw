#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Forward each HTTP request after transforming its complete header block.

A keep-alive client sends the next request on the same socket. The header
block can also arrive split across reads. Body bytes, including chunked
bodies, are copied unchanged. After an Upgrade request (WebSocket) the
connection is no longer HTTP, so the rest is copied as raw bytes.
"""

from __future__ import annotations

import socket
from collections.abc import Callable


class _Closed(Exception):
    pass


def _recv_more(sock: socket.socket, buf: bytearray) -> None:
    chunk = sock.recv(65536)
    if not chunk:
        raise _Closed
    buf.extend(chunk)


def _read_until(sock: socket.socket, buf: bytearray, marker: bytes) -> bytes:
    while True:
        idx = buf.find(marker)
        if idx >= 0:
            found = bytes(buf[:idx])
            del buf[: idx + len(marker)]
            return found
        _recv_more(sock, buf)


def _read_exact(sock: socket.socket, buf: bytearray, count: int) -> bytes:
    while len(buf) < count:
        _recv_more(sock, buf)
    found = bytes(buf[:count])
    del buf[:count]
    return found


def _header_value(head: bytes, name: bytes) -> bytes | None:
    prefix = name.lower() + b":"
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(prefix):
            return line.split(b":", 1)[1].strip()
    return None


def _is_upgrade(head: bytes) -> bool:
    return _header_value(head, b"upgrade") is not None


def _forward_raw(client: socket.socket, backend: socket.socket, buf: bytearray) -> None:
    if buf:
        backend.sendall(bytes(buf))
        buf.clear()
    while True:
        chunk = client.recv(65536)
        if not chunk:
            return
        backend.sendall(chunk)


def _forward_body(
    client: socket.socket,
    backend: socket.socket,
    head: bytes,
    buf: bytearray,
) -> None:
    encoding = _header_value(head, b"transfer-encoding")
    if encoding is not None and b"chunked" in encoding.lower():
        while True:
            size_line = _read_until(client, buf, b"\r\n")
            backend.sendall(size_line + b"\r\n")
            size = int(size_line.split(b";", 1)[0].strip(), 16)
            if size == 0:
                while True:
                    trailer = _read_until(client, buf, b"\r\n")
                    backend.sendall(trailer + b"\r\n")
                    if trailer == b"":
                        return
            backend.sendall(_read_exact(client, buf, size + 2))
    length = _header_value(head, b"content-length")
    if length is None:
        return
    backend.sendall(_read_exact(client, buf, int(length)))


def relay_requests(
    client: socket.socket,
    backend: socket.socket,
    transform: Callable[[bytes], bytes],
    initial: bytes = b"",
) -> None:
    """Read every request from client, transform its headers, write it to backend.

    `initial` is bytes already taken off the client socket before the backend
    connection existed. They still belong to the first request.
    """
    buf = bytearray(initial)
    try:
        while True:
            try:
                head = _read_until(client, buf, b"\r\n\r\n")
            except _Closed:
                return
            backend.sendall(transform(head) + b"\r\n\r\n")
            if _is_upgrade(head):
                _forward_raw(client, backend, buf)
                return
            _forward_body(client, backend, head, buf)
    except (_Closed, OSError, ValueError):
        return
