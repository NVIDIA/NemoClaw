# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Minimal pinned MCP loader fixture for the managed package patch tests."""

from __future__ import annotations

import json
from pathlib import Path


def _json_error_hint(exc):
    del exc
    return "Check the JSON syntax."


def _json_error_snippet(doc, lineno, colno, *, pos):
    del pos
    lines = doc.splitlines()
    if lineno < 1 or lineno > len(lines):
        return None
    source = lines[lineno - 1]
    return f"    {source}\n    {' ' * max(0, colno - 1)}^"


def _load_mcp_config_json(config_path):
    path = Path(config_path)

    if not path.exists():
        error_msg = f"MCP config file not found: {config_path}"
        raise FileNotFoundError(error_msg)

    try:
        with path.open(encoding="utf-8") as file_obj:
            return json.load(file_obj)
    except json.JSONDecodeError as exc:
        parts = [f"Invalid JSON in MCP config file: {exc.msg}"]
        hint = _json_error_hint(exc)
        if hint is not None:
            parts.append(hint)
        snippet = _json_error_snippet(exc.doc, exc.lineno, exc.colno, pos=exc.pos)
        if snippet is not None:
            parts.append(snippet)
        error_msg = "\n".join(parts)
        raise json.JSONDecodeError(error_msg, exc.doc, exc.pos) from exc


def load_mcp_config(config_path):
    config = _load_mcp_config_json(config_path)
    if "mcpServers" not in config:
        raise ValueError("missing mcpServers")
    return config


async def resolve_and_load_mcp_tools(
    *,
    explicit_config_path=None,
    project_context=None,
):
    configs = []
    if explicit_config_path:
        config_path = (
            str(project_context.resolve_user_path(explicit_config_path))
            if project_context is not None
            else explicit_config_path
        )
        configs.append(load_mcp_config(config_path))
    return configs


def discover_mcp_configs(*, project_context=None):
    del project_context
    return [Path.home() / ".deepagents" / ".mcp.json"]
