#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Sandbox-local Discord REST/Gateway facade for Hermes.

Hermes still starts discord.py with the OpenShell placeholder token.  The
sitecustomize preload rewrites discord.py's Discord REST and Gateway transports
to this loopback service.  The facade accepts the placeholder on the local
Gateway, forwards non-emulated REST requests through DISCORD_PROXY, and accepts
Discord outgoing interaction webhooks for injection as Gateway dispatches.
"""

from __future__ import annotations

import asyncio
import binascii
import contextlib
import copy
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlencode

try:
    from aiohttp import ClientSession, WSMsgType, web
except Exception as exc:  # pragma: no cover - exercised in the sandbox image
    print(f"[discord-facade] aiohttp is required: {exc}", file=sys.stderr)
    sys.exit(1)


LOGGER = logging.getLogger("nemoclaw.discord_facade")

DEFAULT_TOKEN_PLACEHOLDER = "openshell:resolve:env:DISCORD_BOT_TOKEN"
DEFAULT_LISTEN_HOST = "127.0.0.1"
DEFAULT_LISTEN_PORT = 3130
DISCORD_API_ORIGIN = "https://discord.com"
INTERACTION_TOKEN_TTL_SECONDS = 15 * 60
MAX_INTERACTION_TOKENS = 1024
APPLICATION_COMMANDS_RE = re.compile(r"^/api/v\d+/applications/(\d+)/commands/?$")
APPLICATION_COMMAND_RE = re.compile(r"^/api/v\d+/applications/(\d+)/commands/(\d+)/?$")
INTERACTION_CALLBACK_RE = re.compile(r"^/api/v\d+/interactions/(\d+)/([^/]+)/callback/?$")
WEBHOOK_TOKEN_RE = re.compile(r"^/api/v\d+/webhooks/(\d+)/([^/]+)(/.*)?$")


@dataclass(eq=False)
class GatewayPeer:
    ws: web.WebSocketResponse
    session_id: str = field(default_factory=lambda: secrets.token_hex(16))
    sequence: int = 0
    identified: bool = False


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid %s=%r", name, raw)
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid %s=%r", name, raw)
        return default


def _json_response(data: Any, status: int = 200) -> web.Response:
    body = json.dumps(data, separators=(",", ":")).encode("utf-8")
    return web.Response(
        body=body, status=status, content_type="application/json"
    )


def _csv_env(*names: str) -> list[str]:
    values: list[str] = []
    for name in names:
        raw = os.getenv(name, "")
        for item in raw.split(","):
            cleaned = item.strip()
            if cleaned:
                values.append(cleaned)
    return values


def _redact_path(path: str) -> str:
    match = WEBHOOK_TOKEN_RE.match(path)
    if match:
        suffix = match.group(3) or ""
        return f"/api/v10/webhooks/{match.group(1)}/<interaction-token>{suffix}"
    match = INTERACTION_CALLBACK_RE.match(path)
    if match:
        return f"/api/v10/interactions/{match.group(1)}/<interaction-token>/callback"
    return path


class DiscordFacade:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        placeholder_token: str,
        upstream_proxy: str | None,
        public_base_url: str | None,
        public_key: str | None,
    ) -> None:
        self.host = host
        self.port = port
        self.placeholder_token = placeholder_token
        self.upstream_proxy = upstream_proxy
        self.public_base_url = public_base_url
        self.public_key = public_key
        self.application_id = os.getenv("NEMOCLAW_DISCORD_APPLICATION_ID", "313700000000000001")
        self.bot_user_id = os.getenv("NEMOCLAW_DISCORD_BOT_USER_ID", "313700000000000002")
        self.bot_username = os.getenv("NEMOCLAW_DISCORD_BOT_USERNAME", "Hermes")
        self.synthetic_reaction_user_id = os.getenv(
            "NEMOCLAW_DISCORD_REACTION_USER_ID",
            "313700000000000003",
        )
        self._peers: set[GatewayPeer] = set()
        self._interaction_tokens: dict[str, tuple[str, float]] = {}
        self._session: ClientSession | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._poll_interval = _env_float("NEMOCLAW_DISCORD_POLL_INTERVAL_SECONDS", 10)
        self._poll_channel_ids = set(_csv_env("NEMOCLAW_DISCORD_POLL_CHANNEL_IDS"))
        self._poll_guild_ids = set(
            _csv_env("NEMOCLAW_DISCORD_POLL_GUILD_IDS", "NEMOCLAW_DISCORD_GUILD_IDS")
        )
        self._poll_discovered_channels: set[str] = set()
        self._message_cache: dict[str, dict[str, Any]] = {}
        self._channel_message_ids: dict[str, set[str]] = {}
        self._thread_cache: dict[str, dict[str, Any]] = {}
        self._poll_warning_keys: set[str] = set()
        self._command_counter = 313700000000010000
        self._commands: dict[str, dict[str, Any]] = {}

    @property
    def gateway_url(self) -> str:
        return f"ws://{self.host}:{self.port}/gateway"

    async def start(self) -> web.AppRunner:
        self._session = ClientSession()
        app = web.Application(client_max_size=2 * 1024 * 1024)
        app.add_routes(
            [
                web.get("/gateway", self.handle_gateway),
                web.post("/interactions", self.handle_interaction),
                web.get("/health", self.handle_health),
                web.route("*", "/api/{tail:.*}", self.handle_rest),
            ]
        )
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()
        LOGGER.info("Discord facade listening on http://%s:%s", self.host, self.port)
        self._start_polling()
        return runner

    async def start_public_interactions(self, host: str, port: int) -> web.AppRunner:
        app = web.Application(client_max_size=2 * 1024 * 1024)
        app.add_routes([web.post("/interactions", self.handle_interaction)])
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()
        LOGGER.info("Discord public interactions listener on http://%s:%s", host, port)
        return runner

    async def close(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def handle_health(self, _request: web.Request) -> web.Response:
        return _json_response({"ok": True, "peers": len(self._peers)})

    async def handle_gateway(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=None, compress=False)
        await ws.prepare(request)
        peer = GatewayPeer(ws=ws)
        self._peers.add(peer)
        LOGGER.info("Discord facade Gateway client connected")
        try:
            await self._send_gateway(peer, op=10, data={"heartbeat_interval": 41250})
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    payload = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws.close(code=4002, message=b"invalid payload")
                    break
                await self._handle_gateway_payload(peer, payload)
        finally:
            self._peers.discard(peer)
            LOGGER.info("Discord facade Gateway client disconnected")
        return ws

    async def _handle_gateway_payload(self, peer: GatewayPeer, payload: dict[str, Any]) -> None:
        op = payload.get("op")
        if op == 1:
            await self._send_gateway(peer, op=11, data=None)
            return
        if op == 2:
            token = str((payload.get("d") or {}).get("token") or "")
            if token != self.placeholder_token:
                LOGGER.error(
                    "Rejecting Discord Gateway IDENTIFY that did not use the OpenShell placeholder"
                )
                await peer.ws.close(code=4004, message=b"authentication failed")
                return
            peer.identified = True
            await self._dispatch_ready(peer)
            return
        if op == 6:
            token = str((payload.get("d") or {}).get("token") or "")
            if token != self.placeholder_token:
                await peer.ws.close(code=4004, message=b"authentication failed")
                return
            peer.identified = True
            await self._dispatch(peer, "RESUMED", {"_trace": ["nemoclaw-discord-facade"]})
            return
        if op in (3, 4):
            return
        LOGGER.debug("Ignoring Discord Gateway opcode %r at facade boundary", op)

    async def _dispatch_ready(self, peer: GatewayPeer) -> None:
        await self._dispatch(
            peer,
            "READY",
            {
                "v": 10,
                "session_id": peer.session_id,
                "resume_gateway_url": self.gateway_url,
                "user": self._bot_user(),
                "application": {
                    "id": self.application_id,
                    "flags": 0,
                },
                "guilds": [],
                "private_channels": [],
                "relationships": [],
                "shard": [0, 1],
                "_trace": ["nemoclaw-discord-facade"],
            },
        )

    def _bot_user(self) -> dict[str, Any]:
        return {
            "id": self.bot_user_id,
            "username": self.bot_username,
            "global_name": self.bot_username,
            "discriminator": "0000",
            "avatar": None,
            "bot": True,
            "system": False,
            "mfa_enabled": False,
            "verified": True,
            "email": None,
            "flags": 0,
            "premium_type": 0,
            "public_flags": 0,
        }

    async def _send_gateway(
        self,
        peer: GatewayPeer,
        *,
        op: int,
        data: Any,
        event_type: str | None = None,
    ) -> None:
        payload = {"op": op, "d": data, "s": peer.sequence if event_type else None, "t": event_type}
        await peer.ws.send_str(json.dumps(payload, separators=(",", ":")))

    async def _dispatch(self, peer: GatewayPeer, event_type: str, data: Any) -> None:
        peer.sequence += 1
        await self._send_gateway(peer, op=0, data=data, event_type=event_type)

    async def dispatch_to_all(self, event_type: str, data: dict[str, Any]) -> None:
        peers = [peer for peer in self._peers if peer.identified and not peer.ws.closed]
        for peer in peers:
            await self._dispatch(peer, event_type, data)

    def _start_polling(self) -> None:
        if self._poll_interval <= 0:
            return
        if not self._poll_channel_ids and not self._poll_guild_ids:
            return
        self._poll_task = asyncio.create_task(self._poll_loop())
        LOGGER.info(
            "Discord facade REST poller enabled (guilds=%d channels=%d interval=%ss)",
            len(self._poll_guild_ids),
            len(self._poll_channel_ids),
            self._poll_interval,
        )

    async def _poll_loop(self) -> None:
        while True:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOGGER.warning("Discord REST polling failed: %s", exc)
            await asyncio.sleep(self._poll_interval)

    async def _poll_once(self) -> None:
        await self._refresh_poll_targets()
        for channel_id in sorted(self._poll_channel_ids | self._poll_discovered_channels):
            await self._poll_channel_messages(channel_id)
        for guild_id in sorted(self._poll_guild_ids):
            await self._poll_guild_threads(guild_id)

    async def _refresh_poll_targets(self) -> None:
        if not self._poll_guild_ids:
            return
        discovered: set[str] = set()
        for guild_id in sorted(self._poll_guild_ids):
            channels = await self._discord_json("GET", f"/api/v10/guilds/{guild_id}/channels")
            if not isinstance(channels, list):
                continue
            for channel in channels:
                if not isinstance(channel, dict):
                    continue
                channel_type = int(channel.get("type", -1))
                if channel_type in {0, 5}:
                    channel_id = str(channel.get("id") or "")
                    if channel_id:
                        discovered.add(channel_id)
        self._poll_discovered_channels = discovered

    async def _poll_channel_messages(self, channel_id: str) -> None:
        messages = await self._discord_json(
            "GET",
            f"/api/v10/channels/{channel_id}/messages?limit=25",
        )
        if not isinstance(messages, list):
            return
        current_ids: set[str] = set()
        for raw in reversed(messages):
            if not isinstance(raw, dict):
                continue
            message = self._normalize_message(raw, channel_id)
            message_id = str(message.get("id") or "")
            if not message_id:
                continue
            current_ids.add(message_id)
            previous = self._message_cache.get(message_id)
            if previous is None:
                self._message_cache[message_id] = message
                await self.dispatch_to_all("MESSAGE_CREATE", self._strip_internal_fields(message))
                continue
            reactions_changed = previous.get("_nemoclaw_reactions") != message.get("_nemoclaw_reactions")
            if self._message_changed(previous, message):
                self._message_cache[message_id] = message
                await self.dispatch_to_all("MESSAGE_UPDATE", self._strip_internal_fields(message))
            await self._dispatch_reaction_deltas(previous, message)
            if reactions_changed:
                self._message_cache[message_id] = message

        previous_ids = self._channel_message_ids.get(channel_id, set())
        if len(messages) < 25:
            for deleted_id in sorted(previous_ids - current_ids):
                deleted = self._message_cache.pop(deleted_id, {})
                payload = {
                    "id": deleted_id,
                    "channel_id": channel_id,
                }
                if deleted.get("guild_id"):
                    payload["guild_id"] = deleted["guild_id"]
                await self.dispatch_to_all("MESSAGE_DELETE", payload)
        self._channel_message_ids[channel_id] = current_ids

    async def _poll_guild_threads(self, guild_id: str) -> None:
        payload = await self._discord_json("GET", f"/api/v10/guilds/{guild_id}/threads/active")
        if not isinstance(payload, dict):
            return
        threads = payload.get("threads")
        if not isinstance(threads, list):
            return
        current_ids: set[str] = set()
        for raw in threads:
            if not isinstance(raw, dict):
                continue
            thread = dict(raw)
            thread_id = str(thread.get("id") or "")
            if not thread_id:
                continue
            current_ids.add(thread_id)
            self._poll_discovered_channels.add(thread_id)
            previous = self._thread_cache.get(thread_id)
            if previous is None:
                self._thread_cache[thread_id] = thread
                await self.dispatch_to_all("THREAD_CREATE", thread)
            elif previous != thread:
                self._thread_cache[thread_id] = thread
                await self.dispatch_to_all("THREAD_UPDATE", thread)

        for thread_id in sorted(set(self._thread_cache) - current_ids):
            old = self._thread_cache.get(thread_id, {})
            if str(old.get("guild_id") or "") != guild_id:
                continue
            self._thread_cache.pop(thread_id, None)
            await self.dispatch_to_all(
                "THREAD_DELETE",
                {
                    "id": thread_id,
                    "guild_id": guild_id,
                    "parent_id": old.get("parent_id"),
                    "type": old.get("type", 11),
                },
            )

    def _normalize_message(self, raw: dict[str, Any], channel_id: str) -> dict[str, Any]:
        message = dict(raw)
        message.setdefault("channel_id", channel_id)
        message.setdefault("type", 0)
        message.setdefault("content", "")
        message.setdefault("mentions", [])
        message.setdefault("mention_roles", [])
        message.setdefault("mention_everyone", False)
        message.setdefault("attachments", [])
        message.setdefault("embeds", [])
        message.setdefault("pinned", False)
        message.setdefault("tts", False)
        message["_nemoclaw_reactions"] = self._reaction_counts(message)
        return message

    @staticmethod
    def _message_changed(previous: dict[str, Any], current: dict[str, Any]) -> bool:
        keys = {"content", "edited_timestamp", "pinned", "attachments", "embeds", "flags"}
        return any(previous.get(key) != current.get(key) for key in keys)

    @staticmethod
    def _strip_internal_fields(message: dict[str, Any]) -> dict[str, Any]:
        public = dict(message)
        public.pop("_nemoclaw_reactions", None)
        return public

    @staticmethod
    def _reaction_counts(message: dict[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
        counts: dict[str, tuple[int, dict[str, Any]]] = {}
        for reaction in message.get("reactions", []) or []:
            if not isinstance(reaction, dict):
                continue
            emoji = reaction.get("emoji") if isinstance(reaction.get("emoji"), dict) else {}
            emoji_key = str(emoji.get("id") or emoji.get("name") or "")
            if not emoji_key:
                continue
            counts[emoji_key] = (int(reaction.get("count") or 0), emoji)
        return counts

    async def _dispatch_reaction_deltas(
        self,
        previous: dict[str, Any],
        current: dict[str, Any],
    ) -> None:
        old_counts = previous.get("_nemoclaw_reactions", {})
        new_counts = current.get("_nemoclaw_reactions", {})
        for emoji_key, (new_count, emoji) in new_counts.items():
            old_count = old_counts.get(emoji_key, (0, emoji))[0]
            if new_count == old_count:
                continue
            event_type = "MESSAGE_REACTION_ADD" if new_count > old_count else "MESSAGE_REACTION_REMOVE"
            payload = {
                "user_id": self.synthetic_reaction_user_id,
                "channel_id": current.get("channel_id"),
                "message_id": current.get("id"),
                "emoji": emoji,
            }
            if current.get("guild_id"):
                payload["guild_id"] = current["guild_id"]
            await self.dispatch_to_all(event_type, payload)

    async def _discord_json(self, method: str, path: str) -> Any:
        if self._session is None:
            return None
        headers = {
            "Authorization": f"Bot {self.placeholder_token}",
            "User-Agent": "NemoClawDiscordFacade/1.0",
        }
        try:
            async with self._session.request(
                method,
                f"{DISCORD_API_ORIGIN}{path}",
                headers=headers,
                proxy=self.upstream_proxy,
                allow_redirects=False,
            ) as response:
                if response.status >= 400:
                    key = f"{method} {path.split('?')[0]} {response.status}"
                    if key not in self._poll_warning_keys:
                        self._poll_warning_keys.add(key)
                        LOGGER.warning("Discord REST poll returned HTTP %s for %s", response.status, path.split("?")[0])
                    return None
                body = await response.read()
        except Exception as exc:
            key = f"{method} {path.split('?')[0]} error"
            if key not in self._poll_warning_keys:
                self._poll_warning_keys.add(key)
                LOGGER.warning("Discord REST poll failed for %s: %s", path.split("?")[0], exc)
            return None
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    async def handle_rest(self, request: web.Request) -> web.Response:
        path = request.path
        method = request.method.upper()
        if method == "GET" and re.fullmatch(r"/api/v\d+/gateway(?:/bot)?", path):
            return _json_response(
                {
                    "url": self.gateway_url,
                    "shards": 1,
                    "session_start_limit": {
                        "total": 1000,
                        "remaining": 1000,
                        "reset_after": 0,
                        "max_concurrency": 1,
                    },
                }
            )
        if method == "GET" and path in ("/api/v10/users/@me", "/api/v9/users/@me"):
            return _json_response(self._bot_user())
        if method == "GET" and path in (
            "/api/v10/oauth2/applications/@me",
            "/api/v9/oauth2/applications/@me",
            "/api/v10/applications/@me",
            "/api/v9/applications/@me",
        ):
            return _json_response(self._application_payload())
        if method == "GET" and path.endswith("/users/@me/guilds"):
            return _json_response([])
        if match := APPLICATION_COMMANDS_RE.match(path):
            return await self._handle_application_commands(request, match.group(1))
        if match := APPLICATION_COMMAND_RE.match(path):
            return await self._handle_application_command(request, match.group(1), match.group(2))
        if match := INTERACTION_CALLBACK_RE.match(path):
            return await self._handle_interaction_callback(request, match.group(1), match.group(2))
        if match := WEBHOOK_TOKEN_RE.match(path):
            return await self._forward_with_interaction_token(request, match)
        return await self._forward_rest(request)

    def _application_payload(self) -> dict[str, Any]:
        return {
            "id": self.application_id,
            "name": "Hermes",
            "icon": None,
            "description": "Hermes Discord facade",
            "bot_public": False,
            "bot_require_code_grant": False,
            "flags": 0,
            "verify_key": self.public_key or "",
            "owner": self._bot_user(),
        }

    async def _handle_application_commands(self, request: web.Request, app_id: str) -> web.Response:
        method = request.method.upper()
        if method == "GET":
            return _json_response(list(self._commands.values()))
        if method == "PUT":
            payload = await self._read_json(request)
            commands = payload if isinstance(payload, list) else []
            self._commands.clear()
            for command in commands:
                stored = self._store_command(app_id, command)
                self._commands[stored["id"]] = stored
            return _json_response(list(self._commands.values()))
        if method == "POST":
            payload = await self._read_json(request)
            stored = self._store_command(app_id, payload if isinstance(payload, dict) else {})
            self._commands[stored["id"]] = stored
            return _json_response(stored, status=201)
        return _json_response({"message": "method not allowed"}, status=405)

    async def _handle_application_command(
        self,
        request: web.Request,
        app_id: str,
        command_id: str,
    ) -> web.Response:
        method = request.method.upper()
        if method == "PATCH":
            payload = await self._read_json(request)
            current = self._commands.get(command_id, {"id": command_id, "application_id": app_id})
            current.update(payload if isinstance(payload, dict) else {})
            current.setdefault("version", str(int(current["id"]) + 1))
            self._commands[command_id] = current
            return _json_response(current)
        if method == "DELETE":
            self._commands.pop(command_id, None)
            return web.Response(status=204)
        return await self._forward_rest(request)

    def _store_command(self, app_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._command_counter += 1
        command_id = str(self._command_counter)
        stored = dict(payload)
        stored.setdefault("type", 1)
        stored.setdefault("name", f"command-{command_id}")
        stored.setdefault("description", "")
        stored.setdefault("options", [])
        stored.update(
            {
                "id": command_id,
                "application_id": app_id,
                "version": str(self._command_counter + 1),
            }
        )
        return stored

    async def _handle_interaction_callback(
        self,
        request: web.Request,
        interaction_id: str,
        local_token: str,
    ) -> web.Response:
        real_token = self._resolve_interaction_token(local_token)
        if real_token is not None:
            path = f"/api/v10/interactions/{interaction_id}/{real_token}/callback"
            return await self._forward_rest(request, override_path=path)
        return await self._forward_rest(request)

    async def _forward_with_interaction_token(
        self,
        request: web.Request,
        match: re.Match[str],
    ) -> web.Response:
        local_token = match.group(2)
        real_token = self._resolve_interaction_token(local_token)
        if real_token is None:
            return await self._forward_rest(request)
        suffix = match.group(3) or ""
        path = f"/api/v10/webhooks/{match.group(1)}/{real_token}{suffix}"
        return await self._forward_rest(request, override_path=path)

    async def handle_interaction(self, request: web.Request) -> web.Response:
        body = await self._read_bytes(request)
        if not self._verify_signature(request, body):
            return _json_response({"error": "invalid signature"}, status=401)
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return _json_response({"error": "invalid json"}, status=400)
        if payload.get("type") == 1:
            return _json_response({"type": 1})

        local_payload = self._localize_interaction_token(payload)
        await self.dispatch_to_all("INTERACTION_CREATE", local_payload)
        return _json_response({"type": 5})

    def _localize_interaction_token(self, payload: dict[str, Any]) -> dict[str, Any]:
        copied = copy.deepcopy(payload)
        token = str(copied.get("token") or "")
        if token:
            local_token = f"nemoclaw-local-{secrets.token_urlsafe(24)}"
            self._store_interaction_token(local_token, token)
            copied["token"] = local_token
        return copied

    def _store_interaction_token(self, local_token: str, real_token: str) -> None:
        self._prune_interaction_tokens()
        self._interaction_tokens[local_token] = (
            real_token,
            time.monotonic() + INTERACTION_TOKEN_TTL_SECONDS,
        )
        self._prune_interaction_tokens()

    def _resolve_interaction_token(self, local_token: str) -> str | None:
        self._prune_interaction_tokens()
        entry = self._interaction_tokens.get(local_token)
        if entry is None:
            return None
        return entry[0]

    def _prune_interaction_tokens(self) -> None:
        now = time.monotonic()
        for local_token, (_real_token, expires_at) in list(self._interaction_tokens.items()):
            if expires_at <= now:
                self._interaction_tokens.pop(local_token, None)
        overflow = len(self._interaction_tokens) - MAX_INTERACTION_TOKENS
        if overflow > 0:
            oldest = sorted(self._interaction_tokens.items(), key=lambda item: item[1][1])
            for local_token, _entry in oldest[:overflow]:
                self._interaction_tokens.pop(local_token, None)

    def _verify_signature(self, request: web.Request, body: bytes) -> bool:
        public_key = (self.public_key or "").strip()
        if not public_key:
            LOGGER.warning("Discord interaction rejected: DISCORD_PUBLIC_KEY is not configured")
            return False
        signature_hex = request.headers.get("X-Signature-Ed25519", "")
        timestamp = request.headers.get("X-Signature-Timestamp", "")
        try:
            signature = binascii.unhexlify(signature_hex)
            verify_key = binascii.unhexlify(public_key)
        except (binascii.Error, ValueError):
            return False
        message = timestamp.encode("utf-8") + body
        try:
            from nacl.signing import VerifyKey

            VerifyKey(verify_key).verify(message, signature)
            return True
        except ImportError:
            pass
        except Exception:
            return False
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

            Ed25519PublicKey.from_public_bytes(verify_key).verify(signature, message)
            return True
        except Exception:
            return False

    async def _forward_rest(
        self,
        request: web.Request,
        *,
        override_path: str | None = None,
    ) -> web.Response:
        if self._session is None:
            return _json_response({"message": "facade session unavailable"}, status=503)
        path = override_path or request.path_qs
        if override_path and request.query_string:
            separator = "&" if "?" in path else "?"
            path = f"{path}{separator}{request.query_string}"
        target = f"{DISCORD_API_ORIGIN}{path}"
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "accept-encoding"}
        }
        body = await self._read_bytes(request)
        LOGGER.debug("Forwarding Discord REST %s %s", request.method, _redact_path(path))
        try:
            async with self._session.request(
                request.method,
                target,
                headers=headers,
                data=body if body else None,
                proxy=self.upstream_proxy,
                allow_redirects=False,
            ) as response:
                response_body = await response.read()
                response_headers = {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower()
                    not in {
                        "content-encoding",
                        "content-length",
                        "transfer-encoding",
                        "connection",
                    }
                }
                return web.Response(
                    status=response.status,
                    body=response_body,
                    headers=response_headers,
                )
        except Exception as exc:
            LOGGER.warning(
                "Discord REST forward failed for %s %s: %s",
                request.method,
                _redact_path(path),
                exc,
            )
            return _json_response({"message": "discord rest forward failed"}, status=502)

    async def _read_json(self, request: web.Request) -> Any:
        body = await self._read_bytes(request)
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    async def _read_bytes(self, request: web.Request) -> bytes:
        return await request.read()

    async def register_interactions_endpoint(self) -> None:
        endpoint = (self.public_base_url or "").rstrip("/")
        if not endpoint:
            return
        app_id = os.getenv("NEMOCLAW_DISCORD_APPLICATION_ID", "").strip()
        if not app_id:
            LOGGER.warning("Cannot register Discord interactions endpoint without application id")
            return
        path = f"/api/v10/applications/{app_id}"
        payload = {"interactions_endpoint_url": f"{endpoint}/interactions"}
        fake_request = _SyntheticRequest("PATCH", path, payload, self.placeholder_token)
        response = await self._forward_rest(fake_request)  # type: ignore[arg-type]
        if response.status >= 400:
            LOGGER.warning("Discord interactions endpoint registration returned HTTP %s", response.status)
        else:
            LOGGER.info("Registered Discord interactions endpoint URL")


class _SyntheticRequest:
    def __init__(self, method: str, path: str, payload: dict[str, Any], placeholder_token: str) -> None:
        self.method = method
        self.path = path
        self.path_qs = path
        self.query_string = ""
        self.headers = {
            "Authorization": f"Bot {placeholder_token}",
            "Content-Type": "application/json",
            "User-Agent": "NemoClawDiscordFacade/1.0",
        }
        self._body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    async def read(self) -> bytes:
        return self._body


def _tunnel_requested() -> bool:
    return bool(
        os.getenv("NEMOCLAW_DISCORD_TUNNEL_COMMAND", "").strip()
        or os.getenv("NEMOCLAW_DISCORD_ENABLE_TUNNEL", "").strip() == "1"
    )


async def _run_tunnel_command(
    public_url_file: str,
    *,
    local_url: str,
) -> tuple[asyncio.subprocess.Process | None, asyncio.Task[None] | None]:
    command = os.getenv("NEMOCLAW_DISCORD_TUNNEL_COMMAND", "").strip()
    if not command and os.getenv("NEMOCLAW_DISCORD_ENABLE_TUNNEL", "").strip() == "1":
        cloudflared = shutil.which("cloudflared")
        if cloudflared:
            command = f"{shlex.quote(cloudflared)} tunnel --url {shlex.quote(local_url)}"
        else:
            LOGGER.warning("Discord interactions tunnel requested but cloudflared is not installed")
    if not command:
        return None, None
    LOGGER.info("Starting sandbox-owned Discord interactions tunnel command")
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    async def _capture_url() -> None:
        url_re = re.compile(rb"https://[A-Za-z0-9.-]+")
        assert proc.stdout is not None
        async for line in proc.stdout:
            match = url_re.search(line)
            if match:
                url = match.group(0).decode("utf-8").rstrip("/")
                with open(public_url_file, "w", encoding="utf-8") as handle:
                    handle.write(url + "\n")
                LOGGER.info("Discord interactions tunnel URL discovered")

    capture_task = asyncio.create_task(_capture_url())

    def _log_capture_failure(task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            LOGGER.warning("Discord interactions tunnel URL capture failed: %s", exc)

    capture_task.add_done_callback(_log_capture_failure)
    return proc, capture_task


async def main() -> None:
    logging.basicConfig(
        level=os.getenv("NEMOCLAW_DISCORD_FACADE_LOG_LEVEL", "INFO").upper(),
        format="[discord-facade] %(levelname)s: %(message)s",
    )
    host = os.getenv("NEMOCLAW_DISCORD_FACADE_HOST", DEFAULT_LISTEN_HOST)
    port = _env_int("NEMOCLAW_DISCORD_FACADE_PORT", DEFAULT_LISTEN_PORT)
    interactions_host = os.getenv("NEMOCLAW_DISCORD_INTERACTIONS_HOST", DEFAULT_LISTEN_HOST)
    interactions_port = _env_int("NEMOCLAW_DISCORD_INTERACTIONS_PORT", port + 1)
    public_url_file = os.getenv("NEMOCLAW_DISCORD_TUNNEL_URL_FILE", "/tmp/nemoclaw-discord-tunnel-url")
    public_base_url = os.getenv("NEMOCLAW_DISCORD_PUBLIC_URL", "").strip() or None

    facade = DiscordFacade(
        host=host,
        port=port,
        placeholder_token=os.getenv("NEMOCLAW_DISCORD_PLACEHOLDER", DEFAULT_TOKEN_PLACEHOLDER),
        upstream_proxy=os.getenv("DISCORD_PROXY") or os.getenv("HTTPS_PROXY") or None,
        public_base_url=public_base_url,
        public_key=os.getenv("DISCORD_PUBLIC_KEY") or os.getenv("NEMOCLAW_DISCORD_PUBLIC_KEY"),
    )
    runner = await facade.start()
    interactions_runner: web.AppRunner | None = None
    if public_base_url or _tunnel_requested():
        interactions_runner = await facade.start_public_interactions(interactions_host, interactions_port)
    tunnel_proc, tunnel_capture_task = await _run_tunnel_command(
        public_url_file,
        local_url=f"http://{interactions_host}:{interactions_port}",
    )
    if not public_base_url:
        for _ in range(20 if tunnel_proc else 1):
            if os.path.exists(public_url_file):
                with open(public_url_file, "r", encoding="utf-8") as handle:
                    public_base_url = handle.read().strip() or None
                if public_base_url:
                    break
            await asyncio.sleep(0.25)
    if public_base_url:
        facade.public_base_url = public_base_url
        await facade.register_interactions_endpoint()

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)
    await stop_event.wait()
    if interactions_runner is not None:
        await interactions_runner.cleanup()
    await runner.cleanup()
    await facade.close()
    if tunnel_proc and tunnel_proc.returncode is None:
        tunnel_proc.terminate()
        try:
            await asyncio.wait_for(tunnel_proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            tunnel_proc.kill()
    if tunnel_capture_task is not None and not tunnel_capture_task.done():
        tunnel_capture_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await tunnel_capture_task


if __name__ == "__main__":
    asyncio.run(main())
