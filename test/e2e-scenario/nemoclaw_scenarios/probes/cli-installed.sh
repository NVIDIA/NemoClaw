#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Probe: cli-installed
#
# Asserts that the nemoclaw CLI is reachable on PATH after the
# environment phase's install action completed.

set -euo pipefail

if ! command -v nemoclaw >/dev/null 2>&1; then
  echo "probe cli-installed: nemoclaw not found on PATH (PATH=${PATH})" >&2
  exit 1
fi

# Resolve to a real binary; aliases or shell functions don't count.
nemoclaw_bin="$(command -v nemoclaw)"
if [[ ! -x "${nemoclaw_bin}" ]]; then
  echo "probe cli-installed: nemoclaw resolved to non-executable: ${nemoclaw_bin}" >&2
  exit 1
fi

printf 'probe cli-installed: ok (%s)\n' "${nemoclaw_bin}"
exit 0
