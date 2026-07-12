# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Progressively disclose Deep Agents tools without changing execution policy.

This middleware is a model-context optimization, not an authorization boundary.
It filters the tools bound to each model request while leaving LangGraph's full
executor registry intact. A model-generated call that guesses a hidden tool name
can therefore still reach that tool; existing tool-call middleware, approval,
credential, and sandbox controls remain responsible for governing execution.
Named discovery, checkpoint state, and model-visible schemas are deterministically
bounded. Opaque provider-native definitions without a callable name remain
visible by identity because they cannot be safely checkpointed or rediscovered.
"""

from collections.abc import Awaitable, Callable, Sequence
import json
import os
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
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.types import Command
from pydantic import BaseModel, Field

MAX_SEARCH_QUERY_LENGTH = 256
"""Maximum model-supplied search query length accepted by ``search_tools``."""

MAX_SEARCH_RESULTS = 20
"""Maximum deterministic catalog matches exposed by one ``search_tools`` call."""

MAX_SEARCH_DESCRIPTION_CHARS = 256
"""Maximum normalized description characters rendered for one search result."""

MAX_SEARCH_OUTPUT_BYTES = 8 * 1024
"""Maximum UTF-8 bytes returned in one ``search_tools`` ToolMessage."""

MAX_DISCOVERED_TOOLS = 64
"""Maximum named tools retained and exposed from one graph thread's state."""

MAX_DISCOVERED_TOOL_NAME_BYTES = 120
"""Maximum UTF-8 and stable-JSON bytes in one discovered tool name."""

MAX_DISCOVERED_STATE_BYTES = 8 * 1024
"""Maximum stable JSON bytes in the checkpointed discovered-name list."""

MAX_SINGLE_TOOL_SCHEMA_BYTES = 16 * 1024
"""Maximum canonical JSON bytes accepted for one named model tool schema."""

MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES = 128 * 1024
"""Maximum canonical JSON bytes across discovered schemas in one model request."""

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

SEARCH_TOOLS_DESCRIPTION = f"""Search hidden tools by a case-insensitive keyword.

Use this when the visible tools do not provide a capability you need. The query
is matched against registered tool names and descriptions. Each call returns at
most {MAX_SEARCH_RESULTS} name-sorted matches, renders at most
{MAX_SEARCH_DESCRIPTION_CHARS} description characters per match and
{MAX_SEARCH_OUTPUT_BYTES} UTF-8 output bytes, and retains at most
{MAX_DISCOVERED_TOOLS} discovered named tools within a
{MAX_DISCOVERED_STATE_BYTES}-byte checkpoint budget. Names whose UTF-8 or
stable-JSON representation exceeds {MAX_DISCOVERED_TOOL_NAME_BYTES} bytes and
named schemas above
{MAX_SINGLE_TOOL_SCHEMA_BYTES} canonical JSON bytes are ineligible; each model
request exposes at most {MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES} canonical JSON bytes of
discovered schemas; core tools remain unconditional. Refine broad queries to
reach omitted matches. An empty query discovers nothing; use a specific keyword
such as "database" or "calendar".
"""


def progressive_tool_disclosure_enabled() -> bool:
    """Return the image-selected disclosure policy, rejecting invalid modes."""
    mode = os.environ.get("NEMOCLAW_TOOL_DISCLOSURE", "progressive").strip().casefold()
    if mode not in {"progressive", "direct"}:
        raise RuntimeError("NEMOCLAW_TOOL_DISCLOSURE must be 'progressive' or 'direct'")
    return mode == "progressive"


def _merge_discovered_tools(
    current: list[str] | None,
    update: list[str] | None,
) -> list[str]:
    """Merge concurrent updates with an order-independent deterministic cap."""
    values: list[object] = []
    if isinstance(current, list):
        values.extend(current)
    if isinstance(update, list):
        values.extend(update)
    return _bounded_discovered_tools(values)


def _eligible_discovered_name(value: object) -> bool:
    """Return whether a name has a bounded checkpoint representation."""
    if not isinstance(value, str) or not value:
        return False
    try:
        utf8_bytes = len(value.encode("utf-8"))
        stable_json_bytes = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except UnicodeEncodeError:
        return False
    return (
        utf8_bytes <= MAX_DISCOVERED_TOOL_NAME_BYTES
        and stable_json_bytes <= MAX_DISCOVERED_TOOL_NAME_BYTES
    )


def _discovered_state_bytes(names: Sequence[str]) -> int:
    """Return stable UTF-8 JSON bytes for the checkpointed name list."""
    return len(
        json.dumps(
            list(names),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def _bounded_discovered_tools(values: Sequence[object] | None) -> list[str]:
    """Normalize checkpointed names and enforce count and byte caps."""
    if values is None or isinstance(values, (str, bytes)):
        return []
    # Selecting the lexical top-K eligible names is associative, commutative,
    # and idempotent under reducer regrouping. The per-name stable-JSON cap
    # makes the aggregate 64-name representation strictly smaller than the
    # independent MAX_DISCOVERED_STATE_BYTES defense-in-depth assertion.
    bounded = sorted({value for value in values if _eligible_discovered_name(value)})[
        :MAX_DISCOVERED_TOOLS
    ]
    if _discovered_state_bytes(bounded) > MAX_DISCOVERED_STATE_BYTES:
        raise AssertionError("discovered tool state exceeded its invariant")
    return bounded


def _bounded_description(description: str) -> str:
    """Render one untrusted catalog description as a bounded single line."""
    normalized = (
        " ".join(description.split()).encode("utf-8", errors="replace").decode("utf-8")
    )
    if not normalized:
        return "No description provided."
    if len(normalized) <= MAX_SEARCH_DESCRIPTION_CHARS:
        return normalized
    return f"{normalized[: MAX_SEARCH_DESCRIPTION_CHARS - 1]}…"


def _bounded_search_output(content: str) -> str:
    """Truncate search output on a valid UTF-8 boundary with an explicit notice."""
    encoded = content.encode("utf-8")
    if len(encoded) <= MAX_SEARCH_OUTPUT_BYTES:
        return content
    notice = (
        f"\n[Search output truncated at {MAX_SEARCH_OUTPUT_BYTES} UTF-8 bytes; "
        "refine your query.]"
    )
    budget = MAX_SEARCH_OUTPUT_BYTES - len(notice.encode("utf-8"))
    prefix = encoded[:budget].decode("utf-8", errors="ignore").rstrip()
    return f"{prefix}{notice}"


def _serialized_tool_schema_bytes(tool: BaseTool | dict[str, Any]) -> int | None:
    """Return stable model-schema bytes, or ``None`` for an unsafe shape."""
    try:
        schema = convert_to_openai_tool(tool)
        serialized = json.dumps(
            schema,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except Exception:  # noqa: BLE001 - malformed provider schemas fail closed
        return None
    return len(serialized.encode("utf-8"))


class ProgressiveToolDisclosureState(AgentState):
    """Private checkpoint state for tools discovered in one graph thread.

    ``PrivateStateAttr`` keeps discoveries out of parent/subagent input and
    output while the checkpointer retains them for the owning graph thread.
    """

    # LangGraph 1.2.6 recognizes a reducer only when it is the final Annotated
    # metadata value. Keep PrivateStateAttr before the reducer so concurrent
    # search_tools calls merge instead of producing a LastValue conflict.
    discovered_tools: NotRequired[
        Annotated[list[str], PrivateStateAttr, _merge_discovered_tools]
    ]


class SearchToolsInput(BaseModel):
    """Input contract for the ``search_tools`` model tool."""

    query: str = Field(
        max_length=MAX_SEARCH_QUERY_LENGTH,
        description="Keyword to match against tool names and descriptions.",
    )


class _ToolCatalogEntry:
    """Immutable searchable metadata for one registered model tool."""

    __slots__ = ("description", "name", "tool")

    def __init__(
        self,
        name: str,
        description: str,
        tool: BaseTool | dict[str, Any],
    ) -> None:
        self.name = name
        self.description = description
        self.tool = tool


def _tool_name(tool: object) -> str | None:
    """Return a registered tool name without changing the tool object."""
    if isinstance(tool, BaseTool):
        return tool.name if isinstance(tool.name, str) and tool.name else None
    if isinstance(tool, dict):
        name = tool.get("name")
        if isinstance(name, str) and name:
            return name
        function = tool.get("function")
        if (
            isinstance(function, dict)
            and isinstance(function.get("name"), str)
            and function["name"]
        ):
            return cast("str", function["name"])
    name = getattr(tool, "name", None)
    if isinstance(name, str) and name:
        return name
    callable_name = getattr(tool, "__name__", None)
    if isinstance(callable_name, str) and callable_name:
        return callable_name
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


def assert_unique_callable_tool_names(
    tools: Sequence[object] | None,
    mcp_server_info: Sequence[object] | None,
) -> None:
    """Reject ambiguous or non-managed registrations before graph creation.

    The pinned runtime combines middleware and regular tools into one executor
    registry keyed by resolved callable name. Its model schema selection and
    executor lookup do not share the same duplicate-name rule, so accepting two
    implementations can bind one schema and execute another. Keep the executor
    registry and MCP metadata as separate views: one loaded MCP tool normally
    appears once in each, while duplicates within either view are ambiguous.
    """
    collisions: set[str] = set()
    registered_owners: dict[str, list[str]] = {}
    for index, tool in enumerate(tools or ()):
        name = _tool_name(tool)
        if name is None:
            continue
        owner = f"registered tool[{index}]"
        registered_owners.setdefault(name, []).append(owner)
        if name in CORE_TOOL_NAMES:
            collisions.add(f"{owner} is a non-managed owner of reserved name {name!r}")

    mcp_owners: dict[str, list[str]] = {}
    for server in mcp_server_info or ():
        raw_server_name = getattr(server, "name", None)
        server_name = raw_server_name if isinstance(raw_server_name, str) else "<unknown>"
        for index, tool_info in enumerate(getattr(server, "tools", ()) or ()):
            runtime_name = tool_info if isinstance(tool_info, str) else _tool_name(tool_info)
            if runtime_name is None:
                continue
            owner = f"MCP server {server_name!r} tool[{index}]"
            mcp_owners.setdefault(runtime_name, []).append(owner)
            if runtime_name in CORE_TOOL_NAMES:
                collisions.add(
                    f"{owner} is a non-managed owner of reserved name {runtime_name!r}"
                )

    for name, owners in registered_owners.items():
        if len(owners) > 1:
            metadata = mcp_owners.get(name, [])
            metadata_detail = (
                f"; MCP metadata owners: {', '.join(metadata)}" if metadata else ""
            )
            collisions.add(
                f"resolved callable name {name!r} has multiple registered "
                f"implementations ({', '.join(owners)}){metadata_detail}"
            )

    for name, owners in mcp_owners.items():
        if len(owners) > 1:
            collisions.add(
                f"resolved callable name {name!r} has multiple MCP owners "
                f"({', '.join(owners)})"
            )

    if collisions:
        detail = "; ".join(sorted(collisions))
        raise RuntimeError(
            "non-unique callable tool namespace before create_deep_agent: " + detail
        )


class ProgressiveToolDisclosureMiddleware(
    AgentMiddleware[ProgressiveToolDisclosureState, ContextT, ResponseT]
):
    """Expose a core tool set, then reveal matching tools for one thread.

    The full tool registry remains registered with the executor. Only the tools
    sent to each model request are filtered. Consequently, a model call that
    guesses a hidden tool name can still execute it through the normal executor;
    existing policy, approval, credential, and sandbox controls continue to
    govern every execution. Progressive disclosure must not be treated as an
    authorization boundary.
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
            if name is None or name in CORE_TOOL_NAMES:
                continue
            if not _eligible_discovered_name(name):
                continue
            entries.setdefault(
                name,
                _ToolCatalogEntry(name, _tool_description(tool), tool),
            )
        return tuple(sorted(entries.values(), key=lambda entry: entry.name))

    def _matching_hidden_tools(
        self,
        query: str,
        tools: Sequence[BaseTool | dict[str, Any]],
    ) -> list[_ToolCatalogEntry]:
        """Return hidden tools whose name or description contains ``query``."""
        normalized = query.strip().casefold()
        if not normalized:
            return []
        matches: list[_ToolCatalogEntry] = []
        for entry in self._catalog_entries(tools):
            if not (
                normalized in entry.name.casefold()
                or normalized in entry.description.casefold()
            ):
                continue
            schema_bytes = _serialized_tool_schema_bytes(entry.tool)
            if (
                schema_bytes is not None
                and schema_bytes <= MAX_SINGLE_TOOL_SCHEMA_BYTES
            ):
                matches.append(entry)
        return matches

    @staticmethod
    def _visible_discovered_tools(
        tools: Sequence[BaseTool | dict[str, Any]],
        discovered_names: Sequence[str],
    ) -> tuple[set[int], set[str]]:
        """Select discovered schemas under deterministic per-tool/total budgets."""
        requested = set(discovered_names)
        candidates: dict[str, tuple[int, BaseTool | dict[str, Any]]] = {}
        for index, tool in enumerate(tools):
            name = _tool_name(tool)
            if name is not None and name not in CORE_TOOL_NAMES and name in requested:
                candidates.setdefault(name, (index, tool))

        selected_indices: set[int] = set()
        selected_names: set[str] = set()
        visible_schema_bytes = 0
        for name, (index, tool) in sorted(candidates.items()):
            schema_bytes = _serialized_tool_schema_bytes(tool)
            if (
                schema_bytes is None
                or schema_bytes > MAX_SINGLE_TOOL_SCHEMA_BYTES
                or visible_schema_bytes + schema_bytes
                > MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES
            ):
                continue
            selected_indices.add(index)
            selected_names.add(name)
            visible_schema_bytes += schema_bytes
        return selected_indices, selected_names

    def _search_tools(
        self,
        query: str,
        runtime: ToolRuntime[ContextT, ProgressiveToolDisclosureState],
    ) -> Command[Any]:
        """Search for hidden tools and persist matches in graph state."""
        matches = self._matching_hidden_tools(query, runtime.tools)
        page = matches[:MAX_SEARCH_RESULTS]
        current_names = _bounded_discovered_tools(runtime.state.get("discovered_tools"))
        current = set(current_names)
        candidate_state = current_names
        _, visible_discovered = self._visible_discovered_tools(
            runtime.tools, current_names
        )
        state_omitted_names: set[str] = set()
        schema_omitted_names: set[str] = set()
        for entry in page:
            if entry.name in candidate_state:
                continue
            proposed_state = _bounded_discovered_tools([*candidate_state, entry.name])
            if entry.name not in proposed_state or not set(candidate_state).issubset(
                proposed_state
            ):
                state_omitted_names.add(entry.name)
                continue
            _, proposed_visible = self._visible_discovered_tools(
                runtime.tools, proposed_state
            )
            if entry.name not in proposed_visible or not visible_discovered.issubset(
                proposed_visible
            ):
                schema_omitted_names.add(entry.name)
                continue
            candidate_state = proposed_state
            visible_discovered = proposed_visible
        schema_omitted_names.update(
            entry.name
            for entry in page
            if entry.name in candidate_state and entry.name not in visible_discovered
        )
        exposed_entries = [
            entry
            for entry in page
            if entry.name in candidate_state and entry.name in visible_discovered
        ]
        matched_names = sorted({entry.name for entry in exposed_entries})
        newly_discovered = [name for name in matched_names if name not in current]

        if matches:
            lines = [
                f"Found {len(matches)} matching hidden tool(s); returning "
                f"{len(exposed_entries)} bounded discovery candidate(s) "
                f"(per-search limit {MAX_SEARCH_RESULTS}):"
            ]
            lines.extend(
                f"- {entry.name}: {_bounded_description(entry.description)}"
                for entry in exposed_entries
            )
            if exposed_entries and not newly_discovered:
                lines.append(
                    "All returned matching tools were already available in this thread."
                )
            if newly_discovered:
                lines.append(
                    "Discovery updates commit through bounded thread state; after "
                    "concurrent searches, the next model tool list is authoritative."
                )
            page_overflow = len(matches) - len(page)
            if page_overflow:
                lines.append(
                    f"{page_overflow} additional match(es) were not shown; "
                    "refine the query to discover them."
                )
            state_omitted = len(state_omitted_names)
            if state_omitted:
                lines.append(
                    f"{state_omitted} match(es) were not exposed because the "
                    f"thread discovery state is limited to {MAX_DISCOVERED_TOOLS} "
                    f"names and {MAX_DISCOVERED_STATE_BYTES} JSON bytes."
                )
            schema_omitted = len(schema_omitted_names)
            if schema_omitted:
                lines.append(
                    f"{schema_omitted} match(es) were not exposed because discovered "
                    f"schemas are limited to {MAX_SINGLE_TOOL_SCHEMA_BYTES} bytes each "
                    f"and {MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES} bytes per model request."
                )
            content = _bounded_search_output("\n".join(lines))
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
        discovered = set(
            _bounded_discovered_tools(request.state.get("discovered_tools"))
        )
        selected_indices, _ = self._visible_discovered_tools(
            request.tools, sorted(discovered)
        )

        visible: list[BaseTool | dict[str, Any]] = []
        for index, tool in enumerate(request.tools):
            name = _tool_name(tool)
            # Opaque provider-native definitions have no stable callable name,
            # cannot be checkpointed/search-discovered, and may be transformed
            # by the provider after LangChain binding. Preserve their identity
            # by default; the named-schema byte budget intentionally cannot
            # account for these provider-owned representations.
            if name is None or name in CORE_TOOL_NAMES or index in selected_indices:
                visible.append(tool)
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
    "MAX_DISCOVERED_STATE_BYTES",
    "MAX_DISCOVERED_TOOL_NAME_BYTES",
    "MAX_DISCOVERED_TOOLS",
    "MAX_SEARCH_DESCRIPTION_CHARS",
    "MAX_SEARCH_OUTPUT_BYTES",
    "MAX_SEARCH_QUERY_LENGTH",
    "MAX_SEARCH_RESULTS",
    "MAX_SINGLE_TOOL_SCHEMA_BYTES",
    "MAX_VISIBLE_DISCOVERED_SCHEMA_BYTES",
    "ProgressiveToolDisclosureMiddleware",
    "ProgressiveToolDisclosureState",
    "SearchToolsInput",
    "assert_unique_callable_tool_names",
    "progressive_tool_disclosure_enabled",
]
