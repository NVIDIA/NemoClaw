#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code headless inference (#5619).
#
# Headless `dcode -n "<prompt>"`, run inside a built Deep Agents Code sandbox,
# must route through the managed https://inference.local/v1 endpoint using the
# placeholder OpenAI-compatible key NemoClaw writes into config.toml. The login
# shell path must return PONG with exit 0; provider, connection, DNS, timeout, and
# ambiguous failures are not acceptable. No real provider/proxy credentials may
# appear in config.toml, .env, .mcp.json, /tmp/nemoclaw-proxy-env.sh, or output.
# Direct DNS/hosts resolution is intentionally not required: OpenShell's managed
# proxy routes inference.local when the request follows the normalized path.

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

sandbox_login_exec() {
  # OpenShell exec sessions may carry their own environment. Remove it so this
  # probe can only recover the proxy contract through /sandbox/.profile, then
  # pin HOME so bash selects the sandbox user's trusted login startup file.
  openshell sandbox exec --name "$SANDBOX_NAME" -- env \
    -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY \
    -u http_proxy -u https_proxy -u no_proxy \
    HOME=/sandbox bash -lc "$1" 2>&1
}

sandbox_direct_dcode() {
  openshell sandbox exec --name "$SANDBOX_NAME" --timeout "$HEADLESS_TIMEOUT" -- dcode "$@" 2>&1
}

nemoclaw_connect_probe() {
  "${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" "$SANDBOX_NAME" connect --probe-only 2>&1
}

sandbox_login_proxy_contract() {
  # OpenShell rejects CR/LF in any exec argv element, so keep this remote login
  # command on one physical line. inference.local is intentionally absent from
  # NO_PROXY: OpenShell does not need to provision inference.local DNS/hosts
  # into the sandbox because its managed proxy owns this L7 route. Adding
  # inference.local here would bypass that proxy and force a direct DNS lookup.
  local contract_command
  # shellcheck disable=SC2016
  contract_command='set -euo pipefail; contract_fail() { printf "%s\n" "NEMOCLAW_DCODE_PROXY_ENV_FAIL:$1"; exit 1; }; proxy_file_metadata() { stat -c "%u:%a" "$1" 2>/dev/null || stat -f "%u:%Lp" "$1" 2>/dev/null; }; [ "${HOME:-}" = /sandbox ] || contract_fail home; for file in /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port; do [ -f "$file" ] && [ ! -L "$file" ] && [ "$(proxy_file_metadata "$file")" = "0:444" ] || contract_fail proxy-file-trust; done; proxy_url="${HTTP_PROXY:-}"; case "$proxy_url" in http://*:*) ;; *) contract_fail proxy-shape ;; esac; case "$proxy_url" in *"@"*) contract_fail proxy-credentials ;; esac; [ "$proxy_url" = "${HTTPS_PROXY:-}" ] || contract_fail https-proxy; [ "$proxy_url" = "${http_proxy:-}" ] || contract_fail lower-http-proxy; [ "$proxy_url" = "${https_proxy:-}" ] || contract_fail lower-https-proxy; proxy_host="${proxy_url#http://}"; proxy_host="${proxy_host%:*}"; expected_no_proxy="localhost,127.0.0.1,::1,${proxy_host}"; [ "${NO_PROXY:-}" = "$expected_no_proxy" ] || contract_fail no-proxy; [ "${no_proxy:-}" = "$expected_no_proxy" ] || contract_fail lower-no-proxy; printf "%s\n" "NEMOCLAW_DCODE_PROXY_ENV_OK"'
  sandbox_login_exec "$contract_command"
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
SECRET_PATTERN='nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|bot[0-9]{8,10}:[A-Za-z0-9_-]{35}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|tvly-[A-Za-z0-9_-]{10,}'

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

is_inference_connection_failure() {
  grep -Eiq 'APIConnectionError|APITimeoutError|ConnectError|ConnectTimeout|ReadTimeout|Could not resolve host|Name or service not known|Temporary failure in name resolution|getaddrinfo.*(ENOTFOUND|EAI_AGAIN|failed|error)|nodename nor servname provided|DNS (lookup|resolution) (failed|error)|connection (timed out|refused)|request timed out'
}

is_actionable_inference_error() {
  grep -Eiq 'API key|authentication|authorization|unauthorized|forbidden|rate[ -]?limit|quota|HTTP[[:space:]]*(401|403|404|429|5[0-9]{2})|status[[:space:]]*(401|403|404|429|5[0-9]{2})|(inference\.local|provider|model|NVIDIA|OpenAI).*(error|failed|failure|invalid|unavailable)|(error|failed|failure|invalid|unavailable).*(inference\.local|provider|model|NVIDIA|OpenAI)'
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

  if [ "$dcode_exit" != "0" ]; then
    if printf '%s' "$payload" | is_local_execution_failure; then
      printf '%s\n' "local-execution-failure"
    elif printf '%s' "$payload" | is_inference_connection_failure; then
      printf '%s\n' "inference-connection-failure"
    elif printf '%s' "$payload" | is_actionable_inference_error; then
      printf '%s\n' "actionable-inference-error"
    else
      printf '%s\n' "nonzero-exit"
    fi
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

  if printf '%s' "$payload" | is_inference_connection_failure; then
    printf '%s\n' "inference-connection-failure"
    return 1
  fi

  if printf '%s' "$payload" | is_actionable_inference_error; then
    printf '%s\n' "actionable-inference-error"
    return 1
  fi

  if printf '%s' "$payload" | grep -Eiq '(^|[^[:alnum:]_])PONG([^[:alnum:]_]|$)'; then
    printf '%s\n' "pong"
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

  # 2. Record whether direct DNS/hosts is absent. When it is, the following
  # login, direct-exec, and connect successes prove they do not depend on it;
  # a present route is informational and is not credited as that proof.
  dns_hosts_output="$(sandbox_exec "if ! command -v getent >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PROBE_UNAVAILABLE; elif timeout 5 getent hosts inference.local >/dev/null 2>&1; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PRESENT; else status=\$?; if [ \"\$status\" -eq 124 ]; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PROBE_TIMEOUT; else printf '%s\\n' NEMOCLAW_DCODE_DNS_ABSENT; fi; fi")"
  if printf '%s\n' "$dns_hosts_output" | grep -Fxq "NEMOCLAW_DCODE_DNS_ABSENT"; then
    direct_dns_state=absent
    pass "direct inference.local DNS/hosts is absent; exercising the proxy-only contract"
  elif printf '%s\n' "$dns_hosts_output" | grep -Fxq "NEMOCLAW_DCODE_DNS_PRESENT"; then
    direct_dns_state=present
    info "direct inference.local DNS/hosts is present; proxy independence is not inferred from this observation"
  else
    direct_dns_state=unknown
    fail_test "could not observe the direct inference.local DNS/hosts state"
  fi

  # 3. The login shell loaded the exact normalized proxy contract from .profile.
  proxy_contract_output="$(sandbox_login_proxy_contract || true)"
  if printf '%s\n' "$proxy_contract_output" | grep -Fxq "NEMOCLAW_DCODE_PROXY_ENV_OK"; then
    pass "login shell loaded the normalized managed proxy environment"
  else
    proxy_contract_reason="$(printf '%s\n' "$proxy_contract_output" | sed -n 's/^NEMOCLAW_DCODE_PROXY_ENV_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    fail_test "login shell did not load the normalized managed proxy environment (${proxy_contract_reason:-unknown contract mismatch})"
  fi

  # 4. The managed route is reachable through the normalized login-shell proxy.
  route_output="$(sandbox_login_exec "curl -sS -o /dev/null -w 'HTTP_CODE:%{http_code}' --proxy \"\${HTTPS_PROXY}\" --noproxy \"\${NO_PROXY}\" --max-time 30 https://inference.local/v1/models" || true)"
  route_code="$(printf '%s' "$route_output" | sed -n 's/.*HTTP_CODE:\([0-9][0-9][0-9]\).*/\1/p' | tail -n1)"
  if [ "$route_code" = "200" ]; then
    pass "login-shell proxy reached https://inference.local/v1/models"
  else
    fail_test "login-shell proxy did not receive HTTP 200 from https://inference.local/v1/models (HTTP ${route_code:-000})"
  fi

  # 5. The same login-shell path runs dcode and returns PONG.
  headless_output="$(sandbox_login_exec "cd /sandbox && timeout ${HEADLESS_TIMEOUT} dcode -n 'Reply with exactly one word: PONG'; echo \"DCODE_EXIT:\$?\"" || true)"
  dcode_exit="$(printf '%s' "$headless_output" | sed -n 's/.*DCODE_EXIT:\([0-9]\+\).*/\1/p' | tail -n1)"
  if classification="$(classify_headless_output "${dcode_exit:-unknown}" "$headless_output")"; then
    pass "login-shell dcode -n reached managed inference with ${classification} (exit ${dcode_exit:-unknown}; direct DNS/hosts ${direct_dns_state})"
  else
    fail_test "login-shell dcode -n did not exit 0 with PONG (${classification}, exit ${dcode_exit:-unknown})"
  fi

  # 6. The public direct-exec path reaches inference without shell startup files.
  if direct_output="$(sandbox_direct_dcode -n "Reply with exactly one word: PONG")"; then
    direct_exit=0
  else
    direct_exit=$?
  fi
  direct_headless_output="${direct_output}
DCODE_EXIT:${direct_exit}"
  if direct_classification="$(classify_headless_output "$direct_exit" "$direct_headless_output")"; then
    pass "direct-exec dcode -n reached managed inference with ${direct_classification} (exit ${direct_exit}; direct DNS/hosts ${direct_dns_state})"
  else
    fail_test "direct-exec dcode -n did not exit 0 with PONG (${direct_classification}, exit ${direct_exit})"
  fi

  # 7. The user-facing connect readiness path accepts the same managed route.
  if connect_output="$(nemoclaw_connect_probe)"; then
    connect_exit=0
    pass "nemoclaw connect --probe-only accepted the managed inference route (direct DNS/hosts ${direct_dns_state})"
  else
    connect_exit=$?
    fail_test "nemoclaw connect --probe-only rejected the managed inference route (exit ${connect_exit})"
  fi

  # 8. No real secrets in managed config, runtime env files, artifacts, logs, or captured output.
  leak_scan="$(sandbox_exec "$(sandbox_artifact_scan_command)" || true)"
  combined="${config_output}
${leak_scan}
${dns_hosts_output}
${proxy_contract_output}
${route_output}
${headless_output}
${direct_headless_output}
${connect_output}"
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
