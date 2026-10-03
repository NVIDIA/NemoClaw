# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The installed Fabric SDK owns validation and native runtime behavior."""

from nemo_fabric import Fabric, FabricConfig, FabricConfigError, FabricError
from pydantic import ValidationError

# No native health API exists at the pinned Fabric revision. Never substitute
# the host's remembered lifecycle state for a native health observation.
HEALTH_CHECKS = ()


class Backend:
    health_checks = HEALTH_CHECKS

    def __init__(self):
        self.fabric = Fabric()

    def validate(self, config, *, base_dir):
        typed = FabricConfig.model_validate(config)
        self.fabric.plan(typed, base_dir=base_dir)
        return typed

    async def start_runtime(self, config, *, base_dir):
        return await self.fabric.start_runtime(config, base_dir=base_dir)

    @staticmethod
    def error_details(error):
        unverified = (
            isinstance(error, FabricConfigError) and error.code == "adapter_capability_unverified"
        )
        invalid = isinstance(error, (FabricConfigError, ValidationError)) and not unverified
        return error.code if isinstance(error, FabricError) else None, invalid, unverified
