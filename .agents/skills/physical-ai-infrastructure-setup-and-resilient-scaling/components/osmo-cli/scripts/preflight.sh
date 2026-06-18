#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MIN_OSMO_CLI_VERSION="6.3.0"
PASS=true
WARNINGS=0

fail() {
  echo "ERROR: $*" >&2
  PASS=false
}

warn() {
  echo "WARNING: $*" >&2
  WARNINGS=$((WARNINGS + 1))
}

ok() {
  echo "OK: $*"
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

osmo_client_version() {
  local output=""
  local major=""
  local minor=""
  local revision=""
  if output=$(osmo version --format-type json 2>&1); then
    major=$(awk -F'"' '/"major"/ { print $4; exit }' <<<"${output}")
    minor=$(awk -F'"' '/"minor"/ { print $4; exit }' <<<"${output}")
    revision=$(awk -F'"' '/"revision"/ { print $4; exit }' <<<"${output}")
    if [[ -n "${major}" && -n "${minor}" && -n "${revision}" ]]; then
      printf "%s.%s.%s" "${major}" "${minor}" "${revision}"
      return 0
    fi
  else
    fail "osmo version failed: ${output}"
    return 1
  fi

  if output=$(osmo version 2>&1); then
    awk '
      match($0, /[0-9]+[.][0-9]+[.][0-9]+/) {
        print substr($0, RSTART, RLENGTH)
        exit
      }
    ' <<<"${output}"
  else
    fail "osmo version failed: ${output}"
    return 1
  fi
}

finish() {
  if [[ "${PASS}" != "true" ]]; then
    echo "==> osmo-cli preflight failed" >&2
    exit 1
  fi
  echo "==> osmo-cli preflight passed (${WARNINGS} warning(s))"
}

echo "==> osmo-cli preflight"
if command -v osmo >/dev/null 2>&1; then
  ok "osmo found ($(command -v osmo))"
else
  fail "osmo not found in PATH"
  finish
fi

osmo_version=""
if osmo_version=$(osmo_client_version); then
  :
else
  osmo_version=""
fi
check_min_version "osmo CLI" "${osmo_version}" "${MIN_OSMO_CLI_VERSION}"
finish
