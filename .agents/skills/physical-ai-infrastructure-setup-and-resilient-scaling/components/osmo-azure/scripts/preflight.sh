#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
TF_DIR="${TF_DIR:-${SCRIPT_DIR}/../../cluster-azure/scripts}"
MIN_AZ_VERSION="2.60.0"
MIN_TERRAFORM_VERSION="1.9.8"
MIN_KUBECTL_VERSION="1.31.0"
MIN_HELM_VERSION="3.0.0"
MIN_GIT_VERSION="2.25.0"
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

check_az_auth() {
  command -v az >/dev/null 2>&1 || return
  local tfvars="${TF_DIR}/deploy.tfvars"
  local subscription_id=""
  local subscription_label="current subscription"
  local account_state=""
  local active_subscription_id=""
  local provider=""
  local provider_state=""

  if [[ -f "${tfvars}" ]]; then
    subscription_id=$(awk -F'"' '/^[[:space:]]*subscription_id[[:space:]]*=/ && $2 !~ /YOUR_SUBSCRIPTION_ID/ { print $2; exit }' "${tfvars}" || printf "")
  fi
  if [[ -n "${subscription_id}" ]]; then
    subscription_label="subscription ${subscription_id}"
  fi

  if [[ -n "${subscription_id}" ]]; then
    account_state=$(az account show --subscription "${subscription_id}" --query state -o tsv 2>/dev/null || printf "")
  else
    account_state=$(az account show --query state -o tsv 2>/dev/null || printf "")
  fi
  if [[ -n "${account_state}" ]]; then
    if [[ "${account_state}" == "Enabled" ]]; then
      ok "az authenticated with access to ${subscription_label}"
    else
      fail "az ${subscription_label} state is ${account_state}; select an Enabled subscription"
    fi
  else
    fail "az CLI cannot read ${subscription_label}; run az login, activate required PIM roles, and select the target subscription"
    return
  fi

  if [[ -n "${subscription_id}" ]]; then
    active_subscription_id=$(az account show --query id -o tsv 2>/dev/null || printf "")
    if [[ "${active_subscription_id}" == "${subscription_id}" ]]; then
      ok "az active subscription matches deploy.tfvars"
    else
      fail "az active subscription is ${active_subscription_id:-<none>}, but deploy.tfvars selects ${subscription_id}; run az account set --subscription ${subscription_id}"
    fi
  fi

  for provider in Microsoft.ContainerService Microsoft.Storage Microsoft.DBforPostgreSQL Microsoft.Cache; do
    if [[ -n "${subscription_id}" ]]; then
      provider_state=$(az provider show --namespace "${provider}" --subscription "${subscription_id}" --query registrationState -o tsv 2>/dev/null || printf "")
    else
      provider_state=$(az provider show --namespace "${provider}" --query registrationState -o tsv 2>/dev/null || printf "")
    fi
    if [[ -n "${provider_state}" ]]; then
      if [[ "${provider_state}" == "Registered" ]]; then
        ok "az can read provider ${provider}"
      else
        warn "az can read provider ${provider}, but registrationState=${provider_state}"
      fi
    else
      fail "az cannot read provider ${provider} in ${subscription_label}; activate PIM/RBAC for the target subscription"
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
    echo "==> osmo-azure preflight failed" >&2
    exit 1
  fi
  echo "==> osmo-azure preflight passed (${WARNINGS} warning(s))"
}

echo "==> osmo-azure preflight"
require_cmds az terraform kubectl helm git awk
check_az_auth
check_min_version "az" "$(az version --query '"azure-cli"' -o tsv 2>/dev/null || printf "")" "${MIN_AZ_VERSION}"
terraform_version=$(terraform version 2>/dev/null | awk 'NR == 1 { sub(/^v/, "", $2); print $2; exit }' || printf "")
check_min_version "terraform" "${terraform_version}" "${MIN_TERRAFORM_VERSION}"
helm_version=$(helm version --short 2>/dev/null | awk '{ sub(/^v/, "", $1); print $1; exit }' || printf "")
check_min_version "helm" "${helm_version}" "${MIN_HELM_VERSION}"
check_min_version "kubectl" "$(kubectl_semver)" "${MIN_KUBECTL_VERSION}"
check_min_version "git" "$(git --version 2>/dev/null | awk '{ print $3; exit }' || printf "")" "${MIN_GIT_VERSION}"
[[ -d "${TF_DIR}" ]] && ok "${TF_DIR} exists" || fail "${TF_DIR} missing; run cluster-azure first or set TF_DIR"
[[ -f "${TF_DIR}/outputs.tf" ]] && ok "${TF_DIR}/outputs.tf exists" || fail "${TF_DIR}/outputs.tf missing"
warn "Terraform state outputs are not checked in preflight; deployment resolves them after Azure cluster apply"
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
