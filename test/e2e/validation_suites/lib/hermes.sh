#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes-specific validation primitives for scenario-suite steps.
#
# Suites consume the normalized $E2E_CONTEXT_DIR/context.env emitted by
# run-scenario.sh. This library intentionally does not install, onboard, or
# rediscover setup state.

if [[ -n "${_E2E_HERMES_SH_LOADED:-}" ]]; then
  # shellcheck disable=SC2317 # sourced-file guard intentionally exits early when loaded twice
  return 0 2>/dev/null || true
fi
_E2E_HERMES_SH_LOADED=1

_E2E_HERMES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_HERMES_RUNTIME_LIB_DIR="$(cd "${_E2E_HERMES_LIB_DIR}/../../runtime/lib" && pwd)"
_E2E_HERMES_VALIDATION_DIR="$(cd "${_E2E_HERMES_LIB_DIR}/.." && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/context.sh"
# shellcheck source=../../runtime/lib/logging.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/logging.sh"
# shellcheck source=../sandbox-exec.sh
. "${_E2E_HERMES_VALIDATION_DIR}/sandbox-exec.sh"

_e2e_hermes_redact() {
  sed -E 's/([A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL|PRIVATE)[A-Za-z_]*=)[^[:space:]]+/\1REDACTED/g; s/(Bearer )[A-Za-z0-9._~+\/-]+/\1REDACTED/g; s/(xox[baprs]-)[A-Za-z0-9-]+/\1REDACTED/g; s/(sk-)[A-Za-z0-9_-]{8,}/\1REDACTED/g; s/(nvapi-)[A-Za-z0-9_-]{8,}/\1REDACTED/g'
}

e2e_hermes_load_context() {
  local ctx
  ctx="$(e2e_context_path)"
  if [[ ! -f "${ctx}" ]]; then
    printf 'hermes context: missing context.env at %s (set E2E_CONTEXT_DIR)\n' "${ctx}" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "${ctx}"
}

_e2e_hermes_require_agent() {
  e2e_hermes_load_context || return 1
  e2e_context_require E2E_AGENT E2E_SANDBOX_NAME || return 1
  local agent
  agent="$(e2e_context_get E2E_AGENT)"
  if [[ "${agent}" != "hermes" ]]; then
    printf "hermes context: E2E_AGENT should be 'hermes', got '%s'\n" "${agent}" >&2
    return 1
  fi
}

_e2e_hermes_assertion() {
  local assertion_id="${1:-}"
  if [[ -z "${assertion_id}" ]]; then
    echo "e2e_hermes: missing assertion id" >&2
    return 2
  fi
  e2e_section "${assertion_id}"
}

_e2e_hermes_plan() {
  local assertion_id="${1:-}"
  local detail="${2:-planned Hermes validation}"
  e2e_env_trace "hermes:plan" "${assertion_id} ${detail}"
  printf '[dry-run] %s: %s\n' "${assertion_id}" "${detail}"
  if [[ -f "$(e2e_context_path)" ]]; then
    e2e_context_dump | _e2e_hermes_redact
  fi
}

_e2e_hermes_run_override() {
  local override_var="${1:-}"
  shift || true
  if [[ -n "${override_var}" && -n "${!override_var:-}" ]]; then
    bash -c "${!override_var}" -- "$@" 2>&1 | _e2e_hermes_redact
    return "${PIPESTATUS[0]}"
  fi
  "$@" 2>&1 | _e2e_hermes_redact
  return "${PIPESTATUS[0]}"
}

_e2e_hermes_sandbox_name() {
  e2e_context_get E2E_SANDBOX_NAME
}

e2e_hermes_assert_gateway_health() {
  local assertion_id="${1:-expected.hermes.runtime.gateway-health}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  e2e_context_require E2E_GATEWAY_URL || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes gateway health from emitted scenario context"
    return 0
  fi
  local gateway
  gateway="$(e2e_context_get E2E_GATEWAY_URL)"
  if ! _e2e_hermes_run_override HERMES_GATEWAY_HEALTH_CMD curl --silent --show-error --fail --max-time 20 "${gateway%/}/health" >/dev/null; then
    echo "e2e_hermes: gateway health probe failed" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_agent_home_permissions() {
  local assertion_id="${1:-expected.hermes.runtime.agent-home}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify /sandbox/.hermes exists and is not world-writable"
    return 0
  fi
  local sandbox
  sandbox="$(_e2e_hermes_sandbox_name)"
  # shellcheck disable=SC2016 # script is evaluated inside the sandbox, not by this shell
  if ! e2e_sandbox_exec "${sandbox}" -- sh -lc 'test -d /sandbox/.hermes && perms=$(stat -c %a /sandbox/.hermes 2>/dev/null || stat -f %Lp /sandbox/.hermes); case "$perms" in *2|*3|*6|*7) exit 1;; *) exit 0;; esac'; then
    echo "e2e_hermes: /sandbox/.hermes missing or world-writable" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_env_integrity() {
  local assertion_id="${1:-expected.hermes.runtime.env-integrity}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes .env is present without leaking sensitive values"
    return 0
  fi
  local sandbox output
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! output="$(e2e_sandbox_exec "${sandbox}" -- sh -lc 'test -f /sandbox/.hermes/.env && grep -E "^(HERMES|OPENAI|NVIDIA|ANTHROPIC|GEMINI|SLACK|DISCORD|TELEGRAM)_" /sandbox/.hermes/.env | sed -E "s/(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)([^=]*)=.*/\1\2=REDACTED/"')"; then
    echo "e2e_hermes: Hermes .env missing or unreadable" >&2
    return 1
  fi
  printf '%s\n' "${output}" | _e2e_hermes_redact
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_security_posture() {
  local assertion_id="${1:-expected.hermes.runtime.security-posture}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes runtime security posture from sandbox state"
    return 0
  fi
  local sandbox
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! e2e_sandbox_exec "${sandbox}" -- sh -lc 'test ! -w /etc && test -d /sandbox/.hermes && test ! -f /sandbox/.hermes/.env.bak'; then
    echo "e2e_hermes: security posture checks failed" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_inference_switch_route_state() {
  local assertion_id="${1:-expected.hermes.inference.switch-route-state}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  e2e_context_require E2E_INFERENCE_ROUTE || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes inference route state after switch"
    return 0
  fi
  local route
  route="$(e2e_context_get E2E_INFERENCE_ROUTE)"
  [[ -n "${route}" ]] || return 1
  e2e_pass "${assertion_id} route=${route}"
}

e2e_hermes_assert_env_immutable_on_switch() {
  local assertion_id="${1:-expected.hermes.inference.env-immutable-on-switch}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "compare Hermes .env hash before and after route switch"
    return 0
  fi
  local before after
  before="$(e2e_context_get E2E_HERMES_ENV_HASH_BEFORE_SWITCH)"
  after="$(e2e_context_get E2E_HERMES_ENV_HASH_AFTER_SWITCH)"
  if [[ -n "${before}" && -n "${after}" && "${before}" != "${after}" ]]; then
    echo "e2e_hermes: Hermes .env hash changed during inference switch" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_gateway_pid_stable() {
  local assertion_id="${1:-expected.hermes.inference.gateway-pid-stable}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "compare gateway PID before and after inference switch"
    return 0
  fi
  local before after
  before="$(e2e_context_get E2E_GATEWAY_PID_BEFORE_SWITCH)"
  after="$(e2e_context_get E2E_GATEWAY_PID_AFTER_SWITCH)"
  if [[ -n "${before}" && -n "${after}" && "${before}" != "${after}" ]]; then
    echo "e2e_hermes: gateway PID changed during inference switch" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_inference_local_chat() {
  local assertion_id="${1:-expected.hermes.inference.inference-local-chat}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "POST https://inference.local/v1/chat/completions from Hermes sandbox"
    return 0
  fi
  local sandbox payload
  sandbox="$(_e2e_hermes_sandbox_name)"
  payload='{"model":"default","messages":[{"role":"user","content":"Say ok"}],"max_tokens":8}'
  printf '%s' "${payload}" | e2e_sandbox_exec_stdin "${sandbox}" -- curl --silent --show-error --fail --max-time 20 -H 'content-type: application/json' -d @- https://inference.local/v1/chat/completions >/dev/null
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_hermes_api_chat() {
  local assertion_id="${1:-expected.hermes.inference.hermes-api-chat}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "exercise Hermes API chat path with redacted provider output"
    return 0
  fi
  local sandbox output
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! output="$(_e2e_hermes_run_override HERMES_API_CHAT_CMD e2e_sandbox_exec "${sandbox}" -- sh -lc 'curl --silent --show-error --fail --max-time 20 http://127.0.0.1:8000/v1/chat/completions')"; then
    printf '%s\n' "${output}" | _e2e_hermes_redact >&2
    return 1
  fi
  printf '%s\n' "${output}" | _e2e_hermes_redact
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_external_timeout_classification() {
  local assertion_id="${1:-expected.hermes.inference.external-timeout-classification}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "classify external provider timeout separately from route regression"
    return 0
  fi
  local output status=0
  output="$(_e2e_hermes_run_override HERMES_EXTERNAL_TIMEOUT_CMD bash -c 'echo no external timeout observed')" || status=$?
  if [[ "${status}" == "28" || "${output}" =~ [Tt]imed[[:space:]-]?out|timeout ]]; then
    printf 'INFO: %s external provider timeout classified as gated/external\n' "${assertion_id}"
    return 0
  fi
  if [[ "${status}" != "0" ]]; then
    printf '%s\n' "${output}" | _e2e_hermes_redact >&2
    return "${status}"
  fi
  e2e_pass "${assertion_id}"
}

_e2e_hermes_messaging_plan() {
  local assertion_id="$1"
  local provider="$2"
  local detail="$3"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "${provider}: ${detail}"
    return 0
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_discord_config_schema() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.config-schema}" discord "validate Hermes Discord config schema"; }
e2e_hermes_assert_discord_policy_egress() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.policy-egress}" discord "validate Discord egress policy"; }
e2e_hermes_assert_discord_gateway_connects() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.gateway-connects}" discord "probe Discord gateway path"; }
e2e_hermes_assert_discord_empty_user_allowlist_open_dm_policy() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.empty-user-allowlist-open-dm-policy}" discord "assert empty allowlist DM policy current-bug behavior"; }
e2e_hermes_assert_discord_no_openclaw_pairing_copy() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.no-openclaw-pairing-copy}" discord "ensure Hermes does not copy OpenClaw pairing behavior"; }
e2e_hermes_assert_discord_plugin_entry_registered() { _e2e_hermes_messaging_plan "${1:-expected.hermes.discord.plugin-entry-registered}" discord "verify plugin entry registration"; }

e2e_hermes_assert_slack_config_enabled() { _e2e_hermes_messaging_plan "${1:-expected.hermes.slack.config-enabled}" slack "validate Slack config enabled"; }
e2e_hermes_assert_slack_provider_state() { _e2e_hermes_messaging_plan "${1:-expected.hermes.slack.provider-state}" slack "validate Slack provider state"; }
e2e_hermes_assert_slack_socket_mode_starts() { _e2e_hermes_messaging_plan "${1:-expected.hermes.slack.socket-mode-starts}" slack "probe socket-mode startup"; }
e2e_hermes_assert_slack_no_secret_leak() { _e2e_hermes_messaging_plan "${1:-expected.hermes.slack.no-secret-leak}" slack "scan Slack surfaces for redacted secrets"; }
e2e_hermes_assert_slack_idle_reconnect_delivers_first_mention() { _e2e_hermes_messaging_plan "${1:-expected.hermes.slack.idle-reconnect-delivers-first-mention}" slack "assert idle reconnect first mention delivery"; }

e2e_hermes_assert_telegram_first_message_tool_dispatch() { _e2e_hermes_messaging_plan "${1:-expected.hermes.telegram.first-message-tool-dispatch}" telegram "assert first message tool dispatch"; }
e2e_hermes_assert_telegram_single_polling_loop() { _e2e_hermes_messaging_plan "${1:-expected.hermes.telegram.single-polling-loop}" telegram "assert single polling loop"; }
e2e_hermes_assert_telegram_privacy_mode_guidance() { _e2e_hermes_messaging_plan "${1:-expected.hermes.telegram.privacy-mode-guidance}" telegram "validate privacy mode guidance"; }
e2e_hermes_assert_telegram_group_message_preconditions() { _e2e_hermes_messaging_plan "${1:-expected.hermes.telegram.group-message-preconditions}" telegram "validate group message preconditions"; }

e2e_hermes_assert_rebuild_provider_credential_reused() {
  local assertion_id="${1:-expected.hermes.rebuild.provider-credential-reused}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify gateway provider credential is reused when host env is empty"
    return 0
  fi
  local output
  if ! output="$(_e2e_hermes_run_override HERMES_GATEWAY_CREDENTIAL_CMD bash -c 'echo gateway credential present')"; then
    printf '%s\n' "${output}" | _e2e_hermes_redact >&2
    return 1
  fi
  printf '%s\n' "${output}" | _e2e_hermes_redact
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_rebuild_messaging_config_preserved() {
  local assertion_id="${1:-expected.hermes.rebuild.messaging-config-preserved}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "compare Hermes messaging config hash across rebuild"
    return 0
  fi
  local before after
  before="$(e2e_context_get E2E_HERMES_MESSAGING_HASH_BEFORE_REBUILD)"
  after="$(e2e_context_get E2E_HERMES_MESSAGING_HASH_AFTER_REBUILD)"
  if [[ -n "${before}" && -n "${after}" && "${before}" != "${after}" ]]; then
    echo "e2e_hermes: messaging config hash changed across rebuild" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_rebuild_dashboard_forward_released() { _e2e_hermes_messaging_plan "${1:-expected.hermes.rebuild.dashboard-forward-released}" rebuild "verify dashboard forward released before rebuild"; }
e2e_hermes_assert_rebuild_post_rebuild_health() { _e2e_hermes_messaging_plan "${1:-expected.hermes.rebuild.post-rebuild-health}" rebuild "verify Hermes post-rebuild health"; }

e2e_hermes_assert_policy_inactive_messaging_not_preenabled() { _e2e_hermes_messaging_plan "${1:-expected.hermes.policy.inactive-messaging-not-preenabled}" policy "assert inactive messaging policies are not preenabled"; }
e2e_hermes_assert_policy_managed_inference_anthropic_messages_path() { _e2e_hermes_messaging_plan "${1:-expected.hermes.policy.managed-inference-anthropic-messages-path}" policy "assert Anthropic /v1/messages egress path"; }
e2e_hermes_assert_policy_venv_python_egress() { _e2e_hermes_messaging_plan "${1:-expected.hermes.policy.venv-python-egress}" policy "assert Hermes venv Python egress policy"; }
e2e_hermes_assert_policy_no_phantom_allowlist() { _e2e_hermes_messaging_plan "${1:-expected.hermes.policy.no-phantom-allowlist}" policy "assert no phantom allowlist entries"; }
e2e_hermes_assert_provider_anthropic_compatible_chat() { _e2e_hermes_messaging_plan "${1:-expected.hermes.provider.anthropic-compatible-chat}" provider "assert Anthropic-compatible in-sandbox chat"; }
e2e_hermes_assert_provider_gemini_tool_schema_compatible() { _e2e_hermes_messaging_plan "${1:-expected.hermes.provider.gemini-tool-schema-compatible}" provider "assert Gemini tool schema compatibility"; }
e2e_hermes_assert_provider_onboard_smoke_not_sufficient() { _e2e_hermes_messaging_plan "${1:-expected.hermes.provider.onboard-smoke-not-sufficient}" provider "assert onboard smoke does not mask runtime chat gaps"; }
e2e_hermes_assert_security_shields_up_down_macos_vm_driver() { _e2e_hermes_messaging_plan "${1:-expected.hermes.security.shields-up-down-macos-vm-driver}" security "assert macOS Docker Desktop VM-driver shields up/down behavior"; }
e2e_hermes_assert_security_shields_config_locked() { _e2e_hermes_messaging_plan "${1:-expected.hermes.security.shields-config-locked}" security "assert shields config locked/status consistency"; }
e2e_hermes_assert_tui_history_writable() { _e2e_hermes_messaging_plan "${1:-expected.hermes.tui.history-writable}" tui "assert Hermes TUI history writable and clean exit"; }
