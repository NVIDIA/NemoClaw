# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch Deep Agents Code for NemoClaw-managed sandbox posture."""

from __future__ import annotations

import importlib.util
from pathlib import Path

PATCH = '''    # NemoClaw-managed sandbox image hardening.
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
    if hasattr(args, "mcp_config"):
        args.mcp_config = None
    if hasattr(args, "no_mcp"):
        args.no_mcp = True
    if hasattr(args, "trust_project_mcp"):
        args.trust_project_mcp = False
    if hasattr(args, "shell_allow_list"):
        args.shell_allow_list = None
    os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)
'''

# Source boundary: Deep Agents Code 0.1.12 parses direct `python3 -m
# deepagents_code` flags inside upstream `deepagents_code.main`; NemoClaw only
# owns the managed image after installation. Invalid state: direct module
# execution can re-enable nested sandbox, MCP, or shell delegation inside an
# already-managed OpenShell sandbox. Keep this build-time patch until upstream
# offers a non-patch policy hook that forces these postures; fail the image build
# if the parser anchor moves.
MARKER = "    args = parser.parse_args()\n"


def main() -> None:
    spec = importlib.util.find_spec("deepagents_code.main")
    if spec is None or spec.origin is None:
        raise RuntimeError("deepagents_code.main not found")

    main_path = Path(spec.origin)
    text = main_path.read_text(encoding="utf-8")
    if "NemoClaw-managed sandbox image hardening." in text:
        return
    if MARKER not in text:
        raise RuntimeError(f"Deep Agents Code parser marker not found in {main_path}")

    main_path.write_text(text.replace(MARKER, f"{MARKER}{PATCH}", 1), encoding="utf-8")


if __name__ == "__main__":
    main()
