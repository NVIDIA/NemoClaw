#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

base_ref=${NEMOCLAW_LINT_BASE_REF:-origin/main}
if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  base_ref=HEAD
fi

added_files=()
for file in "$@"; do
  if ! git cat-file -e "${base_ref}:${file}" 2>/dev/null; then
    added_files+=("${file}")
  fi
done

if ((${#added_files[@]} == 0)); then
  exit 0
fi

exec npx oxlint --config oxlint.anti-slop.config.ts --no-error-on-unmatched-pattern "${added_files[@]}"
