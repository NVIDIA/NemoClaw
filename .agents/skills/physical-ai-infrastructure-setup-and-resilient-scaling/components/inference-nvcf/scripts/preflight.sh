#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
MIN_CURL_VERSION="7.68.0"
MIN_JQ_VERSION="1.6"
PREFLIGHT_SKIP_NETWORK="${PHYSICAL_AI_PREFLIGHT_SKIP_NETWORK:-${ORION_PREFLIGHT_SKIP_NETWORK:-0}}"
PASS=true
WARNINGS=0

fail() { echo "ERROR: $*" >&2; PASS=false; }
warn() { echo "WARNING: $*" >&2; WARNINGS=$((WARNINGS + 1)); }
ok() { echo "OK: $*"; }

require_cmds() {
  local cmd
  for cmd in "$@"; do
    if command -v "${cmd}" >/dev/null 2>&1; then
      ok "${cmd} found ($(command -v "${cmd}"))"
    else
      fail "${cmd} not found in PATH"
    fi
  done
}

version_ge() {
  local got="${1#v}"
  local want="${2#v}"
  got="${got%%[-+]*}"
  want="${want%%[-+]*}"
  awk -v got="${got}" -v want="${want}" '
    BEGIN {
      split(got, g, ".")
      split(want, w, ".")
      for (i = 1; i <= 3; i++) {
        if ((g[i] + 0) > (w[i] + 0)) exit 0
        if ((g[i] + 0) < (w[i] + 0)) exit 1
      }
    }
  '
}

check_min_version() {
  local name="$1"
  local version="$2"
  local min_version="$3"
  if [[ -z "${version}" ]]; then
    fail "could not determine ${name} version; need >= ${min_version}"
  elif version_ge "${version}" "${min_version}"; then
    ok "${name} ${version} >= ${min_version}"
  else
    fail "${name} ${version} < ${min_version}"
  fi
}

finish() {
  if [[ "${PASS}" != "true" ]]; then
    echo "==> inference-nvcf preflight failed" >&2
    exit 1
  fi
  echo "==> inference-nvcf preflight passed (${WARNINGS} warning(s))"
}

echo "==> inference-nvcf preflight"
require_cmds curl jq
check_min_version "curl" "$(curl --version 2>/dev/null | awk 'NR == 1 { print $2; exit }' || printf "")" "${MIN_CURL_VERSION}"
check_min_version "jq" "$(jq --version 2>/dev/null | sed 's/^jq-//' || printf "")" "${MIN_JQ_VERSION}"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
  ok "loaded ${REPO_ROOT}/.env"
else
  warn "${REPO_ROOT}/.env not found"
fi
[[ -n "${NGC_API_KEY:-}" ]] && ok "NGC_API_KEY set" || fail "NGC_API_KEY is unset"

if [[ "${PREFLIGHT_SKIP_NETWORK}" != "1" && -n "${NGC_API_KEY:-}" ]]; then
  if http_code=$(curl -sS --max-time 15 -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${NGC_API_KEY}" \
    https://api.nvcf.nvidia.com/v2/nvcf/functions); then
    :
  else
    http_code="000"
  fi
  [[ "${http_code}" == "200" ]] && ok "NVCF functions API reachable" || fail "NVCF functions API returned HTTP ${http_code}; verify org-level NGC_API_KEY"
fi

finish
