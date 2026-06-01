#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ ! -f "${E2E_CONTEXT_DIR:-}/onboard.log" ]]; then
  echo "FAIL: onboarding.preflight.passed - onboard log not found"
  exit 1
fi

if grep -Eiq "preflight.*(fail|error)|docker|container|daemon|socket" "${E2E_CONTEXT_DIR}/onboard.log"; then
  echo "FAIL: onboarding.preflight.passed - onboard log contains preflight failure evidence"
  exit 1
fi

echo "PASS: onboarding.preflight.passed"
