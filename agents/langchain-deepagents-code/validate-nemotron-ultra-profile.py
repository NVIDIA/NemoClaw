# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the temporary Nemotron 3 Ultra profile overlay in the built image."""

from __future__ import annotations

import importlib.metadata
from collections.abc import Callable, Sequence
from typing import cast

from deepagents import create_deep_agent
from deepagents.profiles.harness.harness_profiles import _harness_profile_for_model
from langchain.agents.middleware.types import AgentMiddleware
from langchain_openai import ChatOpenAI

EXPECTED_VERSIONS = {
    "deepagents-code": "0.1.30",
    "deepagents": "0.7.0a3",
    "langchain": "1.3.11",
    "langchain-core": "1.4.8",
    "langgraph": "1.2.6",
    "langchain-openai": "1.3.3",
}
MANAGED_MODEL_IDS = (
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
)
EXPECTED_MIDDLEWARE = (
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
)


def make_model(model_id: str) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_id,
        api_key="nemoclaw-managed-inference",
        base_url="https://inference.local/v1",
    )


def middleware_names(profile: object) -> tuple[str, ...]:
    middleware = getattr(profile, "extra_middleware")
    if callable(middleware):
        factory = cast(Callable[[], Sequence[AgentMiddleware]], middleware)
        middleware = factory()
    return tuple(type(item).__name__ for item in middleware)


def validate_profile(model_id: str) -> ChatOpenAI:
    model = make_model(model_id)
    profile = _harness_profile_for_model(model, None)
    suffix = profile.system_prompt_suffix
    assert suffix is not None and "<state_changes>" in suffix
    read_file_description = profile.tool_description_overrides.get("read_file")
    assert read_file_description is not None
    for argument in ("file_path", "offset", "limit"):
        assert argument in read_file_description
    assert middleware_names(profile) == EXPECTED_MIDDLEWARE
    return model


def main() -> None:
    for distribution, expected in EXPECTED_VERSIONS.items():
        actual = importlib.metadata.version(distribution)
        assert actual == expected, (
            f"expected {distribution}=={expected}, found {actual}"
        )

    managed_models = [validate_profile(model_id) for model_id in MANAGED_MODEL_IDS]

    # One graph construction materializes the shared middleware schemas and
    # catches pinned-stack incompatibilities without making an inference request.
    agent = create_deep_agent(model=managed_models[0])
    assert agent is not None

    unrelated = _harness_profile_for_model(make_model("gpt-4.1-mini"), None)
    assert unrelated.system_prompt_suffix is None
    assert middleware_names(unrelated) == ()
    print("Nemotron 3 Ultra managed harness profile validation passed.")


if __name__ == "__main__":
    main()
