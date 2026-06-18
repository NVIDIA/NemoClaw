#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
import platform
from pathlib import Path
import shutil
import sys
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report

from preflight_manifest import (
    load_preflight_manifest,
    preflight_required,
    preflight_status_check,
    ready_executable_from_runtime,
    ready_path_from_runtime,
    ready_path_from_upstream,
)


SKILL = "simready-validate"
TOOL = "simready-validate"
DEFAULT_FOUNDATION_REPO_URL = "https://github.com/NVIDIA/simready-foundation"
DEFAULT_FOUNDATION_BRANCH = "main"


def _checkout_name_from_repo_url(repo_url: str) -> str:
    name = urlparse(repo_url).path.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return name


DEFAULT_FOUNDATION_CHECKOUT = _checkout_name_from_repo_url(DEFAULT_FOUNDATION_REPO_URL)


def _default_foundation_root() -> Path | None:
    manifest, _, _ = load_preflight_manifest()
    manifest_root = ready_path_from_runtime(manifest, "simready_validate") or ready_path_from_upstream(manifest, "simready_foundation")
    if manifest_root is not None:
        return manifest_root
    env_root = os.environ.get("SIMREADY_FOUNDATION_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    upstream_root = os.environ.get("PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT")
    if upstream_root:
        candidate = Path(upstream_root).expanduser() / DEFAULT_FOUNDATION_CHECKOUT
        if candidate.exists():
            return candidate.resolve()
    candidate = Path.home() / ".physical-ai-skill-hub" / "upstreams" / DEFAULT_FOUNDATION_CHECKOUT
    if candidate.exists():
        return candidate.resolve()
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable SimReady profile validation dependencies.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    if preflight_required():
        preflight_check = preflight_status_check("simready-validate", "simready_validate")
        if not preflight_check["passed"]:
            payload = {"skill": SKILL, "passed": False, "checks": [preflight_check], "errors": [preflight_check["message"]]}
            emit_json_report(payload, args.report)
            return 1
    manifest, _, _ = load_preflight_manifest()
    executable = ready_executable_from_runtime(manifest, "simready_validate") or shutil.which(TOOL)
    foundation_root = _default_foundation_root()
    requirements_path = foundation_root / "requirements.txt" if foundation_root else None
    installable = requirements_path is not None and requirements_path.is_file()
    if executable is not None:
        tool_message = f"{TOOL} executable: {executable}"
    elif installable:
        tool_message = f"{TOOL} executable not found on PATH; run.py can install it from {requirements_path}"
        if platform.machine().lower() in {"aarch64", "arm64"}:
            tool_message += (
                "; if PyPI usd-core is unavailable on this architecture, run.py will use the "
                "usd-exchange SDK package as the OpenUSD runtime and install simready-validate without deps"
            )
    else:
        tool_message = (
            f"{TOOL} executable: not found; no Foundation requirements.txt found. "
            f"Provide {DEFAULT_FOUNDATION_CHECKOUT} checked out to {DEFAULT_FOUNDATION_BRANCH}, "
            "or set SIMREADY_FOUNDATION_ROOT."
        )
    checks = [
        _check("python_available", True, f"Python executable: {sys.executable}"),
        _check(f"{TOOL}_available_or_installable", executable is not None or installable, tool_message),
    ]
    errors = [check["message"] for check in checks if not check["passed"]]
    payload = {"skill": SKILL, "passed": not errors, "checks": checks, "errors": errors}
    emit_json_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
