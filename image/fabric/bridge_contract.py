# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Capabilities shared by the bridge and image catalog."""

INTERFACE_VERSION = 1
OPERATIONS = ("validate", "prepare", "configure", "check", "invoke", "serve")
HEALTH_CHECKS = ()  # The pinned Fabric revision has no runtime health API.
REQUEST_LIMIT = 512 * 1024
RESULT_LIMIT = 4 * 1024 * 1024
SHUTDOWN_SECONDS = 4  # OpenShell allows five seconds before forced termination.
