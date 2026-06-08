#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ ! -f "${E2E_CONTEXT_DIR:-}/onboard.log" ]]; then
  echo "FAIL: onboarding.preflight.passed - onboard log not found"
  exit 1
fi

# The onboarding action already completed (exit 0) for this assertion to
# run; we only need to confirm the captured onboard.log does not contain
# explicit preflight FAILURE markers. The previous regex matched any
# mention of 'docker' / 'container' / 'daemon' / 'socket', which a normal
# successful onboarding always logs. Tighten to actual failure phrases.
if grep -Eiq \
  "preflight[[:space:]]+(failed|error)|cannot connect to[[:space:]]+(the[[:space:]]+)?docker daemon|permission denied[[:space:]]+while trying to connect to.*docker.*sock|onboarding aborted|FATAL: docker|ERROR: docker daemon" \
  "${E2E_CONTEXT_DIR}/onboard.log"; then
  echo "FAIL: onboarding.preflight.passed - onboard log contains preflight failure evidence"
  exit 1
fi

echo "PASS: onboarding.preflight.passed"
