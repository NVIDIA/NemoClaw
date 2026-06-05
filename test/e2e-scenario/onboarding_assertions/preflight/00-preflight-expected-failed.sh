#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ -z "${E2E_CONTEXT_DIR:-}" ]]; then
  echo "FAIL: onboarding.preflight.expected-failed - E2E_CONTEXT_DIR is not set"
  exit 1
fi

if [[ -f "${E2E_CONTEXT_DIR}/negative-preflight.log" ]] && grep -Eiq "docker|container|daemon|socket|preflight" "${E2E_CONTEXT_DIR}/negative-preflight.log"; then
  echo "PASS: onboarding.preflight.expected-failed"
  exit 0
fi

echo "FAIL: onboarding.preflight.expected-failed - expected Docker/preflight failure evidence not found"
exit 1
