#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code launcher for NemoClaw/OpenShell sandboxes.

set -euo pipefail

if [ "${1:-}" = "--nemoclaw-mcp-capability" ] && [ "$#" -eq 1 ]; then
  printf '%s\n' 'NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2'
  exit 0
fi

unset BASH_ENV ENV OPENAI_PROXY

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export LANGGRAPH_NO_VERSION_CHECK=true
export LANGGRAPH_CLI_NO_ANALYTICS=1
export OTEL_ENABLED=false
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_LANGSMITH_TRACING=false
export DEEPAGENTS_CODE_LANGSMITH_TRACING_V2=false
export DEEPAGENTS_CODE_LANGCHAIN_TRACING=false
export DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2=false
export LANGSMITH_TRACING=false
export LANGSMITH_TRACING_V2=false
export LANGCHAIN_TRACING=false
export LANGCHAIN_TRACING_V2=false
export DEEPAGENTS_CODE_OFFLINE=1
export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"
unset PYTHONHOME PYTHONPATH

readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"
readonly OPENSHELL_ENV_PLACEHOLDER_PREFIX="openshell:resolve:env:"
readonly DEEPAGENTS_CONFIG_FILE="/sandbox/.deepagents/config.toml"
readonly OPENSHELL_TLS_KEY_PATH="/etc/openshell/tls/client/tls.key"
readonly DEEPAGENTS_AUTH_FILE="/sandbox/.deepagents/.state/auth.json"
readonly DEEPAGENTS_CODEX_AUTH_FILE="/sandbox/.deepagents/.state/chatgpt-auth.json"

run_dcode() {
  unset PYTHONHOME PYTHONPATH
  exec /opt/venv/bin/python3 -I -m deepagents_code "$@"
}

# SECURITY: dcode runtime/.env secret guard.
# - Invalid state: a user-controlled runtime env var or /sandbox/.deepagents/.env
#   entry can inject a provider secret into Deep Agents Code, bypassing the
#   managed inference plane and `nemoclaw credentials`.
# - Source boundary: upstream `deepagents_code` is third-party Python; the
#   canonical secret-pattern contract lives at src/lib/security/secret-patterns.ts.
#   Neither is callable from the Bash wrapper before exec, so this matcher
#   mirrors canonical TOKEN_PREFIX_PATTERNS and SECRET_BLOCK_PATTERNS plus the
#   Bearer- and name-context semantics from CONTEXT_PATTERNS that apply to a
#   name=value boundary.
# - Source-fix constraint: the upstream maintainer surface is independent; a
#   Node shim at this boundary would double the process count and add another
#   supply-chain hop. Bash is the only entrypoint available before exec.
# - Scope:
#     * Token-prefix and Bearer-prefix matches operate as unanchored substring
#       regex (catches embedded/wrapped tokens).
#     * Private-key block matching rejects canonical BEGIN/END markers across
#       raw or escaped bodies before mutable metadata can reach status output.
#     * Name-context rejection fires case-insensitively when the variable name
#       ends in a credential keyword (_KEY, _TOKEN, _SECRET, _PASSWORD,
#       _CREDENTIAL, _PASS) and the value is at least 10 chars (mirroring
#       CONTEXT_PATTERNS minimum length).
#     * Managed messaging values (SLACK_BOT_TOKEN, SLACK_APP_TOKEN,
#       TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN) are allowed only when the value
#       matches the platform-specific token shape AND does not embed a
#       non-platform canonical secret prefix.
#     * The env-file parser strips a leading `export ` keyword (mirroring
#       python-dotenv) and rejects values containing dotenv expansion ($VAR,
#       ${VAR}), command substitution ($(...) or backticks), because upstream
#       dcode may resolve those to credentials the raw scan cannot see.
#     * Runtime env iteration uses `env -0` so names that are not valid Bash
#       identifiers (e.g. with hyphens) are still classified.
#     * OpenShell credential placeholders are allowed only when the complete
#       value names the same valid env key, either canonically or with an
#       OpenShell `v<digits>_` revision prefix. Any other occurrence is refused.
# - Regression: test/langchain-deepagents-code-secret-pattern-parity.test.ts
#   pins the canonical TOKEN_PREFIX_PATTERNS, CONTEXT_PATTERNS, and
#   SECRET_BLOCK_PATTERNS fingerprints (source + flags), while
#   test/langchain-deepagents-code-image-credentials.test.ts feeds the shared
#   positive corpus through this wrapper. Any canonical change trips the parity
#   gate and forces this matcher (and its samples) to update.
#   The live no-network acceptance clause is covered by
#   test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh
#   which exercises a real sandbox launch under `nemoclaw exec` and inspects
#   sandbox logs for outgoing requests during the rejected interval.
# - Removal condition: drop this guard when (a) upstream `deepagents_code` itself
#   rejects secret-shaped runtime/.env values, or (b) all dcode invocations
#   route through a Node entrypoint that imports the canonical patterns directly.

has_context_secret_shape() {
  local upper
  upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  # The outer class accepts '=', ':', or whitespace; [:space:] is the nested
  # POSIX character class understood by Bash's [[ string =~ regex ]] operator.
  [[ "$upper" =~ (_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=:[:space:]][\'\"]?[A-Z0-9_.+/=-]{10,} ]]
}

has_bearer_secret_shape() {
  # Spell out ECMAScript `\s` so matching does not depend on the host locale's
  # POSIX `[:space:]` definition (notably for NBSP, narrow NBSP, and BOM).
  local ecmascript_whitespace
  # Use UTF-8 byte escapes so the expression is identical in C and UTF-8
  # locales; Bash leaves `\u` escapes literal in the C locale.
  ecmascript_whitespace=$'([\t\n\v\f\r ]|\xC2\xA0|\xE1\x9A\x80'
  ecmascript_whitespace+=$'|\xE2\x80\x80|\xE2\x80\x81|\xE2\x80\x82|\xE2\x80\x83'
  ecmascript_whitespace+=$'|\xE2\x80\x84|\xE2\x80\x85|\xE2\x80\x86|\xE2\x80\x87'
  ecmascript_whitespace+=$'|\xE2\x80\x88|\xE2\x80\x89|\xE2\x80\x8A|\xE2\x80\xA8'
  ecmascript_whitespace+=$'|\xE2\x80\xA9|\xE2\x80\xAF|\xE2\x81\x9F|\xE3\x80\x80|\xEF\xBB\xBF)'
  [[ "$1" =~ [Bb][Ee][Aa][Rr][Ee][Rr]${ecmascript_whitespace}+[A-Za-z0-9_.+/=-]{10,} ]]
}

has_private_key_block_shape() {
  local value="$1"
  local begin_marker="-----BEGIN "
  local end_marker="-----END "
  case "$value" in
    *"$begin_marker"*"PRIVATE KEY-----"*"$end_marker"*"PRIVATE KEY-----"*)
      return 0
      ;;
  esac
  return 1
}

has_multiline_private_key_block_shape() {
  local value="$1"
  local begin_marker="-----BEGIN "
  local end_marker="-----END "
  local newline=$'\n'
  case "$value" in
    *"$begin_marker"*"PRIVATE KEY-----"*"$newline"*"$end_marker"*"PRIVATE KEY-----"*)
      return 0
      ;;
  esac
  return 1
}

has_non_slack_secret_shape() {
  local value="$1"
  if has_private_key_block_shape "$value"; then
    return 0
  fi
  if [[ "$value" =~ (sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ sk-[A-Za-z0-9_-]{20,} ]]; then
    return 0
  fi
  if [[ "$value" =~ (nvapi-|nvcf-|ghp_|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ github_pat_[A-Za-z0-9_]{30,} ]]; then
    return 0
  fi
  if [[ "$value" =~ A(K|S)IA[A-Z0-9]{16} ]]; then
    return 0
  fi
  if [[ "$value" =~ bot[0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,} ]]; then
    return 0
  fi
  if has_bearer_secret_shape "$value"; then
    return 0
  fi
  if has_context_secret_shape "$value"; then
    return 0
  fi
  if [[ "$value" =~ lsv2_(pt|sk)_[A-Za-z0-9]{10,}(_[A-Za-z0-9]+)* ]]; then
    return 0
  fi
  return 1
}

is_managed_token_value_for_name() {
  local name="$1"
  local value="$2"
  local len=${#value}
  case "$name" in
    DEEPAGENTS_CODE_OPENAI_API_KEY)
      [ "$value" = "nemoclaw-managed-inference" ] && return 0
      ;;
    SLACK_BOT_TOKEN)
      case "$value" in
        xoxb-*)
          if [ "$len" -ge 15 ] && ! has_non_slack_secret_shape "$value"; then
            return 0
          fi
          ;;
      esac
      ;;
    SLACK_APP_TOKEN)
      case "$value" in
        xapp-*)
          if [ "$len" -ge 15 ] && ! has_non_slack_secret_shape "$value"; then
            return 0
          fi
          ;;
      esac
      ;;
    TELEGRAM_BOT_TOKEN)
      if [[ "$value" =~ ^bot[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
        return 0
      fi
      if [[ "$value" =~ ^[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
        return 0
      fi
      ;;
    DISCORD_BOT_TOKEN)
      if [[ "$value" =~ ^[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$ ]]; then
        return 0
      fi
      ;;
  esac
  return 1
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

is_secret_shaped_value() {
  local value="$1"
  if has_private_key_block_shape "$value"; then
    return 0
  fi
  if [[ "$value" =~ (sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ sk-[A-Za-z0-9_-]{20,} ]]; then
    return 0
  fi
  if [[ "$value" =~ (nvapi-|nvcf-|ghp_|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ github_pat_[A-Za-z0-9_]{30,} ]]; then
    return 0
  fi
  if [[ "$value" =~ xox[bpas]-[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ xapp-[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ A(K|S)IA[A-Z0-9]{16} ]]; then
    return 0
  fi
  if [[ "$value" =~ bot[0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,} ]]; then
    return 0
  fi
  if has_bearer_secret_shape "$value"; then
    return 0
  fi
  if has_context_secret_shape "$value"; then
    return 0
  fi
  if [[ "$value" =~ lsv2_(pt|sk)_[A-Za-z0-9]{10,}(_[A-Za-z0-9]+)* ]]; then
    return 0
  fi
  return 1
}

has_credential_name_context() {
  local upper
  upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  case "$upper" in
    KEY | API_KEY | TOKEN | SECRET | PASSWORD | PASS | CREDENTIAL)
      return 0
      ;;
    LANGSMITH_RUNS_ENDPOINTS | LANGCHAIN_RUNS_ENDPOINTS)
      return 0
      ;;
    OTEL_EXPORTER_OTLP_ENDPOINT | OTEL_EXPORTER_OTLP_TRACES_ENDPOINT | OTEL_EXPORTER_OTLP_HEADERS | OTEL_EXPORTER_OTLP_TRACES_HEADERS)
      return 0
      ;;
    *_API_KEY | *_KEY | *_TOKEN | *_SECRET | *_PASSWORD | *_PASS | *_CREDENTIAL)
      return 0
      ;;
  esac
  return 1
}

# SECURITY: OpenShell's supervisor injects this mounted TLS key path into the
# runtime environment. Allow only the exact name/value pair after the generic
# value scan. Never allow the name alone, and never apply this exception to the
# mutable Deep Agents Code .env file.
is_allowed_openshell_runtime_value() {
  local name="$1"
  local value="$2"
  [ "$name" = "OPENSHELL_TLS_KEY" ] && [ "$value" = "$OPENSHELL_TLS_KEY_PATH" ]
}

is_dynamic_dotenv_value() {
  local value="$1"
  case "$value" in
    *\$[A-Za-z_]* | *\$\{* | *\$\(* | *\`*)
      return 0
      ;;
  esac
  return 1
}

is_openshell_env_placeholder_for_name() {
  local name="$1"
  local value="$2"
  local canonical revision_prefix revision_suffix versioned revision

  # OPENSHELL_TLS_KEY is supervisor infrastructure, not a provider credential.
  # Only its exact mounted path is accepted from the runtime environment below;
  # never let a provider placeholder bypass that name/value allowlist.
  [ "$name" != "OPENSHELL_TLS_KEY" ] || return 1

  # Keep this identifier contract aligned with OpenShell provider env keys.
  if [ -z "$name" ] || [ "${#name}" -gt 128 ]; then
    return 1
  fi
  case "$name" in
    [0123456789]* | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_]*) return 1 ;;
  esac

  canonical="${OPENSHELL_ENV_PLACEHOLDER_PREFIX}${name}"
  [ "$value" = "$canonical" ] && return 0

  revision_prefix="${OPENSHELL_ENV_PLACEHOLDER_PREFIX}v"
  revision_suffix="_${name}"
  versioned="${value#"$revision_prefix"}"
  [ "$versioned" != "$value" ] || return 1
  revision="${versioned%"$revision_suffix"}"
  [ "$revision" != "$versioned" ] || return 1
  [ "$versioned" = "$revision$revision_suffix" ] || return 1
  [ "${#revision}" -le 20 ] || return 1
  case "$revision" in
    "" | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

refuse_secret_env() {
  local source="$1"
  local name="$2"
  printf 'dcode: refusing to start — %s contains a secret-shaped value in %s.\n' "$source" "$name" >&2
  printf "  Remove it from the environment, or use 'nemoclaw credentials' to register provider keys.\n" >&2
  exit 2
}

refuse_dynamic_env() {
  local source="$1"
  local name="$2"
  printf 'dcode: refusing to start — %s contains a dynamic value in %s (variable expansion, command substitution, or backtick).\n' "$source" "$name" >&2
  printf "  Use a literal value, or register provider keys with 'nemoclaw credentials'.\n" >&2
  exit 2
}

refuse_invalid_openshell_placeholder() {
  local source="$1"
  local name="$2"
  printf 'dcode: refusing to start — %s contains an invalid OpenShell credential placeholder in %s.\n' "$source" "$name" >&2
  printf '  Use only the exact placeholder for that same environment variable.\n' >&2
  exit 2
}

refuse_auth_store_credentials() {
  local source="$1"
  printf 'dcode: refusing to start — %s contains stored Deep Agents Code credentials.\n' "$source" >&2
  printf "  Remove them and use 'nemoclaw credentials' plus NemoClaw policy/configuration instead.\n" >&2
  exit 2
}

assert_no_secret_runtime_env() {
  local pair name value
  while IFS= read -r -d '' pair; do
    name="${pair%%=*}"
    [ "$name" != "$pair" ] || continue
    value="${pair#*=}"
    if [[ "$value" == *"$OPENSHELL_ENV_PLACEHOLDER_PREFIX"* ]]; then
      if is_openshell_env_placeholder_for_name "$name" "$value"; then
        continue
      fi
      refuse_invalid_openshell_placeholder "runtime environment variable" "$name"
    fi
    if is_managed_token_value_for_name "$name" "$value"; then
      continue
    fi
    if is_secret_shaped_value "$value"; then
      refuse_secret_env "runtime environment variable" "$name"
    fi
    if has_credential_name_context "$name" && [ ${#value} -ge 10 ] && ! is_allowed_openshell_runtime_value "$name" "$value"; then
      refuse_secret_env "runtime environment variable" "$name"
    fi
  done < <(env -0)
}

assert_no_secret_env_file() {
  local env_file="$DEEPAGENTS_ENV_FILE"
  [ -r "$env_file" ] || return 0
  local -a lines=()
  local env_file_content line key value
  # Scan the whole file before line parsing so raw multiline blocks cannot put
  # their begin and end markers on different physical dotenv lines.
  env_file_content="$(<"$env_file")"
  if has_multiline_private_key_block_shape "$env_file_content"; then
    refuse_secret_env "$env_file" "private-key block"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    lines+=("$line")
  done <"$env_file"
  [ "${#lines[@]}" -gt 0 ] || return 0
  for line in "${lines[@]}"; do
    line="${line%$'\r'}"
    line="$(trim_whitespace "$line")"
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac
    case "$line" in
      export[[:space:]]*)
        line="${line#export}"
        line="$(trim_whitespace "$line")"
        ;;
    esac
    key="${line%%=*}"
    [ "$key" != "$line" ] || continue
    value="${line#*=}"
    key="$(trim_whitespace "$key")"
    value="$(trim_whitespace "$value")"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac
    value="$(trim_whitespace "$value")"
    if is_dynamic_dotenv_value "$value"; then
      refuse_dynamic_env "$env_file" "$key"
    fi
    if [[ "$value" == *"$OPENSHELL_ENV_PLACEHOLDER_PREFIX"* ]]; then
      if is_openshell_env_placeholder_for_name "$key" "$value"; then
        continue
      fi
      refuse_invalid_openshell_placeholder "$env_file" "$key"
    fi
    if is_managed_token_value_for_name "$key" "$value"; then
      continue
    fi
    if is_secret_shaped_value "$value"; then
      refuse_secret_env "$env_file" "$key"
    fi
    if has_credential_name_context "$key" && [ ${#value} -ge 10 ]; then
      refuse_secret_env "$env_file" "$key"
    fi
  done
}

assert_no_auth_store_credentials() {
  local auth_file="$DEEPAGENTS_AUTH_FILE"
  # Absent auth.json is normal in a fresh sandbox — allow launch.
  [ -e "$auth_file" ] || return 0
  # Present-but-unreadable is suspicious (e.g. permissions manipulated to
  # hide credentials from this scan). Refuse rather than treat as clean.
  [ -r "$auth_file" ] || refuse_auth_store_credentials "$auth_file"
  set +e
  # Exit 0 = confirmed clean (no truthy credentials); any nonzero = refuse.
  # This closes the malformed-JSON bypass: a file dcode's own loader might
  # still parse should not pass this gate unexamined.
  /opt/venv/bin/python3 -I - "$auth_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    sys.exit(1)
# Schema pin: detection assumes a truthy top-level "credentials" key,
# matching the auth.json shape in deepagents-code==0.1.34. Nested or
# renamed shapes ({"auth":{...}}, {"state":{"credentials":...}}, top-level
# list) are not detected. When bumping the upstream pin, re-review this
# assumption against the new auth.json schema.
credentials = data.get("credentials") if isinstance(data, dict) else None
sys.exit(1 if credentials else 0)
PY
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    refuse_auth_store_credentials "$auth_file"
  fi
}

assert_no_codex_auth_credentials() {
  local auth_file="$DEEPAGENTS_CODEX_AUTH_FILE"
  # ChatGPT OAuth stores a complete bearer/refresh-token bundle in this
  # separate file. Any presence (including a dangling symlink) is credential
  # state and therefore invalid in the managed harness.
  if [ -e "$auth_file" ] || [ -L "$auth_file" ]; then
    refuse_auth_store_credentials "$auth_file"
  fi
}

assert_no_secret_runtime_env
assert_no_secret_env_file
assert_no_auth_store_credentials
assert_no_codex_auth_credentials

# SECURITY: managed identity/status display boundary.
# - Invalid state: config.toml and runtime environment values are mutable inside
#   the sandbox and can contain terminal controls, credentials, unsafe endpoint
#   components, or TOML forms outside the generated NemoClaw contract.
# - Source boundary: this wrapper is the final boundary before those values are
#   printed. Validating only the config writer would not protect later sandbox
#   mutations, and upstream dcode does not expose a validated identity API.
# - Source-fix constraint: this pre-exec Bash entrypoint cannot import the
#   canonical TypeScript filters or a full TOML parser without adding a process
#   and dependency. It therefore reads only known generated sections and exact
#   quoted scalars; arrays, inline comments, and other forms are not accepted.
# - Regression: test/dcode-wrapper-identity.test.ts covers malformed scalars,
#   terminal controls, oversized and secret-shaped metadata, and unsafe endpoint
#   forms. The composed startup/status handoff has a separate integration test.
# - Removal condition: replace these local readers/filters when upstream dcode
#   provides a validated identity API or every invocation uses a Node entrypoint
#   that imports the canonical TypeScript contracts and a real TOML parser.
toml_section_scalar() {
  local section="$1"
  local key="$2"
  local line current_section=""
  [ -r "$DEEPAGENTS_CONFIG_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim_whitespace "$line")"
    case "$line" in
      \[*\])
        current_section="${line#\[}"
        current_section="${current_section%\]}"
        continue
        ;;
    esac
    [ "$current_section" = "$section" ] || continue
    case "$line" in
      "$key = \""*)
        line="${line#"$key = \""}"
        case "$line" in
          *\")
            printf '%s' "${line%\"}"
            return 0
            ;;
        esac
        ;;
    esac
  done <"$DEEPAGENTS_CONFIG_FILE"
  return 0
}

toml_provider_metadata() {
  local field="$1"
  local line route provider _api
  [ -r "$DEEPAGENTS_CONFIG_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "# NemoClaw provider route: "*)
        line="${line#"# NemoClaw provider route: "}"
        IFS=';' read -r route provider _api <<<"$line"
        route="$(trim_whitespace "$route")"
        provider="$(trim_whitespace "$provider")"
        case "$provider" in
          "upstream provider: "*) provider="${provider#"upstream provider: "}" ;;
          *) provider="" ;;
        esac
        case "$field" in
          route) printf '%s' "$route" ;;
          provider) printf '%s' "$provider" ;;
        esac
        return 0
        ;;
    esac
  done <"$DEEPAGENTS_CONFIG_FILE"
  return 0
}

is_safe_dcode_agent_name() {
  local value="$1"
  local pattern='^[A-Za-z0-9_ -]+$'
  local LC_ALL=C
  [ -n "$value" ] || return 1
  [ -n "$(trim_whitespace "$value")" ] || return 1
  [[ "$value" =~ $pattern ]]
}

resolve_dcode_agent() {
  local config_dir candidate
  config_dir="${DEEPAGENTS_CONFIG_FILE%/*}"
  candidate="$(toml_section_scalar agents default)"
  if is_safe_dcode_agent_name "$candidate" && [ -d "$config_dir/$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(toml_section_scalar agents recent)"
  if is_safe_dcode_agent_name "$candidate" && [ -d "$config_dir/$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  printf '%s' 'agent (default)'
}

terminal_safe_identity_value() {
  local value="$1"
  local fallback="${2:-}"
  local LC_ALL=C
  if [ ${#value} -gt 256 ] || [[ "$value" =~ [[:cntrl:]] ]] || is_secret_shaped_value "$value"; then
    printf '%s' "$fallback"
  else
    printf '%s' "$value"
  fi
}

safe_endpoint_identity_value() {
  local value lower_value scheme authority
  value="$(terminal_safe_identity_value "$1")"
  [ -n "$value" ] || return 0
  case "$value" in
    *\\* | *\?* | *\#*) return 0 ;;
  esac
  lower_value="${value,,}"
  # Encoded query, fragment, userinfo, or percent delimiters can conceal
  # credential-bearing endpoint components from the literal checks above.
  case "$lower_value" in
    *%3f* | *%23* | *%40* | *%25*) return 0 ;;
  esac
  scheme="${value%%://*}"
  [ "$scheme" != "$value" ] || return 0
  case "${scheme,,}" in
    http | https) ;;
    *) return 0 ;;
  esac
  authority="${value#*://}"
  authority="${authority%%/*}"
  case "$authority" in
    "" | *@*) return 0 ;;
  esac
  printf '%s' "$value"
}

print_identity() {
  local sandbox_name agent model endpoint route provider
  sandbox_name="$(terminal_safe_identity_value "${NEMOCLAW_SANDBOX_NAME:-unknown}" unknown)"
  agent="$(terminal_safe_identity_value "$(resolve_dcode_agent)" 'agent (default)')"
  model="$(terminal_safe_identity_value "$(toml_section_scalar models default)")"
  [ -n "$model" ] || model="$(terminal_safe_identity_value "$(toml_section_scalar models recent)")"
  endpoint="$(toml_section_scalar models.providers.openai base_url)"
  route="$(terminal_safe_identity_value "$(toml_provider_metadata route)")"
  provider="$(terminal_safe_identity_value "$(toml_provider_metadata provider)")"
  [ -n "$endpoint" ] || endpoint="${OPENAI_BASE_URL:-}"
  endpoint="$(safe_endpoint_identity_value "$endpoint")"
  printf 'Sandbox:  %s\n' "$sandbox_name"
  printf 'Harness:  %s\n' 'langchain-deepagents-code'
  printf 'Agent:    %s\n' "$agent"
  if [ -n "$route" ]; then
    printf 'Route:    %s\n' "$route"
  fi
  if [ -n "$provider" ]; then
    printf 'Provider: %s\n' "$provider"
  fi
  if [ -n "$model" ]; then
    printf 'Model:    %s\n' "$model"
  fi
  if [ -n "$endpoint" ]; then
    printf 'Endpoint: %s\n' "$endpoint"
  fi
  printf 'Runtime:  %s\n' 'Deep Agents Code (terminal)'
}

print_managed_help() {
  cat <<'EOF'
NemoClaw-managed commands:
  dcode status      Show managed sandbox and dcode runtime identity
  dcode whoami      Alias for dcode status
  dcode identity    Alias for dcode status

EOF
}

case "${1:-}" in
  status | whoami | identity)
    print_identity
    exit 0
    ;;
  --help | -h | help)
    print_managed_help
    run_dcode "$@"
    ;;
  --version | -v | -V)
    run_dcode "$@"
    ;;
esac

unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST

reject_managed_override() {
  local posture="$1"
  local arg="$2"
  printf 'NemoClaw manages Deep Agents Code %s; remove %s and use NemoClaw policy/configuration instead.\n' "$posture" "$arg" >&2
  exit 2
}

case "${1:-}" in
  mcp)
    reject_managed_override "MCP posture" "mcp"
    ;;
  update | install)
    reject_managed_override "dependency update posture" "${1:-}"
    ;;
  auth)
    reject_managed_override "credential posture" "auth"
    ;;
  tools)
    case "${2:-}" in
      list | help | "" | -h | --help)
        : # read-only inspection subcommands pass through
        ;;
      *)
        reject_managed_override "managed tool set posture" "tools ${2:-}"
        ;;
    esac
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    --sandbox | --sandbox=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-id | --sandbox-id=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-snapshot-name | --sandbox-snapshot-name=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-setup | --sandbox-setup=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --mcp-config | --mcp-config=* | --trust-project-mcp | --no-mcp | --no-mcp=*)
      reject_managed_override "MCP posture" "$arg"
      ;;
    --shell-allow-list | --shell-allow-list=* | -S | -S?*)
      reject_managed_override "shell allow-list posture" "$arg"
      ;;
    --u | --up | --upd | --upda | --updat | --update | --update=*)
      reject_managed_override "dependency update posture" "$arg"
      ;;
    --auto-u | --auto-up | --auto-upd | --auto-upda | --auto-updat | --auto-update | --auto-update=*)
      reject_managed_override "dependency update posture" "$arg"
      ;;
    --ins | --inst | --insta | --instal | --install | --install=*)
      reject_managed_override "dependency update posture" "$arg"
      ;;
    --model-p | --model-p=* | --model-pa | --model-pa=* | --model-par | --model-par=* | --model-para | --model-para=* | --model-param | --model-param=* | --model-params | --model-params=*)
      reject_managed_override "model parameter posture" "$arg"
      ;;
    --rubric-m | --rubric-m=* | --rubric-mo | --rubric-mo=* | --rubric-mod | --rubric-mod=* | --rubric-mode | --rubric-mode=* | --rubric-model | --rubric-model=*)
      reject_managed_override "rubric model posture" "$arg"
      ;;
    --sta | --sta=* | --star | --star=* | --start | --start=* | --startu | --startu=* | --startup | --startup=* | --startup-*)
      reject_managed_override "startup command posture" "$arg"
      ;;
    --interpreter)
      reject_managed_override "interpreter posture" "$arg"
      ;;
    --interpreter-t | --interpreter-t=* | --interpreter-to | --interpreter-to=* | --interpreter-too | --interpreter-too=* | --interpreter-tool | --interpreter-tool=* | --interpreter-tools | --interpreter-tools=*)
      reject_managed_override "interpreter posture" "$arg"
      ;;
    -y | --auto-a | --auto-ap | --auto-app | --auto-appr | --auto-appro | --auto-approv | --auto-approve)
      reject_managed_override "tool approval posture" "$arg"
      ;;
    --acp)
      reject_managed_override "ACP approval posture" "$arg"
      ;;
  esac
done

# Reject empty or whitespace-only non-interactive prompts (#5752). dcode's
# `-n` / `--non-interactive TEXT` takes the prompt as its value; an empty value
# otherwise silently runs a task or drops into the interactive UI instead of
# failing fast, which breaks headless automation that relies on a non-zero exit
# for misuse. Refuse here, before dcode launches, so no LangGraph server, tools,
# or interactive TUI ever start.
reject_empty_non_interactive() {
  printf 'NemoClaw: empty non-interactive prompt for %s; provide prompt text.\n' "$1" >&2
  exit 2
}

prompt_is_blank() {
  case "$1" in
    *[![:space:]]*) return 1 ;;
    *) return 0 ;;
  esac
}

dcode_args=("$@")
arg_index=0
while [ "$arg_index" -lt "${#dcode_args[@]}" ]; do
  current_arg="${dcode_args[arg_index]}"
  case "$current_arg" in
    -n | --non-interactive)
      # Prompt is the next token. Validate it, then skip past it so a value
      # that happens to look like a flag is not re-examined as one.
      value_index=$((arg_index + 1))
      if [ "$value_index" -lt "${#dcode_args[@]}" ]; then
        if prompt_is_blank "${dcode_args[value_index]}"; then
          reject_empty_non_interactive "$current_arg"
        fi
      fi
      arg_index=$((value_index + 1))
      continue
      ;;
    --non-interactive=*)
      if prompt_is_blank "${current_arg#--non-interactive=}"; then
        reject_empty_non_interactive "--non-interactive"
      fi
      ;;
    -n?*)
      if prompt_is_blank "${current_arg#-n}"; then
        reject_empty_non_interactive "-n"
      fi
      ;;
  esac
  arg_index=$((arg_index + 1))
done

extra_args=(--sandbox none --no-mcp)
# The patched Python entrypoint opens, validates, canonicalizes, and snapshots
# the dedicated NemoClaw MCP projection inside this long-lived process. A shell
# command substitution cannot own that descriptor: its subprocess would close
# the process-local snapshot before Deep Agents Code or its LangGraph child
# could consume it.
# `--no-mcp` also keeps upstream auto-discovery fail-closed until the managed
# entrypoint replaces it with the integrity-bound /proc/self/fd path.

run_dcode "${extra_args[@]}" "$@"
