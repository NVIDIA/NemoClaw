#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Probe: sandbox-absent
#
# Negative-state probe. Asserts that no sandbox was created by a
# scenario whose expected_state declares sandbox.expected=absent
# (preflight failure, onboarding failures).

set -euo pipefail

# E2E_SANDBOX_NAME is seeded by the framework from the scenario id
# even when onboarding never completed; missing context here is a
# framework bug, not a probe pass.
if [[ -z "${E2E_SANDBOX_NAME:-}" ]]; then
  context_env="${E2E_CONTEXT_DIR:-.e2e}/context.env"
  if [[ -f "${context_env}" ]]; then
    E2E_SANDBOX_NAME="$(awk -F= '/^E2E_SANDBOX_NAME=/{print substr($0, index($0, "=")+1); exit}' "${context_env}" | tr -d '"')"
  fi
fi
if [[ -z "${E2E_SANDBOX_NAME:-}" ]]; then
  echo "probe sandbox-absent: E2E_SANDBOX_NAME unset; framework did not seed context" >&2
  exit 2
fi

# Two independent checks — `nemoclaw list` is the user-facing surface
# and openshell-side listing covers cases where nemoclaw is uninstalled
# or wedged. Either reporting the sandbox fails the probe.
if command -v nemoclaw >/dev/null 2>&1; then
  if nemoclaw list 2>/dev/null | grep -qE "(^|[[:space:]])${E2E_SANDBOX_NAME}([[:space:]]|$)"; then
    echo "probe sandbox-absent: nemoclaw list reports sandbox '${E2E_SANDBOX_NAME}', expected absent" >&2
    exit 1
  fi
fi

if command -v openshell >/dev/null 2>&1; then
  if openshell sandbox list 2>/dev/null | grep -Fq "${E2E_SANDBOX_NAME}"; then
    echo "probe sandbox-absent: openshell reports sandbox '${E2E_SANDBOX_NAME}', expected absent" >&2
    exit 1
  fi
fi

echo "probe sandbox-absent: ok"
exit 0
