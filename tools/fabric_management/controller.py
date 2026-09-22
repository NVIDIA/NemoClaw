# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Experimental Fabric-side management contract, not a deployment implementation.

Uses only Fabric plan/start and Runtime status/stop. It deliberately has no
harness dispatch, provider dependency, persistence, or transport. Unknown
mutation outcomes require outside diagnosis; restarting this object is not
recovery. This experiment is not safe to use as a provider backend.
"""

import asyncio
import hashlib
import json
import uuid


class ManagementError(RuntimeError):
    pass


class Controller:
    def __init__(self, fabric, config_type, *, base_dir):
        self.fabric = fabric
        self.config_type = config_type
        self.base_dir = base_dir
        self.runtime = None
        self.config_digest = None
        self.phase = "empty"
        self.epoch = str(uuid.uuid4())
        self.generation = 0
        self.lock = asyncio.Lock()

    def _snapshot(self):
        status = self.runtime.status if self.runtime is not None else None
        return {
            "contract": "fabric-management-experiment/v0",
            "revision": f"{self.epoch}:{self.generation}",
            "phase": self.phase,
            "runtime_id": self.runtime.runtime_id if self.runtime is not None else None,
            "config_digest": self.config_digest,
            "lifecycle": getattr(status, "value", status),
            # The pinned Runtime.status is local bookkeeping, not a health probe.
            "health": {"supported": False},
        }

    async def observe(self):
        async with self.lock:
            return self._snapshot()

    def _resolve(self, document):
        config = self.config_type.model_validate(document)
        plan = self.fabric.plan(config, base_dir=self.base_dir)
        canonical = plan.config.to_mapping()
        encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return self.config_type.model_validate(canonical), hashlib.sha256(
            encoded.encode()
        ).hexdigest()

    def _known(self):
        if self.phase == "unknown":
            raise ManagementError("outcome_unknown")

    def _action(self, digest):
        self._known()
        if self.runtime is None:
            return "start"
        status = self._snapshot()["lifecycle"]
        if status not in ("active", "stopped", "failed"):
            raise ManagementError("lifecycle_unknown")
        return "none" if status == "active" and digest == self.config_digest else "restart"

    async def plan(self, document):
        async with self.lock:
            _, digest = self._resolve(document)
            return {**self._snapshot(), "desired_digest": digest, "action": self._action(digest)}

    def _conditional_write(self, revision):
        self._known()
        if revision != self._snapshot()["revision"]:
            raise ManagementError("stale_revision")

    async def apply(self, document, *, expected_revision, allow_session_reset=False):
        async with self.lock:
            self._conditional_write(expected_revision)
            config, digest = self._resolve(document)
            action = self._action(digest)
            if action == "none":
                return self._snapshot()
            if action == "restart" and not allow_session_reset:
                raise ManagementError("session_reset_required")
            self.generation += 1
            try:
                if self.runtime is not None and self.runtime.status != "stopped":
                    await self.runtime.stop()
                runtime = await self.fabric.start_runtime(config, base_dir=self.base_dir)
            except BaseException:
                # Cancellation/timeouts may occur after a mutation has taken effect.
                self.phase = "unknown"
                raise
            self.runtime = runtime
            self.config_digest = digest
            self.phase = "bound"
            return self._snapshot()

    async def stop(self, *, expected_revision):
        async with self.lock:
            self._conditional_write(expected_revision)
            if self.runtime is None or self.runtime.status == "stopped":
                return self._snapshot()
            self.generation += 1
            try:
                await self.runtime.stop()
            except BaseException:
                self.phase = "unknown"
                raise
            return self._snapshot()
