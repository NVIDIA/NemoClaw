#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

mode=--write
if (($# > 0)); then
  mode=$1
  shift
fi
case "${mode}" in
  --check | --write) ;;
  *)
    echo "usage: ${0} [--check|--write] [file ...]" >&2
    exit 2
    ;;
esac

repo_root=$(git rev-parse --show-toplevel)
cd "${repo_root}"

base_ref=${NEMOCLAW_FORMAT_BASE_REF:-origin/main}
base_commit=$(git rev-parse --verify --quiet "${base_ref}^{commit}") || {
  printf 'ERROR: Oxfmt base ref is unavailable: %s\n' "${base_ref}" >&2
  exit 2
}

candidates=("$@")
if ((${#candidates[@]} == 0)); then
  while IFS= read -r -d "" file; do
    candidates+=("${file}")
  done < <(
    git diff --name-only --diff-filter=ACMR -z "${base_commit}" --
    git ls-files --others --exclude-standard -z
  )
fi

added_files=()
for file in "${candidates[@]}"; do
  case "${file}" in
    "" | /* | . | .. | ./* | ../* | */./* | */../* | */. | */..)
      printf 'ERROR: Oxfmt candidate must be a normalized repository-relative path without \".\" or \"..\" segments: %q\n' "${file}" >&2
      exit 2
      ;;
  esac
  if [[ -L "${file}" ]]; then
    printf 'ERROR: Oxfmt candidate must not be a symbolic link: %q\n' "${file}" >&2
    exit 2
  fi
  if [[ ! -f "${file}" ]]; then
    continue
  fi
  case "${file}" in
    *.cjs | *.cts | *.js | *.jsx | *.mjs | *.mts | *.ts | *.tsx) ;;
    *) continue ;;
  esac
  if [[ "${file}" == .dsh/tools/* ]] || ! git cat-file -e "${base_commit}:${file}" 2>/dev/null; then
    added_files+=("${file}")
  fi
done

if ((${#added_files[@]} == 0)); then
  exit 0
fi

exec npx oxfmt "${mode}" --no-error-on-unmatched-pattern -- "${added_files[@]}"
