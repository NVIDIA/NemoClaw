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

from deepagents_code import agent as agent_module
from deepagents_code import progressive_tool_disclosure as disclosure
from deepagents_code.agent import create_cli_agent
from deepagents_code.mcp_tools import MCPServerInfo, MCPToolInfo
from deepagents_code.progressive_tool_disclosure import (
    MAX_DISCOVERED_STATE_BYTES,
    MAX_DISCOVERED_TOOL_NAME_BYTES,
    MAX_DISCOVERED_TOOLS,
    MAX_SEARCH_DESCRIPTION_CHARS,
    MAX_SEARCH_OUTPUT_BYTES,
    MAX_SEARCH_QUERY_LENGTH,
    MAX_SEARCH_RESULTS,
    MAX_SINGLE_TOOL_SCHEMA_BYTES,
    MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES,
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
    "deepagents-code": "0.1.34",
    "deepagents": "0.7.0a6",
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

        if self.scenario == "collision":
            if step == 0:
                return AIMessage(
                    content="",
                    tool_calls=[
                        _call(
                            "schema_executor_collision",
                            "collision-call",
                            value="proof",
                        )
                    ],
                )
            return AIMessage(content="collision probe complete")

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
    description = ProgressiveToolDisclosureMiddleware().tools[0].description
    for limit in (
        MAX_SEARCH_RESULTS,
        MAX_SEARCH_DESCRIPTION_CHARS,
        MAX_SEARCH_OUTPUT_BYTES,
        MAX_DISCOVERED_TOOLS,
        MAX_DISCOVERED_TOOL_NAME_BYTES,
        MAX_DISCOVERED_STATE_BYTES,
        MAX_SINGLE_TOOL_SCHEMA_BYTES,
        MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES,
    ):
        assert str(limit) in description


class _RequestProbe:
    """Minimal request shape for exact middleware filtering validation."""

    def __init__(self, tools: list[Any], state: dict[str, Any]) -> None:
        self.tools = tools
        self.state = state

    def override(self, **changes: Any) -> _RequestProbe:
        return _RequestProbe(
            changes.get("tools", self.tools), changes.get("state", self.state)
        )


class _RuntimeProbe:
    """Minimal runtime shape for exact search result validation."""

    def __init__(self, tools: list[Any], state: dict[str, Any] | None = None) -> None:
        self.tools = tools
        self.state = state or {}
        self.tool_call_id = "bounded-search"


def _validate_bounded_catalog_and_provider_native_tools() -> None:
    middleware = ProgressiveToolDisclosureMiddleware()
    description = "bulk capability " + ("🧰" * 1024)
    catalog = [
        {
            "type": "function",
            "function": {
                "name": f"bulk_{index:04d}",
                "description": description,
            },
        }
        for index in range(1000)
    ]
    provider_native = {"type": "provider-native", "opaque": object()}
    tools: list[Any] = [*catalog, middleware.tools[0], provider_native]

    result = middleware._search_tools(  # noqa: SLF001
        "bulk capability", _RuntimeProbe(tools)
    )
    reversed_result = middleware._search_tools(  # noqa: SLF001
        "bulk capability", _RuntimeProbe(list(reversed(tools)))
    )
    expected = [f"bulk_{index:04d}" for index in range(MAX_SEARCH_RESULTS)]
    assert result.update["discovered_tools"] == expected
    assert reversed_result.update["discovered_tools"] == expected
    content = result.update["messages"][0].content
    assert reversed_result.update["messages"][0].content == content
    assert len(content.encode("utf-8")) <= MAX_SEARCH_OUTPUT_BYTES
    assert "Search output truncated" in content
    assert ("🧰" * MAX_SEARCH_DESCRIPTION_CHARS) not in content
    first_state = disclosure._merge_discovered_tools(  # noqa: SLF001
        None, result.update["discovered_tools"]
    )
    first_visible = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(tools, {"discovered_tools": first_state})
    )
    assert set(expected).issubset(
        {_tool_name(tool_value) for tool_value in first_visible.tools}
    )

    all_names = [f"bulk_{index:04d}" for index in range(1000)]
    bounded_state = disclosure._merge_discovered_tools(None, all_names)  # noqa: SLF001
    assert bounded_state == all_names[:MAX_DISCOVERED_TOOLS]
    assert (
        disclosure._discovered_state_bytes(bounded_state)  # noqa: SLF001
        <= MAX_DISCOVERED_STATE_BYTES
    )
    assert (
        disclosure._merge_discovered_tools(  # noqa: SLF001
            None, list(reversed(all_names))
        )
        == bounded_state
    )
    assert (
        disclosure._merge_discovered_tools(  # noqa: SLF001
            all_names[:40], all_names[40:100]
        )
        == disclosure._merge_discovered_tools(  # noqa: SLF001
            all_names[40:100], all_names[:40]
        )
        == bounded_state
    )
    long_names = [f"long_{index:04d}_" + ("🧰" * 25) for index in range(64)]
    long_state = disclosure._merge_discovered_tools(None, long_names)  # noqa: SLF001
    assert len(long_state) == MAX_DISCOVERED_TOOLS
    assert (
        disclosure._discovered_state_bytes(long_state)  # noqa: SLF001
        <= MAX_DISCOVERED_STATE_BYTES
    )
    overlong_name = "🧰" * ((MAX_DISCOVERED_TOOL_NAME_BYTES // 4) + 1)
    assert disclosure._merge_discovered_tools(None, [overlong_name]) == []  # noqa: SLF001
    part_a, part_b, part_c = all_names[:50], all_names[50:100], all_names[100:150]
    assert (
        disclosure._merge_discovered_tools(  # noqa: SLF001
            disclosure._merge_discovered_tools(part_a, part_b),  # noqa: SLF001
            part_c,
        )
        == disclosure._merge_discovered_tools(  # noqa: SLF001
            part_a,
            disclosure._merge_discovered_tools(part_b, part_c),  # noqa: SLF001
        )
        == disclosure._merge_discovered_tools(  # noqa: SLF001
            None, [*part_a, *part_b, *part_c]
        )
    )
    varying_a = [f"b{index:02d}_" + ("x" * (index % 80)) for index in range(64)]
    varying_b = ["z"]
    varying_c = ["a"]
    assert (
        disclosure._merge_discovered_tools(  # noqa: SLF001
            disclosure._merge_discovered_tools(varying_a, varying_b),  # noqa: SLF001
            varying_c,
        )
        == disclosure._merge_discovered_tools(  # noqa: SLF001
            varying_a,
            disclosure._merge_discovered_tools(varying_b, varying_c),  # noqa: SLF001
        )
        == disclosure._merge_discovered_tools(  # noqa: SLF001
            None, [*varying_a, *varying_b, *varying_c]
        )
    )

    prepared = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(tools, {"discovered_tools": all_names})
    )
    visible_schemas = [
        tool_value
        for tool_value in prepared.tools
        if _tool_name(tool_value).startswith("bulk_")
    ]
    assert 0 < len(visible_schemas) < MAX_DISCOVERED_TOOLS
    assert (
        sum(
            disclosure._serialized_tool_schema_bytes(tool_value) or 0  # noqa: SLF001
            for tool_value in visible_schemas
        )
        <= MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES
    )
    reversed_prepared = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(list(reversed(tools)), {"discovered_tools": all_names})
    )
    assert sorted(_tool_name(tool_value) for tool_value in prepared.tools) == sorted(
        _tool_name(tool_value) for tool_value in reversed_prepared.tools
    )
    assert prepared.tools[-1] is provider_native
    initial = middleware._prepare_request(_RequestProbe(tools, {}))  # noqa: SLF001
    assert initial.tools[-1] is provider_native

    state_blocked = middleware._search_tools(  # noqa: SLF001
        "bulk_0999", _RuntimeProbe(tools, {"discovered_tools": bounded_state})
    )
    assert "discovered_tools" not in state_blocked.update
    assert (
        "thread discovery state is limited"
        in state_blocked.update["messages"][0].content
    )
    high_state = [f"z_current_{index:04d}" for index in range(64)]
    earlier_state_tool = {
        "type": "function",
        "function": {
            "name": "a_earlier",
            "description": "earlier state candidate",
        },
    }
    high_state_tools = [
        *[
            {
                "type": "function",
                "function": {"name": name, "description": "existing"},
            }
            for name in high_state
        ],
        earlier_state_tool,
        middleware.tools[0],
    ]
    earlier_state_blocked = middleware._search_tools(  # noqa: SLF001
        "a_earlier",
        _RuntimeProbe(high_state_tools, {"discovered_tools": high_state}),
    )
    assert "discovered_tools" not in earlier_state_blocked.update
    assert (
        disclosure._merge_discovered_tools(  # noqa: SLF001
            high_state, earlier_state_blocked.update.get("discovered_tools")
        )
        == high_state
    )

    schema_full_state = all_names[: len(visible_schemas)]
    schema_blocked = middleware._search_tools(  # noqa: SLF001
        all_names[len(visible_schemas)],
        _RuntimeProbe(tools, {"discovered_tools": schema_full_state}),
    )
    assert "discovered_tools" not in schema_blocked.update
    assert (
        "discovered schemas are limited" in schema_blocked.update["messages"][0].content
    )
    earlier_schema = {
        "type": "function",
        "function": {"name": "aaa_schema", "description": description},
    }
    earlier_tools = [earlier_schema, *tools]
    earlier_blocked = middleware._search_tools(  # noqa: SLF001
        "aaa_schema",
        _RuntimeProbe(earlier_tools, {"discovered_tools": schema_full_state}),
    )
    assert "discovered_tools" not in earlier_blocked.update
    assert (
        "discovered schemas are limited"
        in earlier_blocked.update["messages"][0].content
    )

    oversized_schema = {
        "type": "function",
        "function": {
            "name": "oversized_schema",
            "description": "oversized capability",
            "parameters": {
                "properties": {
                    "payload": {"const": "x" * MAX_SINGLE_TOOL_SCHEMA_BYTES}
                },
                "type": "object",
            },
        },
    }
    overlong_tool = {
        "type": "function",
        "function": {
            "name": overlong_name,
            "description": "overlong capability",
            "parameters": {"properties": {}, "type": "object"},
        },
    }
    unserializable_schema = {
        "type": "function",
        "function": {
            "name": "unserializable_schema",
            "description": "unserializable capability",
            "parameters": {
                "properties": {"payload": {"const": object()}},
                "type": "object",
            },
        },
    }
    ineligible_tools = [
        oversized_schema,
        overlong_tool,
        unserializable_schema,
        middleware.tools[0],
        provider_native,
    ]
    for query, name in (
        ("oversized capability", "oversized_schema"),
        ("overlong capability", overlong_name),
        ("unserializable capability", "unserializable_schema"),
    ):
        omitted = middleware._search_tools(  # noqa: SLF001
            query, _RuntimeProbe(ineligible_tools)
        )
        assert "discovered_tools" not in omitted.update
        assert "No hidden tools matched" in omitted.update["messages"][0].content
        filtered = middleware._prepare_request(  # noqa: SLF001
            _RequestProbe(ineligible_tools, {"discovered_tools": [name]})
        )
        assert oversized_schema not in filtered.tools
        assert overlong_tool not in filtered.tools
        assert unserializable_schema not in filtered.tools
        assert filtered.tools[-1] is provider_native

    oversized_core = {
        "name": "ls",
        "description": "oversized core",
        "parameters": {
            "properties": {"payload": {"const": "x" * MAX_SINGLE_TOOL_SCHEMA_BYTES}},
            "type": "object",
        },
    }
    unserializable_core = {
        "name": "read_file",
        "description": "unserializable core",
        "parameters": {
            "properties": {"payload": {"const": object()}},
            "type": "object",
        },
    }
    core_request = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(
            [oversized_core, unserializable_core, middleware.tools[0]],
            {},
        )
    )
    assert core_request.tools[0] is oversized_core
    assert core_request.tools[1] is unserializable_core

    duplicate_first = {
        "type": "function",
        "function": {
            "name": "duplicate_probe",
            "description": "first duplicate description",
        },
    }
    duplicate_second = {
        "type": "function",
        "function": {
            "name": "duplicate_probe",
            "description": "second duplicate description",
        },
    }
    duplicate_tools = [duplicate_first, duplicate_second, middleware.tools[0]]
    duplicate_result = middleware._search_tools(  # noqa: SLF001
        "duplicate_probe", _RuntimeProbe(duplicate_tools)
    )
    duplicate_content = duplicate_result.update["messages"][0].content
    assert "first duplicate description" in duplicate_content
    assert "second duplicate description" not in duplicate_content
    duplicate_visible = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(duplicate_tools, {"discovered_tools": ["duplicate_probe"]})
    )
    assert duplicate_visible.tools[0] is duplicate_first
    assert duplicate_second not in duplicate_visible.tools

    empty_top_level = {"name": "", "description": "empty top-level name"}
    empty_nested = {"type": "function", "function": {"name": ""}}
    empty_visible = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe([empty_top_level, empty_nested, middleware.tools[0]], {})
    )
    assert empty_visible.tools[0] is empty_top_level
    assert empty_visible.tools[1] is empty_nested

    concurrent_state = [f"base_{index:04d}" for index in range(63)]
    concurrent_tools = [
        *[
            {
                "type": "function",
                "function": {"name": name, "description": "existing"},
            }
            for name in concurrent_state
        ],
        {
            "type": "function",
            "function": {"name": "a_new", "description": "concurrent capacity"},
        },
        {
            "type": "function",
            "function": {"name": "z_new", "description": "concurrent capacity"},
        },
        middleware.tools[0],
    ]
    concurrent_results = [
        middleware._search_tools(  # noqa: SLF001
            name,
            _RuntimeProbe(concurrent_tools, {"discovered_tools": concurrent_state}),
        )
        for name in ("a_new", "z_new")
    ]
    assert all(
        "exposing" not in result.update["messages"][0].content
        for result in concurrent_results
    )
    concurrent_updates = disclosure._merge_discovered_tools(  # noqa: SLF001
        concurrent_results[0].update.get("discovered_tools"),
        concurrent_results[1].update.get("discovered_tools"),
    )
    concurrent_merged = disclosure._merge_discovered_tools(  # noqa: SLF001
        concurrent_state, concurrent_updates
    )
    assert len(concurrent_merged) == MAX_DISCOVERED_TOOLS
    concurrent_visible = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(concurrent_tools, {"discovered_tools": concurrent_merged})
    )
    assert {
        _tool_name(tool_value) for tool_value in concurrent_visible.tools
    }.issuperset(concurrent_merged)


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


def _validate_pinned_executor_collision_and_namespace_guard() -> None:
    executions: list[str] = []

    @tool("schema_executor_collision")
    def model_schema_tool(value: str) -> str:
        """model-visible-schema-sentinel"""
        executions.append(f"model-schema:{value}")
        return "wrong-implementation"

    @tool("schema_executor_collision")
    def executor_tool(value: str) -> str:
        """executor-implementation-sentinel"""
        executions.append(f"executor:{value}")
        return "executor-proof"

    # Pin the reason for the guard: disclosure selects the first schema from
    # the full registry while the exact LangChain executor resolves the same
    # duplicate name to the last implementation.
    middleware = ProgressiveToolDisclosureMiddleware()
    prepared = middleware._prepare_request(  # noqa: SLF001
        _RequestProbe(
            [model_schema_tool, executor_tool, middleware.tools[0]],
            {"discovered_tools": ["schema_executor_collision"]},
        )
    )
    visible_collision_tools = [
        tool_value
        for tool_value in prepared.tools
        if _tool_name(tool_value) == "schema_executor_collision"
    ]
    assert visible_collision_tools == [model_schema_tool]
    assert visible_collision_tools[0].description == "model-visible-schema-sentinel"

    collision_model = ScriptedModel(scenario="collision")
    collision_agent = create_agent(
        model=collision_model,
        tools=[model_schema_tool, executor_tool],
    )
    collision_agent.invoke(
        {"messages": [HumanMessage(content="Exercise duplicate tool resolution.")]}
    )
    assert executions == ["executor:proof"]

    @tool("read_file")
    def reserved_regular() -> str:
        """Represent an untrusted regular tool with a reserved core name."""
        return "must-not-run"

    def collision_tool(name: str, marker: str) -> BaseTool:
        @tool(name)
        def probe(value: str = "") -> str:
            """Represent one implementation in a collision fixture."""
            return f"{marker}:{value}"

        return probe

    regular_a = collision_tool("regular_duplicate", "regular-a")
    regular_b = collision_tool("regular_duplicate", "regular-b")
    regular_mcp = collision_tool("mcp_echo", "regular")
    mcp_peer = collision_tool("mcp_echo", "mcp")
    cross_mcp_a = collision_tool("alpha_beta_echo", "alpha-beta_echo")
    cross_mcp_b = collision_tool("alpha_beta_echo", "alpha_beta-echo")

    collision_cases = {
        "regular_regular": (
            "progressive",
            [regular_a, regular_b],
            [],
        ),
        "regular_mcp": (
            "progressive",
            [regular_mcp, mcp_peer],
            [
                MCPServerInfo(
                    name="mcp",
                    transport="http",
                    tools=(
                        MCPToolInfo(
                            name="mcp_echo",
                            description="MCP implementation",
                        ),
                    ),
                )
            ],
        ),
        "cross_mcp": (
            "progressive",
            [cross_mcp_a, cross_mcp_b],
            [
                MCPServerInfo(
                    name=server,
                    transport="http",
                    tools=(
                        MCPToolInfo(
                            name="alpha_beta_echo",
                            description=f"{server} implementation",
                        ),
                    ),
                )
                for server in ("alpha", "alpha_beta")
            ],
        ),
        "reserved_progressive": (
            "progressive",
            [reserved_regular],
            [],
        ),
        "reserved_mcp": (
            "progressive",
            [collision_tool("search_tools", "reserved-mcp")],
            [
                MCPServerInfo(
                    name="search",
                    transport="http",
                    tools=(
                        MCPToolInfo(
                            name="search_tools",
                            description="non-managed reserved implementation",
                        ),
                    ),
                )
            ],
        ),
        "duplicate_direct": (
            "direct",
            [regular_a, regular_b],
            [],
        ),
        "reserved_direct": (
            "direct",
            [collision_tool("execute", "reserved-direct")],
            [],
        ),
    }
    original_cli_factory = agent_module._nemoclaw_original_create_cli_agent
    reached_original: list[str] = []

    def forbidden_original(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        reached_original.append("called")
        raise AssertionError("reserved-name validation ran too late")

    agent_module._nemoclaw_original_create_cli_agent = forbidden_original
    previous = os.environ.get("NEMOCLAW_TOOL_DISCLOSURE")
    try:
        errors: dict[str, str] = {}
        for label, (mode, tools, info) in collision_cases.items():
            os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = mode
            try:
                create_cli_agent(
                    model=object(),
                    assistant_id="callable-namespace-validator",
                    tools=tools,
                    mcp_server_info=info,
                )
            except RuntimeError as exc:
                errors[label] = str(exc)
            else:
                raise AssertionError(f"callable namespace collision {label!r} was accepted")
    finally:
        agent_module._nemoclaw_original_create_cli_agent = original_cli_factory
        if previous is None:
            os.environ.pop("NEMOCLAW_TOOL_DISCLOSURE", None)
        else:
            os.environ["NEMOCLAW_TOOL_DISCLOSURE"] = previous

    assert reached_original == []
    assert set(errors) == set(collision_cases)
    assert "multiple registered implementations" in errors["regular_regular"]
    assert "MCP metadata owners" in errors["regular_mcp"]
    assert "multiple MCP owners" in errors["cross_mcp"]
    assert "reserved name 'read_file'" in errors["reserved_progressive"]
    assert "MCP server 'search' tool[0]" in errors["reserved_mcp"]
    assert "reserved name 'search_tools'" in errors["reserved_mcp"]
    assert "multiple registered implementations" in errors["duplicate_direct"]
    assert "reserved name 'execute'" in errors["reserved_direct"]


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
    _validate_bounded_catalog_and_provider_native_tools()
    _validate_guessed_tool_execution()
    _validate_pinned_executor_collision_and_namespace_guard()
    _validate_direct_mode_execution()
    _validate_checkpoints_and_threads()
    _validate_concurrent_discovery()
    asyncio.run(_validate_async_discovery())
    _validate_local_subagent_isolation()
    print("progressive-disclosure-runtime-ok")


if __name__ == "__main__":
    main()
