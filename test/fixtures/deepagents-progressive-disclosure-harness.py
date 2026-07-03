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
    def __init__(self, name: str, description: str = "") -> None:
        self.name = name
        self.description = description


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
    original = list(tools)
    captured: list[ModelRequest] = []
    middleware.wrap_model_call(
        ModelRequest(tools, {}),
        lambda request: captured.append(request) or ModelResponse(),
    )
    assert _visible_names(captured[-1]) == ["ls", "search_tools", "read_file"]
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


def _run_wiring(agent_path: Path) -> dict[str, Any]:
    _install_stubs()
    package_root = agent_path.parent.parent
    sys.path.insert(0, str(package_root))
    try:
        agent = importlib.import_module("deepagents_code.agent")
    finally:
        sys.path.pop(0)

    class Info:
        def __init__(self, tools: tuple[str, ...]) -> None:
            self.tools = tools

    no_info = agent.create_cli_agent(None)
    empty_info = agent.create_cli_agent([Info(())])
    active = agent.create_cli_agent([Info(("mcp_echo",))])

    middleware_type = agent.ProgressiveToolDisclosureMiddleware
    for main_stack, subagent_stacks in (no_info, empty_info):
        assert not any(isinstance(item, middleware_type) for item in main_stack)
        assert all(
            not any(isinstance(item, middleware_type) for item in stack)
            for stack in subagent_stacks
        )

    main_stack, subagent_stacks = active
    main_instances = [item for item in main_stack if isinstance(item, middleware_type)]
    subagent_instances = [
        item
        for stack in subagent_stacks
        for item in stack
        if isinstance(item, middleware_type)
    ]
    assert len(main_instances) == 1
    assert len(subagent_instances) == 2
    assert len({id(*main_instances), *(id(item) for item in subagent_instances)}) == 3
    return {"main": len(main_instances), "subagents": len(subagent_instances)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "scenario",
        choices=("behavior", "persistence", "isolation", "wiring"),
    )
    parser.add_argument("module", type=Path)
    args = parser.parse_args()
    if args.scenario == "wiring":
        print(json.dumps(_run_wiring(args.module), sort_keys=True))
        return
    module = _load_module(args.module)
    runners = {
        "behavior": _run_behavior,
        "persistence": _run_persistence,
        "isolation": _run_isolation,
    }
    print(json.dumps(runners[args.scenario](module), sort_keys=True))


if __name__ == "__main__":
    main()
