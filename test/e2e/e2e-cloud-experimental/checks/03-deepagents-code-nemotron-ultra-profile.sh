#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: the stock Deep Agents Code sandbox resolves the Nemotron 3 Ultra
# harness profile before later checks intentionally re-onboard to another model.
#
# This is a local runtime contract only. It builds the same pre-resolved
# ChatOpenAI shape that DCode uses, then inspects the selected built-in profile;
# it never invokes the model or makes a network request.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
PREFIX="03-deepagents-code-nemotron-ultra-profile"

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

encode_source() {
  base64 | tr -d '\n'
}

profile_contract_source() {
  cat <<'PY'
from pathlib import Path
import tomllib

from deepagents.profiles.harness.harness_profiles import _harness_profile_for_model
from langchain_openai import ChatOpenAI

CONFIG_PATH = Path("/sandbox/.deepagents/config.toml")
EXPECTED_DEFAULTS = {
    "openai:nvidia/nemotron-3-ultra-550b-a55b",
    "openai:nvidia/nvidia/nemotron-3-ultra",
}
EXPECTED_MIDDLEWARE = [
    "NemotronProgressBudgetMiddleware",
    "NemotronPolicyNudgeMiddleware",
    "NemotronToolCallShim",
    "ReadFileContinuationNoticeMiddleware",
    "ToolRetryMiddleware",
    "ModelRateLimitRetryMiddleware",
    "ChatNVIDIAMessageCompatibilityMiddleware",
    "NemotronReasoningTagCleanupMiddleware",
    "NemotronTextToolCallParser",
    "FollowupDisciplineMiddleware",
    "EntityResolutionGuardMiddleware",
    "FinalAnswerGuardMiddleware",
]

config = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
default_model = config["models"]["default"]
assert default_model in EXPECTED_DEFAULTS, default_model

model_name = default_model.removeprefix("openai:")
provider = config["models"]["providers"]["openai"]
assert provider["models"] == [model_name]
assert provider["api_key_env"] == "DEEPAGENTS_CODE_OPENAI_API_KEY"
assert provider["base_url"] == "https://inference.local/v1"
assert provider["enabled"] is True
assert provider["params"] == {"use_responses_api": False}

model = ChatOpenAI(
    model=model_name,
    api_key="nemoclaw-managed-placeholder",
    base_url=provider["base_url"],
    use_responses_api=provider["params"]["use_responses_api"],
)
profile = _harness_profile_for_model(model, None)

suffix = profile.system_prompt_suffix
assert suffix is not None
for marker in ("<approach>", "<grounding>", "<loop_control>", "<state_changes>"):
    assert marker in suffix, marker

description_overrides = profile.tool_description_overrides
assert set(description_overrides) == {"read_file"}
read_file_description = description_overrides["read_file"]
assert "file_path" in read_file_description
assert "offset" in read_file_description
assert "limit" in read_file_description

middleware_factory = profile.extra_middleware
assert callable(middleware_factory)
actual_middleware = [type(item).__name__ for item in middleware_factory()]
assert actual_middleware == EXPECTED_MIDDLEWARE, actual_middleware

print(f"NEMOCLAW_NEMOTRON_ULTRA_PROFILE_OK:{default_model}")
PY
}

[ -n "$SANDBOX_NAME" ] || fail "sandbox name is required"

# The generic cloud-onboard target runs every shared check against OpenClaw.
# Typed DCode targets reject this SKIP through their required-check wrapper.
if ! sandbox_exec "test -d /sandbox/.deepagents && test -x /usr/local/bin/dcode" >/dev/null; then
  printf '%s: SKIP: sandbox %q is not a Deep Agents Code sandbox\n' "$PREFIX" "$SANDBOX_NAME"
  exit 0
fi

sandbox_exec "test -x /opt/venv/bin/python3" >/dev/null || fail "/opt/venv/bin/python3 is missing"

profile_source="$(profile_contract_source | encode_source)"
profile_command="printf '%s' ${profile_source@Q} | base64 -d | /opt/venv/bin/python3 -I -"
profile_output="$(sandbox_exec "$profile_command")" || fail "Nemotron Ultra harness profile contract failed: $profile_output"
printf '%s\n' "$profile_output" | grep -Fq "NEMOCLAW_NEMOTRON_ULTRA_PROFILE_OK:" || fail "profile verification marker is missing"
pass "configured ChatOpenAI resolves the complete Nemotron Ultra profile without inference"

printf '%s: 1 passed, 0 failed\n' "$PREFIX"
