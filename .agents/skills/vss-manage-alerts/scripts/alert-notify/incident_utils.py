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

"""Shared incident helpers used by all notification backends."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

VERDICT_EMOJI: dict[str, str] = {
    "confirmed": "\u2705",
    "rejected": "\u274c",
    "verification-failed": "\u26a0\ufe0f",
    "not-confirmed": "\U0001f6ab",
}

VERDICT_LABEL: dict[str, str] = {
    "confirmed": "Confirmed",
    "rejected": "Rejected",
    "verification-failed": "Verification Failed",
    "not-confirmed": "Not Confirmed",
}


def safe_get(data: Any, *keys: str | int, default: Any = None) -> Any:
    """Safely traverse nested dicts/lists, returning *default* on any miss."""
    current = data
    for key in keys:
        try:
            current = current[key] if not isinstance(current, dict) else current.get(key)
        except (KeyError, IndexError, TypeError):
            return default
        if current is None:
            return default
    return current


def humanize_category(raw: str) -> str:
    """``"ppe_violation"`` → ``"Ppe Violation"``."""
    return raw.replace("_", " ").title()


def build_test_incident() -> dict:
    """Synthetic incident for end-to-end wiring tests."""
    return {
        "place": {"name": "Test Location", "type": "test"},
        "category": "test_notification",
        "sensorId": "test-sensor-000",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "info": {
            "verdict": "confirmed",
            "reasoning": "This is a test notification to verify integration is working correctly.",
            "videoSource": "https://example.com/test-video.mp4",
            "prompt": "test notification",
        },
    }
