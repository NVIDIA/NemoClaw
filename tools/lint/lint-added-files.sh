#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "${repo_root}"

base_ref=${NEMOCLAW_LINT_BASE_REF:-origin/main}
base_commit=$(git rev-parse --verify --quiet "${base_ref}^{commit}") || {
  printf 'ERROR: anti-slop base ref is unavailable: %s\n' "${base_ref}" >&2
  exit 2
}

added_files=()
for file in "$@"; do
  case "${file}" in
    "" | /* | . | .. | ./* | ../* | */./* | */../* | */. | */..)
      printf 'ERROR: anti-slop candidate must be a repository-relative path: %q\n' "${file}" >&2
      exit 2
      ;;
  esac
  if [[ -L "${file}" ]]; then
    printf 'ERROR: anti-slop candidate must not be a symbolic link: %q\n' "${file}" >&2
    exit 2
  fi
  if [[ ! -f "${file}" ]]; then
    continue
  fi
  case "${file}" in
    *.cjs | *.cts | *.js | *.jsx | *.mjs | *.mts | *.ts | *.tsx) ;;
    *) continue ;;
  esac
  if ! git cat-file -e "${base_commit}:${file}" 2>/dev/null; then
    added_files+=("${file}")
  fi
done

if ((${#added_files[@]} == 0)); then
  exit 0
fi

exec npx oxlint --config oxlint.anti-slop.config.ts --no-error-on-unmatched-pattern -- "${added_files[@]}"
