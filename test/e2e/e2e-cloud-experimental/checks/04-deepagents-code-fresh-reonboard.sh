#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: same-name managed DCode --fresh re-onboard keeps the new live route (#6311).
#
# Start from the typed target's stock DCode sandbox (model A), seed its config
# with safe preferences plus stale managed/unsafe data, and re-onboard the same
# name to model B. The live identity, host status, registry, and restored config
# must all agree on B before the remaining DCode runtime checks execute.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
CLI="${NEMOCLAW_CLI_BIN:-${REPO}/bin/nemoclaw.js}"
PREFIX="04-deepagents-code-fresh-reonboard"
PRIMARY_TARGET_MODEL="openai/openai/gpt-5.5"
FALLBACK_TARGET_MODEL="nvidia/nvidia/nemotron-3-ultra"
HOSTED_ENDPOINT="${NEMOCLAW_ENDPOINT_URL:-https://inference-api.nvidia.com/v1}"
CREDENTIAL_CANARY="nemoclaw-dcode-config-get-canary"
MANAGED_LOGIN_PROFILE="/sandbox/.bash_profile"
HOSTILE_LOGIN_FALLBACK="/sandbox/.bash_login"
HOSTILE_PROFILE_MARKER="/sandbox/.nemoclaw-dcode-hostile-profile-loaded"

fail() {
  printf '%s: FAIL: %s\n' "$PREFIX" "$1" >&2
  exit 1
}

pass() {
  printf '%s: OK (%s)\n' "$PREFIX" "$1"
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

cleanup_hostile_login_fallback() {
  local container_id
  container_id="$(
    docker ps \
      --filter "label=openshell.ai/sandbox-name=$SANDBOX_NAME" \
      --format '{{.ID}}' 2>/dev/null | head -n 1
  )"
  [ -n "$container_id" ] || return 0
  docker exec --user 0 "$container_id" /bin/sh -c \
    "rm -f '$HOSTILE_LOGIN_FALLBACK' '$HOSTILE_PROFILE_MARKER'" \
    >/dev/null 2>&1 || true
}

dcode_identity() {
  # Invoke dcode by absolute path: `openshell sandbox exec -- dcode ...` runs
  # without a login shell, so /usr/local/bin is not on PATH and a bare `dcode`
  # resolves to "command not found". The image installs the launcher at
  # /usr/local/bin/dcode (see agents/langchain-deepagents-code/Dockerfile).
  openshell sandbox exec --name "$SANDBOX_NAME" -- /usr/local/bin/dcode identity 2>&1
}

identity_field() {
  local output="$1"
  local field="$2"
  printf '%s\n' "$output" | sed -n "s/^${field}:[[:space:]]*//p" | tail -n1
}

assert_identity() {
  local output="$1"
  local model="$2"
  local phase="$3"
  local route provider observed_model endpoint
  route="$(identity_field "$output" Route)"
  provider="$(identity_field "$output" Provider)"
  observed_model="$(identity_field "$output" Model)"
  endpoint="$(identity_field "$output" Endpoint)"
  [ "$route" = "inference" ] || fail "$phase identity route is '${route:-missing}'"
  [ "$provider" = "compatible-endpoint" ] || fail "$phase identity provider is '${provider:-missing}'"
  [ "$observed_model" = "openai:${model}" ] || fail "$phase identity model is '${observed_model:-missing}'"
  [ "$endpoint" = "https://inference.local/v1" ] || fail "$phase identity endpoint is '${endpoint:-missing}'"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

wait_for_status_after_reonboard() {
  local attempt attempts delay_seconds status_json status
  attempts="${NEMOCLAW_E2E_DCODE_STATUS_ATTEMPTS:-5}"
  delay_seconds="${NEMOCLAW_E2E_DCODE_STATUS_DELAY_SECONDS:-5}"
  is_positive_integer "$attempts" || fail "status attempts must be a positive integer"
  [[ "$delay_seconds" =~ ^[0-9]+$ ]] || fail "status retry delay must be a non-negative integer"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if status_json="$("$CLI" "$SANDBOX_NAME" status --json)"; then
      printf '%s\n' "$status_json"
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
  done

  printf '%s\n' "$status_json"
  return "$status"
}

seed_config_source() {
  cat <<'PY'
import os
from pathlib import Path
import sys
import tomllib
import tomli_w

path = Path("/sandbox/.deepagents/config.toml")
model, credential_canary = sys.argv[1:]
config = tomllib.loads(path.read_text(encoding="utf-8"))
provider = config["models"]["providers"]["openai"]
config["models"]["default"] = f"openai:{model}"
provider["models"] = [model]
provider["base_url"] = "https://stale.invalid/v1"
config["update"] = {"check": True, "auto_update": True}
config["ui"] = {"show_scrollbar": True, "show_url_open_toast": False, "theme": "discard"}
config["threads"] = {
    "relative_time": False,
    "sort_order": "created_at",
    "columns": {"initial_prompt": False},
}
config["agents"] = {"startup_command": "discard"}
config["headers"] = {"authorization": credential_canary}
config["hooks"] = {"post_start": "discard"}
config["mcp"] = {"autoload": True, "config": "/sandbox/discard-mcp.json"}
config["servers"] = {"discard": {"api_key": "discard"}}
config["shell"] = {"allow_list": ["all"]}
config["skills"] = {"autoload": True, "extra_allowed_dirs": ["/etc"]}
config["tracing"] = {"api_key": "discard"}
headers = (
    "# Generated by NemoClaw. This file contains no provider secrets.\n"
    "# NemoClaw provider route: anthropic; upstream provider: "
    "compatible-anthropic-endpoint; API: anthropic-messages."
)
path.write_text(headers + "\n\n" + tomli_w.dumps(config), encoding="utf-8")
os.chmod(path, 0o600)
print("NEMOCLAW_DCODE_STALE_CONFIG_SEEDED")
PY
}

verify_config_source() {
  cat <<'PY'
from pathlib import Path
import sys
import tomllib

path = Path("/sandbox/.deepagents/config.toml")
initial_model, target_model = sys.argv[1:]
text = path.read_text(encoding="utf-8")
config = tomllib.loads(text)
provider = config["models"]["providers"]["openai"]
assert set(config) == {"models", "update", "ui", "threads", "warnings"}
assert config["models"]["default"] == f"openai:{target_model}"
assert provider["models"] == [target_model]
assert provider["api_key_env"] == "DEEPAGENTS_CODE_OPENAI_API_KEY"
assert provider["base_url"] == "https://inference.local/v1"
assert config["update"] == {"check": False, "auto_update": False}
assert config["ui"] == {"show_scrollbar": True, "show_url_open_toast": False}
assert config["threads"] == {"relative_time": False, "sort_order": "created_at"}
assert config["warnings"] == {"suppress": ["tavily"]}
assert initial_model not in text
for forbidden in (
    "compatible-anthropic-endpoint",
    "https://stale.invalid/v1",
    "startup_command",
    "authorization",
    "autoload",
    "allow_list",
):
    assert forbidden not in text
print("NEMOCLAW_DCODE_FRESH_CONFIG_VERIFIED")
PY
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

[ -n "$SANDBOX_NAME" ] || fail "sandbox name is required"

# The generic cloud-onboard target runs every shared check against its OpenClaw
# sandbox. Typed DCode targets reject this SKIP through their required-check
# wrapper, so this guard only prevents cross-agent execution in the shared run.
if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  printf '%s: SKIP: sandbox %q is not a Deep Agents Code sandbox\n' "$PREFIX" "$SANDBOX_NAME"
  exit 0
fi

[ -n "${COMPATIBLE_API_KEY:-}" ] || fail "COMPATIBLE_API_KEY is required"
[ -x "$CLI" ] || fail "NemoClaw CLI is not executable at $CLI"

if ! identity_before="$(dcode_identity)"; then
  # Surface the captured stdout+stderr (dcode_identity redirects 2>&1) before
  # failing. Without this the real reason `dcode identity` exits non-zero is
  # discarded and CI/result.json only show the generic message with stdout "".
  printf '%s: diagnostic: initial dcode identity output:\n%s\n' "$PREFIX" "${identity_before:-<no output captured>}"
  fail "could not read initial dcode identity"
fi
model_a="$(identity_field "$identity_before" Model)"
model_a="${model_a#openai:}"
[ -n "$model_a" ] || fail "initial dcode identity did not report a model"
assert_identity "$identity_before" "$model_a" "initial"
pass "initial live identity reports model A"

# OpenShell starts command-bearing sandbox sessions through a login shell and
# sets HOME to /sandbox before Bash reads its first user login file. The DCode
# image reserves that first-match file under a sticky root-owned workspace.
# Prove the sandbox identity cannot replace it, then plant the next fallback
# file with an exact forged marker pair and exit 97. Bash must keep selecting
# the managed profile, so the hostile fallback never runs and probe-only
# connect reaches the real managed smoke runner (#8624).
cleanup_hostile_login_fallback
trap cleanup_hostile_login_fallback EXIT
container_id="$(
  docker ps \
    --filter "label=openshell.ai/sandbox-name=$SANDBOX_NAME" \
    --format '{{.ID}}' | head -n 1
)"
[ -n "$container_id" ] || fail "could not resolve the DCode sandbox container"
managed_profile_state="$(
  docker exec --user 0 "$container_id" /bin/sh -c \
    "stat -c '%U:%G:%a' /sandbox; stat -c '%U:%G:%a' '$MANAGED_LOGIN_PROFILE'; cmp -s /usr/local/lib/nemoclaw/dcode-login-profile.sh '$MANAGED_LOGIN_PROFILE' && printf '%s' MANAGED_PROFILE_MATCH"
)" || fail "could not inspect the managed DCode login profile"
expected_profile_state="$(printf '%s\n' root:sandbox:1775 root:root:444 MANAGED_PROFILE_MATCH)"
[ "$managed_profile_state" = "$expected_profile_state" ] || fail "managed DCode login profile posture is unsafe: $managed_profile_state"

set +e
profile_overwrite_output="$(sandbox_exec "printf '%s\n' hostile > '$MANAGED_LOGIN_PROFILE'")"
profile_overwrite_status=$?
set -e
[ "$profile_overwrite_status" -ne 0 ] || fail "sandbox identity replaced the managed DCode login profile"
printf '%s\n' "$profile_overwrite_output" | grep -Eqi 'permission denied|read-only file system' \
  || fail "managed profile overwrite failed for an unexpected reason: $profile_overwrite_output"

sandbox_exec "umask 077; printf '%s\n' 'case \"\${BASH_EXECUTION_STRING:-}\" in' '  *NEMOCLAW_AGENT_SMOKE_BEGIN*)' '    touch $HOSTILE_PROFILE_MARKER' '    printf \"%s\\n\" NEMOCLAW_AGENT_SMOKE_BEGIN NEMOCLAW_AGENT_SMOKE_EXIT:0' '    exit 97' '    ;;' 'esac' > '$HOSTILE_LOGIN_FALLBACK'" \
  >/dev/null || fail "could not install the hostile DCode fallback login profile"

managed_profile_connect_output="$("$CLI" "$SANDBOX_NAME" connect --probe-only 2>&1)" || fail "managed profile did not protect probe-only connect: $managed_profile_connect_output"
marker_state="$(
  docker exec --user 0 "$container_id" /bin/sh -c \
    "if [ -e '$HOSTILE_PROFILE_MARKER' ]; then printf PROFILE_LOADED; else printf PROFILE_NOT_LOADED; fi"
)" || fail "could not inspect the hostile DCode profile marker"
cleanup_hostile_login_fallback
trap - EXIT

printf '%s\n' "$managed_profile_connect_output" | grep -Fq "terminal smoke checks passed" || fail "managed profile probe did not reach the DCode smoke boundary"
[ "$marker_state" = "PROFILE_NOT_LOADED" ] || fail "hostile fallback login profile executed before the managed probe: $marker_state"
pass "root-owned DCode login profile excludes sandbox startup code from managed probes"

if [ "$model_a" = "$PRIMARY_TARGET_MODEL" ]; then
  model_b="$FALLBACK_TARGET_MODEL"
else
  model_b="$PRIMARY_TARGET_MODEL"
fi
[ "$model_a" != "$model_b" ] || fail "model A and model B must differ"

seed_source="$(seed_config_source)"
seed_output="$(
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /opt/venv/bin/python3 -I -c "$seed_source" "$model_a" "$CREDENTIAL_CANARY" 2>&1
)" || fail "could not seed stale DCode config"
printf '%s\n' "$seed_output" | grep -Fq "NEMOCLAW_DCODE_STALE_CONFIG_SEEDED" || fail "stale config seed marker is missing"
pass "seeded safe preferences and stale managed data"

config_json="$("$CLI" "$SANDBOX_NAME" config get 2>&1)" || fail "config get failed for live DCode TOML: $config_json"
CONFIG_JSON="$config_json" MODEL_A="$model_a" CREDENTIAL_CANARY="$CREDENTIAL_CANARY" node -e '
const config = JSON.parse(process.env.CONFIG_JSON);
if (config.models?.default !== "openai:" + process.env.MODEL_A) process.exit(1);
if (Object.hasOwn(config, "gateway")) process.exit(1);
if (config.headers?.authorization !== "[STRIPPED_BY_MIGRATION]") process.exit(1);
if (JSON.stringify(config).includes(process.env.CREDENTIAL_CANARY)) process.exit(1);
' || fail "config get did not return sanitized, parseable JSON for model A"
pass "config get parses live DCode TOML and redacts credentials"

config_model_json="$("$CLI" "$SANDBOX_NAME" config get --key models.default 2>&1)" || fail "keyed config get failed for live DCode TOML: $config_model_json"
CONFIG_MODEL_JSON="$config_model_json" MODEL_A="$model_a" node -e '
if (JSON.parse(process.env.CONFIG_MODEL_JSON) !== "openai:" + process.env.MODEL_A) process.exit(1);
' || fail "keyed config get did not return model A"
pass "keyed config get returns the live model"

config_yaml="$("$CLI" "$SANDBOX_NAME" config get --format yaml 2>&1)" || fail "YAML config get failed for live DCode TOML: $config_yaml"
CONFIG_YAML="$config_yaml" MODEL_A="$model_a" CREDENTIAL_CANARY="$CREDENTIAL_CANARY" node -e '
const config = require("yaml").parse(process.env.CONFIG_YAML);
if (config.models?.default !== "openai:" + process.env.MODEL_A) process.exit(1);
if (Object.hasOwn(config, "gateway")) process.exit(1);
if (config.headers?.authorization !== "[STRIPPED_BY_MIGRATION]") process.exit(1);
if (JSON.stringify(config).includes(process.env.CREDENTIAL_CANARY)) process.exit(1);
' || fail "config get --format yaml did not return sanitized, parseable YAML for model A"
pass "YAML config get preserves the sanitized live DCode shape"

config_sha_before="$(sandbox_exec "sha256sum /sandbox/.deepagents/config.toml | awk '{print \$1}'")" || fail "could not hash DCode config before rejected mutation"
[[ "$config_sha_before" =~ ^[0-9a-f]{64}$ ]] || fail "invalid pre-mutation DCode config hash"
set +e
config_set_output="$("$CLI" "$SANDBOX_NAME" config set --key models.default --value "openai:$model_b" 2>&1)"
config_set_status=$?
set -e
[ "$config_set_status" -ne 0 ] || fail "config set unexpectedly mutated image-baked DCode config"
printf '%s\n' "$config_set_output" | grep -Fq "config is baked into the sandbox image at build time" || fail "config set rejection did not explain the image-baked boundary"
printf '%s\n' "$config_set_output" | grep -Fq "re-onboard with the new selection" || fail "config set rejection did not provide re-onboard guidance"
printf '%s\n' "$config_set_output" | grep -Fq -- "--fresh" || fail "config set rejection did not provide the fresh re-onboard command"
config_sha_after="$(sandbox_exec "sha256sum /sandbox/.deepagents/config.toml | awk '{print \$1}'")" || fail "could not hash DCode config after rejected mutation"
[ "$config_sha_after" = "$config_sha_before" ] || fail "rejected config set changed image-baked DCode config"
pass "config set rejects image-baked DCode mutation without changing the file"

if ! reonboard_output="$(
  COMPATIBLE_API_KEY="$COMPATIBLE_API_KEY" \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_AGENT=langchain-deepagents-code \
    NEMOCLAW_COMPAT_MODEL="$model_b" \
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE=1 \
    NEMOCLAW_ENDPOINT_URL="$HOSTED_ENDPOINT" \
    NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF="$NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF" \
    NEMOCLAW_MODEL="$model_b" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_PREFERRED_API=openai-completions \
    NEMOCLAW_PROVIDER=custom \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    OPENSHELL_GATEWAY=nemoclaw \
    "$CLI" onboard --agent langchain-deepagents-code --name "$SANDBOX_NAME" \
    --fresh --recreate-sandbox --non-interactive --observability --yes \
    --yes-i-accept-third-party-software 2>&1
)"; then
  fail "same-name --fresh re-onboard failed: $reonboard_output"
fi
pass "same-name --fresh re-onboard completed"

sandbox_list="$(openshell sandbox list 2>&1)" || fail "could not list sandbox after re-onboard"
printf '%s\n' "$sandbox_list" | awk -v name="$SANDBOX_NAME" '$1 == name && /Ready/ { found = 1 } END { exit(found ? 0 : 1) }' || fail "same-name sandbox is not Ready after re-onboard"

if ! identity_after="$(dcode_identity)"; then
  printf '%s: diagnostic: dcode identity output after re-onboard:\n%s\n' "$PREFIX" "${identity_after:-<no output captured>}"
  fail "could not read dcode identity after re-onboard"
fi
assert_identity "$identity_after" "$model_b" "fresh"
printf '%s\n' "$identity_after" | grep -Fq "$model_a" && fail "fresh identity still contains model A"
pass "live dcode identity reports model B"

config_model_after_json="$("$CLI" "$SANDBOX_NAME" config get --key models.default 2>&1)" || fail "keyed config get failed after re-onboard: $config_model_after_json"
CONFIG_MODEL_JSON="$config_model_after_json" MODEL_B="$model_b" node -e '
if (JSON.parse(process.env.CONFIG_MODEL_JSON) !== "openai:" + process.env.MODEL_B) process.exit(1);
' || fail "keyed config get did not return model B after re-onboard"
pass "keyed config get reports model B after re-onboard"

# Invalid state: OpenShell publishes the recreated sandbox as Ready before its
#   in-sandbox inference route accepts health probes, so the first status call
#   after a fresh re-onboard can report failureLabel=unreachable for a sandbox
#   that becomes healthy moments later.
# Source boundary: readiness is published by OpenShell's sandbox lifecycle and
#   only consumed here (the Ready assertion above reads it from `list`). The
#   probe is NemoClaw's own probeSandboxInferenceGatewayHealth in
#   src/lib/actions/sandbox/inference-route-health.ts, which reports the route
#   state at the instant it runs and documents that it must not wait.
# Source-fix constraint: NemoClaw cannot make OpenShell delay Ready until the
#   route serves, and making `status` retry internally would turn a
#   point-in-time report into a wait, hiding real outages from every other
#   caller. The retry therefore belongs to this check, the only consumer that
#   knows a re-onboard just happened.
# Regression: test/e2e/support/platform-parity-cloud-experimental.test.ts covers
#   eventual status success and retry exhaustion.
# Removal condition: delete this retry once OpenShell publishes Ready only after
#   the in-sandbox inference route serves, or once NemoClaw exposes an explicit
#   readiness-wait command this check can call instead.
# Keep this bounded so persistent route failures still stop the target before
# the remaining runtime checks.
status_json="$(wait_for_status_after_reonboard)" || fail "nemoclaw status failed after bounded post-re-onboard readiness checks: ${status_json:-<no stdout>}"
STATUS_JSON="$status_json" SANDBOX_NAME="$SANDBOX_NAME" MODEL_B="$model_b" node -e '
const status = JSON.parse(process.env.STATUS_JSON);
if (status.name !== process.env.SANDBOX_NAME ||
    status.model !== process.env.MODEL_B ||
    status.provider !== "compatible-endpoint") process.exit(1);
' || fail "nemoclaw status does not report model B and compatible-endpoint"

SANDBOX_NAME="$SANDBOX_NAME" MODEL_B="$model_b" node -e '
const fs = require("node:fs");
const path = require("node:path");
const registry = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".nemoclaw", "sandboxes.json"), "utf8"));
const entry = registry.sandboxes?.[process.env.SANDBOX_NAME];
if (!entry || entry.agent !== "langchain-deepagents-code" ||
    entry.model !== process.env.MODEL_B ||
    entry.provider !== "compatible-endpoint" ||
    entry.credentialEnv !== "COMPATIBLE_API_KEY") process.exit(1);
' || fail "host registry does not report the verified model B selection"
pass "status and registry report model B"

verify_source="$(verify_config_source)"
verify_output="$(
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /opt/venv/bin/python3 -I -c "$verify_source" "$model_a" "$model_b" 2>&1
)" || fail "live DCode config does not preserve the managed restore boundary"
printf '%s\n' "$verify_output" | grep -Fq "NEMOCLAW_DCODE_FRESH_CONFIG_VERIFIED" || fail "fresh config verification marker is missing"
pass "config keeps model B and only the allowlisted preferences"

printf '%s: 13 passed, 0 failed\n' "$PREFIX"
