# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate progressive disclosure against the exact image-pinned runtime."""

from __future__ import annotations

import asyncio
import importlib.metadata
import os
import tempfile
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

from deepagents_code.agent import create_cli_agent
from deepagents_code.mcp_tools import MCPServerInfo, MCPToolInfo
from deepagents_code.progressive_tool_disclosure import (
    MAX_SEARCH_QUERY_LENGTH,
    ProgressiveToolDisclosureMiddleware,
    SearchToolsInput,
    progressive_tool_disclosure_enabled,
)
from langchain.agents import create_agent
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool, tool
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import Field, ValidationError

PINNED_VERSIONS = {
    "deepagents-code": "0.1.30",
    "deepagents": "0.7.0a3",
    "langchain": "1.3.11",
    "langchain-core": "1.4.8",
    "langgraph": "1.2.6",
}


def _tool_name(tool_value: BaseTool | dict[str, Any] | object) -> str:
    if isinstance(tool_value, BaseTool):
        return tool_value.name
    if isinstance(tool_value, dict):
        name = tool_value.get("name")
        if isinstance(name, str):
            return name
        function = tool_value.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            return function["name"]
    name = getattr(tool_value, "__name__", None)
    return name if isinstance(name, str) else "<unknown>"


def _call(name: str, call_id: str, **arguments: Any) -> dict[str, Any]:
    return {
        "name": name,
        "args": arguments,
        "id": call_id,
        "type": "tool_call",
    }


class ScriptedModel(GenericFakeChatModel):
    """Deterministic tool-calling model that records every bound tool set."""

    messages: Iterator[AIMessage | str] = Field(default_factory=lambda: iter(()))
    scenario: str
    step: int = 0
    bound_tools: list[list[str]] = Field(default_factory=list)
    profile: dict[str, Any] | None = Field(
        default_factory=lambda: {
            "tool_calling": True,
            "max_input_tokens": 1_000_000,
        }
    )

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        del tool_choice, kwargs
        self.bound_tools.append([_tool_name(tool_value) for tool_value in tools])
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        del messages, stop, run_manager, kwargs
        step = self.step
        self.step += 1
        message = self._scripted_message(step)
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _scripted_message(self, step: int) -> AIMessage:  # noqa: C901, PLR0911
        if self.scenario == "guessed":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("guessed_hidden_probe", "guessed-call", value="proof")
                    ],
                )
            return AIMessage(content="guessed tool complete")

        if self.scenario == "direct":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("direct_visible_probe", "direct-call", value="proof")
                    ],
                )
            return AIMessage(content="direct tool complete")

        if self.scenario == "checkpoint":
            if step in (0, 3):
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("search_tools", f"search-{step}", query="weather")
                    ],
                )
            return AIMessage(content="checkpoint turn complete")

        if self.scenario == "concurrent":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("search_tools", "search-alpha", query="alpha capability"),
                        _call("search_tools", "search-beta", query="beta capability"),
                    ],
                )
            return AIMessage(content="parallel discovery complete")

        if self.scenario == "async":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("search_tools", "async-search", query="async capability")
                    ],
                )
            if step == 1:
                return AIMessage(
                    content="",
                    tool_calls=[_call("async_hidden_probe", "async-call")],
                )
            return AIMessage(content="async execution complete")

        if self.scenario == "subagent":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call(
                            "search_tools", "main-hidden-search", query="isolated probe"
                        )
                    ],
                )
            if step == 1:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("search_tools", "main-task-search", query="task")
                    ],
                )
            if step == 2:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call(
                            "task",
                            "main-task-call",
                            description="Prove your initial tool visibility is isolated.",
                            subagent_type="general-purpose",
                        )
                    ],
                )
            if step == 3:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call("search_tools", "subagent-search", query="isolated probe")
                    ],
                )
            if step == 4:
                return AIMessage(content="subagent isolation complete")
            return AIMessage(content="main agent complete")

        raise AssertionError(f"unknown scripted scenario: {self.scenario}")


class ToolAuditMiddleware(AgentMiddleware):
    """Record calls while delegating through the normal executor middleware."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[str] = []

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        self.seen.append(request.tool_call["name"])
        return handler(request)

    async def awrap_tool_call(
        self,
        request: Any,
        handler: Callable[[Any], Any],
    ) -> Any:
        self.seen.append(request.tool_call["name"])
        return await handler(request)


def _validate_versions_and_schema() -> None:
    actual = {
        package: importlib.metadata.version(package) for package in PINNED_VERSIONS
    }
    assert actual == PINNED_VERSIONS, (actual, PINNED_VERSIONS)

    schema = SearchToolsInput.model_json_schema()["properties"]["query"]
    assert schema["maxLength"] == MAX_SEARCH_QUERY_LENGTH == 256
    SearchToolsInput(query="q" * MAX_SEARCH_QUERY_LENGTH)
    try:
        SearchToolsInput(query="q" * (MAX_SEARCH_QUERY_LENGTH + 1))
    except ValidationError:
        pass
    else:
        raise AssertionError("search_tools accepted an oversized query")

    public_args = ProgressiveToolDisclosureMiddleware().tools[0].args
    assert set(public_args) == {"query"}
    assert public_args["query"]["maxLength"] == MAX_SEARCH_QUERY_LENGTH


def _validate_guessed_tool_execution() -> None:
    executions: list[str] = []

    @tool("guessed_hidden_probe")
    def hidden_probe(value: str) -> str:
        """A capability deliberately omitted from the initial model tool list."""
        executions.append(value)
        return "guessed-hidden-proof"

    model = ScriptedModel(scenario="guessed")
    audit = ToolAuditMiddleware()
    agent = create_agent(
        model=model,
        tools=[hidden_probe],
        middleware=[ProgressiveToolDisclosureMiddleware(), audit],
    )
    agent.invoke({"messages": [HumanMessage(content="Guess the hidden tool.")]})

    assert "search_tools" in model.bound_tools[0]
    assert "guessed_hidden_probe" not in model.bound_tools[0]
    assert executions == ["proof"]
    assert "guessed_hidden_probe" in audit.seen


def _validate_direct_mode_execution() -> None:
    executions: list[str] = []

    @tool("direct_visible_probe")
    def direct_probe(value: str) -> str:
        """Return a direct-mode proof through the standard executor stack."""
        executions.append(value)
        return "direct-proof"

    info = MCPServerInfo(
        name="direct-runtime-validator",
        transport="http",
        tools=(
            MCPToolInfo(
                name=direct_probe.name,
                description=direct_probe.description,
            ),
        ),
    )
    model = ScriptedModel(scenario="direct")
    previous = os.environ.get("NEMOCLAW_TOOL_DISCLOSURE")
    os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = "direct"
    try:
        assert not progressive_tool_disclosure_enabled()
        with tempfile.TemporaryDirectory(prefix="deepagents-direct-runtime-") as cwd:
            agent, _backend = create_cli_agent(
                model=model,
                assistant_id="direct-runtime-validator",
                tools=[direct_probe],
                cwd=Path(cwd),
                interactive=False,
                auto_approve=True,
                enable_ask_user=False,
                enable_memory=False,
                enable_skills=False,
                enable_shell=False,
                mcp_server_info=[info],
            )
            agent.invoke(
                {"messages": [HumanMessage(content="Call the directly visible tool.")]}
            )
    finally:
        if previous is None:
            os.environ.pop("NEMOCLAW_TOOL_DISCLOSURE", None)
        else:
            os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = previous

    assert "direct_visible_probe" in model.bound_tools[0]
    assert "search_tools" not in model.bound_tools[0]
    assert executions == ["proof"]


def _validate_checkpoints_and_threads() -> None:
    @tool("weather_checkpoint_probe")
    def weather_probe() -> str:
        """Return a weather checkpoint proof."""
        return "weather-proof"

    model = ScriptedModel(scenario="checkpoint")
    agent = create_agent(
        model=model,
        tools=[weather_probe],
        middleware=[ProgressiveToolDisclosureMiddleware()],
        checkpointer=InMemorySaver(),
    )
    thread_a = {"configurable": {"thread_id": "progressive-thread-a"}}
    thread_b = {"configurable": {"thread_id": "progressive-thread-b"}}

    agent.invoke({"messages": [HumanMessage(content="Discover weather.")]}, thread_a)
    assert "weather_checkpoint_probe" not in model.bound_tools[0]
    assert "weather_checkpoint_probe" in model.bound_tools[1]
    assert agent.get_state(thread_a).values["discovered_tools"] == [
        "weather_checkpoint_probe"
    ]

    resume_index = len(model.bound_tools)
    agent.invoke({"messages": [HumanMessage(content="Resume this thread.")]}, thread_a)
    assert "weather_checkpoint_probe" in model.bound_tools[resume_index]

    other_thread_index = len(model.bound_tools)
    agent.invoke({"messages": [HumanMessage(content="Use a fresh thread.")]}, thread_b)
    assert "weather_checkpoint_probe" not in model.bound_tools[other_thread_index]
    assert "weather_checkpoint_probe" in model.bound_tools[other_thread_index + 1]


def _validate_concurrent_discovery() -> None:
    @tool("alpha_capability_probe")
    def alpha_probe() -> str:
        """Return the alpha capability proof."""
        return "alpha"

    @tool("beta_capability_probe")
    def beta_probe() -> str:
        """Return the beta capability proof."""
        return "beta"

    model = ScriptedModel(scenario="concurrent")
    agent = create_agent(
        model=model,
        tools=[alpha_probe, beta_probe],
        middleware=[ProgressiveToolDisclosureMiddleware()],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "parallel-discovery"}}
    agent.invoke({"messages": [HumanMessage(content="Discover both tools.")]}, config)

    expected = ["alpha_capability_probe", "beta_capability_probe"]
    assert agent.get_state(config).values["discovered_tools"] == expected
    assert all(name not in model.bound_tools[0] for name in expected)
    assert all(name in model.bound_tools[1] for name in expected)


async def _validate_async_discovery() -> None:
    executions: list[str] = []

    @tool("async_hidden_probe")
    def async_probe() -> str:
        """Return an async capability proof through the standard executor."""
        executions.append("async")
        return "async-proof"

    model = ScriptedModel(scenario="async")
    agent = create_agent(
        model=model,
        tools=[async_probe],
        middleware=[ProgressiveToolDisclosureMiddleware()],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "async-discovery"}}
    await agent.ainvoke(
        {"messages": [HumanMessage(content="Discover asynchronously.")]},
        config,
    )

    assert "async_hidden_probe" not in model.bound_tools[0]
    assert "async_hidden_probe" in model.bound_tools[1]
    assert executions == ["async"]
    assert agent.get_state(config).values["discovered_tools"] == ["async_hidden_probe"]


def _validate_local_subagent_isolation() -> None:
    @tool("isolated_probe")
    def isolated_probe() -> str:
        """Return an isolated probe capability."""
        return "isolated-proof"

    model = ScriptedModel(scenario="subagent")
    info = MCPServerInfo(
        name="runtime-validator",
        transport="http",
        tools=(
            MCPToolInfo(
                name=isolated_probe.name,
                description=isolated_probe.description,
            ),
        ),
    )
    with tempfile.TemporaryDirectory(prefix="deepagents-progressive-runtime-") as cwd:
        agent, _backend = create_cli_agent(
            model=model,
            assistant_id="progressive-runtime-validator",
            tools=[isolated_probe],
            cwd=Path(cwd),
            interactive=False,
            auto_approve=True,
            enable_ask_user=False,
            enable_memory=False,
            enable_skills=False,
            enable_shell=False,
            mcp_server_info=[info],
        )
        agent.invoke(
            {"messages": [HumanMessage(content="Delegate an isolation proof.")]}
        )

    assert model.step == 6
    assert "isolated_probe" not in model.bound_tools[0]
    assert "isolated_probe" in model.bound_tools[1]
    assert "task" not in model.bound_tools[1]
    assert "task" in model.bound_tools[2]
    assert "isolated_probe" not in model.bound_tools[3]
    assert "isolated_probe" in model.bound_tools[4]
    assert "isolated_probe" in model.bound_tools[5]


def main() -> None:
    _validate_versions_and_schema()
    _validate_guessed_tool_execution()
    _validate_direct_mode_execution()
    _validate_checkpoints_and_threads()
    _validate_concurrent_discovery()
    asyncio.run(_validate_async_discovery())
    _validate_local_subagent_isolation()
    print("progressive-disclosure-runtime-ok")


if __name__ == "__main__":
    main()
