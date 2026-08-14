#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: the stock Deep Agents Code sandbox resolves the Nemotron 3 Ultra
# harness profile, and the installed managed resolver supplies the reviewed
# Ultra template argument, before later checks intentionally rerun onboarding
# with another model.
#
# This runtime contract builds the same pre-resolved ChatOpenAI settings that
# DCode uses, then inspects the selected built-in profile. It never invokes the
# model or makes a network request.
#
# The config.toml assertions below describe the sandbox configuration, which is
# not what #7441 broke: the hardened managed resolver never consumes the config
# params table, so a TOML round-trip passes with or without the fix. The managed
# resolver contract therefore calls the installed deepagents_code.config
# function directly, under a socket guard that fails closed on any network use.

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

profile_contract_source() {
  cat <<'PY'
import asyncio
import hashlib
import importlib.metadata
import socket
from pathlib import Path
import tomllib

from deepagents.profiles import _builtin_profiles
from deepagents.profiles.harness import _nvidia_nemotron_3_ultra
from deepagents.profiles.harness.harness_profiles import (
    _HARNESS_PROFILES,
    _harness_profile_for_model,
)
from deepagents_code.model_config import ModelConfig
from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI

CONFIG_PATH = Path("/sandbox/.deepagents/config.toml")
EXPECTED_VERSIONS = {
    "nemoclaw-deepagents-profile": "0.1.0",
    "deepagents-code": "0.1.55",
    "deepagents": "0.7.5",
}
MANAGED_MODEL_IDS = (
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
)
EXPECTED_EXTRA_BODY = {
    "chat_template_kwargs": {"force_nonempty_content": True},
}
EXPECTED_NATIVE_PROFILE_SHA256 = (
    "3b95b118e90c4ae19890c611cc7e1e85261217f971496e9bb7508142133c7d9a"
)
EXPECTED_BOOTSTRAP_SHA256 = (
    "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf"
)
EXPECTED_NATIVE_MIDDLEWARE = [
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
MANAGED_GUARD = "NemoClawExecutePlaceholderGuardMiddleware"
EXPECTED_MIDDLEWARE = [*EXPECTED_NATIVE_MIDDLEWARE, MANAGED_GUARD]

for distribution, expected in EXPECTED_VERSIONS.items():
    actual = importlib.metadata.version(distribution)
    assert actual == expected, (distribution, actual)

profile_entry_points = [
    entry_point
    for entry_point in importlib.metadata.entry_points(
        group="deepagents.harness_profiles"
    )
    if entry_point.name == "nemoclaw-managed-aliases"
]
assert len(profile_entry_points) == 1, profile_entry_points
profile_entry_point = profile_entry_points[0]
assert profile_entry_point.value == "nemoclaw_deepagents_profile:register"
assert profile_entry_point.dist is not None
assert profile_entry_point.dist.metadata["Name"] == "nemoclaw-deepagents-profile"

native_profile_path = Path(_nvidia_nemotron_3_ultra.__file__)
native_profile_hash = hashlib.sha256(native_profile_path.read_bytes()).hexdigest()
assert native_profile_hash == EXPECTED_NATIVE_PROFILE_SHA256, native_profile_hash
bootstrap_path = Path(_builtin_profiles.__file__)
bootstrap_hash = hashlib.sha256(bootstrap_path.read_bytes()).hexdigest()
assert bootstrap_hash == EXPECTED_BOOTSTRAP_SHA256, bootstrap_hash

config = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
default_model = config["models"]["default"]
configured_model_id = default_model.removeprefix("openai:")
assert configured_model_id in MANAGED_MODEL_IDS, default_model

provider = config["models"]["providers"]["openai"]
assert provider["models"] == [configured_model_id]
assert provider["api_key_env"] == "DEEPAGENTS_CODE_OPENAI_API_KEY"
assert provider["base_url"] == "https://inference.local/v1"
assert provider["enabled"] is True
assert provider["params"] == {
    "use_responses_api": False,
    configured_model_id: {"extra_body": EXPECTED_EXTRA_BODY},
}

model_kwargs = ModelConfig.load(CONFIG_PATH).get_kwargs(
    "openai", model_name=configured_model_id
)
assert model_kwargs == {
    "use_responses_api": False,
    "extra_body": EXPECTED_EXTRA_BODY,
}

# Managed resolver contract (#7441). The assertions above cover the sandbox
# configuration and upstream's config reader; the managed launcher builds its
# model from the installed resolver below, which deliberately ignores that
# params table. Only this block verifies the installed patch, so it checks all
# returned settings rather than one key.
from deepagents_code.config import (
    _NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS,
    _get_provider_kwargs,
)
from deepagents_code._nemoclaw_managed import (
    managed_inference_base_url,
    managed_reasoning_effort,
)
from deepagents_code.model_config import ModelConfigError

# A mutable allowlist would let a caller widen the shaped set at runtime.
assert isinstance(_NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS, frozenset)
assert set(_NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS) == set(MANAGED_MODEL_IDS)

MANAGED_BASE_URL = managed_inference_base_url()
assert MANAGED_BASE_URL == provider["base_url"], MANAGED_BASE_URL
# The resolver supplies only the fixed synthetic credential. The provider
# credential never reaches the constructor or appears in the returned settings.
OPENAI_CONTRACT = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": MANAGED_BASE_URL,
    "use_responses_api": False,
}
MANAGED_REASONING_EFFORT = managed_reasoning_effort()
if MANAGED_REASONING_EFFORT is not None:
    OPENAI_CONTRACT["extra_body"] = {
        "reasoning_effort": MANAGED_REASONING_EFFORT,
    }
MANAGED_ULTRA_EXTRA_BODY = {
    **OPENAI_CONTRACT.get("extra_body", {}),
    **EXPECTED_EXTRA_BODY,
}
OPENROUTER_CONTRACT = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": MANAGED_BASE_URL,
}
# Deliberate near miss: a different Nemotron generation must not be shaped.
UNSHAPED_MODEL_NAMES = ("gpt-4.1-mini", "nvidia/nemotron-4-ultra-550b-a55b", None)
BLOCKED_PROVIDERS = ("anthropic", "fireworks", "ollama", "nvidia")


def blocked_socket(*args, **kwargs):
    raise AssertionError("managed resolver contract attempted a network connection")


real_socket = socket.socket
socket.socket = blocked_socket
try:
    for model_id in MANAGED_MODEL_IDS:
        assert _get_provider_kwargs("openai", model_name=model_id) == {
            **OPENAI_CONTRACT,
            "extra_body": MANAGED_ULTRA_EXTRA_BODY,
        }, model_id
        # The reviewed argument belongs to the OpenAI adapter alone; the managed
        # OpenRouter adapter keeps the unshaped contract for the same model.
        assert (
            _get_provider_kwargs("openrouter", model_name=model_id)
            == OPENROUTER_CONTRACT
        ), model_id

    for model_name in UNSHAPED_MODEL_NAMES:
        assert (
            _get_provider_kwargs("openai", model_name=model_name) == OPENAI_CONTRACT
        ), model_name
        assert (
            _get_provider_kwargs("openrouter", model_name=model_name)
            == OPENROUTER_CONTRACT
        ), model_name

    for blocked_provider in BLOCKED_PROVIDERS:
        try:
            _get_provider_kwargs(blocked_provider, model_name=MANAGED_MODEL_IDS[0])
        except ModelConfigError:
            pass
        else:
            raise AssertionError(blocked_provider)

    # Mutation of one result cannot change a later result.
    tampered = _get_provider_kwargs("openai", model_name=MANAGED_MODEL_IDS[0])
    tampered["api_key"] = "tampered"
    tampered["extra_body"]["chat_template_kwargs"]["force_nonempty_content"] = False
    assert _get_provider_kwargs("openai", model_name=MANAGED_MODEL_IDS[0]) == {
        **OPENAI_CONTRACT,
        "extra_body": MANAGED_ULTRA_EXTRA_BODY,
    }
finally:
    socket.socket = real_socket

print(
    "NEMOCLAW_MANAGED_RESOLVER_CONTRACT_OK:"
    f"shaped={len(MANAGED_MODEL_IDS)}:"
    f"unshaped={len(UNSHAPED_MODEL_NAMES)}:"
    f"blocked={len(BLOCKED_PROVIDERS)}"
)


class ProfileOnlyChatOpenAI(ChatOpenAI):
    """Fail closed if local profile resolution ever attempts inference."""

    def _generate(self, *args, **kwargs):
        raise AssertionError("profile contract attempted synchronous inference")

    async def _agenerate(self, *args, **kwargs):
        raise AssertionError("profile contract attempted asynchronous inference")

    def _stream(self, *args, **kwargs):
        raise AssertionError("profile contract attempted synchronous streaming")

    async def _astream(self, *args, **kwargs):
        raise AssertionError("profile contract attempted asynchronous streaming")


def make_model(model_id):
    model = ProfileOnlyChatOpenAI(
        model=model_id,
        api_key="nemoclaw-managed-placeholder",
        base_url=provider["base_url"],
        **model_kwargs,
    )
    assert model.extra_body == EXPECTED_EXTRA_BODY
    return model


def middleware_items(profile):
    middleware_factory = profile.extra_middleware
    if callable(middleware_factory):
        return list(middleware_factory())
    return list(middleware_factory)


def middleware_names(profile):
    return [type(item).__name__ for item in middleware_items(profile)]


managed_profiles = []
for model_id in MANAGED_MODEL_IDS:
    profile = _harness_profile_for_model(make_model(model_id), None)
    managed_profiles.append(profile)
    suffix = profile.system_prompt_suffix
    assert suffix is not None
    for marker in ("<approach>", "<grounding>", "<loop_control>", "<state_changes>"):
        assert marker in suffix, (model_id, marker)

    description_overrides = profile.tool_description_overrides
    assert set(description_overrides) == {"read_file"}
    read_file_description = description_overrides["read_file"]
    for argument in ("file_path", "offset", "limit"):
        assert argument in read_file_description
    assert middleware_names(profile) == EXPECTED_MIDDLEWARE, model_id

canonical_profile = _HARNESS_PROFILES[
    "nvidia:nvidia/nemotron-3-ultra-550b-a55b"
]
assert middleware_names(canonical_profile) == EXPECTED_NATIVE_MIDDLEWARE
assert all(profile is not canonical_profile for profile in managed_profiles)
assert managed_profiles[0] is managed_profiles[1]
guard = next(
    item
    for item in middleware_items(managed_profiles[0])
    if type(item).__name__ == MANAGED_GUARD
)


class GuardRequest:
    def __init__(self, name, command, call_id):
        self.tool_call = {
            "name": name,
            "args": {"command": command},
            "id": call_id,
        }


sync_calls = []
sync_request = GuardRequest("execute", "\t[  CONTENT  ]\n", "e2e-sync")


def sync_handler(request):
    sync_calls.append(request)
    return "unexpected-sync-dispatch"


sync_result = guard.wrap_tool_call(sync_request, sync_handler)
assert isinstance(sync_result, ToolMessage)
assert sync_calls == []
assert sync_result.tool_call_id == "e2e-sync"
assert sync_result.name == "execute"
assert sync_result.status == "error"
assert isinstance(sync_result.content, str)
assert "placeholder '[content]'" in sync_result.content
assert "complete command" in sync_result.content

async_calls = []
async_request = GuardRequest("execute", "[content]", "e2e-async")


async def async_handler(request):
    async_calls.append(request)
    return "unexpected-async-dispatch"


async_result = asyncio.run(guard.awrap_tool_call(async_request, async_handler))
assert isinstance(async_result, ToolMessage)
assert async_calls == []
assert async_result.tool_call_id == "e2e-async"
assert async_result.name == "execute"
assert async_result.status == "error"
assert isinstance(async_result.content, str)
assert "placeholder '[content]'" in async_result.content
assert "complete command" in async_result.content

concrete_calls = []
concrete_request = GuardRequest("execute", "printf concrete", "e2e-concrete")


def concrete_handler(request):
    concrete_calls.append(request)
    return "concrete-dispatch"


assert guard.wrap_tool_call(concrete_request, concrete_handler) == "concrete-dispatch"
assert concrete_calls == [concrete_request]

unrelated = _harness_profile_for_model(make_model("gpt-4.1-mini"), None)
assert unrelated.system_prompt_suffix is None
assert middleware_names(unrelated) == []
assert hashlib.sha256(native_profile_path.read_bytes()).hexdigest() == native_profile_hash
assert hashlib.sha256(bootstrap_path.read_bytes()).hexdigest() == bootstrap_hash

print(
    "NEMOCLAW_NEMOTRON_ULTRA_PROFILE_OK:"
    f"{default_model}:dcode={EXPECTED_VERSIONS['deepagents-code']}:"
    f"deepagents={EXPECTED_VERSIONS['deepagents']}:"
    f"plugin={EXPECTED_VERSIONS['nemoclaw-deepagents-profile']}"
)
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

profile_source="$(profile_contract_source)"
profile_output="$(
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /opt/venv/bin/python3 -I -c "$profile_source" 2>&1
)" || fail "Nemotron Ultra harness profile contract failed: $profile_output"
printf '%s\n' "$profile_output" | grep -Fq "NEMOCLAW_NEMOTRON_ULTRA_PROFILE_OK:" || fail "profile verification marker is missing"
pass "configured ChatOpenAI resolves the complete Nemotron Ultra profile without inference"
printf '%s\n' "$profile_output" | grep -Fq "NEMOCLAW_MANAGED_RESOLVER_CONTRACT_OK:" || fail "managed resolver contract marker is missing"
pass "installed managed resolver matches the tested Ultra, non-Ultra, provider, and network contracts without inference"

printf '%s: 2 passed, 0 failed\n' "$PREFIX"
