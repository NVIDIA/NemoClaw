#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if ! command -v nemoclaw >/dev/null 2>&1; then
  echo "FAIL: onboarding.base.cli-installed - nemoclaw not found on PATH"
  exit 1
fi

nemoclaw --version >/dev/null

echo "PASS: onboarding.base.cli-installed"
