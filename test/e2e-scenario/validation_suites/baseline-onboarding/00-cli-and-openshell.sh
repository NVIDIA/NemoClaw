#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/baseline_onboarding.sh
source "$SCRIPT_DIR/../lib/baseline_onboarding.sh"
baseline_onboarding_load_context
baseline_assert_nemoclaw_on_path
baseline_assert_openshell_on_path
baseline_assert_nemoclaw_help_exits_zero
