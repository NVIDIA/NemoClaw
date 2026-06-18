#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${TF_DIR:-${SCRIPT_DIR}/../../cluster-azure/scripts}"
RESOURCE_GROUP="${RESOURCE_GROUP:-}"
PROJECT_NAME="${PROJECT_NAME:-}"
MIN_AZ_VERSION="2.60.0"
MIN_TERRAFORM_VERSION="1.9.8"
MIN_JQ_VERSION="1.6"
MIN_CURL_VERSION="7.68.0"
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

  for provider in Microsoft.MachineLearningServices Microsoft.CognitiveServices; do
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

terraform_version() {
  local version=""
  command -v terraform >/dev/null 2>&1 || return
  version=$(terraform version -json 2>/dev/null | awk -F'"' '/"terraform_version"/ { print $4; exit }' || printf "")
  [[ -n "${version}" ]] || version=$(terraform version 2>/dev/null | awk 'NR == 1 { sub(/^v/, "", $2); print $2; exit }' || printf "")
  printf "%s" "${version}"
}

finish() {
  if [[ "${PASS}" != "true" ]]; then
    echo "==> inference-azure preflight failed" >&2
    exit 1
  fi
  echo "==> inference-azure preflight passed (${WARNINGS} warning(s))"
}

echo "==> inference-azure preflight"
require_cmds az jq curl awk
check_az_auth
check_min_version "az" "$(az version --query '"azure-cli"' -o tsv 2>/dev/null || printf "")" "${MIN_AZ_VERSION}"
check_min_version "jq" "$(jq --version 2>/dev/null | sed 's/^jq-//' || printf "")" "${MIN_JQ_VERSION}"
check_min_version "curl" "$(curl --version 2>/dev/null | awk 'NR == 1 { print $2; exit }' || printf "")" "${MIN_CURL_VERSION}"
if az extension show -n ml -o none >/dev/null 2>&1; then
  ok "az extension ml installed"
else
  fail "az extension ml missing; run: az extension add -n ml --yes"
fi
if [[ -z "${RESOURCE_GROUP}" || -z "${PROJECT_NAME}" ]]; then
  require_cmds terraform
  check_min_version "terraform" "$(terraform_version)" "${MIN_TERRAFORM_VERSION}"
  [[ -d "${TF_DIR}" ]] && ok "${TF_DIR} exists" || fail "${TF_DIR} missing; set TF_DIR or pass --resource-group and --project"
  warn "RESOURCE_GROUP/PROJECT_NAME not fully set; install.sh will resolve Terraform outputs after Azure cluster apply"
fi
finish
