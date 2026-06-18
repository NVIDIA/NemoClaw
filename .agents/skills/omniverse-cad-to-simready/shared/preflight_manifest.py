#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


PREFLIGHT_MANIFEST_ENV = "PHYSICAL_AI_PREFLIGHT_MANIFEST"
PREFLIGHT_REQUIRED_ENV = "PHYSICAL_AI_REQUIRE_PREFLIGHT"
DEFAULT_MANIFEST_NAME = "cad-to-simready-preflight.json"


def skill_hub_home() -> Path:
    return Path(os.environ.get("PHYSICAL_AI_SKILL_HUB_HOME", "~/.physical-ai-skill-hub")).expanduser()


def default_manifest_path() -> Path:
    state_root = os.environ.get("PHYSICAL_AI_SKILL_HUB_STATE")
    if state_root:
        return Path(state_root).expanduser() / DEFAULT_MANIFEST_NAME
    return skill_hub_home() / "state" / DEFAULT_MANIFEST_NAME


def configured_manifest_path() -> Path:
    explicit = os.environ.get(PREFLIGHT_MANIFEST_ENV)
    return Path(explicit).expanduser() if explicit else default_manifest_path()


def load_preflight_manifest(path: Path | None = None) -> tuple[dict[str, Any] | None, Path, str | None]:
    manifest_path = path.expanduser() if path is not None else configured_manifest_path()
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, manifest_path, f"preflight manifest was not found: {manifest_path}"
    except (OSError, json.JSONDecodeError) as exc:
        return None, manifest_path, f"preflight manifest could not be read: {exc}"
    if not isinstance(payload, dict):
        return None, manifest_path, f"preflight manifest is not a JSON object: {manifest_path}"
    return payload, manifest_path, None


def preflight_required() -> bool:
    return os.environ.get(PREFLIGHT_REQUIRED_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def preflight_block_message(target: str, path: Path | None = None) -> str:
    manifest_path = path or configured_manifest_path()
    return (
        f"cad-to-simready preflight has not prepared `{target}`. "
        "Run `preflight/scripts/preflight.py` for the required targets and source the generated env file, "
        f"or set {PREFLIGHT_MANIFEST_ENV} to a ready manifest. Expected manifest: {manifest_path}"
    )


def runtime_entry(manifest: dict[str, Any] | None, name: str) -> dict[str, Any] | None:
    if not manifest:
        return None
    runtimes = manifest.get("runtimes")
    if not isinstance(runtimes, dict):
        return None
    entry = runtimes.get(name)
    return entry if isinstance(entry, dict) else None


def upstream_entry(manifest: dict[str, Any] | None, name: str) -> dict[str, Any] | None:
    if not manifest:
        return None
    upstreams = manifest.get("upstreams")
    if not isinstance(upstreams, dict):
        return None
    entry = upstreams.get(name)
    return entry if isinstance(entry, dict) else None


def service_entry(manifest: dict[str, Any] | None, name: str) -> dict[str, Any] | None:
    if not manifest:
        return None
    services = manifest.get("services")
    if not isinstance(services, dict):
        return None
    entry = services.get(name)
    return entry if isinstance(entry, dict) else None


def manifest_env_value(manifest: dict[str, Any] | None, name: str) -> str | None:
    if not manifest:
        return None
    env = manifest.get("env")
    if not isinstance(env, dict):
        return None
    value = env.get(name)
    return str(value) if value else None


def manifest_path_value(entry: dict[str, Any] | None, key: str) -> Path | None:
    if not entry:
        return None
    value = entry.get(key)
    return Path(str(value)).expanduser().resolve() if value else None


def ready_path_from_runtime(manifest: dict[str, Any] | None, runtime_name: str, key: str = "root") -> Path | None:
    entry = runtime_entry(manifest, runtime_name)
    if not entry or entry.get("status") != "ready":
        return None
    return manifest_path_value(entry, key)


def ready_path_from_upstream(manifest: dict[str, Any] | None, upstream_name: str) -> Path | None:
    entry = upstream_entry(manifest, upstream_name)
    if not entry or entry.get("status") not in {"ready", "present"}:
        return None
    return manifest_path_value(entry, "path")


def ready_executable_from_runtime(manifest: dict[str, Any] | None, runtime_name: str) -> str | None:
    entry = runtime_entry(manifest, runtime_name)
    if not entry or entry.get("status") != "ready":
        return None
    executable = entry.get("executable")
    return str(executable) if executable else None


def ready_service_url(manifest: dict[str, Any] | None, service_name: str) -> str | None:
    entry = service_entry(manifest, service_name)
    if entry and entry.get("status") == "ready" and entry.get("base_url"):
        return str(entry["base_url"]).rstrip("/")
    env_name_by_service = {
        "material": "CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL",
        "physics": "CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL",
        "texture": "CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL",
        "ovrtx": "RENDER_ENDPOINT",
    }
    env_name = env_name_by_service.get(service_name)
    value = manifest_env_value(manifest, env_name) if env_name else None
    return value.rstrip("/") if value else None


def preflight_status_check(target: str, component: str) -> dict[str, Any]:
    manifest, path, error = load_preflight_manifest()
    if error:
        return {
            "name": f"preflight_{target}_ready",
            "passed": False,
            "severity": "error",
            "message": preflight_block_message(target, path),
        }
    entry = runtime_entry(manifest, component) or service_entry(manifest, component) or upstream_entry(manifest, component)
    passed = bool(entry and entry.get("status") in {"ready", "present"})
    detail = f"Preflight manifest: {path}"
    if entry:
        detail = f"{detail}; {component} status: {entry.get('status')}"
    return {
        "name": f"preflight_{target}_ready",
        "passed": passed,
        "severity": "error",
        "message": detail if passed else preflight_block_message(target, path),
    }
