# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the released Nemotron 3 Ultra profile in the managed image."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
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
from deepagents.profiles.harness.harness_profiles import (
    HarnessProfile,
    _harness_profile_for_model,
)
from deepagents_code.agent import create_cli_agent
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI

EXPECTED_VERSIONS = {
    "nemoclaw-deepagents-profile": "0.1.0",
    "deepagents-code": "0.1.34",
    "deepagents": "0.7.0a6",
    "langchain": "1.3.11",
    "langchain-core": "1.4.8",
    "langgraph": "1.2.6",
    "langchain-openai": "1.3.3",
}
EXPECTED_PROFILE_ENTRY_POINT = (
    "deepagents.harness_profiles",
    "nemoclaw-managed-aliases",
    "nemoclaw_deepagents_profile:register",
)
EXPECTED_PLUGIN_LICENSE_EXPRESSION = "Apache-2.0"
EXPECTED_PLUGIN_SOURCE_SHA256 = (
    "75ff7e7a5142cad4305126ccb1b8fc756306e82d4c559ddbc624012fb54ebfc4"
)
EXPECTED_NATIVE_PROFILE_SHA256 = (
    "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7"
)
EXPECTED_BOOTSTRAP_SHA256 = (
    "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf"
)
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
DENIED_DISPATCH_COMMAND = "uname -a"


def require(condition: bool, message: str) -> None:
    """Keep image validation active under optimized Python execution."""
    if not condition:
        raise RuntimeError(message)


def deepagents_root() -> Path:
    spec = importlib.util.find_spec("deepagents")
    require(
        spec is not None and spec.submodule_search_locations is not None,
        "could not locate the installed deepagents package",
    )
    roots = tuple(Path(entry) for entry in spec.submodule_search_locations)
    require(
        len(roots) == 1, f"expected one deepagents package root, found {len(roots)}"
    )
    root = roots[0]
    require(
        not root.is_symlink() and root.is_dir(),
        f"deepagents package root is not a trusted directory: {root}",
    )
    return root


def validate_official_sources() -> None:
    root = deepagents_root()
    for relative_path, label, expected_hash in (
        (
            Path("profiles/harness/_nvidia_nemotron_3_ultra.py"),
            "native Nemotron profile source",
            EXPECTED_NATIVE_PROFILE_SHA256,
        ),
        (
            Path("profiles/_builtin_profiles.py"),
            "built-in profile bootstrap",
            EXPECTED_BOOTSTRAP_SHA256,
        ),
    ):
        path = root / relative_path
        require(
            not path.is_symlink() and path.is_file(),
            f"{label} is not a trusted regular file: {path}",
        )
        source = path.read_bytes()
        require(
            hashlib.sha256(source).hexdigest() == expected_hash,
            f"{label} does not match the reviewed official wheel",
        )
        compile(source, str(path), "exec")


def validate_profile_entry_point() -> None:
    group, name, value = EXPECTED_PROFILE_ENTRY_POINT
    group_entries = tuple(importlib.metadata.entry_points().select(group=group))
    require(group_entries, f"profile entry point group {group!r} was not found")
    matches = [
        entry_point
        for entry_point in group_entries
        if entry_point.name == name
    ]
    require(len(matches) == 1, f"expected exactly one {name!r} profile entry point")
    entry_point = matches[0]
    require(
        entry_point.value == value,
        f"profile entry point target is {entry_point.value!r}, expected {value!r}",
    )
    distribution = entry_point.dist
    require(distribution is not None, "profile entry point has no source distribution")
    require(
        distribution.metadata["Name"] == "nemoclaw-deepagents-profile",
        "profile entry point comes from an unexpected distribution",
    )
    require(
        distribution.version == EXPECTED_VERSIONS["nemoclaw-deepagents-profile"],
        "profile entry point comes from an unexpected distribution version",
    )
    require(
        distribution.metadata.get("License-Expression")
        == EXPECTED_PLUGIN_LICENSE_EXPRESSION,
        "profile plugin license metadata does not match the reviewed package",
    )
    module_spec = importlib.util.find_spec("nemoclaw_deepagents_profile")
    require(
        module_spec is not None and module_spec.origin is not None,
        "could not locate the installed profile plugin",
    )
    module_path = Path(module_spec.origin)
    distribution_path = Path(
        distribution.locate_file("nemoclaw_deepagents_profile/__init__.py")
    )
    # Plugin registration separately binds the imported Deep Agents package to
    # its distribution; this check binds the plugin module to its distribution.
    for path, label in (
        (module_path, "imported profile plugin"),
        (distribution_path, "distributed profile plugin"),
    ):
        require(
            not path.is_symlink() and path.is_file(),
            f"{label} is not a trusted regular file: {path}",
        )
    require(
        module_path.samefile(distribution_path),
        "imported profile plugin does not match its reviewed distribution",
    )
    source = module_path.read_bytes()
    require(
        hashlib.sha256(source).hexdigest() == EXPECTED_PLUGIN_SOURCE_SHA256,
        "profile plugin source does not match the reviewed first-party package",
    )
    compile(source, str(module_path), "exec")


class ScriptedManagedModel(FakeMessagesListChatModel):
    """Expose the managed ChatOpenAI identity while returning fixed messages."""

    model_name: str = MANAGED_MODEL_IDS[0]

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedManagedModel:
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

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
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


def middleware_names(profile: HarnessProfile) -> tuple[str, ...]:
    middleware = profile.extra_middleware
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
) -> tuple[tuple[tuple[str, int | None], ...], tuple[str, str | None]]:
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
        len(execute_results) == 1,
        "execute validation did not produce exactly one tool result",
    )
    tool_result = execute_results[0]
    require(isinstance(tool_result.content, str), "execute result content is not text")
    return tuple(backend.dispatched_commands), (tool_result.content, tool_result.status)


def validate_dispatch_case(
    command: str,
) -> tuple[tuple[tuple[str, int | None], ...], tuple[str, str | None]]:
    repaired = dispatch_execute_once(
        AIMessage(content=json.dumps({"tool": "bash", "cmd": command}))
    )
    native = dispatch_execute_once(
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "execute",
                    "args": {"command": command},
                    "id": "native-execute",
                    "type": "tool_call",
                }
            ],
        )
    )
    require(repaired == native, "repaired and native execute dispatch results differ")
    return repaired


def validate_parser_dispatch_parity() -> None:
    """Prove repaired and native execute calls share the managed dispatcher."""
    allowed = validate_dispatch_case(DISPATCH_COMMAND)
    require(
        allowed[0] == ((DISPATCH_COMMAND, None),),
        "execute dispatch arguments do not match the managed command",
    )
    require(allowed[1][1] == "success", "managed execute dispatch was not successful")

    denied = validate_dispatch_case(DENIED_DISPATCH_COMMAND)
    require(denied[0] == (), "denied execute command reached the shell backend")
    require(denied[1][1] == "error", "denied execute command did not return an error")
    require(
        "Shell command rejected" in denied[1][0],
        "denied execute command did not preserve the managed rejection result",
    )


def main() -> None:
    for distribution, expected in EXPECTED_VERSIONS.items():
        actual = importlib.metadata.version(distribution)
        require(
            actual == expected,
            f"expected {distribution}=={expected}, found {actual}",
        )

    validate_profile_entry_point()
    validate_official_sources()
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
    # Final source re-verification matches Dockerfile's import-gate marker:
    # re-bind and re-hash the plugin plus both official files after graph and
    # dispatch checks to close the install/import-to-validation window.
    validate_profile_entry_point()
    validate_official_sources()
    print("Nemotron 3 Ultra managed harness profile validation passed.")


if __name__ == "__main__":
    main()
