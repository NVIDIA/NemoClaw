#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

sandbox_name="${1:-tm}"
if [[ ! "$sandbox_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid sandbox name: %s\n' "$sandbox_name" >&2
  exit 2
fi

printf 'The proof is armed for sandbox %s. Complete the normal onboarding prompts.\n' \
  "$sandbox_name"
printf 'When the live replacement returns cuInit(0)=801, NemoClaw will run the one-path A/B before its normal rollback.\n'

npm run build:cli

export NEMOCLAW_SANDBOX_NAME="$sandbox_name"
export NEMOCLAW_DIAGNOSE_JETSON_OPENRM_POLICY=1
exec node bin/nemoclaw.js onboard --resume
