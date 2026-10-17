#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Live HPA watch with normalized GPU % (not kubectl Quantity milliform like 32500m/40).
# Same as: ./scripts/get-hpa.sh -w
# Interval: HPA_WATCH_INTERVAL_SEC (default 2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/get-hpa.sh" -w "$@"
