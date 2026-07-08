# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the released Nemotron 3 Ultra profile in the managed image."""

from __future__ import annotations

import importlib.metadata
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, cast

from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import ExecuteResponse
from deepagents.profiles.harness._nvidia_nemotron_3_ultra import (
    NemotronTextToolCallParser,
)
from deepagents.profiles.harness.harness_profiles import _harness_profile_for_model
from deepagents_code.agent import create_cli_agent
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI

EXPECTED_VERSIONS = {
    "deepagents-code": "0.1.34",
    "deepagents": "0.7.0a6",
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
DISPATCH_COMMAND = "printf NEMOCLAW_DISPATCH_OK"


def require(condition: bool, message: str) -> None:
    """Keep image validation active under optimized Python execution."""
    if not condition:
        raise RuntimeError(message)


class ScriptedManagedModel(FakeMessagesListChatModel):
    """Expose the managed ChatOpenAI identity while returning fixed messages."""

    model_name: str = MANAGED_MODEL_IDS[0]

    def bind_tools(
        self, tools: Any, **kwargs: Any
    ) -> ScriptedManagedModel:
        del tools, kwargs
        return self

    def _get_ls_params(self, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        return {"ls_provider": "openai", "ls_model_name": self.model_name}


class RecordingManagedShell(LocalShellBackend):
    """Record model-dispatched shell calls without executing host commands."""

    def __init__(self, root_dir: Path) -> None:
        super().__init__(root_dir=root_dir, virtual_mode=False)
        self.dispatched_commands: list[tuple[str, int | None]] = []

    def execute(
        self, command: str, *, timeout: int | None = None
    ) -> ExecuteResponse:
        if "__DETECT_CONTEXT_EOF__" not in command:
            self.dispatched_commands.append((command, timeout))
        return ExecuteResponse(
            output="NEMOCLAW_DISPATCH_OK\n",
            exit_code=0,
            truncated=False,
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
    require(
        suffix is not None and "<state_changes>" in suffix,
        f"{model_id}: native profile system prompt is missing state guidance",
    )
    read_file_description = profile.tool_description_overrides.get("read_file")
    require(
        read_file_description is not None,
        f"{model_id}: native profile is missing the read_file override",
    )
    for argument in ("file_path", "offset", "limit"):
        require(
            argument in read_file_description,
            f"{model_id}: read_file override is missing {argument}",
        )
    require(
        middleware_names(profile) == EXPECTED_MIDDLEWARE,
        f"{model_id}: native middleware stack does not match the reviewed profile",
    )
    return model


def validate_parser_tool_visibility() -> None:
    cases = (
        ('{"tool": "bash", "cmd": "echo blocked"}', "execute"),
        (
            "<function=write_file><parameter name=file_path>/tmp/x</parameter>"
            "<parameter name=content>x</parameter></function>",
            "write_file",
        ),
        (
            "<function=delete><parameter name=file_path>/tmp/x</parameter></function>",
            "delete",
        ),
    )
    for content, tool_name in cases:
        message = AIMessage(content=content)
        blocked = NemotronTextToolCallParser._repair_message(message, {"read_file"})
        require(blocked.content == content, f"blocked {tool_name} content changed")
        require(blocked.tool_calls == [], f"blocked {tool_name} became a tool call")

        allowed = NemotronTextToolCallParser._repair_message(message, {tool_name})
        require(allowed.content == "", f"allowed {tool_name} retained tool-call text")
        require(
            len(allowed.tool_calls) == 1,
            f"allowed {tool_name} did not produce exactly one tool call",
        )
        require(
            allowed.tool_calls[0]["name"] == tool_name,
            f"allowed {tool_name} produced the wrong tool name",
        )


def dispatch_execute_once(
    first_response: AIMessage,
) -> tuple[tuple[str, int | None], tuple[str, str | None]]:
    """Run one model-produced execute call through DCode's managed allow-list."""
    with tempfile.TemporaryDirectory(prefix="nemoclaw-profile-dispatch-") as tmp:
        backend = RecordingManagedShell(Path(tmp))
        model = ScriptedManagedModel(
            responses=[
                first_response,
                AIMessage(content="The approved command completed successfully."),
            ]
        )
        graph, _ = create_cli_agent(
            model,
            "nemoclaw-profile-validation",
            sandbox=backend,
            sandbox_type="nemoclaw-validation",
            system_prompt="Use the execute tool once, then report the result.",
            interactive=False,
            auto_approve=False,
            interrupt_shell_only=True,
            shell_allow_list=["printf"],
            enable_ask_user=False,
            enable_memory=False,
            enable_skills=False,
        )
        result = graph.invoke(
            {"messages": [HumanMessage(content="Run the validation command once.")]},
            context={"auto_approve": False},
        )

    execute_results = [
        message
        for message in result["messages"]
        if isinstance(message, ToolMessage) and message.name == "execute"
    ]
    require(
        len(backend.dispatched_commands) == 1,
        "execute validation did not dispatch exactly one shell command",
    )
    require(
        len(execute_results) == 1,
        "execute validation did not produce exactly one tool result",
    )
    tool_result = execute_results[0]
    require(isinstance(tool_result.content, str), "execute result content is not text")
    return backend.dispatched_commands[0], (tool_result.content, tool_result.status)


def validate_parser_dispatch_parity() -> None:
    """Prove repaired and native execute calls share the managed dispatcher."""
    repaired = dispatch_execute_once(
        AIMessage(
            content=(
                '{"tool":"bash","cmd":"'
                f"{DISPATCH_COMMAND}"
                '"}'
            )
        )
    )
    native = dispatch_execute_once(
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "execute",
                    "args": {"command": DISPATCH_COMMAND},
                    "id": "native-execute",
                    "type": "tool_call",
                }
            ],
        )
    )
    require(repaired == native, "repaired and native execute dispatch results differ")
    require(
        repaired[0] == (DISPATCH_COMMAND, None),
        "execute dispatch arguments do not match the managed command",
    )
    require(repaired[1][1] == "success", "managed execute dispatch was not successful")


def main() -> None:
    for distribution, expected in EXPECTED_VERSIONS.items():
        actual = importlib.metadata.version(distribution)
        require(
            actual == expected,
            f"expected {distribution}=={expected}, found {actual}",
        )

    managed_models = [validate_profile(model_id) for model_id in MANAGED_MODEL_IDS]
    validate_parser_tool_visibility()
    validate_parser_dispatch_parity()

    # One graph construction materializes the shared middleware schemas and
    # catches pinned-stack incompatibilities without making an inference request.
    agent = create_deep_agent(model=managed_models[0])
    require(agent is not None, "complete Deep Agents graph did not compile")

    unrelated = _harness_profile_for_model(make_model("gpt-4.1-mini"), None)
    require(
        unrelated.system_prompt_suffix is None,
        "unrelated OpenAI model received Ultra system guidance",
    )
    require(
        middleware_names(unrelated) == (),
        "unrelated OpenAI model received Ultra middleware",
    )
    print("Nemotron 3 Ultra managed harness profile validation passed.")


if __name__ == "__main__":
    main()
