# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Dependency-free behavioral harness for progressive_tool_disclosure.py."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import importlib.util
import inspect
import json
import sys
import types
from pathlib import Path
from typing import Any, TypeVar


class _Generic:
    @classmethod
    def __class_getitem__(cls, _item: object) -> type:
        return cls


class AgentMiddleware(_Generic):
    def __init__(self) -> None:
        self.tools: list[BaseTool] = []


class AgentState(dict[str, Any], _Generic):
    pass


class ModelResponse(_Generic):
    pass


class AIMessage:
    pass


class ToolMessage:
    def __init__(self, content: str, *, tool_call_id: str | None = None) -> None:
        self.content = content
        self.tool_call_id = tool_call_id


class BaseTool:
    def __init__(
        self,
        name: str,
        description: str = "",
        schema: dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.schema = schema or {"properties": {}, "type": "object"}


class StructuredTool(BaseTool):
    def __init__(self, name: str, description: str, func: Any, coroutine: Any) -> None:
        super().__init__(name, description)
        self.func = func
        self.coroutine = coroutine

    @classmethod
    def from_function(
        cls,
        *,
        name: str,
        description: str,
        func: Any,
        coroutine: Any,
        **_kwargs: Any,
    ) -> "StructuredTool":
        return cls(name, description, func, coroutine)

    @property
    def injected_args_keys(self) -> frozenset[str]:
        """Model the pinned StructuredTool runtime-argument retention check."""
        return frozenset(
            name
            for name, parameter in inspect.signature(self.func).parameters.items()
            if parameter.annotation is ToolRuntime
        )


class ToolRuntime(_Generic):
    def __init__(
        self,
        state: dict[str, Any],
        tool_call_id: str = "search-call",
        tools: list[BaseTool] | None = None,
    ) -> None:
        self.state = state
        self.tool_call_id = tool_call_id
        self.tools = tools or []


class ModelRequest(_Generic):
    def __init__(self, tools: list[Any], state: dict[str, Any]) -> None:
        self.tools = tools
        self.state = state

    def override(self, **changes: Any) -> "ModelRequest":
        return ModelRequest(
            changes.get("tools", self.tools), changes.get("state", self.state)
        )


class Command(_Generic):
    def __init__(self, *, update: dict[str, Any]) -> None:
        self.update = update


class BaseModel:
    pass


def Field(*, description: str, max_length: int | None = None) -> str:
    del max_length
    return description


def convert_to_openai_tool(tool: BaseTool | dict[str, Any]) -> dict[str, Any]:
    if isinstance(tool, BaseTool):
        return {
            "type": "function",
            "function": {
                "description": tool.description,
                "name": tool.name,
                "parameters": tool.schema,
            },
        }
    return tool


def _install_stubs() -> None:
    context_t = TypeVar("ContextT")
    response_t = TypeVar("ResponseT")
    modules: dict[str, types.ModuleType] = {}
    for name in (
        "langchain",
        "langchain.agents",
        "langchain.agents.middleware",
        "langchain.agents.middleware.types",
        "langchain.tools",
        "langchain_core",
        "langchain_core.messages",
        "langchain_core.tools",
        "langchain_core.utils",
        "langchain_core.utils.function_calling",
        "langgraph",
        "langgraph.runtime",
        "langgraph.types",
        "pydantic",
    ):
        module = types.ModuleType(name)
        modules[name] = module
        sys.modules[name] = module

    middleware_types = modules["langchain.agents.middleware.types"]
    middleware_types.AgentMiddleware = AgentMiddleware
    middleware_types.AgentState = AgentState
    middleware_types.ContextT = context_t
    middleware_types.ModelRequest = ModelRequest
    middleware_types.ModelResponse = ModelResponse
    middleware_types.PrivateStateAttr = object()
    middleware_types.ResponseT = response_t
    modules["langchain.tools"].ToolRuntime = ToolRuntime
    modules["langchain_core.messages"].AIMessage = AIMessage
    modules["langchain_core.messages"].ToolMessage = ToolMessage
    modules["langchain_core.tools"].BaseTool = BaseTool
    modules["langchain_core.tools"].StructuredTool = StructuredTool
    modules[
        "langchain_core.utils.function_calling"
    ].convert_to_openai_tool = convert_to_openai_tool
    modules["langgraph.types"].Command = Command
    modules["pydantic"].BaseModel = BaseModel
    modules["pydantic"].Field = Field


def _load_module(path: Path) -> types.ModuleType:
    _install_stubs()
    spec = importlib.util.spec_from_file_location("progressive_tool_disclosure", path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _fixture(module: types.ModuleType) -> tuple[Any, list[Any], BaseTool, BaseTool]:
    middleware = module.ProgressiveToolDisclosureMiddleware()
    weather = BaseTool("Weather_Forecast", "Get a five-day weather outlook")
    database = BaseTool("query_database", "Search customer records by account name")
    tools: list[Any] = [
        weather,
        BaseTool("ls", "List files"),
        database,
        middleware.tools[0],
        BaseTool("read_file", "Read a file"),
        {"type": "provider-native"},
    ]
    return middleware, tools, weather, database


def _visible_names(request: ModelRequest) -> list[str]:
    return [tool.name for tool in request.tools if isinstance(tool, BaseTool)]


def _run_behavior(module: types.ModuleType) -> dict[str, Any]:
    middleware, tools, weather, database = _fixture(module)
    assert module.MAX_SEARCH_QUERY_LENGTH == 256
    provider_native = tools[-1]
    original = list(tools)
    captured: list[ModelRequest] = []
    middleware.wrap_model_call(
        ModelRequest(tools, {}),
        lambda request: captured.append(request) or ModelResponse(),
    )
    assert _visible_names(captured[-1]) == ["ls", "search_tools", "read_file"]
    assert captured[-1].tools[-1] is provider_native
    assert tools == original
    assert tools[0] is weather and tools[2] is database

    search_tool = middleware.tools[0]
    assert search_tool.injected_args_keys == frozenset({"runtime"})
    by_name = search_tool.func(query="wEaThEr", runtime=ToolRuntime({}, tools=tools))
    assert by_name.update["discovered_tools"] == ["Weather_Forecast"]
    assert "Weather_Forecast" in by_name.update["messages"][0].content
    state = module._merge_discovered_tools(None, by_name.update["discovered_tools"])
    revealed = middleware._prepare_request(
        ModelRequest(tools, {"discovered_tools": state})
    )
    assert weather in revealed.tools

    by_description = search_tool.func(
        query="CUSTOMER RECORDS",
        runtime=ToolRuntime({"discovered_tools": state}, tools=tools),
    )
    assert by_description.update["discovered_tools"] == ["query_database"]
    state = module._merge_discovered_tools(
        state, by_description.update["discovered_tools"]
    )
    assert state == ["Weather_Forecast", "query_database"]
    cumulative = middleware._prepare_request(
        ModelRequest(tools, {"discovered_tools": state})
    )
    assert weather in cumulative.tools and database in cumulative.tools
    assert cumulative.tools[-1] is provider_native

    repeated = search_tool.func(
        query="weather",
        runtime=ToolRuntime({"discovered_tools": state}, tools=tools),
    )
    assert repeated.update["discovered_tools"] == ["Weather_Forecast"]
    assert "already available" in repeated.update["messages"][0].content
    for query in ("not-a-capability", "   "):
        unmatched = search_tool.func(
            query=query,
            runtime=ToolRuntime({"discovered_tools": state}, tools=tools),
        )
        assert "discovered_tools" not in unmatched.update

    async def exercise_async() -> list[str]:
        async def handler(request: ModelRequest) -> ModelResponse:
            captured.append(request)
            return ModelResponse()

        await middleware.awrap_model_call(
            ModelRequest(tools, {"discovered_tools": state}),
            handler,
        )
        return _visible_names(captured[-1])

    async_names = asyncio.run(exercise_async())
    assert async_names == _visible_names(cumulative)
    return {
        "initial": _visible_names(captured[0]),
        "discovered": state,
        "async": async_names,
        "max_query_length": module.MAX_SEARCH_QUERY_LENGTH,
        "provider_native_preserved": captured[0].tools[-1] is provider_native,
    }


def _run_overflow(module: types.ModuleType) -> dict[str, Any]:
    middleware = module.ProgressiveToolDisclosureMiddleware()
    description = "bulk capability " + ("🧰" * 1024)
    bulk_tools = [BaseTool(f"bulk_{index:04d}", description) for index in range(1000)]
    provider_native = {"type": "provider-native", "opaque": object()}
    tools: list[Any] = [
        *bulk_tools,
        BaseTool("ls", "List files"),
        middleware.tools[0],
        provider_native,
    ]
    search_tool = middleware.tools[0]

    first = search_tool.func(
        query="bulk capability", runtime=ToolRuntime({}, tools=tools)
    )
    reversed_result = search_tool.func(
        query="bulk capability", runtime=ToolRuntime({}, tools=list(reversed(tools)))
    )
    discovered = first.update["discovered_tools"]
    expected_page = [f"bulk_{index:04d}" for index in range(module.MAX_SEARCH_RESULTS)]
    content = first.update["messages"][0].content
    assert discovered == expected_page
    assert reversed_result.update["discovered_tools"] == expected_page
    assert reversed_result.update["messages"][0].content == content
    assert len(content.encode("utf-8")) <= module.MAX_SEARCH_OUTPUT_BYTES
    assert "Search output truncated" in content
    assert (
        len(module._bounded_description(description))
        == module.MAX_SEARCH_DESCRIPTION_CHARS
    )
    first_state = module._merge_discovered_tools(None, discovered)
    first_visible = middleware._prepare_request(
        ModelRequest(tools, {"discovered_tools": first_state})
    )
    assert set(discovered).issubset(set(_visible_names(first_visible)))

    all_names = [tool.name for tool in bulk_tools]
    bounded_state = module._merge_discovered_tools(None, all_names)
    assert bounded_state == all_names[: module.MAX_DISCOVERED_TOOLS]
    assert (
        module._discovered_state_bytes(bounded_state)
        <= module.MAX_DISCOVERED_STATE_BYTES
    )
    assert (
        module._merge_discovered_tools(None, list(reversed(all_names))) == bounded_state
    )
    assert (
        module._merge_discovered_tools(all_names[:40], all_names[40:100])
        == module._merge_discovered_tools(all_names[40:100], all_names[:40])
        == bounded_state
    )
    long_names = [f"long_{index:04d}_" + ("🧰" * 25) for index in range(64)]
    long_state = module._merge_discovered_tools(None, long_names)
    assert len(long_state) == module.MAX_DISCOVERED_TOOLS
    assert (
        module._discovered_state_bytes(long_state) <= module.MAX_DISCOVERED_STATE_BYTES
    )
    overlong_name = "🧰" * ((module.MAX_DISCOVERED_TOOL_NAME_BYTES // 4) + 1)
    assert module._merge_discovered_tools(None, [overlong_name]) == []
    part_a, part_b, part_c = all_names[:50], all_names[50:100], all_names[100:150]
    assert (
        module._merge_discovered_tools(
            module._merge_discovered_tools(part_a, part_b), part_c
        )
        == module._merge_discovered_tools(
            part_a, module._merge_discovered_tools(part_b, part_c)
        )
        == module._merge_discovered_tools(None, [*part_a, *part_b, *part_c])
    )
    varying_a = [f"b{index:02d}_" + ("x" * (index % 80)) for index in range(64)]
    varying_b = ["z"]
    varying_c = ["a"]
    assert (
        module._merge_discovered_tools(
            module._merge_discovered_tools(varying_a, varying_b), varying_c
        )
        == module._merge_discovered_tools(
            varying_a, module._merge_discovered_tools(varying_b, varying_c)
        )
        == module._merge_discovered_tools(None, [*varying_a, *varying_b, *varying_c])
    )

    prepared = middleware._prepare_request(
        ModelRequest(tools, {"discovered_tools": all_names})
    )
    visible_schemas = [
        tool
        for tool in prepared.tools
        if isinstance(tool, BaseTool) and tool.name.startswith("bulk_")
    ]
    assert 0 < len(visible_schemas) < module.MAX_DISCOVERED_TOOLS
    assert (
        sum(module._serialized_tool_schema_bytes(tool) or 0 for tool in visible_schemas)
        <= module.MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES
    )
    reversed_prepared = middleware._prepare_request(
        ModelRequest(list(reversed(tools)), {"discovered_tools": all_names})
    )
    assert sorted(_visible_names(prepared)) == sorted(_visible_names(reversed_prepared))
    assert prepared.tools[-1] is provider_native
    initial = middleware._prepare_request(ModelRequest(tools, {}))
    assert initial.tools[-1] is provider_native

    state_blocked = search_tool.func(
        query="bulk_0999",
        runtime=ToolRuntime(
            {"discovered_tools": bounded_state},
            tools=tools,
        ),
    )
    assert "discovered_tools" not in state_blocked.update
    assert (
        "thread discovery state is limited"
        in state_blocked.update["messages"][0].content
    )
    high_state = [f"z_current_{index:04d}" for index in range(64)]
    earlier_state_tool = BaseTool("a_earlier", "earlier state candidate")
    high_state_tools = [
        *[BaseTool(name, "existing") for name in high_state],
        earlier_state_tool,
        middleware.tools[0],
    ]
    earlier_state_blocked = search_tool.func(
        query="a_earlier",
        runtime=ToolRuntime(
            {"discovered_tools": high_state},
            tools=high_state_tools,
        ),
    )
    assert "discovered_tools" not in earlier_state_blocked.update
    assert (
        module._merge_discovered_tools(
            high_state, earlier_state_blocked.update.get("discovered_tools")
        )
        == high_state
    )

    schema_full_state = all_names[: len(visible_schemas)]
    schema_blocked = search_tool.func(
        query=all_names[len(visible_schemas)],
        runtime=ToolRuntime(
            {"discovered_tools": schema_full_state},
            tools=tools,
        ),
    )
    assert "discovered_tools" not in schema_blocked.update
    assert (
        "discovered schemas are limited" in schema_blocked.update["messages"][0].content
    )

    earlier_schema = BaseTool("aaa_schema", description)
    earlier_tools = [earlier_schema, *tools]
    earlier_blocked = search_tool.func(
        query="aaa_schema",
        runtime=ToolRuntime(
            {"discovered_tools": schema_full_state},
            tools=earlier_tools,
        ),
    )
    assert "discovered_tools" not in earlier_blocked.update
    assert (
        "discovered schemas are limited"
        in earlier_blocked.update["messages"][0].content
    )
    assert set(
        _visible_names(
            middleware._prepare_request(
                ModelRequest(earlier_tools, {"discovered_tools": schema_full_state})
            )
        )
    ) == set(
        _visible_names(
            middleware._prepare_request(
                ModelRequest(tools, {"discovered_tools": schema_full_state})
            )
        )
    )

    oversized_schema = BaseTool(
        "oversized_schema",
        "oversized capability",
        {
            "properties": {
                "payload": {"const": "x" * module.MAX_SINGLE_TOOL_SCHEMA_BYTES}
            },
            "type": "object",
        },
    )
    overlong_tool = BaseTool(overlong_name, "overlong capability")
    unserializable_schema = BaseTool(
        "unserializable_schema",
        "unserializable capability",
        {"properties": {"payload": {"const": object()}}, "type": "object"},
    )
    ineligible_tools = [
        oversized_schema,
        overlong_tool,
        unserializable_schema,
        middleware.tools[0],
        provider_native,
    ]
    for query, name in (
        ("oversized capability", oversized_schema.name),
        ("overlong capability", overlong_tool.name),
        ("unserializable capability", unserializable_schema.name),
    ):
        omitted = search_tool.func(
            query=query,
            runtime=ToolRuntime({}, tools=ineligible_tools),
        )
        assert "discovered_tools" not in omitted.update
        assert "No hidden tools matched" in omitted.update["messages"][0].content
        filtered = middleware._prepare_request(
            ModelRequest(ineligible_tools, {"discovered_tools": [name]})
        )
        assert oversized_schema not in filtered.tools
        assert overlong_tool not in filtered.tools
        assert unserializable_schema not in filtered.tools
        assert filtered.tools[-1] is provider_native

    oversized_core = BaseTool(
        "ls",
        "oversized core",
        {
            "properties": {
                "payload": {"const": "x" * module.MAX_SINGLE_TOOL_SCHEMA_BYTES}
            },
            "type": "object",
        },
    )
    unserializable_core = BaseTool(
        "read_file",
        "unserializable core",
        {"properties": {"payload": {"const": object()}}, "type": "object"},
    )
    core_request = middleware._prepare_request(
        ModelRequest(
            [oversized_core, unserializable_core, middleware.tools[0]],
            {},
        )
    )
    assert core_request.tools[0] is oversized_core
    assert core_request.tools[1] is unserializable_core

    duplicate_first = BaseTool("duplicate_probe", "first duplicate description")
    duplicate_second = BaseTool("duplicate_probe", "second duplicate description")
    duplicate_tools = [
        duplicate_first,
        duplicate_second,
        middleware.tools[0],
    ]
    duplicate_result = search_tool.func(
        query="duplicate_probe",
        runtime=ToolRuntime({}, tools=duplicate_tools),
    )
    duplicate_content = duplicate_result.update["messages"][0].content
    assert "first duplicate description" in duplicate_content
    assert "second duplicate description" not in duplicate_content
    duplicate_visible = middleware._prepare_request(
        ModelRequest(duplicate_tools, {"discovered_tools": ["duplicate_probe"]})
    )
    assert duplicate_visible.tools[0] is duplicate_first
    assert duplicate_second not in duplicate_visible.tools

    empty_base_tool = BaseTool("", "empty name")
    empty_dict_tool = {"type": "function", "function": {"name": ""}}
    empty_visible = middleware._prepare_request(
        ModelRequest([empty_base_tool, empty_dict_tool, middleware.tools[0]], {})
    )
    assert empty_visible.tools[0] is empty_base_tool
    assert empty_visible.tools[1] is empty_dict_tool

    concurrent_state = [f"base_{index:04d}" for index in range(63)]
    concurrent_a = BaseTool("a_new", "concurrent capacity")
    concurrent_z = BaseTool("z_new", "concurrent capacity")
    concurrent_tools = [
        *[BaseTool(name, "existing") for name in concurrent_state],
        concurrent_a,
        concurrent_z,
        middleware.tools[0],
    ]
    concurrent_results = [
        search_tool.func(
            query=name,
            runtime=ToolRuntime(
                {"discovered_tools": concurrent_state},
                tools=concurrent_tools,
            ),
        )
        for name in ("a_new", "z_new")
    ]
    assert all(
        "exposing" not in result.update["messages"][0].content
        for result in concurrent_results
    )
    concurrent_merged = module._merge_discovered_tools(
        concurrent_results[0].update.get("discovered_tools"),
        concurrent_results[1].update.get("discovered_tools"),
    )
    concurrent_merged = module._merge_discovered_tools(
        concurrent_state, concurrent_merged
    )
    assert len(concurrent_merged) == module.MAX_DISCOVERED_TOOLS
    concurrent_visible = middleware._prepare_request(
        ModelRequest(concurrent_tools, {"discovered_tools": concurrent_merged})
    )
    assert set(_visible_names(concurrent_visible)).issuperset(concurrent_merged)

    return {
        "core_schema_limits_exempt": True,
        "description_chars": module.MAX_SEARCH_DESCRIPTION_CHARS,
        "discovered_count": len(discovered),
        "discovery_limit": module.MAX_DISCOVERED_TOOLS,
        "discovery_name_bytes": module.MAX_DISCOVERED_TOOL_NAME_BYTES,
        "discovery_state_bytes": module._discovered_state_bytes(long_state),
        "discovery_state_bytes_limit": module.MAX_DISCOVERED_STATE_BYTES,
        "duplicate_first_wins": duplicate_visible.tools[0] is duplicate_first,
        "empty_names_preserved": empty_visible.tools[:2]
        == [empty_base_tool, empty_dict_tool],
        "long_state_count": len(long_state),
        "output_bytes": len(content.encode("utf-8")),
        "output_bytes_limit": module.MAX_SEARCH_OUTPUT_BYTES,
        "oversized_schema_omitted": oversized_schema not in filtered.tools,
        "provider_native_preserved": initial.tools[-1] is provider_native,
        "result_limit": module.MAX_SEARCH_RESULTS,
        "single_schema_bytes_limit": module.MAX_SINGLE_TOOL_SCHEMA_BYTES,
        "state_count": len(bounded_state),
        "search_to_request_consistent": set(discovered).issubset(
            set(_visible_names(first_visible))
        ),
        "reducer_associative": True,
        "concurrent_response_bounded": True,
        "sequential_visibility_monotonic": True,
        "state_blocked": True,
        "schema_blocked": True,
        "visible_schema_bytes_limit": module.MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES,
        "visible_schema_count": len(visible_schemas),
    }


def _run_persistence(module: types.ModuleType) -> dict[str, Any]:
    first, tools, weather, _database = _fixture(module)
    first._prepare_request(ModelRequest(tools, {"messages": ["before compaction"]}))
    command = first.tools[0].func(query="weather", runtime=ToolRuntime({}, tools=tools))
    checkpoint = {
        "messages": ["compacted summary"],
        "discovered_tools": command.update["discovered_tools"],
    }

    resumed = module.ProgressiveToolDisclosureMiddleware()
    resumed_tools = [
        tool for tool in tools if getattr(tool, "name", None) != "search_tools"
    ]
    resumed_tools.insert(3, resumed.tools[0])
    visible = resumed._prepare_request(ModelRequest(resumed_tools, checkpoint))
    assert weather in visible.tools
    unknown = resumed._prepare_request(
        ModelRequest(resumed_tools, {"discovered_tools": ["missing_tool"]})
    )
    assert weather not in unknown.tools
    assert "discovered_tools" in module.ProgressiveToolDisclosureState.__annotations__
    return {"resumed": _visible_names(visible), "unknown": _visible_names(unknown)}


def _run_isolation(module: types.ModuleType) -> dict[str, Any]:
    middleware, tools, weather, _database = _fixture(module)
    thread_a = middleware._prepare_request(
        ModelRequest(tools, {"discovered_tools": ["Weather_Forecast"]})
    )
    thread_b = middleware._prepare_request(ModelRequest(tools, {}))
    assert weather in thread_a.tools
    assert weather not in thread_b.tools
    subagent = module.ProgressiveToolDisclosureMiddleware()
    assert subagent is not middleware
    assert subagent.tools[0] is not middleware.tools[0]
    return {"thread_a": _visible_names(thread_a), "thread_b": _visible_names(thread_b)}


def _run_namespace(module: types.ModuleType) -> dict[str, Any]:
    class Info:
        def __init__(self, name: str, tools: tuple[BaseTool, ...]) -> None:
            self.name = name
            self.tools = tools

    def collision(
        tools: list[BaseTool], mcp_server_info: list[Info] | None = None
    ) -> str:
        try:
            module.assert_unique_callable_tool_names(tools, mcp_server_info)
        except RuntimeError as exc:
            return str(exc)
        raise AssertionError("ambiguous callable tool namespace was accepted")

    duplicate_regular = [
        BaseTool("shared_regular", "first implementation"),
        BaseTool("shared_regular", "second implementation"),
    ]
    regular_mcp = [
        BaseTool("mcp_echo", "regular implementation"),
        BaseTool("mcp_echo", "MCP implementation"),
    ]
    cross_mcp = [
        BaseTool("alpha_beta_echo", "first MCP implementation"),
        BaseTool("alpha_beta_echo", "second MCP implementation"),
    ]
    safe_mcp = BaseTool("safe_echo", "one loaded MCP implementation")
    module.assert_unique_callable_tool_names(
        [safe_mcp], [Info("safe", (safe_mcp,))]
    )

    return {
        "cross_mcp": collision(
            cross_mcp,
            [
                Info("alpha", (cross_mcp[0],)),
                Info("alpha_beta", (cross_mcp[1],)),
            ],
        ),
        "regular_mcp": collision(
            regular_mcp, [Info("mcp", (regular_mcp[1],))]
        ),
        "regular_regular": collision(duplicate_regular),
        "reserved_mcp": collision(
            [BaseTool("search_tools")],
            [Info("search", (BaseTool("search_tools"),))],
        ),
        "reserved_regular": collision([BaseTool("read_file")]),
        "safe_mcp": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "scenario",
        choices=("behavior", "overflow", "persistence", "isolation", "namespace"),
    )
    parser.add_argument("module", type=Path)
    args = parser.parse_args()
    module = _load_module(args.module)
    runners = {
        "behavior": _run_behavior,
        "overflow": _run_overflow,
        "persistence": _run_persistence,
        "isolation": _run_isolation,
        "namespace": _run_namespace,
    }
    print(json.dumps(runners[args.scenario](module), sort_keys=True))


if __name__ == "__main__":
    main()
