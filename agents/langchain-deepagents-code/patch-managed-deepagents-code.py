# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch Deep Agents Code for NemoClaw-managed sandbox posture."""

from __future__ import annotations

import importlib.util
from pathlib import Path

MAIN_PATCH = """    # NemoClaw-managed sandbox image hardening.
    if getattr(args, "command", None) == "mcp":
        parser.error("MCP commands are disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if hasattr(args, "sandbox"):
        args.sandbox = "none"
    if hasattr(args, "sandbox_id"):
        args.sandbox_id = None
    if hasattr(args, "sandbox_snapshot_name"):
        args.sandbox_snapshot_name = None
    if hasattr(args, "sandbox_setup"):
        args.sandbox_setup = None
    # deepagents-code 0.1.12 treats this as its trusted user-level config;
    # /sandbox/.mcp.json is project-level and gated by project-MCP trust.
    managed_mcp_config = "/sandbox/.deepagents/.mcp.json"
    has_managed_mcp = os.path.isfile(managed_mcp_config) and os.path.getsize(managed_mcp_config) > 0
    if hasattr(args, "mcp_config"):
        args.mcp_config = managed_mcp_config if has_managed_mcp else None
    if hasattr(args, "no_mcp"):
        args.no_mcp = not has_managed_mcp
    if hasattr(args, "trust_project_mcp"):
        args.trust_project_mcp = False
    if hasattr(args, "shell_allow_list"):
        args.shell_allow_list = None
    os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)
"""

AGENT_IMPORT_ANCHOR = "from deepagents_code.project_utils import ProjectContext, get_server_project_context\n"
AGENT_IMPORT_PATCH = (
    AGENT_IMPORT_ANCHOR
    + """from deepagents_code.progressive_tool_disclosure import (
    ProgressiveToolDisclosureMiddleware,
)
"""
)

AGENT_ACTIVATION_ANCHOR = """    tools = tools or []
    effective_cwd = (
"""
AGENT_ACTIVATION_PATCH = """    tools = tools or []
    progressive_tool_disclosure_enabled = any(
        info.tools for info in mcp_server_info or ()
    )
    effective_cwd = (
"""

AGENT_SUBAGENT_ANCHOR = """        return middleware

    for subagent_meta in list_subagents(
"""
AGENT_SUBAGENT_PATCH = """        if progressive_tool_disclosure_enabled:
            middleware.append(ProgressiveToolDisclosureMiddleware())
        return middleware

    for subagent_meta in list_subagents(
"""

AGENT_MAIN_ANCHOR = """    agent_middleware.append(
        create_summarization_tool_middleware(model, composite_backend)
    )

    # Create the agent
"""
AGENT_MAIN_PATCH = """    agent_middleware.append(
        create_summarization_tool_middleware(model, composite_backend)
    )
    if progressive_tool_disclosure_enabled:
        agent_middleware.append(ProgressiveToolDisclosureMiddleware())

    # Create the agent
"""

MIDDLEWARE_MODULE = "progressive_tool_disclosure.py"

# Progressive-disclosure source boundary: Deep Agents Code 0.1.12 constructs
# its main and local-subagent middleware stacks inside ``agent.py`` and exposes
# no supported injection hook for this image-owned middleware. Invalid state is
# any upstream anchor drift or a partial install that could leave main and
# subagent visibility behavior inconsistent, so the image build fails closed.
# Remove these agent.py anchors once the pinned upstream offers a stable hook
# that can install separate middleware instances in both stacks.

# Source boundary: Deep Agents Code 0.1.12 parses direct `python3 -m
# deepagents_code` flags inside upstream `deepagents_code.main`; NemoClaw only
# owns the managed image after installation. Invalid state: direct module
# execution can re-enable nested sandbox, MCP, or shell delegation inside an
# already-managed OpenShell sandbox. Keep this build-time patch until upstream
# offers a non-patch policy hook that forces these postures; fail the image build
# if the parser anchor moves.
MAIN_ANCHOR = "    args = parser.parse_args()\n"
MAIN_SENTINEL = "NemoClaw-managed sandbox image hardening."
AGENT_SENTINEL = "ProgressiveToolDisclosureMiddleware"


def _patch_main(text: str, main_path: Path) -> str:
    """Return the parser-hardening patch, failing on upstream anchor drift."""
    if MAIN_SENTINEL in text:
        if text.count(MAIN_PATCH) != 1:
            raise RuntimeError(
                f"Deep Agents Code parser patch is incomplete in {main_path}"
            )
        return text
    if text.count(MAIN_ANCHOR) != 1:
        raise RuntimeError(
            f"Deep Agents Code parser marker not found exactly once in {main_path}"
        )
    return text.replace(MAIN_ANCHOR, f"{MAIN_ANCHOR}{MAIN_PATCH}", 1)


def _patch_agent(text: str, agent_path: Path) -> str:
    """Return progressive-disclosure wiring with exact 0.1.12 anchors."""
    if AGENT_SENTINEL in text:
        installed_patches = (
            (AGENT_IMPORT_PATCH, "import"),
            (AGENT_ACTIVATION_PATCH, "activation"),
            (AGENT_SUBAGENT_PATCH, "subagent"),
            (AGENT_MAIN_PATCH, "main-agent"),
        )
        for patch, label in installed_patches:
            if text.count(patch) != 1:
                raise RuntimeError(
                    f"Deep Agents Code {label} patch is incomplete in {agent_path}"
                )
        return text

    replacements = (
        (AGENT_IMPORT_ANCHOR, AGENT_IMPORT_PATCH, "import"),
        (AGENT_ACTIVATION_ANCHOR, AGENT_ACTIVATION_PATCH, "activation"),
        (AGENT_SUBAGENT_ANCHOR, AGENT_SUBAGENT_PATCH, "subagent"),
        (AGENT_MAIN_ANCHOR, AGENT_MAIN_PATCH, "main-agent"),
    )
    for anchor, _replacement, label in replacements:
        if text.count(anchor) != 1:
            raise RuntimeError(
                f"Deep Agents Code {label} marker not found exactly once in {agent_path}"
            )
    for anchor, replacement, _label in replacements:
        text = text.replace(anchor, replacement, 1)
    return text


def main() -> None:
    spec = importlib.util.find_spec("deepagents_code.main")
    if spec is None or spec.origin is None:
        raise RuntimeError("deepagents_code.main not found")

    main_path = Path(spec.origin)
    agent_path = main_path.with_name("agent.py")
    module_source_path = Path(__file__).with_name(MIDDLEWARE_MODULE)
    module_destination_path = main_path.with_name(MIDDLEWARE_MODULE)
    if not agent_path.is_file():
        raise RuntimeError(f"deepagents_code.agent not found at {agent_path}")
    if not module_source_path.is_file():
        raise RuntimeError(
            f"NemoClaw middleware source not found at {module_source_path}"
        )

    module_source = module_source_path.read_text(encoding="utf-8")
    if module_destination_path.exists():
        installed_module = module_destination_path.read_text(encoding="utf-8")
        if installed_module != module_source:
            raise RuntimeError(
                f"Refusing to overwrite unexpected middleware at {module_destination_path}"
            )

    # Validate and render every exact anchor before writing any installed file.
    patched_main = _patch_main(main_path.read_text(encoding="utf-8"), main_path)
    patched_agent = _patch_agent(agent_path.read_text(encoding="utf-8"), agent_path)

    if not module_destination_path.exists():
        module_destination_path.write_text(module_source, encoding="utf-8")
    main_path.write_text(patched_main, encoding="utf-8")
    agent_path.write_text(patched_agent, encoding="utf-8")


if __name__ == "__main__":
    main()
