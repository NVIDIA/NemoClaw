#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/baseline_onboarding.sh
source "$SCRIPT_DIR/../lib/baseline_onboarding.sh"
baseline_onboarding_load_context
baseline_assert_sandbox_list_contains_context_sandbox
baseline_assert_sandbox_status_exits_zero
baseline_assert_logs_produce_output
