#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Probe: gateway-absent
#
# Negative-state probe. Asserts that no gateway was started by a
# scenario whose expected_state declares gateway.expected=absent
# (preflight failure, invalid-key onboarding failure,
# gateway-port-conflict onboarding failure). This is the typed
# replacement for the runtime.expected-failure.no-side-effects
# pending step on the gateway-started axis: a real probe that fails
# closed if the gateway IS running.

set -euo pipefail

# Order matters: cheap CLI status check first, then port reachability
# fallback. We deliberately do NOT rely on any single signal so a
# scenario that leaves a partially-started gateway behind cannot
# slip through.

if command -v nemoclaw >/dev/null 2>&1; then
  if nemoclaw gateway status >/dev/null 2>&1; then
    echo "probe gateway-absent: nemoclaw reports gateway is running, expected absent" >&2
    nemoclaw gateway status >&2 || true
    exit 1
  fi
fi

# Best-effort URL reachability check. context.env may carry a
# gateway URL even for negative scenarios (it is computed from the
# scenario id, not from a successful onboard).
context_env="${E2E_CONTEXT_DIR:-.e2e}/context.env"
if [[ -f "${context_env}" ]]; then
  url="$(awk -F= '/^E2E_GATEWAY_URL=/{print substr($0, index($0, "=")+1); exit}' "${context_env}" | tr -d '"')"
  if [[ -n "${url}" ]]; then
    if curl -fsS -o /dev/null --max-time 3 "${url%/}/health" 2>/dev/null; then
      echo "probe gateway-absent: ${url%/}/health responded healthy, expected absent" >&2
      exit 1
    fi
  fi
fi

echo "probe gateway-absent: ok"
exit 0
