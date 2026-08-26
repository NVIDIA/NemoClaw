#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

candidate_npmrc="$(find . -path './.git' -prune -o -name .npmrc -print -quit)"
if [ -n "$candidate_npmrc" ]; then
  echo "Candidate repository npm configuration is not allowed during trusted dependency installation." >&2
  exit 1
fi

npm ci --ignore-scripts
npm --prefix nemoclaw ci --ignore-scripts
