#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code headless inference (#5619).
#
# Headless `dcode -n "<prompt>"`, run inside a built Deep Agents Code sandbox,
# must route through the managed https://inference.local/v1 endpoint using the
# placeholder OpenAI-compatible key NemoClaw writes into config.toml, and either
# return a response or a deterministic, actionable provider/model error (never a
# hang or ambiguous failure). No real provider/proxy credentials may appear in
# config.toml, .env, .mcp.json, /tmp/nemoclaw-proxy-env.sh, or the captured output.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="07-deepagents-code-headless-inference"
HEADLESS_TIMEOUT="${DEEPAGENTS_HEADLESS_TIMEOUT:-120}"

ok() { printf '%s\n' "${PREFIX}: OK ($*)"; }
info() { printf '%s\n' "${PREFIX}: $*"; }
fail_test() {
  printf '%s\n' "${PREFIX}: FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}
pass() {
  ok "$1"
  PASSED=$((PASSED + 1))
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

sandbox_artifact_scan_command() {
  cat <<'SCAN'
for path in /sandbox/.deepagents/config.toml /sandbox/.deepagents/.env /sandbox/.deepagents/.mcp.json /tmp/nemoclaw-proxy-env.sh; do
  if [ -e "$path" ]; then
    cat "$path" 2>/dev/null || true
  fi
done
while IFS= read -r -d "" artifact; do
  cat "$artifact" 2>/dev/null || true
done < <(find /sandbox/.deepagents -maxdepth 3 -type f \( -name "*.log" -o -name "*.json" -o -name "*.toml" -o -name ".env" \) -print0 2>/dev/null)
SCAN
}

# Secret-shaped patterns that must never appear in managed config or output.
SECRET_PATTERN='nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|bot[0-9]{8,10}:[A-Za-z0-9_-]{35}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'

PASSED=0
FAILED=0

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

contains_secret() {
  grep -Eq "$SECRET_PATTERN"
}

references_managed_inference_route() {
  grep -Eq 'https://inference\.local(/v1)?'
}

references_managed_placeholder_key() {
  grep -Eq 'api_key_env[[:space:]]*=[[:space:]]*"DEEPAGENTS_CODE_OPENAI_API_KEY"'
}

is_local_execution_failure() {
  grep -Eiq '(^|[[:space:]])(usage:|Traceback|SyntaxError|ImportError|ModuleNotFoundError|No module named|command not found|No such file or directory|Permission denied|invalid option)([[:space:]]|$)|DCODE_EXIT:12[67]'
}

is_actionable_inference_error() {
  grep -Eiq 'inference\.local|provider|model|NVIDIA|OpenAI|API key|authentication|authorization|unauthorized|forbidden|rate[ -]?limit|quota|HTTP[[:space:]]*(401|403|404|429|5[0-9]{2})|status[[:space:]]*(401|403|404|429|5[0-9]{2})'
}

classify_headless_output() {
  local dcode_exit="$1"
  local headless_output="$2"
  local payload
  payload="$(printf '%s' "$headless_output" | sed 's/DCODE_EXIT:[0-9]*//g')"

  if [ "$dcode_exit" = "124" ]; then
    printf '%s\n' "timeout"
    return 1
  fi

  if [ -z "$(printf '%s' "$payload" | tr -d '[:space:]')" ]; then
    printf '%s\n' "empty-output"
    return 1
  fi

  if printf '%s' "$payload" | is_local_execution_failure; then
    printf '%s\n' "local-execution-failure"
    return 1
  fi

  if printf '%s' "$payload" | grep -Eiq '(^|[^[:alnum:]_])PONG([^[:alnum:]_]|$)'; then
    printf '%s\n' "pong"
    return 0
  fi

  if printf '%s' "$payload" | is_actionable_inference_error; then
    printf '%s\n' "actionable-inference-error"
    return 0
  fi

  printf '%s\n' "ambiguous-output"
  return 1
}

main() {
  if ! is_positive_integer "$HEADLESS_TIMEOUT"; then
    fail_test "DEEPAGENTS_HEADLESS_TIMEOUT must be a positive integer"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
    info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
    exit 0
  fi

  info "Running Deep Agents Code headless inference checks in sandbox: $SANDBOX_NAME"

  # 1. config.toml points at the managed inference route, not a real provider host.
  config_output="$(sandbox_exec "cat /sandbox/.deepagents/config.toml 2>/dev/null" || true)"
  if printf '%s' "$config_output" | references_managed_inference_route; then
    pass "config.toml routes through the managed inference.local endpoint"
  else
    fail_test "config.toml does not reference the managed inference.local route (captured config redacted from log)"
  fi
  if printf '%s' "$config_output" | references_managed_placeholder_key; then
    pass "config.toml uses the managed Deep Agents Code placeholder API key"
  else
    fail_test "config.toml does not use the managed placeholder API key env reference (captured config redacted from log)"
  fi

  # 2. Headless dcode -n returns PONG or a deterministic, actionable inference error.
  headless_output="$(sandbox_exec "cd /sandbox && timeout ${HEADLESS_TIMEOUT} dcode -n 'Reply with exactly one word: PONG'; echo \"DCODE_EXIT:\$?\"")"
  dcode_exit="$(printf '%s' "$headless_output" | sed -n 's/.*DCODE_EXIT:\([0-9]\+\).*/\1/p' | tail -n1)"
  if classification="$(classify_headless_output "${dcode_exit:-unknown}" "$headless_output")"; then
    pass "dcode -n reached managed inference with ${classification} (exit ${dcode_exit:-unknown})"
  else
    fail_test "dcode -n did not produce PONG or an allowlisted provider/model/inference error (${classification}, exit ${dcode_exit:-unknown})"
  fi

  # 3. No real secrets in managed config, runtime env files, artifacts, logs, or captured output.
  leak_scan="$(sandbox_exec "$(sandbox_artifact_scan_command)" || true)"
  combined="${config_output}
${leak_scan}
${headless_output}"
  if printf '%s' "$combined" | contains_secret; then
    fail_test "secret-shaped value found in config/env/output (redacted from log)"
  else
    pass "no real provider/proxy credentials in config, runtime env, or output"
  fi

  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  [ "$FAILED" -eq 0 ] || exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
