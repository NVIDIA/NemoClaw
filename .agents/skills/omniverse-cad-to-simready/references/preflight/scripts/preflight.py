#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prepare local cad-to-simready dependencies and write a preflight manifest.

Usage:
    python3 scripts/preflight.py [--check-only]
    python3 scripts/preflight.py --report preflight.json --env-file preflight.env

Arguments:
    --check-only              Verify local readiness without cloning, installing, or deploying.
    --skip-content-agents     Do not verify or deploy Content Agents services.
    --skip-deploy             Verify Content Agents endpoints but do not start services.
    --report PATH             Write the preflight manifest JSON.
    --env-file PATH           Write shell exports for downstream references.
    --powershell-env-file PATH
                              Write PowerShell env assignments for downstream references.
    --markdown-report PATH    Write a human-readable readiness report.

Exit codes:
    0 - dependencies and services are ready or explicitly skipped
    1 - one or more dependencies or services are blocked
    2 - unexpected error (crash or malformed input)
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import tail_text
from usd_convert_cad_diagnostics import summarize_usd_convert_cad_validation_failure


SKILL = "cad-to-simready-preflight"
SCHEMA_VERSION = "1.0"
DEFAULT_TARGETS = ("conversion", "validation", "content-agents")
SECRET_NAME_PARTS = ("KEY", "TOKEN", "SECRET", "PASSWORD")
DEFAULT_SERVICE_URLS = {
    "ovrtx": "http://localhost:8001",
    "material": "http://localhost:8100",
    "physics": "http://localhost:8200",
    "texture": "http://localhost:8300",
}
SMOKE_CAMERA_TRANSLATE_X = 3
SMOKE_CAMERA_TRANSLATE_Y = 3
SMOKE_CAMERA_TRANSLATE_Z = 3
SMOKE_CAMERA_ROTATE_X = -30
SMOKE_CAMERA_ROTATE_Y = 45
SMOKE_CAMERA_ROTATE_Z = 0
SMOKE_LIGHT_ROTATE_X = -45
SMOKE_LIGHT_ROTATE_Y = 30
SMOKE_LIGHT_ROTATE_Z = 0
SMOKE_CAMERA_TRANSLATE = f"{SMOKE_CAMERA_TRANSLATE_X}, {SMOKE_CAMERA_TRANSLATE_Y}, {SMOKE_CAMERA_TRANSLATE_Z}"
SMOKE_CAMERA_ROTATE = f"{SMOKE_CAMERA_ROTATE_X}, {SMOKE_CAMERA_ROTATE_Y}, {SMOKE_CAMERA_ROTATE_Z}"
SMOKE_LIGHT_ROTATE = f"{SMOKE_LIGHT_ROTATE_X}, {SMOKE_LIGHT_ROTATE_Y}, {SMOKE_LIGHT_ROTATE_Z}"
OVRTX_RENDER_SMOKE_USDA_TEMPLATE = """#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "World"
{
    def Cube "Cube"
    {
        double size = 1
    }

    def Camera "Camera"
    {
        float focalLength = 35
        float horizontalAperture = 36
        float verticalAperture = 36
        float2 clippingRange = (0.1, 1000)
        double3 xformOp:translate = (__SMOKE_CAMERA_TRANSLATE__)
        float3 xformOp:rotateXYZ = (__SMOKE_CAMERA_ROTATE__)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]
    }

    def DistantLight "KeyLight"
    {
        float intensity = 5000
        float3 xformOp:rotateXYZ = (__SMOKE_LIGHT_ROTATE__)
        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
    }
}
"""
OVRTX_RENDER_SMOKE_USDA = (
    OVRTX_RENDER_SMOKE_USDA_TEMPLATE.replace("__SMOKE_CAMERA_TRANSLATE__", SMOKE_CAMERA_TRANSLATE)
    .replace("__SMOKE_CAMERA_ROTATE__", SMOKE_CAMERA_ROTATE)
    .replace("__SMOKE_LIGHT_ROTATE__", SMOKE_LIGHT_ROTATE)
)
CONTENT_AGENTS_SECRET_ENV_NAMES = (
    "NVIDIA_API_KEY",
    "NGC_API_KEY",
    "NVCF_API_KEY",
    "NSTORAGE_API_KEY",
    "INFERENCE_NVIDIA_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MA_NVIDIA_API_KEY",
    "MA_NSTORAGE_API_KEY",
    "MA_IMAGE_GEN_API_KEY",
    "MA_CLUSTER_EMBEDDING_API_KEY",
    "MA_NIM_API_KEY",
    "PA_NVIDIA_API_KEY",
    "PA_NSTORAGE_API_KEY",
    "PA_NIM_API_KEY",
    "TA_IMAGE_GEN_API_KEY",
)
SIMREADY_RUNTIME_EXTRA_REQUIREMENTS = ("numpy>=1.24,<3",)
DEFAULT_SIMREADY_VALIDATE_REQUIREMENT = "simready-validate>=2026.4.8"
USD_EXCHANGE_SDK_FALLBACK_REQUIREMENTS = (
    "usd-exchange>=2.3.0",
    "omniverse-asset-validator",
    "omniverse-usd-profiles>=1.10.22",
)
DEFAULT_CONVERSION_TOOLS = {
    "repo-python",
    "usd-convert-cad",
    "usd-convert-gsplat",
}
UV_INSTALL_HINT = "Install uv with: curl -LsSf https://astral.sh/uv/install.sh | sh"
OPENUSD_IMPORT_CHECK = "from pxr import Usd, UsdGeom, UsdPhysics; print(Usd.GetVersion())"
ASSET_VALIDATOR_IMPORT_CHECK = "import omni.asset_validator"
USD_SUFFIXES = {".usd", ".usda", ".usdc", ".usdz"}
REPO_PYTHON_SOURCE_FORMATS = {"urdf", "mjcf", "mujoco"}
CAD_SOURCE_SUFFIXES = {
    ".3dm",
    ".3ds",
    ".3mf",
    ".asm",
    ".catpart",
    ".catproduct",
    ".dae",
    ".dgn",
    ".fbx",
    ".glb",
    ".gltf",
    ".iam",
    ".ifc",
    ".ifczip",
    ".iges",
    ".igs",
    ".ipt",
    ".jt",
    ".obj",
    ".ply",
    ".prt",
    ".sldasm",
    ".sldprt",
    ".step",
    ".stl",
    ".stp",
    ".x_t",
}
GSPLAT_SOURCE_SUFFIXES = {".ply", ".splat", ".ksplat"}
LOCAL_RENDER_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
CONTAINER_RENDER_ENV_KEYS = ("RENDER_ENDPOINT", "OVRTX_RENDER_ENDPOINT", "CONTENT_AGENTS_RENDER_BASE_URL")
UPSTREAMS = {
    "usd_convert_cad": {
        "url": "https://github.com/NVIDIA-Omniverse/usd-convert-cad",
        "branch": None,
        "checkout": "usd-convert-cad",
        "env": "USD_CONVERT_CAD_ROOT",
    },
    "usd_convert_gsplat": {
        "url": "https://github.com/NVIDIA-Omniverse/usd-convert-gsplat",
        "branch": None,
        "checkout": "usd-convert-gsplat",
        "env": "USD_CONVERT_GSPLAT_ROOT",
    },
    "simready_foundation": {
        "url": "https://github.com/NVIDIA/simready-foundation",
        "branch": "main",
        "checkout": "simready-foundation",
        "env": "SIMREADY_FOUNDATION_ROOT",
    },
    "content_agents": {
        "url": "https://github.com/nvidia-omniverse/content-agents",
        "branch": "main",
        "checkout": "content-agents",
        "env": "CONTENT_AGENTS_UPSTREAM_ROOT",
    },
}


@dataclass
class Step:
    name: str
    status: str
    message: str
    command: list[str] = field(default_factory=list)
    returncode: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": self.name,
            "status": self.status,
            "message": self.message,
        }
        if self.command:
            payload["command"] = self.command
        if self.returncode is not None:
            payload["returncode"] = self.returncode
        if self.stdout_tail:
            payload["stdout_tail"] = self.stdout_tail
        if self.stderr_tail:
            payload["stderr_tail"] = self.stderr_tail
        return payload


def _checkout_name_from_repo_url(repo_url: str) -> str:
    name = urlparse(repo_url).path.rstrip("/").rsplit("/", 1)[-1]
    return name[:-4] if name.endswith(".git") else name


def _default_home() -> Path:
    return Path(os.environ.get("PHYSICAL_AI_SKILL_HUB_HOME", "~/.physical-ai-skill-hub")).expanduser()


def _default_state_root(home: Path) -> Path:
    return Path(os.environ.get("PHYSICAL_AI_SKILL_HUB_STATE", home / "state")).expanduser()


def _default_upstream_root(home: Path) -> Path:
    return Path(os.environ.get("PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT", home / "upstreams")).expanduser()


def _default_venv_root(home: Path) -> Path:
    return Path(os.environ.get("PHYSICAL_AI_SKILL_HUB_VENV_ROOT", home / "venvs")).expanduser()


def _is_secret_name(name: str) -> bool:
    upper = name.upper()
    return any(part in upper for part in SECRET_NAME_PARTS)


def _redaction_values(env: dict[str, str]) -> list[str]:
    return [value for name, value in env.items() if value and _is_secret_name(name) and len(value) >= 4]


def _redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        redacted = redacted.replace(secret, "<redacted>")
    return redacted


def _run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 900,
) -> Step:
    command_env = env or os.environ.copy()
    secrets = _redaction_values(command_env)
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            env=command_env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Step(
            name=Path(command[0]).name,
            status="blocked",
            message=f"command could not complete: {exc}",
            command=command,
        )
    status = "ready" if completed.returncode == 0 else "blocked"
    return Step(
        name=Path(command[0]).name,
        status=status,
        message="command completed" if completed.returncode == 0 else f"command failed with exit {completed.returncode}",
        command=command,
        returncode=completed.returncode,
        stdout_tail=tail_text(_redact(completed.stdout or "", secrets)),
        stderr_tail=tail_text(_redact(completed.stderr or "", secrets)),
    )


def _container_reachable_render_endpoint(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in LOCAL_RENDER_HOSTS:
        return value
    host = "host.docker.internal"
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=host))


def _content_agents_deploy_env() -> dict[str, str]:
    """Translate host-local renderer URLs for agent containers during deploy."""
    env = os.environ.copy()
    for key in CONTAINER_RENDER_ENV_KEYS:
        if env.get(key):
            env[key] = _container_reachable_render_endpoint(env[key])
    if not env.get("RENDER_ENDPOINT"):
        for key in ("OVRTX_RENDER_ENDPOINT", "CONTENT_AGENTS_RENDER_BASE_URL"):
            if env.get(key):
                env["RENDER_ENDPOINT"] = _container_reachable_render_endpoint(env[key])
                break
    return env


def _path_entries(*entries: Path | None) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for entry in entries:
        if entry is None:
            continue
        value = str(entry.expanduser())
        if value in seen or not Path(value).is_dir():
            continue
        seen.add(value)
        values.append(value)
    return values


def _path_env_with_entries(*entries: Path | None) -> str | None:
    extra = _path_entries(*entries)
    if not extra:
        return None
    return os.pathsep.join([*extra, os.environ.get("PATH", "")])


def _user_tool_dirs() -> list[str]:
    home = Path.home()
    uv_python_dirs = sorted((home / ".local" / "share" / "uv" / "python").glob("*/bin"))
    return _path_entries(home / ".local" / "bin", home / "bin", *uv_python_dirs)


def _which(name: str, *, extra_dirs: list[str] | None = None) -> str | None:
    search_dirs = [*(extra_dirs or []), *_user_tool_dirs()]
    search_path = os.environ.get("PATH", "")
    if search_dirs:
        search_path = os.pathsep.join([*search_dirs, search_path])
    return shutil.which(name, path=search_path)


def _env_with_extra_path(*entries: Path | None) -> dict[str, str]:
    env = os.environ.copy()
    path_value = _path_env_with_entries(*entries, *[Path(value) for value in _user_tool_dirs()])
    if path_value:
        env["PATH"] = path_value
    return env


def _csv_values(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def _selected_targets(raw: str, *, skip_content_agents: bool) -> tuple[str, ...]:
    values = _csv_values(raw)
    if values:
        selected = tuple(target for target in values if target in DEFAULT_TARGETS)
    else:
        selected = tuple(DEFAULT_TARGETS)
    if skip_content_agents:
        selected = tuple(target for target in selected if target != "content-agents")
    return selected


def _normalized_source_format(source_asset: Path | None, source_format: str) -> str:
    if source_format:
        return source_format.strip().lower().lstrip(".")
    if source_asset is None:
        return ""
    suffix = source_asset.suffix.lower()
    if suffix in USD_SUFFIXES:
        return "usd"
    if suffix == ".urdf":
        return "urdf"
    if suffix in {".mjcf", ".xml"}:
        return "mujoco"
    if suffix in GSPLAT_SOURCE_SUFFIXES:
        return "gsplat"
    if suffix in CAD_SOURCE_SUFFIXES:
        return "cad"
    return suffix.lstrip(".")


def _inferred_conversion_tools(source_format: str) -> set[str] | None:
    if not source_format:
        return None
    if source_format in {"usd", "openusd"}:
        return set()
    if source_format in REPO_PYTHON_SOURCE_FORMATS:
        return {"repo-python"}
    if source_format in {"cad", "mesh", "scene", "obj", "stl", "dae", "gltf", "glb", "fbx", "step", "stp"}:
        return {"usd-convert-cad"}
    if source_format in {"gsplat", "splat", "ksplat"}:
        return {"usd-convert-gsplat"}
    return None


def _selected_conversion_tools(raw: str, source_asset: Path | None, source_format: str) -> tuple[set[str], dict[str, Any]]:
    explicit_tools = {tool for tool in _csv_values(raw) if tool in DEFAULT_CONVERSION_TOOLS}
    normalized_source_format = _normalized_source_format(source_asset, source_format)
    inferred_tools = _inferred_conversion_tools(normalized_source_format)
    if explicit_tools:
        tools = explicit_tools
        reason = "explicit"
    elif inferred_tools is not None:
        tools = inferred_tools
        reason = "source-format"
    else:
        tools = set(DEFAULT_CONVERSION_TOOLS)
        reason = "default"
    return tools, {
        "source_asset": str(source_asset) if source_asset else "",
        "source_format": normalized_source_format,
        "conversion_tools_reason": reason,
    }


def _project_venv_dir(project_root: Path | None) -> Path | None:
    if project_root is None:
        return None
    venv = project_root / ".venv"
    return venv if venv.exists() else None


def _project_venv_bin(project_root: Path | None) -> Path | None:
    venv = _project_venv_dir(project_root)
    if venv is None:
        return None
    return _venv_bin_dir(venv)


def _project_venv_python(project_root: Path | None) -> Path | None:
    venv_bin = _project_venv_bin(project_root)
    if venv_bin is None:
        return None
    python = venv_bin / ("python.exe" if os.name == "nt" else "python")
    return python if python.exists() else None


def _find_executable(name: str, *, project_root: Path | None = None) -> str | None:
    extra_dirs = _path_entries(_project_venv_bin(project_root))
    return _which(name, extra_dirs=extra_dirs)


def _find_project_root(explicit: Path | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(explicit.expanduser().resolve())
    candidates.append(Path.cwd().resolve())
    candidates.extend(Path(__file__).resolve().parents)
    for candidate in candidates:
        current = candidate
        while True:
            if (current / "pyproject.toml").is_file():
                return current
            if current.parent == current:
                break
            current = current.parent
    return None


def _upstream_path(name: str, upstream_root: Path) -> Path:
    spec = UPSTREAMS[name]
    override = os.environ.get(str(spec["env"]))
    if override:
        return Path(override).expanduser().resolve()
    checkout = str(spec["checkout"]) or _checkout_name_from_repo_url(str(spec["url"]))
    return (upstream_root / checkout).expanduser().resolve()


def _git_commit(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    completed = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30, check=False)
    return completed.stdout.strip() if completed.returncode == 0 else None


def _git_dirty(path: Path) -> bool:
    completed = subprocess.run(["git", "-C", str(path), "status", "--porcelain"], capture_output=True, text=True, timeout=30, check=False)
    return bool(completed.stdout.strip()) if completed.returncode == 0 else False


def _ensure_upstream(name: str, upstream_root: Path, *, check_only: bool, no_update: bool) -> tuple[dict[str, Any], list[Step]]:
    spec = UPSTREAMS[name]
    path = _upstream_path(name, upstream_root)
    branch = spec["branch"]
    steps: list[Step] = []
    if not path.exists():
        if check_only:
            return (
                {
                    "status": "blocked",
                    "path": str(path),
                    "url": spec["url"],
                    "branch": branch,
                    "message": f"checkout is missing: {path}",
                },
                steps,
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        command = ["git", "clone", str(spec["url"]), str(path)]
        if branch:
            command = ["git", "clone", "--branch", str(branch), str(spec["url"]), str(path)]
        steps.append(_run(command, timeout=1800))
    elif (path / ".git").exists() and not check_only and not no_update:
        if _git_dirty(path):
            steps.append(Step(name=f"{name}_update", status="skipped", message="checkout has local changes; skipped automatic update"))
        else:
            if branch:
                steps.append(_run(["git", "-C", str(path), "fetch", "origin", str(branch)], timeout=600))
                steps.append(_run(["git", "-C", str(path), "checkout", str(branch)], timeout=120))
            steps.append(_run(["git", "-C", str(path), "pull", "--ff-only"], timeout=600))

    present = path.exists()
    status = "present" if present else "blocked"
    if any(step.status == "blocked" for step in steps):
        status = "blocked"
    return (
        {
            "status": status,
            "path": str(path),
            "url": spec["url"],
            "branch": branch,
            "commit": _git_commit(path),
            "message": "checkout is present" if present else f"checkout is missing: {path}",
        },
        steps,
    )


def _runtime_entry(status: str, message: str, **extra: Any) -> dict[str, Any]:
    payload = {"status": status, "message": message}
    payload.update({key: value for key, value in extra.items() if value is not None and value != ""})
    return payload


def _nearest_existing_parent(path: Path) -> Path:
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    return current


def _check_request_inputs(source_asset: Path | None, output_root: Path | None, *, check_only: bool) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    blockers: list[str] = []

    if source_asset is None:
        checks.append({"name": "source_asset", "status": "skipped", "message": "no source asset was provided"})
    elif not source_asset.exists():
        message = f"source asset does not exist: {source_asset}"
        checks.append({"name": "source_asset", "status": "blocked", "message": message})
        blockers.append(message)
    elif not os.access(source_asset, os.R_OK):
        message = f"source asset is not readable: {source_asset}"
        checks.append({"name": "source_asset", "status": "blocked", "message": message})
        blockers.append(message)
    else:
        checks.append({"name": "source_asset", "status": "ready", "message": "source asset exists and is readable"})

    if output_root is None:
        checks.append({"name": "output_root", "status": "skipped", "message": "no output root was provided"})
    else:
        try:
            if output_root.exists():
                if not output_root.is_dir():
                    message = f"output root exists but is not a directory: {output_root}"
                    checks.append({"name": "output_root", "status": "blocked", "message": message})
                    blockers.append(message)
                elif not os.access(output_root, os.W_OK):
                    message = f"output root is not writable: {output_root}"
                    checks.append({"name": "output_root", "status": "blocked", "message": message})
                    blockers.append(message)
                else:
                    checks.append({"name": "output_root", "status": "ready", "message": "output root exists and is writable"})
            elif check_only:
                parent = _nearest_existing_parent(output_root.parent)
                if parent.exists() and os.access(parent, os.W_OK):
                    checks.append({"name": "output_root", "status": "ready", "message": f"output root can be created under {parent}"})
                else:
                    message = f"output root parent is not writable or does not exist: {output_root.parent}"
                    checks.append({"name": "output_root", "status": "blocked", "message": message})
                    blockers.append(message)
            else:
                output_root.mkdir(parents=True, exist_ok=True)
                checks.append({"name": "output_root", "status": "ready", "message": "output root was created"})
        except OSError as exc:
            message = f"output root could not be prepared: {exc}"
            checks.append({"name": "output_root", "status": "blocked", "message": message})
            blockers.append(message)

    status = "blocked" if blockers else ("skipped" if source_asset is None and output_root is None else "ready")
    message = "request inputs are ready" if status == "ready" else "request input checks were skipped" if status == "skipped" else "; ".join(blockers)
    return _runtime_entry(
        status,
        message,
        source_asset=str(source_asset) if source_asset else "",
        output_root=str(output_root) if output_root else "",
        checks=checks,
    )


def _check_repo_python(project_root: Path | None, *, check_only: bool, skip_uv_sync: bool) -> tuple[dict[str, Any], list[Step]]:
    uv = _which("uv")
    steps: list[Step] = []
    if project_root is None:
        return _runtime_entry("skipped", "no pyproject.toml found near cwd or preflight script", executable=sys.executable), steps
    if uv is None:
        return _runtime_entry(
            "blocked",
            "`uv` was not found on PATH",
            project_root=str(project_root),
            executable=sys.executable,
            install_hint=UV_INSTALL_HINT,
        ), steps
    if not check_only and not skip_uv_sync:
        steps.append(_run([uv, "sync", "--dev", "--python", "3.12"], cwd=project_root, timeout=1800))
    status = "blocked" if any(step.status == "blocked" for step in steps) else "ready"
    message = "repo Python environment is synchronized" if status == "ready" else "repo Python environment sync failed"
    if check_only or skip_uv_sync:
        message = "repo Python environment sync was not run"
    venv = _project_venv_dir(project_root)
    repo_python = _project_venv_python(project_root)
    return _runtime_entry(
        status,
        message,
        project_root=str(project_root),
        executable=str(repo_python or sys.executable),
        uv=uv,
        venv=str(venv) if venv else "",
    ), steps


def _check_openusd_python(project_root: Path | None) -> tuple[dict[str, Any], list[Step]]:
    python = str(_project_venv_python(project_root) or Path(sys.executable))
    step = _run([python, "-c", OPENUSD_IMPORT_CHECK], env=_env_with_extra_path(_project_venv_bin(project_root)), timeout=60)
    status = "ready" if step.status == "ready" else "blocked"
    message = "OpenUSD Python APIs are importable" if status == "ready" else "OpenUSD Python APIs are not importable"
    return _runtime_entry(status, message, executable=python), [step]


def _check_asset_validator(project_root: Path | None) -> tuple[dict[str, Any], list[Step]]:
    executable = _find_executable("omni_asset_validate", project_root=project_root)
    if executable:
        return _runtime_entry("ready", "omni_asset_validate CLI is on PATH", executable=executable), []
    python = str(_project_venv_python(project_root) or Path(sys.executable))
    step = _run([python, "-c", ASSET_VALIDATOR_IMPORT_CHECK], env=_env_with_extra_path(_project_venv_bin(project_root)), timeout=60)
    status = "ready" if step.status == "ready" else "blocked"
    message = "omni.asset_validator Python module is importable" if status == "ready" else "omni_asset_validate CLI and omni.asset_validator module are unavailable"
    return _runtime_entry(status, message, executable=python), [step]


def _check_git_lfs(*, install_lfs: bool, check_only: bool) -> tuple[dict[str, Any], list[Step]]:
    git_lfs = _which("git-lfs") or _which("git")
    if _which("git-lfs") is None:
        return _runtime_entry("blocked", "`git-lfs` was not found on PATH"), []
    steps: list[Step] = []
    if install_lfs and not check_only:
        steps.append(_run(["git", "lfs", "install"], timeout=120))
        steps.append(_run(["git", "lfs", "pull"], timeout=1800))
    status = "blocked" if any(step.status == "blocked" for step in steps) else "ready"
    return _runtime_entry(status, "Git LFS is available", executable=git_lfs), steps


def _check_usd_convert_cad(root: Path, *, project_root: Path | None, check_only: bool) -> tuple[dict[str, Any], list[Step]]:
    steps: list[Step] = []
    install_py = root / "install.py"
    validate_py = root / "validate.py"
    convert_py = root / "convert.py"
    if not root.exists():
        return _runtime_entry("blocked", "usd-convert-cad checkout is missing", root=str(root)), steps
    if not convert_py.is_file() or not validate_py.is_file():
        return _runtime_entry("blocked", "usd-convert-cad convert.py or validate.py is missing", root=str(root)), steps
    env = os.environ.copy()
    env.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")
    if not check_only:
        python = str(_project_venv_python(project_root) or Path(sys.executable))
        command_env = env.copy()
        extra_path = _env_with_extra_path(_project_venv_bin(project_root)).get("PATH")
        if extra_path:
            command_env["PATH"] = extra_path
        validate = _run([python, str(validate_py)], cwd=root, env=command_env, timeout=900)
        steps.append(validate)
        if validate.status == "blocked" and install_py.is_file():
            install = _run([python, str(install_py)], cwd=root, env=command_env, timeout=3600)
            steps.append(install)
            validate = _run([python, str(validate_py)], cwd=root, env=command_env, timeout=900)
            steps.append(validate)
    status = "ready" if check_only or (steps and steps[-1].status == "ready") else "blocked"
    message = "usd-convert-cad is installed and validated" if status == "ready" else "usd-convert-cad install or validation failed"
    if check_only:
        message = "usd-convert-cad files are present; runtime validation was not run"
    runtime = _runtime_entry(status, message, root=str(root), executable=str(convert_py))
    if status == "blocked":
        final_validate = next(
            (
                step
                for step in reversed(steps)
                if len(step.command) > 1 and Path(step.command[1]).name == "validate.py"
            ),
            None,
        )
        if final_validate is not None:
            output = "\n".join(part for part in (final_validate.stdout_tail, final_validate.stderr_tail) if part)
            diagnostic = summarize_usd_convert_cad_validation_failure(output, final_validate.returncode)
            if diagnostic:
                runtime["message"] = f"{message}: {diagnostic['summary']} {diagnostic['recovery_hint']}"
                runtime["diagnostics"] = [diagnostic]
    return runtime, steps


def _check_usd_convert_gsplat(root: Path, *, project_root: Path | None) -> tuple[dict[str, Any], list[Step]]:
    executable = _find_executable("gsplat2USD", project_root=project_root)
    cli_source = root / "source" / "python" / "usd_convert_gsplat" / "cli.py"
    if not root.exists():
        return _runtime_entry("blocked", "usd-convert-gsplat checkout is missing", root=str(root), executable=executable), []
    if not cli_source.is_file():
        return _runtime_entry("blocked", "usd-convert-gsplat CLI source is missing", root=str(root), executable=executable), []
    if executable is None:
        return _runtime_entry("blocked", "gsplat2USD CLI is not on PATH", root=str(root)), []
    return _runtime_entry("ready", "gsplat2USD CLI and upstream capability source are available", root=str(root), executable=executable), []


def _venv_bin_dir(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts" if os.name == "nt" else "bin")


def _simready_executable(venv_dir: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return _venv_bin_dir(venv_dir) / f"simready-validate{suffix}"


def _simready_runtime_import_check(venv_dir: Path) -> Step:
    python = _venv_bin_dir(venv_dir) / ("python.exe" if os.name == "nt" else "python")
    return _run([str(python), "-c", "import numpy"], timeout=60)


def _foundation_requirements_path(root: Path) -> Path:
    candidates = [
        root / "requirements.txt",
        root / "nv_core" / "validator_sample" / "requirements.txt",
    ]
    return next((path for path in candidates if path.is_file()), candidates[0])


def _dedupe_requirements(requirements: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for requirement in requirements:
        key = requirement.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(requirement)
    return deduped


def _foundation_simready_requirements(requirements_path: Path) -> tuple[list[str], list[str]]:
    simready_requirements: list[str] = []
    other_requirements: list[str] = []
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.lower().startswith("simready-validate"):
            simready_requirements.append(line)
        elif not line.lower().startswith("usd-core"):
            other_requirements.append(line)
    return simready_requirements or [DEFAULT_SIMREADY_VALIDATE_REQUIREMENT], other_requirements


def _is_aarch64() -> bool:
    return platform.machine().lower() in {"aarch64", "arm64"}


def _simready_install_detail(step: Step) -> str:
    return "\n".join(part for part in (step.stdout_tail, step.stderr_tail, step.message) if part)


def _should_try_simready_usd_exchange_fallback(step: Step) -> bool:
    if step.status != "blocked" or not _is_aarch64():
        return False
    lowered = _simready_install_detail(step).lower()
    return "usd-core" in lowered or "no matching distribution" in lowered or "resolutionimpossible" in lowered


def _simready_pip_install_command(python: Path, requirements: list[str], *, uv: str | None) -> list[str]:
    if uv:
        return [uv, "pip", "install", "--python", str(python), *requirements]
    return [str(python), "-m", "pip", "install", "--disable-pip-version-check", *requirements]


def _simready_pip_install_step(python: Path, requirements: list[str], *, uv: str | None) -> Step:
    return _run(_simready_pip_install_command(python, requirements, uv=uv), timeout=1800)


def _install_simready_with_usd_exchange_sdk_runtime(python: Path, requirements_path: Path, *, uv: str | None) -> list[Step]:
    simready_requirements, other_requirements = _foundation_simready_requirements(requirements_path)
    runtime_requirements = _dedupe_requirements(
        [*USD_EXCHANGE_SDK_FALLBACK_REQUIREMENTS, *other_requirements, *SIMREADY_RUNTIME_EXTRA_REQUIREMENTS]
    )
    steps = [_simready_pip_install_step(python, runtime_requirements, uv=uv)]
    if steps[-1].status != "blocked":
        steps.append(_simready_pip_install_step(python, ["--no-deps", *simready_requirements], uv=uv))
    return steps


def _check_simready(root: Path, venv_root: Path, *, project_root: Path | None, check_only: bool) -> tuple[dict[str, Any], list[Step]]:
    requirements = _foundation_requirements_path(root)
    executable = _which("simready-validate")
    if executable:
        return _runtime_entry("ready", "simready-validate executable is on PATH", root=str(root), executable=executable), []
    if not root.exists():
        return _runtime_entry("blocked", "SimReady Foundation checkout is missing", root=str(root)), []
    if not requirements.is_file():
        return _runtime_entry("blocked", "SimReady Foundation requirements.txt is missing", root=str(root)), []
    steps: list[Step] = []
    venv_dir = venv_root / "simready-validate"
    venv_executable = _simready_executable(venv_dir)
    if venv_executable.is_file():
        import_check = _simready_runtime_import_check(venv_dir)
        if import_check.status == "blocked":
            steps.append(
                Step(
                    name="simready_validate_runtime_check",
                    status="ready",
                    message="existing preflight venv is missing runtime dependencies; reinstalling",
                    stderr_tail=import_check.stderr_tail,
                )
            )
        else:
            steps.append(import_check)
            return _runtime_entry(
                "ready",
                "simready-validate executable is available from the preflight venv",
                root=str(root),
                executable=str(venv_executable),
                venv=str(venv_dir),
            ), steps
    if check_only:
        return _runtime_entry("blocked", "simready-validate is installable from Foundation requirements but was not installed in check-only mode", root=str(root)), []
    uv = _which("uv")
    if uv:
        venv_command = [uv, "venv", "--python", "3.12"]
        if venv_dir.exists():
            venv_command.append("--clear")
        steps = [_run([*venv_command, str(venv_dir)], timeout=300)]
    else:
        steps = [_run([sys.executable, "-m", "venv", str(venv_dir)], env=_env_with_extra_path(_project_venv_bin(project_root)), timeout=300)]
    python = _venv_bin_dir(venv_dir) / ("python.exe" if os.name == "nt" else "python")
    if steps[-1].status != "blocked":
        steps.append(_simready_pip_install_step(python, ["-r", str(requirements), *SIMREADY_RUNTIME_EXTRA_REQUIREMENTS], uv=uv))
        if _should_try_simready_usd_exchange_fallback(steps[-1]):
            steps.extend(_install_simready_with_usd_exchange_sdk_runtime(python, requirements, uv=uv))
    if steps[-1].status != "blocked":
        steps.append(_simready_runtime_import_check(venv_dir))
    status = "ready" if venv_executable.is_file() and steps[-1].status != "blocked" else "blocked"
    return _runtime_entry(
        status,
        "simready-validate was installed into the preflight venv" if status == "ready" else "simready-validate install failed",
        root=str(root),
        executable=str(venv_executable) if venv_executable.exists() else "",
        venv=str(venv_dir),
    ), steps


SERVICE_ENV_BY_SERVICE = {
    "ovrtx": ("RENDER_ENDPOINT", "OVRTX_RENDER_ENDPOINT", "CONTENT_AGENTS_RENDER_BASE_URL"),
    "material": ("CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL", "MATERIAL_AGENT_BASE_URL"),
    "physics": ("CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL", "PHYSICS_AGENT_BASE_URL"),
    "texture": ("CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL", "TEXTURE_AGENT_BASE_URL"),
}


def _service_env_url(service: str) -> str:
    for name in SERVICE_ENV_BY_SERVICE[service]:
        value = os.environ.get(name)
        if value:
            return value.rstrip("/")
    return DEFAULT_SERVICE_URLS[service]


def _service_url_was_provided(service: str) -> bool:
    return any(bool(os.environ.get(name)) for name in SERVICE_ENV_BY_SERVICE[service])


def _health_urls(base_url: str) -> list[str]:
    clean = base_url.rstrip("/")
    return [f"{clean}/health", f"{clean}/v2/health/ready"]


def _is_remote_or_invocation_endpoint(base_url: str) -> bool:
    lowered = base_url.lower()
    return lowered.startswith("https://") or "nvcf" in lowered or "invocation" in lowered


def _render_url(base_url: str) -> str:
    clean = base_url.rstrip("/")
    return clean if clean.endswith("/render") else f"{clean}/render"


def _ovrtx_render_smoke_timeout() -> int:
    raw = os.environ.get("OVRTX_PREFLIGHT_SMOKE_TIMEOUT_SECONDS", "120")
    try:
        timeout = int(raw)
    except ValueError:
        timeout = 120
    return max(5, timeout)


def _iter_render_image_candidates(value: Any, parent_key: str | None = None, in_images: bool = False) -> Any:
    candidate_keys = {"image", "png", "image_data", "output_image", "render", "rendered_image", "images", "rgb"}
    if isinstance(value, str) and (in_images or parent_key in candidate_keys):
        yield value
        return
    if isinstance(value, list):
        for item in value:
            yield from _iter_render_image_candidates(item, parent_key, in_images)
        return
    if isinstance(value, dict):
        nested_in_images = in_images or parent_key == "images"
        for key, item in value.items():
            yield from _iter_render_image_candidates(item, key, nested_in_images)


def _render_response_has_png(body: bytes) -> tuple[bool, str]:
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return True, "render smoke returned PNG bytes"
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return False, f"render smoke response was not PNG or JSON: {exc}"
    if isinstance(payload, dict) and payload.get("status") == "exception":
        return False, f"render smoke reported exception: {payload.get('error') or 'unknown error'}"
    for candidate in _iter_render_image_candidates(payload):
        data = candidate.split(",", 1)[1] if candidate.startswith("data:image") and "," in candidate else candidate
        try:
            decoded = base64.b64decode(data, validate=True)
        except (ValueError, TypeError):
            continue
        if decoded.startswith(b"\x89PNG\r\n\x1a\n"):
            return True, "render smoke returned base64 PNG"
    if isinstance(payload, dict) and payload.get("images") == {}:
        return False, "render smoke returned success with empty images"
    return False, "render smoke did not return PNG bytes or a base64 PNG field"


def _probe_ovrtx_render_smoke(base_url: str) -> dict[str, Any]:
    payload = {
        "url": "data:application/octet-stream;base64,"
        + base64.b64encode(OVRTX_RENDER_SMOKE_USDA.encode("utf-8")).decode("ascii"),
        "force_render": True,
        "render_settings": {
            "camera_paths": ["/World/Camera"],
            "frame_range": {"start": 0, "end": 0},
            "camera_parameters": {"width": 64, "height": 64},
            "sensors": None,
            "apply_background_mask": False,
            "num_sensor_updates": 1,
        },
    }
    url = _render_url(base_url)
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=_ovrtx_render_smoke_timeout()) as response:
            body = response.read()
            passed, message = _render_response_has_png(body)
            status = "ready" if passed else "blocked"
            return {
                "status": status,
                "render_url": url,
                "message": message,
                "response_status": response.status,
                "response_content_type": response.headers.get("Content-Type", ""),
                "response_bytes": len(body),
            }
    except HTTPError as exc:
        body = exc.read(4096).decode("utf-8", errors="replace")
        return {
            "status": "blocked",
            "render_url": url,
            "message": f"render smoke HTTP {exc.code}: {body}",
        }
    except URLError as exc:
        return {
            "status": "blocked",
            "render_url": url,
            "message": f"render smoke could not reach endpoint: {exc.reason}",
        }
    except TimeoutError:
        return {
            "status": "blocked",
            "render_url": url,
            "message": "render smoke timed out",
        }
    except OSError as exc:
        return {
            "status": "blocked",
            "render_url": url,
            "message": f"render smoke failed: {exc}",
        }


def _probe_service(service: str, base_url: str, timeout: int = 8) -> dict[str, Any]:
    if _is_remote_or_invocation_endpoint(base_url):
        return {
            "status": "ready",
            "base_url": base_url.rstrip("/"),
            "message": f"{service} remote/provided endpoint accepted; generic unauthenticated health probe skipped",
        }
    deadline = time.monotonic() + timeout
    errors: list[str] = []
    while True:
        errors = []
        for url in _health_urls(base_url):
            request = Request(url, method="GET")
            request_timeout = max(1.0, min(5.0, deadline - time.monotonic()))
            try:
                with urlopen(request, timeout=request_timeout) as response:
                    body = response.read(4096).decode("utf-8", errors="replace")
                    try:
                        health_payload = json.loads(body)
                    except json.JSONDecodeError:
                        health_payload = {}
                    if service == "ovrtx":
                        ovrtx_ready = (
                            health_payload.get("status") == "healthy"
                            and health_payload.get("gpu_initialized", True) is not False
                            and health_payload.get("renderer_initialized", True) is not False
                        )
                        if not ovrtx_ready:
                            errors.append(f"{url}: OVRTX renderer is not ready: {body}")
                            continue
                        smoke = _probe_ovrtx_render_smoke(base_url)
                        if smoke["status"] != "ready":
                            return {
                                "status": "blocked",
                                "base_url": base_url.rstrip("/"),
                                "health_url": url,
                                "message": f"ovrtx health endpoint responded but render smoke failed: {smoke['message']}",
                                "health_response": body,
                                "render_smoke": smoke,
                            }
                        return {
                            "status": "ready",
                            "base_url": base_url.rstrip("/"),
                            "health_url": url,
                            "message": f"{service} health endpoint and render smoke responded with HTTP {response.status}",
                            "health_response": body,
                            "render_smoke": smoke,
                        }
                    if service in {"material", "physics", "texture"} and health_payload.get("api_keys_configured") is False:
                        return {
                            "status": "blocked",
                            "base_url": base_url.rstrip("/"),
                            "health_url": url,
                            "message": f"{service} health endpoint responded but API keys are not configured",
                            "health_response": body,
                        }
                    return {
                        "status": "ready",
                        "base_url": base_url.rstrip("/"),
                        "health_url": url,
                        "message": f"{service} health endpoint responded with HTTP {response.status}",
                        "health_response": body,
                    }
            except HTTPError as exc:
                errors.append(f"{url}: HTTP {exc.code}")
            except URLError as exc:
                errors.append(f"{url}: {exc.reason}")
            except TimeoutError:
                errors.append(f"{url}: timed out")
            except OSError as exc:
                errors.append(f"{url}: {exc}")
        if time.monotonic() >= deadline:
            break
        time.sleep(min(2.0, max(0.1, deadline - time.monotonic())))
    return {
        "status": "blocked",
        "base_url": base_url.rstrip("/"),
        "message": f"{service} health endpoint did not respond",
        "errors": errors,
    }


def _deploy_ovrtx(world_root: Path) -> Step:
    compose_file = world_root / "apps" / "ovrtx_rendering_api" / "docker-compose.yml"
    if not compose_file.is_file():
        return Step(
            name="ovrtx_deploy",
            status="blocked",
            message="upstream OVRTX Docker Compose file was not found",
            command=["docker", "compose", "-f", str(compose_file), "up", "-d", "--build"],
        )
    env = os.environ.copy()
    env.setdefault("OVRTX_RENDER_MODE", "pt")
    return _run(
        ["docker", "compose", "-f", str(compose_file), "up", "-d", "--build"],
        cwd=world_root,
        env=env,
        timeout=3600,
    )


def _check_content_agents_deployment_host() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    blockers: list[str] = []

    nvidia_smi = _which("nvidia-smi")
    if nvidia_smi is None:
        message = "nvidia-smi was not found on PATH"
        checks.append({"name": "nvidia_smi", "status": "blocked", "message": message})
        blockers.append(message)
    else:
        step = _run([nvidia_smi, "-L"], timeout=30)
        status = "ready" if step.status == "ready" else "blocked"
        message = "nvidia-smi reported at least one GPU" if status == "ready" else "nvidia-smi could not query GPUs"
        checks.append({"name": "nvidia_smi", "status": status, "message": message, "executable": nvidia_smi})
        if status == "blocked":
            blockers.append(message)

    docker = _which("docker")
    if docker is None:
        message = "docker was not found on PATH"
        checks.append({"name": "docker", "status": "blocked", "message": message})
        blockers.append(message)
    else:
        info = _run([docker, "info", "--format", "{{json .ServerVersion}}"], timeout=30)
        info_status = "ready" if info.status == "ready" else "blocked"
        info_message = "Docker daemon is reachable" if info_status == "ready" else "Docker daemon is not reachable"
        checks.append({"name": "docker_daemon", "status": info_status, "message": info_message, "executable": docker})
        if info_status == "blocked":
            blockers.append(info_message)
        compose = _run([docker, "compose", "version"], timeout=30)
        compose_status = "ready" if compose.status == "ready" else "blocked"
        compose_message = "Docker Compose v2 is available" if compose_status == "ready" else "Docker Compose v2 is not available"
        checks.append({"name": "docker_compose_v2", "status": compose_status, "message": compose_message, "executable": docker})
        if compose_status == "blocked":
            blockers.append(compose_message)

    status = "ready" if not blockers else "blocked"
    return _runtime_entry(
        status,
        "local Content Agents deployment host is ready" if status == "ready" else "; ".join(blockers),
        checks=checks,
    )


def _should_check_content_agents_deployment_host(service_reports: dict[str, Any], *, will_deploy: bool) -> bool:
    if will_deploy:
        return True
    return any(report.get("status") == "blocked" and not _service_url_was_provided(service) for service, report in service_reports.items())


def _check_content_agents(
    world_root: Path,
    *,
    include_texture: bool,
    check_only: bool,
    skip_deploy: bool,
) -> tuple[dict[str, Any], dict[str, Any], list[Step]]:
    services = ("ovrtx", "material", "physics", "texture") if include_texture else ("ovrtx", "material", "physics")
    service_reports = {service: _probe_service(service, _service_env_url(service)) for service in services}
    if all(report["status"] == "ready" for report in service_reports.values()):
        return _runtime_entry("ready", "Content Agents services are already healthy", root=str(world_root)), service_reports, []

    steps: list[Step] = []
    if _should_check_content_agents_deployment_host(service_reports, will_deploy=not (check_only or skip_deploy)):
        deployment_host = _check_content_agents_deployment_host()
    else:
        deployment_host = _runtime_entry(
            "skipped",
            "explicit Content Agents endpoints were provided; local deployment host diagnostics were not needed",
        )
    if check_only or skip_deploy:
        return (
            _runtime_entry(
                "blocked",
                "Content Agents services are not healthy and deployment was not requested",
                root=str(world_root),
                deployment_host=deployment_host,
            ),
            service_reports,
            steps,
        )
    if not world_root.exists():
        return _runtime_entry("blocked", "content-agents checkout is missing", root=str(world_root)), service_reports, steps
    if os.name == "nt":
        return (
            _runtime_entry(
                "blocked",
                "Content Agents deployment requires a Linux Docker/GPU host; use WSL2/Linux Docker or provide healthy endpoints",
                root=str(world_root),
            ),
            service_reports,
            steps,
        )
    if _which("docker") is None:
        return _runtime_entry("blocked", "docker was not found on PATH", root=str(world_root), deployment_host=deployment_host), service_reports, steps
    if deployment_host.get("status") == "blocked":
        return _runtime_entry("blocked", "Content Agents local deployment host is not ready", root=str(world_root), deployment_host=deployment_host), service_reports, steps
    if not os.environ.get("NVIDIA_API_KEY"):
        return _runtime_entry("blocked", "NVIDIA_API_KEY is required for managed local Content Agents deployment", root=str(world_root), deployment_host=deployment_host), service_reports, steps

    steps.append(_ensure_content_agents_secret_env(world_root))
    if steps[-1].status == "blocked":
        return _runtime_entry("blocked", "failed to prepare upstream Content Agents credential environment", root=str(world_root)), service_reports, steps

    targets = ["ovrtx", "material", "physics"]
    if include_texture:
        targets.append("texture")

    # Keep deployment ownership upstream. Prefer the collection deploy wrapper
    # when available; fall back to older script-shaped deploy references.
    deploy_commands: list[tuple[Path, list[str]]] = []
    for path in (
        world_root / ".agents" / "skills" / "deploy-collection" / "scripts" / "deploy_collection.sh",
        world_root / ".codex" / "skills" / "deploy-collection" / "scripts" / "deploy_collection.sh",
    ):
        command = [str(path), "up"] if os.access(path, os.X_OK) else ["bash", str(path), "up"]
        deploy_commands.append((path, command))
    for path in (
        world_root / ".agents" / "skills" / "deploy-content-agents" / "scripts" / "run.py",
        world_root / ".codex" / "skills" / "deploy-content-agents" / "scripts" / "run.py",
        world_root / "scripts" / "deploy_content_agents.py",
    ):
        deploy_commands.append((path, [sys.executable, str(path), "--targets", ",".join(targets)]))

    deploy_script, deploy_command = next(((path, command) for path, command in deploy_commands if path.is_file()), (None, []))
    if deploy_script is None:
        return (
            _runtime_entry(
                "blocked",
                "content-agents checkout is present, but no upstream Content Agents deployment script was found; run the upstream deployment skills or provide healthy endpoints",
                root=str(world_root),
            ),
            service_reports,
            steps,
        )
    steps.append(_run(deploy_command, cwd=world_root, env=_content_agents_deploy_env(), timeout=3600))
    service_reports = {service: _probe_service(service, _service_env_url(service), timeout=30) for service in services}
    if steps[-1].status != "blocked" and service_reports.get("ovrtx", {}).get("status") != "ready":
        # The upstream collection helper starts agent services, while the
        # renderer remains owned by the upstream standalone OVRTX deployment.
        # Invoke that upstream Compose entrypoint as the second managed
        # deployment step when the renderer was not already healthy.
        steps.append(_deploy_ovrtx(world_root))
        service_reports = {
            service: _probe_service(
                service,
                _service_env_url(service),
                timeout=300 if service == "ovrtx" else 30,
            )
            for service in services
        }
    status = "ready" if all(report["status"] == "ready" for report in service_reports.values()) else "blocked"
    return _runtime_entry(status, "Content Agents services are healthy" if status == "ready" else "Content Agents deployment did not produce healthy endpoints", root=str(world_root)), service_reports, steps


def _env_payload(manifest_path: Path, manifest: dict[str, Any]) -> dict[str, str]:
    env: dict[str, str] = {
        "PHYSICAL_AI_PREFLIGHT_MANIFEST": str(manifest_path),
        "PHYSICAL_AI_REQUIRE_PREFLIGHT": "1",
        "PHYSICAL_AI_SKILL_HUB_HOME": manifest["paths"]["home"],
        "PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT": manifest["paths"]["upstream_root"],
        "PHYSICAL_AI_SKILL_HUB_STATE": manifest["paths"]["state_root"],
    }
    for name, entry in manifest.get("upstreams", {}).items():
        env_name = UPSTREAMS.get(name, {}).get("env")
        if env_name and entry.get("path"):
            env[str(env_name)] = str(entry["path"])
    simready = manifest.get("runtimes", {}).get("simready_validate", {})
    if simready.get("venv"):
        env["PHYSICAL_AI_SIMREADY_VALIDATE_VENV"] = str(simready["venv"])
    repo_python = manifest.get("runtimes", {}).get("repo_python", {})
    if repo_python.get("venv"):
        path_value = _path_env_with_entries(_venv_bin_dir(Path(str(repo_python["venv"]))))
        if path_value:
            env["PATH"] = path_value
    for key, value in manifest.get("env", {}).items():
        env[key] = str(value)
    return env


def _write_env_file(path: Path, env: dict[str, str]) -> None:
    lines = [
        "# Source this file before running cad-to-simready references.",
    ]
    for key in sorted(env):
        value = env[key].replace("'", "'\"'\"'")
        lines.append(f"export {key}='{value}'")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_powershell_env_file(path: Path, env: dict[str, str]) -> None:
    lines = [
        "# Dot-source this file before running cad-to-simready references.",
    ]
    for key in sorted(env):
        value = env[key].replace("'", "''")
        lines.append(f"$env:{key} = '{value}'")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _dotenv_line_key(raw_line: str) -> str | None:
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    key = line.split("=", 1)[0].strip()
    if key.startswith("export "):
        key = key.removeprefix("export ").strip()
    return key or None


def _read_dotenv_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


def _content_agents_secret_line(name: str, value: str) -> str:
    return f"{name}={value.replace(chr(10), '')}"


def _content_agents_secret_env() -> dict[str, str]:
    available = {
        name: os.environ[name]
        for name in CONTENT_AGENTS_SECRET_ENV_NAMES
        if os.environ.get(name)
    }
    if "NGC_API_KEY" not in available and os.environ.get("NVIDIA_API_KEY"):
        # The upstream local collection uses host.docker.internal for the local
        # renderer, while Material/Physics readiness treats non-local render
        # hostnames as requiring the render usage key. Keep the public managed
        # deployment contract to NVIDIA_API_KEY by mirroring it into the
        # upstream private .env only when the explicit key is absent.
        available["NGC_API_KEY"] = os.environ["NVIDIA_API_KEY"]
    return available


def _ensure_content_agents_secret_env(world_root: Path) -> Step:
    """Mirror known deployment secrets from the process env into upstream .env."""
    env_path = world_root / ".env"
    available = _content_agents_secret_env()
    if not available:
        return Step(
            name="content_agents_secret_env",
            status="skipped",
            message="no known Content Agents credential environment variables were set",
        )
    lines = _read_dotenv_lines(env_path)
    existing_keys: set[str] = set()
    changed = False
    for index, raw_line in enumerate(lines):
        key = _dotenv_line_key(raw_line)
        if not key:
            continue
        existing_keys.add(key)
        if key in available:
            replacement = _content_agents_secret_line(key, available[key])
            if lines[index] != replacement:
                lines[index] = replacement
                changed = True
    appended: list[str] = []
    for name in CONTENT_AGENTS_SECRET_ENV_NAMES:
        if name in available and name not in existing_keys:
            appended.append(_content_agents_secret_line(name, available[name]))
    if appended:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(appended)
        changed = True
    if changed:
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except OSError:
        pass
    action = "updated" if changed else "already contains"
    count = len([name for name in CONTENT_AGENTS_SECRET_ENV_NAMES if name in available])
    return Step(
        name="content_agents_secret_env",
        status="ready",
        message=f"upstream Content Agents .env {action} {count} deployment credential name(s)",
    )


def _write_markdown(path: Path, manifest: dict[str, Any]) -> None:
    lines = [
        "# CAD to SimReady Preflight",
        "",
        f"- Status: `{manifest['status']}`",
        f"- Platform: `{manifest['platform']['system']}`",
        f"- Manifest: `{manifest['manifest_path']}`",
        "",
        "## Runtimes",
        "",
    ]
    for name, entry in sorted(manifest.get("runtimes", {}).items()):
        lines.append(f"- `{name}`: `{entry.get('status')}` - {entry.get('message', '')}")
    lines.extend(["", "## Services", ""])
    for name, entry in sorted(manifest.get("services", {}).items()):
        lines.append(f"- `{name}`: `{entry.get('status')}` - {entry.get('base_url', '')}")
    lines.extend(["", "## Blockers", ""])
    blockers = manifest.get("blockers", [])
    lines.extend(f"- {blocker}" for blocker in blockers)
    if not blockers:
        lines.append("- None")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def build_manifest(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, str]]:
    home = args.home.expanduser().resolve() if args.home else _default_home().resolve()
    state_root = args.state_root.expanduser().resolve() if args.state_root else _default_state_root(home).resolve()
    upstream_root = args.upstream_root.expanduser().resolve() if args.upstream_root else _default_upstream_root(home).resolve()
    venv_root = args.venv_root.expanduser().resolve() if args.venv_root else _default_venv_root(home).resolve()
    manifest_path = args.report.expanduser().resolve() if args.report else state_root / "cad-to-simready-preflight.json"
    project_root = _find_project_root(args.project_root)
    source_asset = args.source_asset.expanduser().resolve() if args.source_asset else None
    output_root = args.output_root.expanduser().resolve() if args.output_root else None
    targets = _selected_targets(args.targets, skip_content_agents=args.skip_content_agents)
    conversion_tools, route_selection = _selected_conversion_tools(args.conversion_tools, source_asset, args.source_format)
    legacy_options_ignored: list[str] = []

    steps: list[Step] = []
    upstreams: dict[str, Any] = {}
    runtimes: dict[str, Any] = {}
    services: dict[str, Any] = {}
    env: dict[str, str] = {}

    request_runtime = _check_request_inputs(source_asset, output_root, check_only=args.check_only)
    runtimes["request"] = request_runtime

    if not args.check_only:
        home.mkdir(parents=True, exist_ok=True)
        state_root.mkdir(parents=True, exist_ok=True)
        upstream_root.mkdir(parents=True, exist_ok=True)
        venv_root.mkdir(parents=True, exist_ok=True)

    repo_runtime, repo_steps = _check_repo_python(project_root, check_only=args.check_only, skip_uv_sync=args.skip_uv_sync)
    runtimes["repo_python"] = repo_runtime
    steps.extend(repo_steps)
    git_lfs_runtime, git_lfs_steps = _check_git_lfs(install_lfs=args.lfs, check_only=args.check_only)
    runtimes["git_lfs"] = git_lfs_runtime
    steps.extend(git_lfs_steps)

    if "conversion" in targets:
        upstreams_by_tool = {
            "usd-convert-cad": "usd_convert_cad",
            "usd-convert-gsplat": "usd_convert_gsplat",
        }
        for tool_name in sorted(conversion_tools & set(upstreams_by_tool)):
            upstream_name = upstreams_by_tool[tool_name]
            upstreams[upstream_name], upstream_steps = _ensure_upstream(upstream_name, upstream_root, check_only=args.check_only, no_update=args.no_update)
            steps.extend(upstream_steps)
        if "usd-convert-cad" in conversion_tools:
            cad_runtime, cad_steps = _check_usd_convert_cad(
                Path(upstreams["usd_convert_cad"]["path"]),
                project_root=project_root,
                check_only=args.check_only,
            )
            runtimes["usd_convert_cad"] = cad_runtime
            steps.extend(cad_steps)
        if "usd-convert-gsplat" in conversion_tools:
            runtimes["usd_convert_gsplat"], gsplat_steps = _check_usd_convert_gsplat(Path(upstreams["usd_convert_gsplat"]["path"]), project_root=project_root)
            steps.extend(gsplat_steps)
        if "repo-python" in conversion_tools:
            runtimes["source_conversion_repo_python"] = _runtime_entry(
                "ready" if repo_runtime.get("status") == "ready" else "blocked",
                "repo Python conversion tools are available" if repo_runtime.get("status") == "ready" else "repo Python conversion tools require repo Python readiness",
                project_root=str(project_root) if project_root else "",
            )

    if "validation" in targets:
        openusd_runtime, openusd_steps = _check_openusd_python(project_root)
        runtimes["openusd_python"] = openusd_runtime
        steps.extend(openusd_steps)
        asset_validator_runtime, asset_validator_steps = _check_asset_validator(project_root)
        runtimes["asset_validator"] = asset_validator_runtime
        steps.extend(asset_validator_steps)
        upstreams["simready_foundation"], simready_upstream_steps = _ensure_upstream("simready_foundation", upstream_root, check_only=args.check_only, no_update=args.no_update)
        steps.extend(simready_upstream_steps)
        simready_runtime, simready_steps = _check_simready(
            Path(upstreams["simready_foundation"]["path"]),
            venv_root,
            project_root=project_root,
            check_only=args.check_only,
        )
        runtimes["simready_validate"] = simready_runtime
        steps.extend(simready_steps)

    if "content-agents" in targets:
        upstreams["content_agents"], world_steps = _ensure_upstream("content_agents", upstream_root, check_only=args.check_only, no_update=args.no_update)
        steps.extend(world_steps)
        content_runtime, services, content_steps = _check_content_agents(
            Path(upstreams["content_agents"]["path"]),
            include_texture=args.include_texture,
            check_only=args.check_only,
            skip_deploy=args.skip_deploy,
        )
        runtimes["content_agents"] = content_runtime
        steps.extend(content_steps)
        if services.get("material", {}).get("status") == "ready":
            env["CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL"] = services["material"]["base_url"]
        if services.get("physics", {}).get("status") == "ready":
            env["CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL"] = services["physics"]["base_url"]
        if services.get("texture", {}).get("status") == "ready":
            env["CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL"] = services["texture"]["base_url"]
        if services.get("ovrtx", {}).get("status") == "ready":
            env["RENDER_ENDPOINT"] = services["ovrtx"]["base_url"]
            env["OVRTX_RENDER_ENDPOINT"] = services["ovrtx"]["base_url"]

    blockers: list[str] = []
    for name, entry in sorted(runtimes.items()):
        if entry.get("status") == "blocked":
            blockers.append(f"{name}: {entry.get('message')}")
    for name, entry in sorted(services.items()):
        if entry.get("status") == "blocked":
            blockers.append(f"{name}: {entry.get('message')}")
    status = "ready" if not blockers else "blocked"
    if args.skip_content_agents and "content-agents" not in targets:
        runtimes["content_agents"] = _runtime_entry("skipped", "Content Agents preflight was explicitly skipped")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "skill": SKILL,
        "status": status,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "preflight_mode": "route-aware-dependency-bootstrap",
        "dependency_policy": "selected-target-dependencies",
        "platform": {
            "system": platform.system().lower(),
            "machine": platform.machine(),
            "python": sys.version.split()[0],
        },
        "targets": list(targets),
        "conversion_tools": sorted(conversion_tools),
        "legacy_options_ignored": legacy_options_ignored,
        "route_selection": route_selection,
        "paths": {
            "home": str(home),
            "state_root": str(state_root),
            "upstream_root": str(upstream_root),
            "venv_root": str(venv_root),
            "project_root": str(project_root) if project_root else "",
            "output_root": str(output_root) if output_root else "",
        },
        "upstreams": upstreams,
        "runtimes": runtimes,
        "services": services,
        "env": env,
        "steps": [step.to_dict() for step in steps],
        "blockers": blockers,
    }
    return manifest, _env_payload(manifest_path, manifest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install cad-to-simready dependencies, deploy/verify services, and write a preflight manifest.")
    parser.add_argument("--targets", default="", help="Comma-separated targets to prepare: conversion, validation, content-agents.")
    parser.add_argument("--home", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--upstream-root", type=Path)
    parser.add_argument("--venv-root", type=Path)
    parser.add_argument("--project-root", type=Path)
    parser.add_argument("--source-asset", type=Path, help="Optional source asset used to infer the conversion route.")
    parser.add_argument("--output-root", type=Path, help="Optional output root to verify or create before downstream stages.")
    parser.add_argument("--source-format", default="", help="Optional source format used to infer the conversion route when no source asset is available.")
    parser.add_argument("--conversion-tools", default="", help="Comma-separated conversion tools to prepare: repo-python, usd-convert-cad, usd-convert-gsplat.")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--powershell-env-file", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--skip-uv-sync", action="store_true")
    parser.add_argument("--skip-content-agents", action="store_true")
    parser.add_argument("--skip-deploy", action="store_true")
    parser.add_argument("--include-texture", action="store_true")
    parser.add_argument("--lfs", action="store_true", help="Run git lfs install and git lfs pull for repo fixtures.")
    parser.add_argument("--no-update", action="store_true", help="Do not update existing upstream checkouts.")
    args = parser.parse_args(argv)

    manifest, env = build_manifest(args)
    manifest_path = Path(manifest["manifest_path"])
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.env_file:
        _write_env_file(args.env_file.expanduser().resolve(), env)
    if args.powershell_env_file:
        _write_powershell_env_file(args.powershell_env_file.expanduser().resolve(), env)
    if args.markdown_report:
        _write_markdown(args.markdown_report.expanduser().resolve(), manifest)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0 if manifest["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
