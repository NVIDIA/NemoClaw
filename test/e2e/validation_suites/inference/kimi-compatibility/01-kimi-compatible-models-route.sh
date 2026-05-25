#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/inference_routing.sh
. "${SCRIPT_DIR}/../../lib/inference_routing.sh"
e2e_inference_routing_assert_health "post-onboard.kimi-compatibility.models-route-reachable"
