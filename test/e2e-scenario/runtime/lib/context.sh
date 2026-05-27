#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Normalized E2E context helper.
#
# Each scenario produces a `.e2e/context.env` file with normalized key/value
# pairs describing the completed environment. Downstream suites, expected-
# state validators, and artifact collection source this file instead of
# rediscovering scenario state.
#
# Standard keys (set by the scenario runner):
#   E2E_SCENARIO            scenario id
#   E2E_PLATFORM_OS         ubuntu|macos|wsl|...
#   E2E_EXECUTION_TARGET    local|remote
#   E2E_INSTALL_METHOD      repo-checkout|curl-install-script|...
#   E2E_ONBOARDING_PATH     cloud|local
#   E2E_AGENT               openclaw|hermes
#   E2E_PROVIDER            nvidia|ollama|openai-compatible
#   E2E_SANDBOX_NAME        unique sandbox identifier
#   E2E_GATEWAY_URL         gateway base URL
#   E2E_CONTAINER_ENGINE    docker
#   E2E_CONTAINER_DAEMON    running|missing
#   E2E_INFERENCE_ROUTE     inference-local|...
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/context.sh"
#   e2e_context_init
#   e2e_context_set E2E_SCENARIO ubuntu-repo-cloud-openclaw
#   e2e_context_require E2E_SANDBOX_NAME
#   e2e_context_dump

# Resolve and export E2E_CONTEXT_DIR. If not set, default to <repo-root>/.e2e
_e2e_context_resolve_dir() {
  if [[ -n "${E2E_CONTEXT_DIR:-}" ]]; then
    return 0
  fi
  local script_dir repo_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "${script_dir}/../../.." && pwd)"
  export E2E_CONTEXT_DIR="${repo_root}/.e2e"
}

e2e_context_init() {
  _e2e_context_resolve_dir
  mkdir -p "${E2E_CONTEXT_DIR}"
  : >"${E2E_CONTEXT_DIR}/context.env"
}

e2e_context_path() {
  _e2e_context_resolve_dir
  printf '%s\n' "${E2E_CONTEXT_DIR}/context.env"
}

# CodeRabbit review item #4: validate that KEY is a plain POSIX identifier
# (so we never interpolate metacharacters into grep regexes) and that VALUE
# has no newlines or control characters that could break the line-oriented
# context.env format.
_e2e_context_validate_key() {
  local key="${1:-}"
  if [[ -z "${key}" ]]; then
    echo "e2e_context: missing key" >&2
    return 2
  fi
  if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "e2e_context: invalid key (POSIX identifier required): ${key}" >&2
    return 2
  fi
}

_e2e_context_validate_value() {
  local value="${1-}"
  # Reject newlines that would corrupt the line-oriented context.env
  # format. We deliberately do not reject all control characters since
  # tabs and escape sequences can appear in legitimate values (e.g. test
  # fixtures that seed tracing markers). Newlines are the only format
  # break. (CodeRabbit review item #4.)
  if [[ "${value}" == *$'\n'* ]] || [[ "${value}" == *$'\r'* ]]; then
    echo "e2e_context: value contains newline characters; reject" >&2
    return 2
  fi
}

# e2e_context_set KEY VALUE
# Appends or updates a single key in context.env. Value is written literally;
# callers are responsible for not embedding newlines.
e2e_context_set() {
  local key="${1:-}"
  local value="${2:-}"
  _e2e_context_validate_key "${key}" || return 2
  _e2e_context_validate_value "${value}" || return 2
  _e2e_context_resolve_dir
  local ctx="${E2E_CONTEXT_DIR}/context.env"
  if [[ ! -f "${ctx}" ]]; then
    mkdir -p "${E2E_CONTEXT_DIR}"
    : >"${ctx}"
  fi
  # Remove any existing assignment for this key, then append.
  local tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "${ctx}" >"${tmp}" || true
  mv "${tmp}" "${ctx}"
  printf '%s=%s\n' "${key}" "${value}" >>"${ctx}"
}

# e2e_context_get KEY
# Prints the value of KEY (empty if missing). Does not fail.
e2e_context_get() {
  local key="${1:-}"
  _e2e_context_validate_key "${key}" || return 2
  _e2e_context_resolve_dir
  local ctx="${E2E_CONTEXT_DIR}/context.env"
  [[ -f "${ctx}" ]] || return 0
  local line
  line="$(grep "^${key}=" "${ctx}" | tail -n1 || true)"
  printf '%s' "${line#"${key}"=}"
}

# e2e_context_require KEY [KEY ...]
# Exits non-zero if any required key is missing or empty.
e2e_context_require() {
  _e2e_context_resolve_dir
  local ctx="${E2E_CONTEXT_DIR}/context.env"
  local missing=()
  local key value
  for key in "$@"; do
    _e2e_context_validate_key "${key}" || return 2
    if [[ -f "${ctx}" ]]; then
      value="$(grep "^${key}=" "${ctx}" | tail -n1 || true)"
      value="${value#"${key}"=}"
    else
      value=""
    fi
    if [[ -z "${value}" ]]; then
      missing+=("${key}")
    fi
  done
  if ((${#missing[@]} > 0)); then
    printf 'e2e context: missing required key(s): %s\n' "${missing[*]}" >&2
    printf 'e2e context: expected in %s\n' "${ctx}" >&2
    return 1
  fi
}

# Internal: decide whether a key's value should be redacted.
_e2e_context_is_sensitive_key() {
  local key="$1"
  case "$key" in
    *TOKEN* | *SECRET* | *PASSWORD* | *API_KEY* | *APIKEY* | *CREDENTIAL* | *PRIVATE*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# e2e_context_dump
# Print the context to stdout with sensitive values redacted. Safe to use in
# CI logs and artifact bundles.
e2e_context_dump() {
  _e2e_context_resolve_dir
  local ctx="${E2E_CONTEXT_DIR}/context.env"
  if [[ ! -f "${ctx}" ]]; then
    echo "e2e context: no context.env at ${ctx}" >&2
    return 1
  fi
  echo "# E2E context (${ctx})"
  local key rest
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue
    key="${line%%=*}"
    rest="${line#*=}"
    if _e2e_context_is_sensitive_key "${key}"; then
      printf '%s=%s\n' "${key}" "REDACTED"
    else
      printf '%s=%s\n' "${key}" "${rest}"
    fi
  done <"${ctx}"
}
