#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

[[ "${1:-}" == "openclaw" ]] || exit 2

output="$(cat)"
shopt -s nocasematch
labelled_version='(^|[^[:alnum:]_])openclaw[[:space:]]*(version[[:space:]:=]*|release[[:space:]:=]*|v)?([0-9]+\.[0-9]+\.[0-9]+)([^0-9.]|$)'
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ $labelled_version ]]; then
    printf '%s\n' "${BASH_REMATCH[3]}"
    exit 0
  fi
done <<<"$output"

bare_version='^[[:space:]]*v?([0-9]+\.[0-9]+\.[0-9]+)[[:space:]]*$'
if [[ "$output" =~ $bare_version ]]; then
  printf '%s\n' "${BASH_REMATCH[1]}"
  exit 0
fi

exit 1
