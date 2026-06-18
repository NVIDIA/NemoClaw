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

"""Notifier base contract shared by Slack, Dashboard, and future backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NotifierResult:
    """Outcome of a single backend delivery attempt."""

    backend: str
    success: bool
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


class NotifierBase(ABC):
    """Abstract notifier. Each delivery backend implements this interface.

    Lifecycle:
        - `init()` is called once during server startup. Use it to validate env
          vars, build clients, and perform a connectivity check.
        - `send(incident)` is called per incident received on the webhook.
        - `send_test()` is called by the `/test` endpoint to verify the wiring.
        - `close()` is called during server shutdown.

    Implementations must be safe to call concurrently from asyncio tasks.
    """

    name: str

    @abstractmethod
    async def init(self) -> None:
        """Validate config and connect to the backend. Raise on fatal errors."""

    @abstractmethod
    async def send(self, incident: dict) -> NotifierResult:
        """Deliver a formatted notification for the given incident payload."""

    @abstractmethod
    async def send_test(self) -> NotifierResult:
        """Deliver a synthetic test notification to verify end-to-end wiring."""

    @abstractmethod
    async def close(self) -> None:
        """Release any resources held by the backend (HTTP clients, etc.)."""

    @abstractmethod
    def status_info(self) -> dict[str, Any]:
        """Return a dict of backend-specific status fields for /status output."""
