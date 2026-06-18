# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""OpenClaw Dashboard notification backend. See :class:`DashboardNotifier` for
connection requirements and behavior."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import websockets

from incident_utils import VERDICT_EMOJI, VERDICT_LABEL, safe_get, humanize_category, build_test_incident
from notifier_base import NotifierBase, NotifierResult

logger = logging.getLogger("alert-notify.dashboard")

SESSION_KEY = "hook:alerts:main"
SESSION_LABEL = "alerts"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _http_url_to_ws_url(url: str) -> str:
    parts = urlsplit(url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urlunsplit((scheme, parts.netloc, parts.path or "/", "", ""))


def _format_timestamp(ts: str | None) -> str:
    if not ts or ts == "N/A":
        return "N/A"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except (ValueError, TypeError):
        return ts


class GatewayRpcError(Exception):
    """Raised when a gateway RPC call returns an error frame."""

    def __init__(self, method: str, error: dict | str):
        self.method = method
        self.error = error
        msg = error.get("message", error) if isinstance(error, dict) else error
        super().__init__(f"{method}: {msg}")


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

def build_dashboard_message(incident: dict) -> str:
    """Build a markdown notification body for OpenClaw chat."""
    verdict = str(safe_get(incident, "info", "verdict", default="unknown")).lower()
    category_raw = str(safe_get(incident, "category", default="unknown"))
    sensor_id = str(safe_get(incident, "sensorId", default="N/A"))
    place_name = str(safe_get(incident, "place", "name", default="N/A"))
    timestamp = str(safe_get(incident, "timestamp", default="N/A"))
    reasoning = str(safe_get(incident, "info", "reasoning", default="N/A"))
    video_url = str(safe_get(incident, "info", "videoSource", default="N/A"))
    prompt = str(safe_get(incident, "info", "prompt", default="N/A"))

    emoji = VERDICT_EMOJI.get(verdict, "\u2753")
    verdict_label = VERDICT_LABEL.get(verdict, verdict.upper())
    category_label = humanize_category(category_raw)
    formatted_ts = _format_timestamp(timestamp)

    lines: list[str] = [
        f"## {emoji} {category_label} - {verdict_label}",
        "",
        "| | |",
        "|---|---|",
        f"| **Sensor** | `{sensor_id}` |",
        f"| **Place** | {place_name} |",
        f"| **Time** | {formatted_ts} |",
        "",
    ]

    if reasoning and reasoning != "N/A":
        lines.append(f"> **\U0001f9e0 VLM Reasoning:** {reasoning}")
        lines.append("")

    if prompt and prompt != "N/A":
        lines.append(f"**\U0001f50d Detection Prompt:** _{prompt}_")
        lines.append("")

    if video_url and video_url != "N/A":
        lines.append(f"[\U0001f3ac View Video Evidence]({video_url})")

    return "\n".join(lines).rstrip()


# ---------------------------------------------------------------------------
# Notifier
# ---------------------------------------------------------------------------

class DashboardNotifier(NotifierBase):
    """Injects incident notifications directly into the OpenClaw Dashboard
    ``alerts`` session via WebSocket RPC (``chat.inject``).

    Connection requirements (all automatically satisfied when running on the
    same host as the gateway):

    * Connect from **localhost** (loopback interface).
    * Provide ``gateway.auth.token`` as ``auth.token`` in the connect frame.
    * Use ``client.id = "gateway-client"`` and ``client.mode = "backend"``.

    Under these conditions the gateway preserves full operator scopes without
    requiring device identity or Ed25519 payload signing.
    """

    name = "dashboard"

    def __init__(self) -> None:
        self._token: str | None = None
        self._ws_url: str | None = None
        self._session_ready: bool = False
        self._sent_count: int = 0
        self._last_error: str | None = None

    # -- lifecycle ----------------------------------------------------------

    async def init(self) -> None:
        self._token = (
            os.environ.get("OPENCLAW_GATEWAY_AUTH_TOKEN", "").strip()
            or os.environ.get("OPENCLAW_HOOKS_TOKEN", "").strip()
        )
        gateway = os.environ.get("OPENCLAW_GATEWAY_URL", "").strip()
        if gateway:
            gateway = gateway.rstrip("/")

        missing = [
            n for n, v in (
                ("OPENCLAW_GATEWAY_AUTH_TOKEN", self._token),
                ("OPENCLAW_GATEWAY_URL", gateway),
            ) if not v
        ]
        if missing:
            raise RuntimeError(
                f"Dashboard backend missing required env vars: {', '.join(missing)}"
            )

        self._ws_url = _http_url_to_ws_url(gateway)
        logger.info(
            "Dashboard WebSocket RPC URL: %s (lazy session bootstrap)",
            self._ws_url,
        )

    async def close(self) -> None:
        self._session_ready = False

    # -- low-level RPC ------------------------------------------------------

    async def _rpc(self, ws, method: str, params: dict, timeout: float = 10.0) -> dict:
        """Send a single RPC request and wait for the matching response."""
        req_id = str(uuid.uuid4())
        frame = {
            "type": "req",
            "id": req_id,
            "method": method,
            "params": params,
        }
        await ws.send(json.dumps(frame))

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise GatewayRpcError(method, "timed out waiting for response")
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if msg.get("id") != req_id:
                continue
            if not msg.get("ok"):
                raise GatewayRpcError(method, msg.get("error", "unknown error"))
            return msg.get("result") or {}

    async def _connect_ws(self):
        """Open a WebSocket, complete the connect handshake, return the ws."""
        ws = await websockets.connect(self._ws_url, open_timeout=10)
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            evt = json.loads(raw)
            if evt.get("event") != "connect.challenge":
                raise GatewayRpcError("connect", f"expected connect.challenge, got {evt.get('event')}")

            connect_res = await self._rpc(ws, "connect", {
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": {
                    "id": "gateway-client",
                    "mode": "backend",
                    "version": "1.0.0",
                    "platform": "linux",
                },
                "auth": {"token": self._token},
                "role": "operator",
                "scopes": ["operator.admin", "operator.read", "operator.write"],
                "caps": [],
            })
            logger.debug("Gateway connect OK: %s", connect_res)
            return ws
        except Exception:
            await ws.close()
            raise

    # -- session management -------------------------------------------------

    async def _ensure_session(self, ws) -> None:
        """Resolve or create the alerts session (lazy, once per lifetime)."""
        if self._session_ready:
            return

        try:
            await self._rpc(ws, "sessions.resolve", {"key": SESSION_KEY})
            logger.info("Session '%s' already exists", SESSION_KEY)
        except GatewayRpcError:
            logger.info("Session '%s' not found, creating...", SESSION_KEY)
            await self._rpc(ws, "sessions.create", {
                "key": SESSION_KEY,
                "label": SESSION_LABEL,
            })
            logger.info("Session '%s' created", SESSION_KEY)

        self._session_ready = True

    # -- inject -------------------------------------------------------------

    async def _inject(self, ws, message: str) -> dict:
        return await self._rpc(ws, "chat.inject", {
            "sessionKey": SESSION_KEY,
            "message": message,
        })

    # -- public interface ---------------------------------------------------

    async def send(self, incident: dict) -> NotifierResult:
        try:
            message = build_dashboard_message(incident)
        except Exception as exc:
            self._last_error = f"Format error: {exc}"
            logger.exception("Failed to build dashboard message")
            return NotifierResult(
                backend=self.name, success=False, error=self._last_error,
            )

        try:
            ws = await self._connect_ws()
            try:
                await self._ensure_session(ws)
                result = await self._inject(ws, message)
            finally:
                await ws.close()

            self._sent_count += 1
            self._last_error = None
            logger.info("Dashboard notification sent: session=%s", SESSION_KEY)
            return NotifierResult(
                backend=self.name,
                success=True,
                detail={"session_key": SESSION_KEY, **result},
            )
        except GatewayRpcError as exc:
            if "session not found" in str(exc).lower():
                self._session_ready = False
            self._last_error = str(exc)
            logger.error("Dashboard RPC error: %s", exc)
            return NotifierResult(backend=self.name, success=False, error=self._last_error)
        except Exception as exc:
            self._last_error = f"Send error: {exc}"
            logger.exception("Failed to send dashboard notification")
            return NotifierResult(backend=self.name, success=False, error=self._last_error)

    async def send_test(self) -> NotifierResult:
        return await self.send(build_test_incident())

    def status_info(self) -> dict[str, Any]:
        return {
            "connected": self._ws_url is not None and self._sent_count > 0 and self._last_error is None,
            "ws_url": self._ws_url,
            "session_key": SESSION_KEY,
            "session_ready": self._session_ready,
            "sent": self._sent_count,
            "last_error": self._last_error,
        }
