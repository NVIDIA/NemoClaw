#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/../lib/rebuild_upgrade.sh"
rebuild_upgrade_assert_sandbox_registry_preserved
rebuild_upgrade_assert_gateway_version_upgraded
rebuild_upgrade_assert_sandbox_reachable
