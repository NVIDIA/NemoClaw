# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Authenticated, model-pinned inference access to an externally owned Ollama daemon."""

import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


def load_key(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / "inference-key"
    marker = root / "initialized"
    if not path.exists():
        if marker.exists():
            raise RuntimeError("managed inference credential is missing; regeneration forbidden")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as output:
                output.write(secrets.token_hex(32))
                output.flush()
                os.fsync(output.fileno())
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o777 != 0o600
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or info.st_size != 64
        ):
            raise RuntimeError("managed inference credential permissions are invalid")
        key = source.read(65)
    if not re.fullmatch("[0-9a-f]{64}", key):
        raise RuntimeError("managed inference credential is invalid")
    marker.touch(mode=0o600, exist_ok=True)
    with marker.open("rb") as marker_file:
        os.fsync(marker_file.fileno())
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return key


def loopback_listener(port):
    found = False
    for name in ("tcp", "tcp6"):
        for line in Path("/proc/net", name).read_text().splitlines()[1:]:
            fields = line.split()
            address, number = fields[1].split(":")
            if fields[3] != "0A" or int(number, 16) != port:
                continue
            raw = b"".join(
                bytes.fromhex(address[i : i + 8])[::-1] for i in range(0, len(address), 8)
            )
            ip = ipaddress.ip_address(raw)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            if not ip.is_loopback:
                raise RuntimeError("external Ollama must listen only on loopback")
            found = True
    if not found:
        raise RuntimeError("external Ollama listener is absent")


def serve(settings, root, host, port):
    upstream = urlsplit(settings["upstream"])
    if (
        upstream.scheme != "http"
        or upstream.path != "/v1"
        or upstream.query
        or upstream.fragment
        or upstream.username
        or upstream.password
        or not upstream.port
        or not ipaddress.ip_address(upstream.hostname).is_loopback
        or not re.fullmatch("[0-9a-f]{64}", settings["digest"])
        or not isinstance(settings["model"], str)
        or not settings["model"]
    ):
        raise RuntimeError("invalid external Ollama proxy specification")
    key = load_key(root)

    def inventory():
        loopback_listener(upstream.port)
        conn = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=10)
        try:
            conn.request("GET", "/api/tags")
            response = conn.getresponse()
            body = response.read((1 << 20) + 1)
            if response.status != 200 or len(body) > 1 << 20:
                raise RuntimeError("external model inventory is unavailable")
            models = json.loads(body)["models"]
            names = [model["name"] for model in models]
            if len(set(names)) != len(names):
                raise RuntimeError("external model inventory is ambiguous")
            model = next((m for m in models if m["name"] == settings["model"]), None)
            if not model or model["digest"] != settings["digest"] or model["size"] <= 0:
                raise RuntimeError("external model is absent or its digest changed")
        finally:
            conn.close()

    inventory()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_):
            pass

        def reply(self, status, body=b""):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.dispatch()

        def dispatch(self):
            auth = self.headers.get_all("Authorization", [])
            if len(auth) != 1 or not hmac.compare_digest(
                auth[0].encode(), ("Bearer " + key).encode()
            ):
                return self.reply(401)
            if (self.command, self.path) not in (
                ("GET", "/v1/models"),
                ("POST", "/v1/chat/completions"),
            ):
                return self.reply(404)
            if (
                self.headers.get("Transfer-Encoding")
                or len(self.headers.get_all("Content-Length", [])) > 1
            ):
                return self.reply(400)
            body = None
            if self.command == "POST":
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 4 << 20:
                        return self.reply(413)
                    body = self.rfile.read(size)
                    if len(body) != size:
                        return self.reply(400)
                    payload = json.loads(body)
                    if not isinstance(payload, dict) or payload.get("model") != settings["model"]:
                        return self.reply(403)
                except (ValueError, OSError):
                    return self.reply(400)
            try:
                inventory()
            except (RuntimeError, OSError, ValueError, KeyError, http.client.HTTPException):
                return self.reply(502)
            if self.command == "GET":
                return self.reply(
                    200,
                    json.dumps(
                        {
                            "object": "list",
                            "data": [
                                {"id": settings["model"], "object": "model", "owned_by": "ollama"}
                            ],
                        }
                    ).encode(),
                )
            conn = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=600)
            started = False
            try:
                # Rebuild headers; never forward the proxy credential to the daemon.
                conn.request(
                    "POST", "/v1/chat/completions", body, {"Content-Type": "application/json"}
                )
                response = conn.getresponse()
                if 300 <= response.status < 400:
                    return self.reply(502)
                self.send_response(response.status)
                self.send_header(
                    "Content-Type", response.getheader("Content-Type", "application/json")
                )
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                started = True
                while chunk := response.read1(65536):
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except (OSError, http.client.HTTPException):
                if not started:
                    self.reply(502)
            finally:
                self.close_connection = True
                conn.close()

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def __init__(self, *args):
            self.slots = threading.BoundedSemaphore(32)
            super().__init__(*args)

        def process_request(self, request, address):
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, address)
            except BaseException:
                self.slots.release()
                raise

        def process_request_thread(self, request, address):
            try:
                super().process_request_thread(request, address)
            finally:
                self.slots.release()

    return Server((host, port), Handler)


if __name__ == "__main__":
    try:
        settings = json.loads(os.environ["NEMOCLAW_OLLAMA_PROXY"])
        binding = urlsplit(settings.pop("endpoint"))
        server = serve(settings, Path("/data"), binding.hostname, binding.port)
        server.serve_forever()
    except Exception:
        raise SystemExit(
            "Ollama proxy startup failed; retained resources require inspection"
        ) from None
