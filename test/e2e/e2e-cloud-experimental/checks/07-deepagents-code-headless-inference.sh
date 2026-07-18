#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code headless inference and RLIMIT enforcement (#5619, #6545).
#
# Headless `dcode -n "<prompt>"`, run inside a built Deep Agents Code sandbox,
# must route through the managed https://inference.local/v1 endpoint using the
# placeholder OpenAI-compatible key NemoClaw writes into config.toml. The login
# shell path must reject an empty prompt with exit 2, then return PONG with exit
# 0 for a real prompt; provider, connection, DNS, timeout, and ambiguous failures
# are not acceptable. No real provider/proxy credentials may appear in
# config.toml, .env, .mcp.json, /tmp/nemoclaw-proxy-env.sh, or output.
# The sandbox entrypoint, direct managed launcher, and both login/interactive
# shell paths must keep the documented nproc=512 and nofile=65536 contract.
# Direct DNS/hosts resolution is intentionally not required: OpenShell's managed
# proxy routes inference.local when the request follows the normalized path.
# Keep these phases in one ordered acceptance check: the absent-DNS observation
# must describe the same sandbox used by login, direct-exec, and connect, and the
# final credential scan must cover every captured output. A second connect run
# sends untrusted evidence through the image-installed route-probe helper and
# must stop before session attach. Per-phase diagnostics retain failure
# attribution without splitting that shared evidence boundary.

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
    -u ALL_PROXY -u all_proxy \
    HOME=/sandbox bash -lc "$1" 2>&1
}

sandbox_interactive_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- env \
    -u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY \
    -u http_proxy -u https_proxy -u no_proxy \
    -u ALL_PROXY -u all_proxy \
    HOME=/sandbox bash --noprofile --rcfile /etc/bash.bashrc -ic "$1" 2>&1
}

sandbox_direct_rlimit_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /usr/local/lib/nemoclaw/dcode-managed-exec bash -c "$1" 2>&1
}

sandbox_direct_dcode() {
  openshell sandbox exec --name "$SANDBOX_NAME" --timeout "$HEADLESS_TIMEOUT" -- dcode "$@" 2>&1
}

sandbox_dcode_wrapper_contract() {
  # Keep this assertion as one atomic shell expression for clear failure attribution.
  # shellcheck disable=SC2016
  sandbox_exec 'dcode_path="$(command -v dcode 2>/dev/null || true)"; [ "$dcode_path" = /usr/local/bin/dcode ] && [ -x /usr/local/lib/nemoclaw/dcode-launcher.sh ] && [ -x /usr/local/lib/nemoclaw/dcode-managed-exec ] && [ -x /usr/local/lib/nemoclaw/dcode-wrapper.sh ] && cmp -s /usr/local/bin/dcode /usr/local/lib/nemoclaw/dcode-launcher.sh && cmp -s /usr/local/lib/nemoclaw/dcode-managed-exec /usr/local/lib/nemoclaw/dcode-launcher.sh && python3 -c '\''import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("deepagents_code") else 1)'\'' && printf "%s\\n" NEMOCLAW_DCODE_WRAPPER_CHAIN_OK'
}

write_openshell_target_shim() {
  local shim_path="$1"

  cat >"$shim_path" <<'SHIM'
#!/bin/bash
set -euo pipefail

real_openshell="${OPENSHELL_NEMOCLAW_REAL_BIN:?}"
trace_file="${OPENSHELL_NEMOCLAW_TARGET_TRACE:?}"
original_args=("$@")

if [ "${1:-}" = "sandbox" ] && [ "${2:-}" = "exec" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n | --name)
        [ "$#" -ge 2 ] || exit 64
        printf '%s\n' "$2" >>"$trace_file"
        break
        ;;
      --name=*)
        printf '%s\n' "${1#--name=}" >>"$trace_file"
        break
        ;;
      --)
        break
        ;;
    esac
    shift
  done
fi

unset OPENSHELL_NEMOCLAW_REAL_BIN OPENSHELL_NEMOCLAW_TARGET_TRACE
exec "$real_openshell" "${original_args[@]}"
SHIM
  chmod 0700 "$shim_path"
}

validate_connect_target_trace() {
  local trace_file="$1"
  local observed=0
  local target

  if [ ! -s "$trace_file" ]; then
    printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:missing"
    return 1
  fi

  while IFS= read -r target || [ -n "$target" ]; do
    observed=$((observed + 1))
    if [ "$target" != "$SANDBOX_NAME" ]; then
      printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:mismatch"
      return 1
    fi
  done <"$trace_file"

  if [ "$observed" -eq 0 ]; then
    printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:missing"
    return 1
  fi
}

nemoclaw_connect_probe() {
  local real_openshell
  local trace_dir
  local trace_file
  local shim_path
  local connect_output
  local connect_status
  local trace_result

  real_openshell="$(command -v openshell 2>/dev/null || true)"
  case "$real_openshell" in
    /*) ;;
    *)
      printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:openshell"
      return 1
      ;;
  esac
  if [ ! -x "$real_openshell" ]; then
    printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:openshell"
    return 1
  fi

  if ! trace_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-dcode-connect.XXXXXX")"; then
    printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:shim"
    return 1
  fi
  trace_file="$trace_dir/targets"
  shim_path="$trace_dir/openshell"
  if ! : >"$trace_file" || ! write_openshell_target_shim "$shim_path"; then
    rm -rf -- "$trace_dir"
    printf '%s\n' "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:shim"
    return 1
  fi

  # Exercise the public bare-connect route with every sandbox-name alias
  # removed. The test-only OpenShell shim records the actual post-routing exec
  # targets and then exact-execs the real absolute OpenShell binary.
  if connect_output="$(
    unset SANDBOX_NAME NEMOCLAW_SANDBOX_NAME NEMOCLAW_SANDBOX
    env \
      OPENSHELL_NEMOCLAW_REAL_BIN="$real_openshell" \
      OPENSHELL_NEMOCLAW_TARGET_TRACE="$trace_file" \
      NEMOCLAW_OPENSHELL_BIN="$shim_path" \
      "${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" connect --probe-only 2>&1
  )"; then
    connect_status=0
  else
    connect_status=$?
  fi

  if trace_result="$(validate_connect_target_trace "$trace_file")"; then
    rm -rf -- "$trace_dir"
    printf '%s\n' "$connect_output"
    return "$connect_status"
  else
    connect_status=$?
  fi

  rm -rf -- "$trace_dir"
  printf '%s\n' "$connect_output"
  printf '%s\n' "$trace_result"
  return "$connect_status"
}

dcode_connect_fail_closed_contract() (
  local fixture_dir real_openshell openshell_shim probe_marker attach_marker
  local connect_output connect_exit
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")"
  trap 'rm -rf "$fixture_dir"' EXIT
  real_openshell="$(command -v openshell)"
  openshell_shim="${fixture_dir}/openshell"
  probe_marker="${fixture_dir}/managed-probe-used"
  attach_marker="${fixture_dir}/session-attach-invoked"

  cat >"$openshell_shim" <<'SHIM'
#!/bin/bash
set -euo pipefail

readonly REAL_OPENSHELL="${OPENSHELL_NEMOCLAW_E2E_REAL_BIN:?}"
readonly PROBE_MARKER="${OPENSHELL_NEMOCLAW_E2E_PROBE_MARKER:?}"
readonly ATTACH_MARKER="${OPENSHELL_NEMOCLAW_E2E_ATTACH_MARKER:?}"

if [ "${1:-}" = "sandbox" ] && [ "${2:-}" = "connect" ]; then
  : >"$ATTACH_MARKER"
  exit 97
fi

args=("$@")
for ((index = 0; index + 3 < ${#args[@]}; index += 1)); do
  if [ "${args[index]}" = "/usr/local/lib/nemoclaw/dcode-managed-exec" ] \
    && [ "${args[index + 1]}" = "/bin/sh" ] \
    && [ "${args[index + 2]}" = "-c" ]; then
    : >"$PROBE_MARKER"
    args[index + 3]='printf "%s\n" "UNTRUSTED PREAMBLE" "BROKEN 000"'
    exec "$REAL_OPENSHELL" "${args[@]}"
  fi
done

exec "$REAL_OPENSHELL" "$@"
SHIM
  chmod 700 "$openshell_shim"

  if connect_output="$(env \
    NEMOCLAW_OPENSHELL_BIN="$openshell_shim" \
    OPENSHELL_NEMOCLAW_E2E_REAL_BIN="$real_openshell" \
    OPENSHELL_NEMOCLAW_E2E_PROBE_MARKER="$probe_marker" \
    OPENSHELL_NEMOCLAW_E2E_ATTACH_MARKER="$attach_marker" \
    "${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" "$SANDBOX_NAME" connect 2>&1)"; then
    connect_exit=0
  else
    connect_exit=$?
  fi

  printf '%s\n' "$connect_output"
  printf 'NEMOCLAW_DCODE_UNTRUSTED_CONNECT_EXIT:%s\n' "$connect_exit"
  if [ -f "$probe_marker" ]; then
    printf '%s\n' NEMOCLAW_DCODE_IMAGE_PROBE_USED
  fi
  if [ -e "$attach_marker" ]; then
    printf '%s\n' NEMOCLAW_DCODE_SESSION_ATTACH_INVOKED
  else
    printf '%s\n' NEMOCLAW_DCODE_SESSION_ATTACH_NOT_INVOKED
  fi
)

sandbox_login_proxy_contract() {
  # Keep the remote login contract in one quoted shell expression so the
  # fixture can dispatch it atomically. inference.local is intentionally absent from
  # NO_PROXY: OpenShell does not need to provision inference.local DNS/hosts
  # into the sandbox because its managed proxy owns this L7 route. Adding
  # inference.local here would bypass that proxy and force a direct DNS lookup.
  local contract_command
  # shellcheck disable=SC2016
  contract_command='set -euo pipefail; contract_fail() { printf "%s\n" "NEMOCLAW_DCODE_PROXY_ENV_FAIL:$1"; exit 1; }; proxy_file_metadata() { stat -c "%u:%a" "$1" 2>/dev/null || stat -f "%u:%Lp" "$1" 2>/dev/null; }; [ "${HOME:-}" = /sandbox ] || contract_fail home; runtime_uid="$(id -u)" || contract_fail runtime-user; sandbox_uid="$(id -u sandbox)" || contract_fail runtime-user; [ "$runtime_uid" != 0 ] && [ "$runtime_uid" = "$sandbox_uid" ] || contract_fail runtime-user; for file in /usr/local/share/nemoclaw/dcode-proxy-host /usr/local/share/nemoclaw/dcode-proxy-port; do [ -f "$file" ] && [ ! -L "$file" ] && [ "$(proxy_file_metadata "$file")" = "0:444" ] || contract_fail proxy-file-trust; done; trusted_proxy_host="$(cat /usr/local/share/nemoclaw/dcode-proxy-host)" || contract_fail proxy-file-read; trusted_proxy_port="$(cat /usr/local/share/nemoclaw/dcode-proxy-port)" || contract_fail proxy-file-read; proxy_env=/tmp/nemoclaw-proxy-env.sh; [ -f "$proxy_env" ] && [ ! -L "$proxy_env" ] && [ "$(proxy_file_metadata "$proxy_env")" = "${runtime_uid}:444" ] || contract_fail proxy-env-file-metadata; [ -z "${ALL_PROXY+x}" ] || contract_fail all-proxy; [ -z "${all_proxy+x}" ] || contract_fail lower-all-proxy; proxy_url="${HTTP_PROXY:-}"; case "$proxy_url" in http://*:*) ;; *) contract_fail proxy-shape ;; esac; case "$proxy_url" in *"@"*) contract_fail proxy-credentials ;; esac; expected_proxy_url="http://${trusted_proxy_host}:${trusted_proxy_port}"; [ "$proxy_url" = "$expected_proxy_url" ] || contract_fail proxy-source; [ "$proxy_url" = "${HTTPS_PROXY:-}" ] || contract_fail https-proxy; [ "$proxy_url" = "${http_proxy:-}" ] || contract_fail lower-http-proxy; [ "$proxy_url" = "${https_proxy:-}" ] || contract_fail lower-https-proxy; expected_no_proxy="localhost,127.0.0.1,::1,${trusted_proxy_host}"; [ "${NO_PROXY:-}" = "$expected_no_proxy" ] || contract_fail no-proxy; [ "${no_proxy:-}" = "$expected_no_proxy" ] || contract_fail lower-no-proxy; printf "%s\n" "NEMOCLAW_DCODE_PROXY_ENV_OK"'
  sandbox_login_exec "$contract_command"
}

dcode_entrypoint_rlimit_contract_command() {
  local proc_root="${1:-/proc}"
  local quoted_proc_root
  printf -v quoted_proc_root '%q' "$proc_root"
  # Keep the generated command on one physical line and bind it to the unique
  # argv marker installed by start.sh's exec -a. OpenShell remains PID 1.
  # shellcheck disable=SC2016
  printf '%s%s%s' 'set -euo pipefail; contract_fail() { printf "%s\n" "NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_FAIL:$1"; exit 1; }; proc_root=' "$quoted_proc_root" '; entrypoint_pid=""; for proc_dir in "$proc_root"/[0-9]*; do [ -d "$proc_dir" ] && [ -r "$proc_dir/cmdline" ] || continue; if ! cmdline="$(tr "\000" "\n" < "$proc_dir/cmdline" 2>/dev/null)"; then continue; fi; argc="$(printf "%s\n" "$cmdline" | awk "END { print NR }")"; [ "$argc" = 3 ] || continue; argv0="$(printf "%s\n" "$cmdline" | sed -n "1p")"; argv1="$(printf "%s\n" "$cmdline" | sed -n "2p")"; argv2="$(printf "%s\n" "$cmdline" | sed -n "3p")"; if [ "$argv0" = nemoclaw-dcode-entrypoint ] && [ "$argv1" = -f ] && [ "$argv2" = /dev/null ]; then [ -z "$entrypoint_pid" ] || contract_fail process-count; entrypoint_pid="${proc_dir##*/}"; fi; done; [ -n "$entrypoint_pid" ] || contract_fail process-count; limits="$proc_root/$entrypoint_pid/limits"; [ -r "$limits" ] || contract_fail limits; nproc_soft="$(awk "\$1 == \"Max\" && \$2 == \"processes\" { print \$3; exit }" "$limits")"; nproc_hard="$(awk "\$1 == \"Max\" && \$2 == \"processes\" { print \$4; exit }" "$limits")"; nofile_soft="$(awk "\$1 == \"Max\" && \$2 == \"open\" && \$3 == \"files\" { print \$4; exit }" "$limits")"; nofile_hard="$(awk "\$1 == \"Max\" && \$2 == \"open\" && \$3 == \"files\" { print \$5; exit }" "$limits")"; for value in "$nproc_soft" "$nproc_hard" "$nofile_soft" "$nofile_hard"; do case "$value" in "" | *[!0-9]*) contract_fail nonnumeric ;; esac; done; [ "$nproc_soft" = 512 ] && [ "$nproc_hard" = 512 ] || contract_fail nproc; [ "$nofile_soft" = 65536 ] && [ "$nofile_hard" = 65536 ] || contract_fail nofile; printf "%s\n" NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_OK'
}

sandbox_entrypoint_rlimit_contract() {
  sandbox_exec "$(dcode_entrypoint_rlimit_contract_command /proc)"
}

rlimit_shell_contract_command() {
  # Keep this contract as one atomic shell expression for clear failure attribution.
  # shellcheck disable=SC2016
  printf '%s' 'set -euo pipefail; contract_fail() { printf "%s\n" "NEMOCLAW_DCODE_SHELL_RLIMIT_FAIL:$1"; exit 1; }; nproc_soft="$(ulimit -Su)"; nproc_hard="$(ulimit -Hu)"; nofile_soft="$(ulimit -Sn)"; nofile_hard="$(ulimit -Hn)"; for value in "$nproc_soft" "$nproc_hard" "$nofile_soft" "$nofile_hard"; do case "$value" in "" | *[!0-9]*) contract_fail nonnumeric ;; esac; done; [ "$nproc_soft" = 512 ] && [ "$nproc_hard" = 512 ] || contract_fail nproc; [ "$nofile_soft" = 65536 ] && [ "$nofile_hard" = 65536 ] || contract_fail nofile; set +e; ulimit -Su 513 >/dev/null 2>&1; raise_nproc="$?"; ulimit -Sn 65537 >/dev/null 2>&1; raise_nofile="$?"; set -e; [ "$raise_nproc" -ne 0 ] || contract_fail raise-nproc; [ "$raise_nofile" -ne 0 ] || contract_fail raise-nofile; printf "%s\n" NEMOCLAW_DCODE_SHELL_RLIMIT_OK'
}

sandbox_artifact_scan_command() {
  cat <<'SCAN'
for path in /sandbox/.deepagents/config.toml /sandbox/.deepagents/.env /sandbox/.deepagents/.mcp.json /sandbox/.deepagents/.nemoclaw-mcp.json /tmp/nemoclaw-proxy-env.sh; do
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
SECRET_PATTERN='nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|bot[0-9]{8,10}:[A-Za-z0-9_-]{35}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|tvly-[A-Za-z0-9_-]{10,}|lsv2_(pt|sk)_[A-Za-z0-9]{10,}(_[A-Za-z0-9]+)*'

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

uses_native_openrouter_config() {
  local config
  config="$(cat)"
  printf '%s\n' "$config" | grep -Eq '^default[[:space:]]*=[[:space:]]*"openrouter:[^"]+"' \
    && printf '%s\n' "$config" | grep -Fxq '[models.providers.openrouter]'
}

is_local_execution_failure() {
  grep -Eiq '(^|[[:space:]])(usage:|Traceback|SyntaxError|ImportError|ModuleNotFoundError|No module named|command not found|No such file or directory|Permission denied|invalid option)([[:space:]]|$)|DCODE_EXIT:12[67]'
}

is_dcode_wrapper_failure() {
  grep -Eiq "(^|[[:space:]/])(dcode|dcode-launcher\\.sh|dcode-wrapper\\.sh):[[:space:]]*(command not found|No such file or directory|Permission denied)|No module named ['\\\"]?deepagents_code"
}

is_inference_connection_failure() {
  grep -Eiq 'APIConnectionError|APITimeoutError|ConnectError|ConnectTimeout|ReadTimeout|Could not resolve host|Name or service not known|Temporary failure in name resolution|getaddrinfo.*(ENOTFOUND|EAI_AGAIN|failed|error)|nodename nor servname provided|DNS (lookup|resolution) (failed|error)|connection (timed out|refused)|request timed out'
}

is_actionable_inference_error() {
  grep -Eiq 'API key|authentication|authorization|unauthorized|forbidden|rate[ -]?limit|quota|HTTP[[:space:]]*(401|403|404|429|5[0-9]{2})|status[[:space:]]*(401|403|404|429|5[0-9]{2})|(inference\.local|provider|model|NVIDIA|OpenAI).*(error|failed|failure|invalid|unavailable)|(error|failed|failure|invalid|unavailable).*(inference\.local|provider|model|NVIDIA|OpenAI)'
}

is_empty_prompt_rejection() {
  grep -Fxq 'NemoClaw: empty non-interactive prompt for -n; provide prompt text.'
}

# Route reachability is proved separately with /v1/models. This classifier has
# the stronger #6191 acceptance contract: dcode itself must be usable and return
# exit-zero PONG, so authentication, quota, provider, and model errors are
# intentionally failures rather than route-only success signals.
classify_headless_output() {
  local dcode_exit="$1"
  local headless_output="$2"
  local payload
  payload="$(printf '%s' "$headless_output" | sed 's/DCODE_EXIT:[0-9]*//g')"

  if [ "$dcode_exit" = "124" ]; then
    printf '%s\n' "timeout"
    return 1
  fi

  if printf '%s' "$payload" | is_dcode_wrapper_failure; then
    printf '%s\n' "wrapper-missing"
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

  if [ "$dcode_exit" != "0" ]; then
    printf '%s\n' "nonzero-exit"
    return 1
  fi

  if [ -z "$(printf '%s' "$payload" | tr -d '[:space:]')" ]; then
    printf '%s\n' "empty-output"
    return 1
  fi

  if printf '%s\n' "$payload" | tr -d '\r' | grep -Eiq '^[[:space:]]*PONG[[:space:]]*$'; then
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

  if ! sandbox_exec "test -d /sandbox/.deepagents" >/dev/null; then
    info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
    exit 0
  fi

  info "Running Deep Agents Code headless inference checks in sandbox: $SANDBOX_NAME"

  wrapper_contract_output="$(sandbox_dcode_wrapper_contract || true)"
  if printf '%s\n' "$wrapper_contract_output" | grep -Fxq "NEMOCLAW_DCODE_WRAPPER_CHAIN_OK"; then
    pass "managed dcode launcher, wrapper, and Python module are installed"
  else
    fail_test "managed dcode wrapper chain is missing or incomplete"
  fi

  entrypoint_rlimit_output="$(sandbox_entrypoint_rlimit_contract || true)"
  if printf '%s\n' "$entrypoint_rlimit_output" | grep -Fxq "NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_OK"; then
    pass "dcode entrypoint process tree enforces nproc=512 and nofile=65536"
  else
    entrypoint_rlimit_reason="$(printf '%s\n' "$entrypoint_rlimit_output" | sed -n 's/^NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    fail_test "dcode entrypoint process tree does not enforce resource limits (${entrypoint_rlimit_reason:-unknown contract mismatch})"
  fi

  rlimit_contract_command="$(rlimit_shell_contract_command)"
  login_rlimit_output="$(sandbox_login_exec "$rlimit_contract_command" || true)"
  if printf '%s\n' "$login_rlimit_output" | grep -Fxq "NEMOCLAW_DCODE_SHELL_RLIMIT_OK"; then
    pass "dcode login shell enforces and cannot raise nproc/nofile limits"
  else
    login_rlimit_reason="$(printf '%s\n' "$login_rlimit_output" | sed -n 's/^NEMOCLAW_DCODE_SHELL_RLIMIT_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    fail_test "dcode login shell does not enforce resource limits (${login_rlimit_reason:-unknown contract mismatch})"
  fi

  interactive_rlimit_output="$(sandbox_interactive_exec "$rlimit_contract_command" || true)"
  if printf '%s\n' "$interactive_rlimit_output" | grep -Fxq "NEMOCLAW_DCODE_SHELL_RLIMIT_OK"; then
    pass "dcode interactive/connect shell enforces and cannot raise nproc/nofile limits"
  else
    interactive_rlimit_reason="$(printf '%s\n' "$interactive_rlimit_output" | sed -n 's/^NEMOCLAW_DCODE_SHELL_RLIMIT_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    fail_test "dcode interactive/connect shell does not enforce resource limits (${interactive_rlimit_reason:-unknown contract mismatch})"
  fi

  direct_rlimit_output="$(sandbox_direct_rlimit_exec "$rlimit_contract_command" || true)"
  if printf '%s\n' "$direct_rlimit_output" | grep -Fxq "NEMOCLAW_DCODE_SHELL_RLIMIT_OK"; then
    pass "direct dcode launcher enforces and cannot raise nproc/nofile limits"
  else
    direct_rlimit_reason="$(printf '%s\n' "$direct_rlimit_output" | sed -n 's/^NEMOCLAW_DCODE_SHELL_RLIMIT_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    fail_test "direct dcode launcher does not enforce resource limits (${direct_rlimit_reason:-unknown contract mismatch})"
  fi

  # The status expansion belongs to the remote login shell.
  # shellcheck disable=SC2016
  empty_login_output="$(sandbox_login_exec 'timeout 10 dcode -n ""; status=$?; printf "\nNEMOCLAW_DCODE_EMPTY_EXIT:%s\n" "$status"' || true)"
  empty_login_exit="$(printf '%s' "$empty_login_output" | sed -n 's/.*NEMOCLAW_DCODE_EMPTY_EXIT:\([0-9]\+\).*/\1/p' | tail -n1)"
  if [ "$empty_login_exit" = "2" ] && printf '%s\n' "$empty_login_output" | is_empty_prompt_rejection; then
    pass "login-shell dcode rejects an empty non-interactive prompt with exit 2"
  else
    fail_test "login-shell dcode did not reject an empty non-interactive prompt with exit 2 (exit ${empty_login_exit:-unknown})"
  fi

  if empty_direct_output="$(sandbox_direct_dcode -n "")"; then
    empty_direct_exit=0
  else
    empty_direct_exit=$?
  fi
  if [ "$empty_direct_exit" = "2" ] && printf '%s\n' "$empty_direct_output" | is_empty_prompt_rejection; then
    pass "direct-exec dcode rejects an empty non-interactive prompt with exit 2"
  else
    fail_test "direct-exec dcode did not reject an empty non-interactive prompt with exit 2 (exit ${empty_direct_exit})"
  fi

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
  if printf '%s\n' "$config_output" | uses_native_openrouter_config; then
    native_openrouter=1
    openrouter_identity_output="$(sandbox_direct_dcode identity || true)"
    if printf '%s\n' "$openrouter_identity_output" | grep -Fxq "Provider: openrouter" \
      && printf '%s\n' "$openrouter_identity_output" | grep -Eq '^Model:[[:space:]]+openrouter:' \
      && printf '%s\n' "$openrouter_identity_output" | grep -Fxq "Endpoint: https://inference.local/v1"; then
      pass "installed dcode identity reports the native managed OpenRouter route"
    else
      fail_test "installed dcode identity does not report native OpenRouter consistently"
    fi
  else
    native_openrouter=0
    openrouter_identity_output=""
  fi

  # 2. Record whether direct DNS/hosts is absent. When it is, the following
  # login, direct-exec, and connect successes prove they do not depend on it;
  # a present route is informational and is not credited as that proof.
  dns_hosts_output="$(sandbox_exec "if ! command -v getent >/dev/null 2>&1; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PROBE_MISSING_GETENT; elif ! command -v timeout >/dev/null 2>&1; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PROBE_MISSING_TIMEOUT; elif timeout 5 getent hosts inference.local >/dev/null 2>&1; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PRESENT; else status=\$?; if [ \"\$status\" -eq 124 ]; then printf '%s\\n' NEMOCLAW_DCODE_DNS_PROBE_TIMEOUT; else printf '%s\\n' NEMOCLAW_DCODE_DNS_ABSENT; fi; fi")"
  if printf '%s\n' "$dns_hosts_output" | grep -Fxq "NEMOCLAW_DCODE_DNS_PROBE_MISSING_GETENT"; then
    direct_dns_state=unknown
    fail_test "required DNS diagnostic tool getent is unavailable in the sandbox"
  elif printf '%s\n' "$dns_hosts_output" | grep -Fxq "NEMOCLAW_DCODE_DNS_PROBE_MISSING_TIMEOUT"; then
    direct_dns_state=unknown
    fail_test "required DNS diagnostic tool timeout is unavailable in the sandbox"
  elif printf '%s\n' "$dns_hosts_output" | grep -Fxq "NEMOCLAW_DCODE_DNS_ABSENT"; then
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
    if [ "$native_openrouter" -eq 1 ]; then
      if printf '%s\n' "$headless_output" | grep -Fq "Usage Stats" \
        && printf '%s\n' "$headless_output" | grep -Eiq '(^|[[:space:]])openrouter([[:space:]]|$)'; then
        pass "headless usage output reports the native OpenRouter provider"
      else
        fail_test "headless usage output does not report the native OpenRouter provider"
      fi
    fi
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

  # 7. The user-facing bare-connect readiness path must route every observed
  # sandbox exec to the same sandbox used by the preceding lifecycle evidence.
  connect_output=""
  if connect_output="$(nemoclaw_connect_probe)"; then
    connect_exit=0
    pass "bare connect targeted the Deep Agents Code sandbox"
    pass "nemoclaw connect --probe-only accepted the managed inference route (direct DNS/hosts ${direct_dns_state})"
  else
    connect_exit=$?
    connect_target_reason="$(printf '%s\n' "$connect_output" | sed -n 's/^NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:\([a-z-]*\)$/\1/p' | tail -n1)"
    if [ -n "$connect_target_reason" ]; then
      fail_test "bare connect did not target the expected sandbox (${connect_target_reason})"
    else
      fail_test "nemoclaw connect --probe-only rejected the managed inference route (exit ${connect_exit})"
    fi
  fi

  # 8. Untrusted evidence from the image-installed helper must fail closed
  # before the user-facing connect path can invoke interactive session attach.
  fail_closed_connect_output="$(dcode_connect_fail_closed_contract || true)"
  fail_closed_connect_exit="$(printf '%s\n' "$fail_closed_connect_output" | sed -n 's/^NEMOCLAW_DCODE_UNTRUSTED_CONNECT_EXIT:\([0-9][0-9]*\)$/\1/p' | tail -n1)"
  if [ -n "$fail_closed_connect_exit" ] \
    && [ "$fail_closed_connect_exit" -ne 0 ] \
    && grep -Fq NEMOCLAW_DCODE_IMAGE_PROBE_USED <<<"$fail_closed_connect_output" \
    && grep -Fq NEMOCLAW_DCODE_SESSION_ATTACH_NOT_INVOKED <<<"$fail_closed_connect_output" \
    && grep -Fq "UNTRUSTED PREAMBLE" <<<"$fail_closed_connect_output" \
    && grep -Fq "did not return a trusted result" <<<"$fail_closed_connect_output"; then
    pass "connect rejects untrusted image-backed route evidence before session attach"
  else
    fail_test "connect did not fail closed before session attach for untrusted image-backed route evidence"
  fi

  # 9. No real secrets in managed config, runtime env files, artifacts, logs, or captured output.
  leak_scan="$(sandbox_exec "$(sandbox_artifact_scan_command)" || true)"
  combined="${config_output}
${openrouter_identity_output}
${leak_scan}
${entrypoint_rlimit_output}
${login_rlimit_output}
${interactive_rlimit_output}
${direct_rlimit_output}
${empty_login_output}
${empty_direct_output}
${dns_hosts_output}
${proxy_contract_output}
${route_output}
${headless_output}
${direct_headless_output}
${connect_output}
${fail_closed_connect_output}"
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
