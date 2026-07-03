# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Progressively disclose Deep Agents tools without changing execution policy."""

from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Any, NotRequired, cast

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ContextT,
    ModelRequest,
    ModelResponse,
    PrivateStateAttr,
    ResponseT,
)
from langchain.tools import ToolRuntime
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import Command
from pydantic import BaseModel, Field

CORE_TOOL_NAMES = frozenset(
    {
        "search_tools",
        "ls",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "execute",
        "ask_user",
        "write_todos",
    }
)
"""Tools that remain visible before any progressive discovery."""

SEARCH_TOOLS_DESCRIPTION = """Search hidden tools by a case-insensitive keyword.

Use this when the visible tools do not provide a capability you need. The query
is matched against registered tool names and descriptions. Matching tools become
available for the rest of this conversation thread. An empty query discovers
nothing; use a specific capability keyword such as "database" or "calendar".
"""


def _merge_discovered_tools(
    current: list[str] | None,
    update: list[str] | None,
) -> list[str]:
    """Union concurrent and resumed discovery updates deterministically."""
    return sorted(set(current or ()) | set(update or ()))


class ProgressiveToolDisclosureState(AgentState):
    """Private checkpoint state for tools discovered in one graph thread.

    ``PrivateStateAttr`` keeps discoveries out of parent/subagent input and
    output while the checkpointer retains them for the owning graph thread.
    """

    discovered_tools: Annotated[
        NotRequired[list[str]],
        _merge_discovered_tools,
        PrivateStateAttr,
    ]


class SearchToolsInput(BaseModel):
    """Input contract for the ``search_tools`` model tool."""

    query: str = Field(
        description="Keyword to match against tool names and descriptions."
    )


class _ToolCatalogEntry:
    """Immutable searchable metadata for one registered model tool."""

    __slots__ = ("description", "name")

    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description


def _tool_name(tool: BaseTool | dict[str, Any]) -> str | None:
    """Return a registered tool name without changing the tool object."""
    if isinstance(tool, BaseTool):
        return tool.name
    name = tool.get("name")
    if isinstance(name, str):
        return name
    function = tool.get("function")
    if isinstance(function, dict) and isinstance(function.get("name"), str):
        return cast("str", function["name"])
    return None


def _tool_description(tool: BaseTool | dict[str, Any]) -> str:
    """Return searchable descriptive text for a registered tool."""
    if isinstance(tool, BaseTool):
        return tool.description or ""
    description = tool.get("description")
    if isinstance(description, str):
        return description
    function = tool.get("function")
    if isinstance(function, dict) and isinstance(function.get("description"), str):
        return cast("str", function["description"])
    return ""


class ProgressiveToolDisclosureMiddleware(
    AgentMiddleware[ProgressiveToolDisclosureState, ContextT, ResponseT]
):
    """Expose a core tool set, then reveal matching tools for one thread.

    The full tool registry remains registered with the executor. Only the tools
    sent to each model request are filtered, so existing policy, approval, and
    credential boundaries still govern execution after a tool is discovered.
    """

    state_schema = ProgressiveToolDisclosureState

    def __init__(self) -> None:
        """Create an isolated disclosure middleware instance."""
        super().__init__()

        # Keep these annotations concrete (this module intentionally does not
        # enable postponed annotations). StructuredTool uses inspect.signature
        # to retain injected ToolRuntime arguments after validating the public
        # SearchToolsInput schema.
        def search_tools(
            query: str,
            runtime: ToolRuntime[ContextT, ProgressiveToolDisclosureState],
        ) -> Command[Any]:
            return self._search_tools(query, runtime)

        async def asearch_tools(
            query: str,
            runtime: ToolRuntime[ContextT, ProgressiveToolDisclosureState],
        ) -> Command[Any]:
            return self._search_tools(query, runtime)

        self.tools = [
            StructuredTool.from_function(
                name="search_tools",
                description=SEARCH_TOOLS_DESCRIPTION,
                func=search_tools,
                coroutine=asearch_tools,
                args_schema=SearchToolsInput,
                infer_schema=False,
            )
        ]

    @staticmethod
    def _catalog_entries(
        tools: Sequence[BaseTool | dict[str, Any]],
    ) -> tuple[_ToolCatalogEntry, ...]:
        """Build searchable metadata from the full executor registry."""
        entries: dict[str, _ToolCatalogEntry] = {}
        for tool in tools:
            name = _tool_name(tool)
            if name is not None:
                entries[name] = _ToolCatalogEntry(name, _tool_description(tool))
        return tuple(entries.values())

    def _matching_hidden_tools(
        self,
        query: str,
        tools: Sequence[BaseTool | dict[str, Any]],
    ) -> list[_ToolCatalogEntry]:
        """Return hidden tools whose name or description contains ``query``."""
        normalized = query.strip().casefold()
        if not normalized:
            return []
        return [
            entry
            for entry in self._catalog_entries(tools)
            if entry.name not in CORE_TOOL_NAMES
            and (
                normalized in entry.name.casefold()
                or normalized in entry.description.casefold()
            )
        ]

    def _search_tools(
        self,
        query: str,
        runtime: ToolRuntime[ContextT, ProgressiveToolDisclosureState],
    ) -> Command[Any]:
        """Search for hidden tools and persist matches in graph state."""
        matches = self._matching_hidden_tools(query, runtime.tools)
        current = set(runtime.state.get("discovered_tools") or ())
        matched_names = sorted({entry.name for entry in matches})
        newly_discovered = [name for name in matched_names if name not in current]

        if matches:
            lines = [f"Discovered {len(matches)} matching tool(s):"]
            lines.extend(
                f"- {entry.name}: {entry.description or 'No description provided.'}"
                for entry in matches
            )
            if not newly_discovered:
                lines.append(
                    "All matching tools were already available in this thread."
                )
            content = "\n".join(lines)
        else:
            content = (
                f"No hidden tools matched {query.strip()!r}. "
                "Try a different capability keyword."
            )

        update: dict[str, Any] = {
            "messages": [ToolMessage(content, tool_call_id=runtime.tool_call_id)]
        }
        if matched_names:
            update["discovered_tools"] = matched_names
        return Command(update=update)

    def _prepare_request(
        self,
        request: ModelRequest[ContextT],
    ) -> ModelRequest[ContextT]:
        """Filter model-visible tools using checkpointed discovery state."""
        discovered = set(request.state.get("discovered_tools") or ())
        visible = [
            tool
            for tool in request.tools
            if (name := _tool_name(tool)) is not None
            and (name in CORE_TOOL_NAMES or name in discovered)
        ]
        return request.override(tools=visible)

    def wrap_model_call(
        self,
        request: ModelRequest[ContextT],
        handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
    ) -> ModelResponse[ResponseT] | AIMessage:
        """Filter tools for a synchronous model request."""
        return handler(self._prepare_request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[ContextT],
        handler: Callable[
            [ModelRequest[ContextT]],
            Awaitable[ModelResponse[ResponseT]],
        ],
    ) -> ModelResponse[ResponseT] | AIMessage:
        """Filter tools for an asynchronous model request."""
        return await handler(self._prepare_request(request))


__all__ = [
    "CORE_TOOL_NAMES",
    "ProgressiveToolDisclosureMiddleware",
    "ProgressiveToolDisclosureState",
]
