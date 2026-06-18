#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check

from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_service_url


AGENTS: dict[str, dict[str, tuple[str, ...]]] = {
    "material-agent-client": {
        "default_env": ("CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL", "MATERIAL_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_MATERIAL_AGENT_TOKEN",
            "MATERIAL_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
    },
    "physics-agent-client": {
        "default_env": ("CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL", "PHYSICS_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_PHYSICS_AGENT_TOKEN",
            "PHYSICS_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
    },
    "texture-agent-client": {
        "default_env": ("CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL", "TEXTURE_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_TEXTURE_AGENT_TOKEN",
            "TEXTURE_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
    },
}


def _skill_name() -> str:
    return Path(sys.argv[0]).resolve().parents[1].name


def _env_first(names: tuple[str, ...]) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def _env_or_file_first(names: tuple[str, ...]) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
        file_value = os.getenv(f"{name}_FILE")
        if not file_value:
            continue
        try:
            token = Path(file_value).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if token:
            return token
    return None


def _write_report(payload: dict[str, Any], report_path: Path | None) -> None:
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(text, encoding="utf-8")
    print(text, end="")


def check_dependencies() -> dict[str, Any]:
    skill = _skill_name()
    spec = AGENTS[skill]
    agent_key = skill.split("-", 1)[0]
    preflight_checks: list[dict[str, Any]] = []
    if preflight_required():
        preflight_check = preflight_status_check(skill, agent_key)
        if not preflight_check["passed"]:
            return {
                "skill": skill,
                "passed": False,
                "checks": [preflight_check],
                "errors": [preflight_check["message"]],
            }
        preflight_checks.append(preflight_check)
    manifest, _, _ = load_preflight_manifest()
    base_url = _env_first(spec["default_env"]) or ready_service_url(manifest, agent_key)
    token = _env_or_file_first(spec["token_env"])
    checks = [*preflight_checks,
        _check("python_available", True, f"Python executable: {sys.executable}", "info"),
        _check(
            "content_agents_endpoint_configured",
            bool(base_url),
            f"Endpoint configured: {base_url}"
            if base_url
            else f"Set one of {', '.join(spec['default_env'])}",
        ),
        _check(
            "content_agents_token_available",
            bool(token),
            "Bearer token is available from environment"
            if token
            else f"Set one of {', '.join(spec['token_env'])} when the service requires auth",
            "warning",
        ),
    ]
    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    return {
        "skill": skill,
        "passed": not errors,
        "checks": checks,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check portable Content Agents wrapper dependencies.")
    parser.add_argument("--report", type=Path, help="Write dependency check JSON to this path.")
    args = parser.parse_args(argv)

    payload = check_dependencies()
    _write_report(payload, args.report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
