#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
MIN_KUBECTL_VERSION="1.31.0"
MIN_HELM_VERSION="3.0.0"
MIN_GIT_VERSION="2.25.0"
MIN_MICROK8S_VERSION="1.31.0"
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

kubectl_semver() {
  local version=""
  version=$(kubectl version --client=true --short 2>/dev/null | awk '/Client Version/ { sub(/^v/, "", $3); print $3; exit }' || printf "")
  [[ -n "${version}" ]] || version=$(kubectl version --client -o json 2>/dev/null | awk -F'"' '/"gitVersion"/ { sub(/^v/, "", $4); print $4; exit }' || printf "")
  printf "%s" "${version}"
}

finish() {
  if [[ "${PASS}" != "true" ]]; then
    echo "==> osmo-k8s preflight failed" >&2
    exit 1
  fi
  echo "==> osmo-k8s preflight passed (${WARNINGS} warning(s))"
}

echo "==> osmo-k8s preflight"
require_cmds kubectl helm git microk8s awk
helm_version=$(helm version --short 2>/dev/null | awk '{ sub(/^v/, "", $1); print $1; exit }' || printf "")
check_min_version "helm" "${helm_version}" "${MIN_HELM_VERSION}"
check_min_version "kubectl" "$(kubectl_semver)" "${MIN_KUBECTL_VERSION}"
check_min_version "git" "$(git --version 2>/dev/null | awk '{ print $3; exit }' || printf "")" "${MIN_GIT_VERSION}"
check_min_version "microk8s" "$(microk8s version 2>/dev/null | awk '{ sub(/^v/, "", $2); print $2; exit }' || printf "")" "${MIN_MICROK8S_VERSION}"
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
finish
