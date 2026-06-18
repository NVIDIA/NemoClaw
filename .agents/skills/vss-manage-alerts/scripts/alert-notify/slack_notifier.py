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

"""Slack notification backend. See :class:`SlackNotifier`."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from datetime import datetime
from typing import Any

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from incident_utils import VERDICT_EMOJI, VERDICT_LABEL, safe_get, humanize_category, build_test_incident
from notifier_base import NotifierBase, NotifierResult

logger = logging.getLogger("alert-notify.slack")

_MRKDWN_MAX_LEN = 3000

_VERDICT_COLOR = {
    "confirmed": "#e01e5a",
    "rejected": "#2eb67d",
    "verification-failed": "#ecb22e",
    "not-confirmed": "#dddddd",
}


def _truncate_mrkdwn(text: str, max_len: int = _MRKDWN_MAX_LEN) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 4] + " \u2026"


def _format_timestamp(ts: str | None) -> str:
    if not ts or ts == "N/A":
        return "N/A"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        epoch = int(dt.timestamp())
        return f"<!date^{epoch}^{{date_long_pretty}} {{time_secs}}|{dt.strftime('%Y-%m-%d %H:%M:%S UTC')}>"
    except (ValueError, TypeError):
        return ts


def build_slack_blocks(incident: dict) -> tuple[list[dict], str, str]:
    """Build Slack Block Kit blocks from an incident payload.

    Returns (blocks, fallback_text, color).
    """
    verdict = str(safe_get(incident, "info", "verdict", default="unknown")).lower()
    category_raw = str(safe_get(incident, "category", default="unknown"))
    sensor_id = str(safe_get(incident, "sensorId", default="N/A"))
    place_name = str(safe_get(incident, "place", "name", default="N/A"))
    timestamp = str(safe_get(incident, "timestamp", default="N/A"))
    reasoning = str(safe_get(incident, "info", "reasoning", default="N/A"))
    video_url = str(safe_get(incident, "info", "videoSource", default="N/A"))
    prompt = str(safe_get(incident, "info", "prompt", default="N/A"))

    verdict_emoji = VERDICT_EMOJI.get(verdict, "\u2753")
    verdict_label = VERDICT_LABEL.get(verdict, verdict.upper())
    category_label = humanize_category(category_raw)
    formatted_ts = _format_timestamp(timestamp)
    color = _VERDICT_COLOR.get(verdict, "#dddddd")

    blocks: list[dict] = [
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Verdict:*\n{verdict_emoji} `{verdict_label}`"},
                {"type": "mrkdwn", "text": f"*Category:*\n`{category_label}`"},
            ],
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Sensor ID:*\n`{sensor_id}`"},
                {"type": "mrkdwn", "text": f"*Place:*\n{place_name}"},
                {"type": "mrkdwn", "text": f"*Timestamp:*\n{formatted_ts}"},
            ],
        },
        {"type": "divider"},
    ]

    if reasoning and reasoning != "N/A":
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": _truncate_mrkdwn(f"*\U0001f9e0 VLM Reasoning:*\n> {reasoning}"),
            },
        })

    if prompt and prompt != "N/A":
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": _truncate_mrkdwn(f"*\U0001f50d Detection Prompt:*\n> _{prompt}_"),
            },
        })

    if video_url and video_url != "N/A":
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*\U0001f3ac Video Evidence:*\n<{video_url}|View Video Clip>",
            },
        })

    fallback_text = f"\u26a0\ufe0f {category_label} - {verdict_label} at {place_name}"
    return blocks, fallback_text, color


class SlackNotifier(NotifierBase):
    """Posts incident notifications to a Slack channel via the Slack Web API."""

    name = "slack"

    def __init__(self) -> None:
        self._token: str | None = None
        self._channel: str | None = None
        self._client: WebClient | None = None
        self._sent_count: int = 0
        self._last_error: str | None = None

    async def init(self) -> None:
        self._token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
        self._channel = os.environ.get("SLACK_CHANNEL_ID", "").strip()

        missing = [
            name for name, value in (
                ("SLACK_BOT_TOKEN", self._token),
                ("SLACK_CHANNEL_ID", self._channel),
            ) if not value
        ]
        if missing:
            raise RuntimeError(
                f"Slack backend missing required env vars: {', '.join(missing)}"
            )

        loop = asyncio.get_running_loop()
        try:
            client = WebClient(token=self._token)
            response = await loop.run_in_executor(None, client.auth_test)
            logger.info(
                "Slack auth OK - bot: %s, team: %s",
                response["user"], response["team"],
            )
            self._client = client
        except SlackApiError as exc:
            error = exc.response["error"]
            raise RuntimeError(f"Slack auth failed: {error}") from exc

    async def _post(self, blocks: list[dict], fallback_text: str, color: str) -> dict:
        if not self._client:
            raise RuntimeError("Slack client not initialized")
        loop = asyncio.get_running_loop()
        call = functools.partial(
            self._client.chat_postMessage,
            channel=self._channel,
            text=fallback_text,
            attachments=[{"color": color, "blocks": blocks}],
        )
        return await loop.run_in_executor(None, call)

    async def send(self, incident: dict) -> NotifierResult:
        try:
            blocks, fallback_text, color = build_slack_blocks(incident)
        except Exception as exc:
            self._last_error = f"Format error: {exc}"
            logger.exception("Failed to build Slack message")
            return NotifierResult(
                backend=self.name, success=False, error=self._last_error,
            )

        try:
            response = await self._post(blocks, fallback_text, color)
            self._sent_count += 1
            self._last_error = None
            logger.info(
                "Slack notification sent: channel=%s, ts=%s",
                self._channel, response.get("ts", "?"),
            )
            return NotifierResult(
                backend=self.name,
                success=True,
                detail={
                    "slack_ts": response.get("ts"),
                    "channel": self._channel,
                },
            )
        except SlackApiError as exc:
            error = f"Slack API: {exc.response['error']}"
            self._last_error = error
            logger.error("Slack API error: %s", exc.response["error"])
            return NotifierResult(backend=self.name, success=False, error=error)
        except Exception as exc:
            error = f"Send error: {exc}"
            self._last_error = error
            logger.exception("Failed to send Slack notification")
            return NotifierResult(backend=self.name, success=False, error=error)

    async def send_test(self) -> NotifierResult:
        return await self.send(build_test_incident())

    async def close(self) -> None:
        self._client = None

    def status_info(self) -> dict[str, Any]:
        return {
            "connected": self._client is not None,
            "channel_id": self._channel,
            "sent": self._sent_count,
            "last_error": self._last_error,
        }
