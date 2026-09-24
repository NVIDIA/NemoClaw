# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Bridge-scoped HTTP admission for one sandbox-owned OpenClaw agent."""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import stat
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

GRANT_PATH = Path("/sandbox/.nemoclaw/agent-access/voice.json")
# OpenClaw dashboards reject the Hermes-reserved range. Reusing its upper port
# keeps this internal listener disjoint from every declared OpenClaw interface.
LISTEN_PORT = 8652
MAX_HEADER_BYTES = 16 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SESSION_LIFETIME_SECONDS = 5 * 60
TURN_TIMEOUT_SECONDS = 2 * 60
_NAME = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
_UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
_HEX32 = re.compile(r"^[a-f0-9]{32}$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_VALUE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$")
_GRANT_KEYS = {
    "version",
    "deployment",
    "generation",
    "integration",
    "sandbox",
    "agent",
    "clientAddress",
    "credentialSha256",
    "expiresAt",
}


class GrantError(ValueError):
    """Content-free invalid or revoked admission grant."""


def _open_private(path):
    if not path.is_absolute() or len(path.parts) < 3 or not hasattr(os, "O_NOFOLLOW"):
        raise GrantError("invalid grant")
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    directory_flags = flags | os.O_DIRECTORY
    first = path.parts[1]
    if first in ("", ".", ".."):
        raise GrantError("invalid grant")
    directory = os.open(f"/{first}", directory_flags)
    try:
        for component in path.parts[2:-1]:
            if component in ("", ".", ".."):
                raise GrantError("invalid grant")
            following = os.open(component, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = following
        return os.open(path.name, flags | os.O_NONBLOCK, dir_fd=directory)
    except OSError as error:
        raise GrantError("invalid grant") from error
    finally:
        os.close(directory)


def _strict_object(items):
    value = {}
    for key, item in items:
        if key in value:
            raise GrantError("invalid grant")
        value[key] = item
    return value


def load_grant(path, agent, peer):
    """Load a current owner-only grant bound to this agent and bridge peer."""

    path = Path(path)
    try:
        descriptor = _open_private(path)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or metadata.st_mode & 0o7777 != 0o600
                or not 1 <= metadata.st_size <= 8192
            ):
                raise GrantError("invalid grant")
            raw = os.read(descriptor, 8193)
        finally:
            os.close(descriptor)
        if not raw or len(raw) > 8192:
            raise GrantError("invalid grant")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
    except GrantError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise GrantError("invalid grant") from error
    if not isinstance(value, dict) or set(value) != _GRANT_KEYS:
        raise GrantError("invalid grant")
    expires = value["expiresAt"]
    if (
        value["version"] != 1
        or not isinstance(value["deployment"], str)
        or _UUID.fullmatch(value["deployment"]) is None
        or not isinstance(value["generation"], str)
        or _HEX32.fullmatch(value["generation"]) is None
        or not isinstance(value["integration"], str)
        or _NAME.fullmatch(value["integration"]) is None
        or not isinstance(value["sandbox"], str)
        or _NAME.fullmatch(value["sandbox"]) is None
        or value["agent"] != agent
        or not isinstance(value["credentialSha256"], str)
        or _HEX64.fullmatch(value["credentialSha256"]) is None
        or type(expires) is not int
        or not int(time.time()) < expires <= int(time.time()) + 31 * 24 * 3600
    ):
        raise GrantError("invalid grant")
    try:
        address = ipaddress.ip_address(value["clientAddress"])
    except (TypeError, ValueError) as error:
        raise GrantError("invalid grant") from error
    if address.version != 4 or not (address.is_loopback or address.is_private):
        raise GrantError("invalid grant")
    try:
        observed = ipaddress.ip_address(peer)
    except ValueError as error:
        raise GrantError("invalid grant") from error
    if observed != address:
        raise GrantError("invalid grant")
    return value


def _bearer(headers):
    value = headers.get("x-nemoclaw-authorization", "")
    if not value.startswith("Bearer "):
        return ""
    token = value[7:]
    if not token or any(ord(character) < 0x21 or ord(character) > 0x7E for character in token):
        return ""
    return token


def _hash(value):
    return hashlib.sha256(value.encode("ascii", errors="ignore")).hexdigest()


def _exact_strings(value, fields):
    return (
        isinstance(value, dict)
        and set(value) == set(fields)
        and all(isinstance(value[field], str) for field in fields)
    )


def _runtime_value(value):
    return isinstance(value, str) and _VALUE.fullmatch(value) is not None


def _selected_agent(runtime):
    agents = (runtime.inference or {}).get("agents")
    if agents:
        if len(agents) != 1 or not isinstance(agents[0], dict):
            raise GrantError("invalid runtime")
        agent = agents[0].get("name")
    else:
        agent = runtime.name
    if not isinstance(agent, str) or _NAME.fullmatch(agent) is None:
        raise GrantError("invalid runtime")
    return agent


class AgentIngress:
    """One protected voice gateway inside the selected sandbox generation."""

    def __init__(self, runtime, *, grant_path=GRANT_PATH, host="0.0.0.0", port=LISTEN_PORT):
        self.runtime = runtime
        self.grant_path = Path(grant_path)
        self.host = host
        self.requested_port = port
        self.server = None
        self.session = None

    @property
    def port(self):
        if self.server is None:
            return self.requested_port
        return self.server.sockets[0].getsockname()[1]

    async def start(self):
        if self.server is not None:
            raise RuntimeError("agent ingress is already running")
        self.server = await asyncio.start_server(
            self._handle,
            self.host,
            self.requested_port,
            limit=MAX_REQUEST_BYTES + MAX_HEADER_BYTES,
        )

    async def stop(self):
        self.session = None
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    def _authority(self, headers, peer, expected_hash=None):
        agent = _selected_agent(self.runtime)
        grant = load_grant(self.grant_path, agent, peer)
        if expected_hash is not None and not hmac.compare_digest(
            grant["credentialSha256"], expected_hash
        ):
            raise GrantError("revoked grant")
        token_hash = _hash(_bearer(headers))
        if expected_hash is None and not hmac.compare_digest(token_hash, grant["credentialSha256"]):
            raise GrantError("invalid grant")
        if self.runtime.process is None or self.runtime.process.returncode is not None:
            raise GrantError("invalid runtime")
        return grant

    async def _read_request(self, reader):
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        if len(raw) > MAX_HEADER_BYTES:
            raise ValueError("invalid request")
        lines = raw[:-4].split(b"\r\n")
        try:
            method, path, version = lines[0].decode("ascii").split(" ")
        except (UnicodeDecodeError, ValueError) as error:
            raise ValueError("invalid request") from error
        if version != "HTTP/1.1" or not path.startswith("/") or path.startswith("//"):
            raise ValueError("invalid request")
        headers = {}
        for raw_header in lines[1:]:
            try:
                name, value = raw_header.decode("ascii").split(":", 1)
            except (UnicodeDecodeError, ValueError) as error:
                raise ValueError("invalid request") from error
            name = name.strip().lower()
            value = value.strip()
            if not name or name in headers:
                raise ValueError("invalid request")
            headers[name] = value
        if "transfer-encoding" in headers:
            raise ValueError("invalid request")
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError as error:
            raise ValueError("invalid request") from error
        if not 0 <= length <= MAX_REQUEST_BYTES:
            raise ValueError("invalid request")
        body = await asyncio.wait_for(reader.readexactly(length), 10) if length else b""
        return method, path, headers, body

    @staticmethod
    async def _write(writer, status, body=b"", media=None):
        reasons = {
            200: "OK",
            201: "Created",
            204: "No Content",
            400: "Bad Request",
            401: "Unauthorized",
            404: "Not Found",
            409: "Conflict",
            413: "Content Too Large",
            415: "Unsupported Media Type",
            500: "Internal Server Error",
            502: "Bad Gateway",
        }
        headers = [
            f"HTTP/1.1 {status} {reasons[status]}",
            "Cache-Control: no-store",
            f"Content-Length: {len(body)}",
            "Connection: close",
        ]
        if media:
            headers.append(f"Content-Type: {media}")
        writer.write(("\r\n".join(headers) + "\r\n\r\n").encode() + body)
        await writer.drain()

    @staticmethod
    def _json(body):
        try:
            value = json.loads(body.decode("utf-8"), object_pairs_hook=_strict_object)
        except (UnicodeDecodeError, json.JSONDecodeError, GrantError) as error:
            raise ValueError("invalid request") from error
        if not isinstance(value, dict):
            raise ValueError("invalid request")
        return value

    async def _handle(self, reader, writer):
        peer = writer.get_extra_info("peername")
        peer = peer[0] if peer else ""
        try:
            method, path, headers, body = await self._read_request(reader)
            await self._route(writer, peer, method, path, headers, body)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ValueError):
            await self._write(writer, 400, b'{"error":"invalid_request"}', "application/json")
        except Exception:
            await self._write(writer, 500, b'{"error":"internal_error"}', "application/json")
        finally:
            writer.close()
            await writer.wait_closed()

    async def _route(self, writer, peer, method, path, headers, body):
        if method == "GET" and path == "/healthz" and not body:
            try:
                self._authority(headers, peer)
            except GrantError:
                await self._write(writer, 401)
                return
            await self._write(writer, 204)
            return
        if method == "POST" and path == "/v1/voice/sessions":
            try:
                authority = self._authority(headers, peer)
            except GrantError:
                await self._write(
                    writer, 401, b'{"error":"authentication_failed"}', "application/json"
                )
                return
            if headers.get("content-type") != "application/json":
                await self._write(writer, 415, b'{"error":"invalid_request"}', "application/json")
                return
            value = self._json(body)
            if not _exact_strings(value, ["runtimeConversationId"]) or not _runtime_value(
                value["runtimeConversationId"]
            ):
                await self._write(writer, 400, b'{"error":"invalid_request"}', "application/json")
                return
            if self.session is not None and self.session["expiresAt"] > time.time():
                await self._write(
                    writer, 409, b'{"error":"session_in_progress"}', "application/json"
                )
                return
            session_id = str(uuid.uuid4())
            session_grant = secrets.token_urlsafe(32)
            expires = time.time() + SESSION_LIFETIME_SECONDS
            binding = json.dumps(
                [
                    _selected_agent(self.runtime),
                    "nemoclaw-voice-gateway/v1",
                    self.runtime.runtime_id,
                    self.runtime.name,
                    value["runtimeConversationId"],
                ],
                separators=(",", ":"),
            )
            session_key = (
                f"agent:{_selected_agent(self.runtime)}:nemoclaw-voice:"
                + hashlib.sha256(binding.encode()).digest().hex()
            )
            self.session = {
                "id": session_id,
                "grantHash": _hash(session_grant),
                "authorityHash": authority["credentialSha256"],
                "expiresAt": expires,
                "sessionKey": session_key,
                "used": False,
            }
            response = json.dumps(
                {
                    "voiceSessionId": session_id,
                    "grant": session_grant,
                    "expiresAt": datetime.fromtimestamp(expires, UTC)
                    .isoformat()
                    .replace("+00:00", "Z"),
                },
                separators=(",", ":"),
            ).encode()
            await self._write(writer, 201, response, "application/json")
            return

        match = re.fullmatch(r"/v1/voice/sessions/([A-Za-z0-9-]+)/turns", path)
        if method == "POST" and match:
            await self._turn(writer, peer, match.group(1), headers, body)
            return
        match = re.fullmatch(r"/v1/voice/sessions/([A-Za-z0-9-]+)", path)
        if method == "DELETE" and match and not body:
            if not self._session_authorized(peer, match.group(1), headers):
                await self._write(
                    writer, 401, b'{"error":"authentication_failed"}', "application/json"
                )
                return
            self.session = None
            await self._write(writer, 204)
            return
        await self._write(writer, 404)

    def _session_authorized(self, peer, session_id, headers):
        session = self.session
        if (
            session is None
            or session["id"] != session_id
            or session["expiresAt"] <= time.time()
            or not hmac.compare_digest(_hash(_bearer(headers)), session["grantHash"])
        ):
            return False
        try:
            self._authority(headers, peer, session["authorityHash"])
        except GrantError:
            return False
        return True

    async def _turn(self, writer, peer, session_id, headers, body):
        if not self._session_authorized(peer, session_id, headers):
            await self._write(writer, 401, b'{"error":"authentication_failed"}', "application/json")
            return
        if headers.get("content-type") != "application/json":
            await self._write(writer, 415, b'{"error":"invalid_request"}', "application/json")
            return
        value = self._json(body)
        if (
            not _exact_strings(value, ["commitId", "text"])
            or not _runtime_value(value["commitId"])
            or not value["text"]
            or "\0" in value["text"]
            or len(value["text"].encode()) > 48 * 1024
        ):
            await self._write(writer, 400, b'{"error":"invalid_request"}', "application/json")
            return
        if self.session["used"]:
            await self._write(writer, 409, b'{"error":"turn_limit_reached"}', "application/json")
            return
        self.session["used"] = True
        turn_id = str(uuid.uuid4())
        response_id = str(uuid.uuid4())
        try:
            async with self.runtime.lock:
                native = await asyncio.wait_for(
                    self.runtime.rpc(
                        "agent",
                        {
                            "agentId": _selected_agent(self.runtime),
                            "sessionKey": self.session["sessionKey"],
                            "message": value["text"],
                            "idempotencyKey": turn_id,
                            "deliver": False,
                            "timeout": TURN_TIMEOUT_SECONDS,
                        },
                        timeout=TURN_TIMEOUT_SECONDS + 20,
                    ),
                    TURN_TIMEOUT_SECONDS + 25,
                )
            payloads = native.get("result", {}).get("payloads", [])
            if (
                native.get("status") != "ok"
                or native.get("result", {}).get("meta", {}).get("aborted")
                or native.get("result", {}).get("meta", {}).get("error")
                or not isinstance(payloads, list)
                or any(not isinstance(item, dict) or item.get("isError") for item in payloads)
            ):
                raise RuntimeError("agent failed")
            text = "\n".join(item["text"] for item in payloads if isinstance(item.get("text"), str))
            if not text or len(text.encode()) > MAX_RESPONSE_BYTES:
                raise RuntimeError("agent failed")
            events = [
                {
                    "type": "response.started",
                    "voiceSessionId": session_id,
                    "turnId": turn_id,
                    "responseId": response_id,
                },
                {
                    "type": "response.text.delta",
                    "voiceSessionId": session_id,
                    "turnId": turn_id,
                    "responseId": response_id,
                    "sequence": 0,
                    "text": text,
                },
                {
                    "type": "response.completed",
                    "voiceSessionId": session_id,
                    "turnId": turn_id,
                    "responseId": response_id,
                },
            ]
        except Exception:
            events = [
                {
                    "type": "response.failed",
                    "voiceSessionId": session_id,
                    "turnId": turn_id,
                    "responseId": response_id,
                    "reason": "agent_gateway_unavailable",
                }
            ]
        encoded = b"".join(
            json.dumps(event, separators=(",", ":")).encode() + b"\n" for event in events
        )
        await self._write(writer, 200, encoded, "application/x-ndjson")


__all__ = ["AgentIngress", "GRANT_PATH", "GrantError", "load_grant"]
