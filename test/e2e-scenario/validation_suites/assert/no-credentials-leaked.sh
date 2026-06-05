#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Credential-leak scan.
#
# Scans a directory (e.g. a migration bundle, a blueprint digest, or a
# sandbox filesystem mount) for common credential patterns. Any match is
# a failure.
#
# Usage:
#   e2e_assert_no_credentials_leaked <path> [--pattern <regex>]...
#
# Default patterns cover OpenAI / NVIDIA / GitHub / generic tokens. Callers
# can supply additional --pattern flags to extend the set.

e2e_assert_no_credentials_leaked() {
  local target="${1:-}"
  if [[ -z "${target}" ]]; then
    echo "FAIL: e2e_assert_no_credentials_leaked: missing target path" >&2
    return 2
  fi
  if [[ ! -e "${target}" ]]; then
    echo "FAIL: e2e_assert_no_credentials_leaked: target not found: ${target}" >&2
    return 2
  fi
  shift
  # Default credential patterns. grep -E syntax.
  local patterns=(
    'sk-[A-Za-z0-9]{16,}'        # OpenAI-style
    'nvapi-[A-Za-z0-9_-]{16,}'   # NVIDIA API keys
    'ghp_[A-Za-z0-9]{20,}'       # GitHub PAT
    'xox[abp]-[A-Za-z0-9-]{10,}' # Slack tokens
    'AKIA[0-9A-Z]{16}'           # AWS access key
  )
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pattern)
        patterns+=("${2:?value required}")
        shift 2
        ;;
      *)
        echo "e2e_assert_no_credentials_leaked: unknown arg: $1" >&2
        return 2
        ;;
    esac
  done

  local found=0
  local p
  for p in "${patterns[@]}"; do
    if [[ -d "${target}" ]]; then
      if grep -r -E -l "${p}" "${target}" >/dev/null 2>&1; then
        echo "FAIL: credential pattern matched in ${target}: ${p}" >&2
        # Print up to 5 matching file paths; word-split is intentional here.
        while IFS= read -r hit; do
          printf '  hit: %s\n' "${hit}" >&2
        done < <(grep -r -E -l "${p}" "${target}" 2>/dev/null | head -5)
        found=1
      fi
    else
      if grep -E -q "${p}" "${target}" 2>/dev/null; then
        echo "FAIL: credential pattern matched in ${target}: ${p}" >&2
        found=1
      fi
    fi
  done
  if ((found == 1)); then
    return 1
  fi
  return 0
}
