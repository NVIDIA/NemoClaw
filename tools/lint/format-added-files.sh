#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

mode=${1:---write}
case "${mode}" in
  --check | --write) ;;
  *)
    echo "usage: ${0} [--check|--write] [file ...]" >&2
    exit 2
    ;;
esac
shift

base_ref=${NEMOCLAW_FORMAT_BASE_REF:-origin/main}
if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  base_ref=HEAD
fi

candidates=("$@")
if ((${#candidates[@]} == 0)); then
  while IFS= read -r -d "" file; do
    candidates+=("${file}")
  done < <(
    git diff --name-only --diff-filter=ACMR -z "${base_ref}" --
    git ls-files --others --exclude-standard -z
  )
fi

added_files=()
for file in "${candidates[@]}"; do
  if [[ ! -f "${file}" ]]; then
    continue
  fi
  case "${file}" in
    *.cjs | *.cts | *.js | *.jsx | *.mjs | *.mts | *.ts | *.tsx) ;;
    *) continue ;;
  esac
  if ! git cat-file -e "${base_ref}:${file}" 2>/dev/null; then
    added_files+=("${file}")
  fi
done

if ((${#added_files[@]} == 0)); then
  exit 0
fi

exec npx oxfmt "${mode}" --no-error-on-unmatched-pattern "${added_files[@]}"
