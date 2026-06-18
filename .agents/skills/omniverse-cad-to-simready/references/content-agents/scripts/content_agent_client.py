#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from email.message import Message
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import check_result as _check, emit_json_report

from content_agent_material_cleanup import cleanup_material_output
from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_service_url


USD_EXTENSIONS = {".usd", ".usda", ".usdc", ".usdz"}
USD_LAYER_EXTENSIONS = {".usd", ".usda", ".usdc"}
TERMINAL_SUCCESS = {"completed", "complete", "succeeded", "success", "done"}
TERMINAL_FAILURE = {"failed", "failure", "cancelled", "canceled", "error"}
MATERIAL_ZERO_IMAGE_MARKERS = (
    "rendering produced 0 images",
    "build_dataset_usd",
)
PHYSICS_OPTIMIZER_FAILURE_MARKERS = (
    "optimize_usd",
    "scene optimizer",
    "local backend unavailable",
    "optimizer_endpoint",
    "nvcf_optimizer_function_id",
)
SCENE_OPTIMIZER_PERMISSION_MARKERS = (
    "permission denied",
    "/app/.build-resources/scene_optimizer_core/python",
)
PHYSICS_SCENE_OPTIMIZER_CONTAINER_CANDIDATES = (
    "content-physics-agent-service",
    "pash-e2e-physics_agent_service",
    "physics_agent_service",
)
MDL_UPLOAD_PREP_SNIPPET = r"""
import json
import shutil
import sys
from pathlib import Path

from pxr import Sdf, Usd

asset_path = Path(sys.argv[1]).resolve()
label = sys.argv[2] if len(sys.argv) > 2 else "content_agents"
info = {
    "staged": False,
    "path": str(asset_path),
    "stripped_mdl_source_assets": 0,
    "cleared_unresolved_service_asset_paths": 0,
    "warning": None,
}

def is_unresolved_service_asset_path(path: str) -> bool:
    lower = path.lower()
    return ".usdz[" in lower and lower.startswith(
        (
            "/var/material-agent/sessions/",
            "/var/physics-agent/sessions/",
            "/var/texture-agent/sessions/",
        )
    )

stage = Usd.Stage.Open(str(asset_path))
if stage is None:
    info["warning"] = f"Could not inspect {label} upload USD for MDL source assets"
    print(json.dumps(info))
    raise SystemExit(0)
mdl_attr_count = 0
service_asset_path_count = 0
for prim in stage.Traverse():
    for attr in prim.GetAttributes():
        try:
            value = attr.Get()
        except Exception:
            continue
        if not isinstance(value, Sdf.AssetPath):
            continue
        path = str(value.path)
        if path.lower().endswith(".mdl"):
            mdl_attr_count += 1
        elif is_unresolved_service_asset_path(path):
            service_asset_path_count += 1
if mdl_attr_count == 0 and service_asset_path_count == 0:
    print(json.dumps(info))
    raise SystemExit(0)
staged_path = asset_path.with_name(f"{asset_path.stem}_{label}_upload{asset_path.suffix.lower()}")
if staged_path.exists():
    staged_path.unlink()
shutil.copy2(asset_path, staged_path)
staged = Usd.Stage.Open(str(staged_path))
if staged is None:
    raise RuntimeError(f"Could not open staged {label} upload USD: {staged_path}")
stripped = 0
cleared_service_paths = 0
for prim in staged.Traverse():
    for attr in prim.GetAttributes():
        try:
            value = attr.Get()
        except Exception:
            continue
        if not isinstance(value, Sdf.AssetPath):
            continue
        path = str(value.path)
        if path.lower().endswith(".mdl"):
            attr.Clear()
            stripped += 1
        elif is_unresolved_service_asset_path(path):
            attr.Clear()
            cleared_service_paths += 1
if (stripped or cleared_service_paths) and not staged.GetRootLayer().Save():
    raise RuntimeError(f"Could not save staged {label} upload USD: {staged_path}")
info.update(
    {
        "staged": True,
        "path": str(staged_path.resolve()),
        "stripped_mdl_source_assets": stripped,
        "cleared_unresolved_service_asset_paths": cleared_service_paths,
        "source_path": str(asset_path),
    }
)
print(json.dumps(info))
"""
USD_TOPOLOGY_INSPECTION_SNIPPET = r"""
import json
import sys
from pathlib import Path

from pxr import Usd, UsdGeom

asset_path = Path(sys.argv[1]).resolve()
result = {
    "inspected": False,
    "reason": None,
    "default_prim_path": None,
    "mesh_count": 0,
    "geom_subset_count": 0,
    "mesh_with_geom_subset_count": 0,
    "instance_count": 0,
    "instance_proxy_count": 0,
    "prototype_count": 0,
    "has_composed_component_topology": False,
    "component_topology_reasons": [],
}
stage = Usd.Stage.Open(str(asset_path))
if stage is None:
    result["reason"] = "Could not open USD stage"
    print(json.dumps(result))
    raise SystemExit(0)
default_prim = stage.GetDefaultPrim()
if not default_prim:
    result["reason"] = "Stage has no default prim"
    print(json.dumps(result))
    raise SystemExit(0)
result["inspected"] = True
result["default_prim_path"] = str(default_prim.GetPath())
try:
    result["prototype_count"] = len(stage.GetPrototypes())
except Exception:
    result["prototype_count"] = 0
mesh_paths_with_subsets = set()
for prim in Usd.PrimRange(default_prim):
    if not prim.IsActive():
        continue
    if prim.IsA(UsdGeom.Mesh):
        result["mesh_count"] += 1
    if prim.IsInstance():
        result["instance_count"] += 1
    if prim.IsInstanceProxy():
        result["instance_proxy_count"] += 1
    is_geom_subset = prim.GetTypeName() == "GeomSubset"
    try:
        is_geom_subset = is_geom_subset or bool(UsdGeom.Subset(prim))
    except Exception:
        pass
    if is_geom_subset:
        result["geom_subset_count"] += 1
        parent = prim.GetParent()
        if parent and parent.IsA(UsdGeom.Mesh):
            mesh_paths_with_subsets.add(str(parent.GetPath()))
result["mesh_with_geom_subset_count"] = len(mesh_paths_with_subsets)
if result["geom_subset_count"]:
    result["component_topology_reasons"].append("geom_subsets")
if result["instance_count"] or result["instance_proxy_count"] or result["prototype_count"]:
    result["component_topology_reasons"].append("instances_or_prototypes")
result["has_composed_component_topology"] = bool(result["component_topology_reasons"])
print(json.dumps(result))
"""

AGENTS: dict[str, dict[str, Any]] = {
    "material-agent-client": {
        "agent_key": "material",
        "agent": "material-agent",
        "default_env": ("CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL", "MATERIAL_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_MATERIAL_AGENT_TOKEN",
            "MATERIAL_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
        "output_endpoint": "output",
        "output_suffix": "_material.usd",
        "output_label": "materialized_usd",
        "optional_artifacts": (
            ("predictions", "predictions", ".jsonl", False),
            ("report", "report", ".html", False),
        ),
        "next_step": "physics-agent-client",
    },
    "physics-agent-client": {
        "agent_key": "physics",
        "agent": "physics-agent",
        "default_env": ("CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL", "PHYSICS_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_PHYSICS_AGENT_TOKEN",
            "PHYSICS_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
        "output_endpoint": "output-usd",
        "output_suffix": "_physics.usd",
        "output_label": "physics_usd",
        "optional_artifacts": (
            ("predictions", "predictions", ".jsonl", False),
            ("dataset", "dataset", ".jsonl", False),
            ("report", "report", ".html", False),
        ),
        "next_step": "simready-conform-profile",
    },
    "texture-agent-client": {
        "agent_key": "texture",
        "agent": "texture-agent",
        "default_env": ("CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL", "TEXTURE_AGENT_BASE_URL"),
        "token_env": (
            "CONTENT_AGENTS_TEXTURE_AGENT_TOKEN",
            "TEXTURE_AGENT_TOKEN",
            "CONTENT_AGENTS_TOKEN",
            "NGC_API_KEY",
            "NVCF_API_KEY",
        ),
        "output_endpoint": "output",
        "output_suffix": "_textured.usdz",
        "output_label": "textured_usdz",
        "optional_artifacts": (
            ("materials", "materials", ".json", False),
            ("textures", "textures", ".zip", False),
            ("renders", "renders", ".zip", False),
        ),
        "next_step": "simready-conform-profile",
    },
}


def _skill_name() -> str:
    return Path(sys.argv[0]).resolve().parents[1].name


def _spec() -> dict[str, Any]:
    skill_name = _skill_name()
    if skill_name not in AGENTS:
        raise RuntimeError(f"Unsupported Content Agents skill directory: {skill_name}")
    return AGENTS[skill_name]


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


def _resolve_base_url(base_url: str | None, spec: dict[str, Any]) -> tuple[str | None, str | None]:
    if base_url:
        return base_url.rstrip("/"), "cli"
    env_base_url = _env_first(spec["default_env"])
    if env_base_url:
        return env_base_url.rstrip("/"), "env_base_url"
    manifest, _, _ = load_preflight_manifest()
    manifest_base_url = ready_service_url(manifest, str(spec["agent_key"]))
    if manifest_base_url:
        return manifest_base_url.rstrip("/"), "preflight_manifest"
    return None, None


def _headers(token: str | None, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = dict(extra or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _http_request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 120,
) -> tuple[int, dict[str, str], bytes]:
    request = Request(url, data=data, headers=_headers(token, headers), method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from exc
    except (TimeoutError, OSError) as exc:
        raise RuntimeError(f"Could not reach {url}: {exc}") from exc


def _json_request(method: str, url: str, *, token: str | None, timeout: int) -> dict[str, Any]:
    _, _, body = _http_request(method, url, token=token, timeout=timeout)
    payload = json.loads(body.decode("utf-8"))
    return payload if isinstance(payload, dict) else {"value": payload}


def _multipart_body(asset_path: Path, fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"----physical-ai-skill-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    chunks.extend(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="usd_file"; filename="{asset_path.name}"\r\n'.encode("utf-8"),
            b"Content-Type: application/octet-stream\r\n\r\n",
            asset_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode("utf-8"),
        ]
    )
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _post_pipeline(asset_path: Path, base_url: str, token: str | None, fields: dict[str, str], timeout: int) -> str:
    body, content_type = _multipart_body(asset_path, fields)
    _, _, response_body = _http_request(
        "POST",
        urljoin(f"{base_url.rstrip('/')}/", "pipeline"),
        token=token,
        data=body,
        headers={"Content-Type": content_type},
        timeout=timeout,
    )
    payload = json.loads(response_body.decode("utf-8"))
    session_id = payload.get("session_id")
    if not session_id:
        raise RuntimeError("Content Agents service did not return session_id")
    return str(session_id)


def _layer_identifier(layer: Any) -> str:
    return str(getattr(layer, "realPath", None) or getattr(layer, "identifier", "") or "")


def _prepare_upload_asset(asset_path: Path, output_directory: Path) -> tuple[Path, dict[str, Any]]:
    upload_info: dict[str, Any] = {
        "asset_path": str(asset_path),
        "dependency_layers": [],
        "dependency_assets": [],
        "dependency_count": 0,
        "inspection_error": None,
        "packaging": "none",
        "package_size_bytes": None,
        "path": str(asset_path),
        "unresolved_paths": [],
    }
    if asset_path.suffix.lower() == ".usdz":
        upload_info["packaging"] = "already_usdz"
        return asset_path, upload_info

    try:
        from pxr import UsdUtils
    except Exception as exc:
        upload_info["inspection_error"] = f"OpenUSD dependency inspection is unavailable: {exc}"
        return asset_path, upload_info

    try:
        layers, assets, unresolved_paths = UsdUtils.ComputeAllDependencies(str(asset_path))
    except Exception as exc:
        upload_info["inspection_error"] = f"Could not inspect USD dependencies: {exc}"
        return asset_path, upload_info

    root_path = asset_path.resolve()
    dependency_layers: list[str] = []
    for layer in layers:
        identifier = _layer_identifier(layer)
        if not identifier:
            continue
        try:
            if Path(identifier).resolve() == root_path:
                continue
        except OSError:
            pass
        dependency_layers.append(identifier)

    dependency_assets = [str(asset) for asset in assets]
    unresolved = [str(path) for path in unresolved_paths]
    upload_info["dependency_layers"] = dependency_layers
    upload_info["dependency_assets"] = dependency_assets
    upload_info["unresolved_paths"] = unresolved
    upload_info["dependency_count"] = len(dependency_layers) + len(dependency_assets)

    if unresolved:
        raise RuntimeError("Cannot package USD for Content Agents upload; unresolved dependencies: " + ", ".join(unresolved))
    if upload_info["dependency_count"] == 0:
        return asset_path, upload_info

    output_directory.mkdir(parents=True, exist_ok=True)
    package_path = output_directory / f"{asset_path.stem}_content_agents_upload.usdz"
    if package_path.exists():
        package_path.unlink()
    ok = UsdUtils.CreateNewUsdzPackage(str(asset_path), str(package_path))
    if not ok or not package_path.exists() or package_path.stat().st_size == 0:
        raise RuntimeError(f"OpenUSD failed to package USD dependencies for Content Agents upload: {package_path}")

    upload_info["packaging"] = "usdz"
    upload_info["path"] = str(package_path.resolve())
    upload_info["package_size_bytes"] = package_path.stat().st_size
    return package_path, upload_info


def _is_unresolved_service_asset_path(path: str) -> bool:
    lower = path.lower()
    return ".usdz[" in lower and lower.startswith(
        (
            "/var/material-agent/sessions/",
            "/var/physics-agent/sessions/",
            "/var/texture-agent/sessions/",
        )
    )


def _stage_mdl_safe_upload_asset(asset_path: Path, label: str) -> tuple[Path, dict[str, Any]]:
    info: dict[str, Any] = {
        "staged": False,
        "path": str(asset_path),
        "stripped_mdl_source_assets": 0,
        "cleared_unresolved_service_asset_paths": 0,
        "warning": None,
    }
    if asset_path.suffix.lower() not in USD_LAYER_EXTENSIONS:
        return asset_path, info

    try:
        from pxr import Sdf, Usd
    except Exception as exc:
        staged_path, external_info = _stage_mdl_safe_upload_asset_external(asset_path, label)
        if external_info.get("staged") or not external_info.get("warning"):
            return staged_path, external_info
        info["warning"] = (
            f"OpenUSD Python APIs are unavailable for {label} upload prep: {exc}. "
            + str(external_info.get("warning") or "No alternate OpenUSD Python runtime staged the upload.")
        )
        return asset_path, info

    try:
        stage = Usd.Stage.Open(str(asset_path))
    except Exception as exc:
        info["warning"] = f"Could not inspect {label} upload USD for MDL source assets: {exc}"
        return asset_path, info
    if stage is None:
        info["warning"] = f"Could not inspect {label} upload USD for MDL source assets"
        return asset_path, info

    mdl_attrs: list[str] = []
    service_asset_attrs: list[str] = []
    for prim in stage.Traverse():
        for attr in prim.GetAttributes():
            try:
                value = attr.Get()
            except Exception:
                continue
            if not isinstance(value, Sdf.AssetPath):
                continue
            path = str(value.path)
            if path.lower().endswith(".mdl"):
                mdl_attrs.append(str(attr.GetPath()))
            elif _is_unresolved_service_asset_path(path):
                service_asset_attrs.append(str(attr.GetPath()))
    if not mdl_attrs and not service_asset_attrs:
        return asset_path, info

    staged_path = asset_path.with_name(f"{asset_path.stem}_{label}_upload{asset_path.suffix.lower()}")
    try:
        if staged_path.exists():
            staged_path.unlink()
        shutil.copy2(asset_path, staged_path)
        staged = Usd.Stage.Open(str(staged_path))
        if staged is None:
            raise RuntimeError(f"Could not open staged {label} upload USD: {staged_path}")
        stripped = 0
        cleared_service_paths = 0
        for prim in staged.Traverse():
            for attr in prim.GetAttributes():
                try:
                    value = attr.Get()
                except Exception:
                    continue
                if not isinstance(value, Sdf.AssetPath):
                    continue
                path = str(value.path)
                if path.lower().endswith(".mdl"):
                    attr.Clear()
                    stripped += 1
                elif _is_unresolved_service_asset_path(path):
                    attr.Clear()
                    cleared_service_paths += 1
        if (stripped or cleared_service_paths) and not staged.GetRootLayer().Save():
            raise RuntimeError(f"Could not save staged {label} upload USD: {staged_path}")
    except Exception as exc:
        staged_path.unlink(missing_ok=True)
        info["warning"] = f"Could not stage {label} upload USD without MDL source assets: {exc}"
        return asset_path, info

    info.update(
        {
            "staged": True,
            "path": str(staged_path.resolve()),
            "stripped_mdl_source_assets": stripped,
            "cleared_unresolved_service_asset_paths": cleared_service_paths,
            "source_path": str(asset_path),
        }
    )
    return staged_path, info


def _stage_mdl_safe_upload_asset_external(asset_path: Path, label: str) -> tuple[Path, dict[str, Any]]:
    uv = shutil.which("uv")
    info: dict[str, Any] = {
        "staged": False,
        "path": str(asset_path),
        "stripped_mdl_source_assets": 0,
        "warning": None,
    }
    if not uv:
        info["warning"] = "uv was not found on PATH for alternate OpenUSD Python upload prep"
        return asset_path, info
    command = [uv, "run", "--python", "3.12", "python", "-c", MDL_UPLOAD_PREP_SNIPPET, str(asset_path), label]
    try:
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    except Exception as exc:
        info["warning"] = f"Alternate OpenUSD Python upload prep failed to launch: {exc}"
        return asset_path, info
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        info["warning"] = f"Alternate OpenUSD Python upload prep failed: {detail[:500]}"
        return asset_path, info
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        info["warning"] = f"Alternate OpenUSD Python upload prep returned invalid JSON: {exc}"
        return asset_path, info
    if not isinstance(payload, dict):
        info["warning"] = "Alternate OpenUSD Python upload prep returned a non-object payload"
        return asset_path, info
    if payload.get("staged") and payload.get("path"):
        return Path(str(payload["path"])), payload
    return asset_path, payload


def _stage_physics_upload_asset(asset_path: Path) -> tuple[Path, dict[str, Any]]:
    return _stage_mdl_safe_upload_asset(asset_path, "physics")


def _stage_material_upload_asset(asset_path: Path) -> tuple[Path, dict[str, Any]]:
    return _stage_mdl_safe_upload_asset(asset_path, "material")


def _inspect_usd_topology_external(asset_path: Path) -> dict[str, Any]:
    uv = shutil.which("uv")
    if not uv:
        return {"inspected": False, "reason": "uv was not found on PATH for alternate OpenUSD Python inspection"}
    command = [uv, "run", "--python", "3.12", "python", "-c", USD_TOPOLOGY_INSPECTION_SNIPPET, str(asset_path)]
    try:
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    except Exception as exc:
        return {"inspected": False, "reason": f"Alternate OpenUSD Python inspection failed to launch: {exc}"}
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        return {"inspected": False, "reason": f"Alternate OpenUSD Python inspection failed: {detail[:500]}"}
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return {"inspected": False, "reason": f"Alternate OpenUSD Python inspection returned invalid JSON: {exc}"}
    return payload if isinstance(payload, dict) else {"inspected": False, "reason": "Alternate OpenUSD Python inspection returned a non-object payload"}


def _wait_for_status(
    base_url: str,
    token: str | None,
    session_id: str,
    *,
    timeout: int,
    poll_interval: float,
    request_timeout: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_status: dict[str, Any] = {}
    transient_errors: list[str] = []
    status_url = urljoin(f"{base_url.rstrip('/')}/", f"pipeline/{session_id}/status")
    while True:
        try:
            last_status = _json_request("GET", status_url, token=token, timeout=request_timeout)
        except Exception as exc:
            if not _is_transient_status_poll_error(exc):
                raise
            transient_errors.append(str(exc))
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Timed out waiting for Content Agents session {session_id}; "
                    f"last transient status poll error: {exc}"
                ) from exc
            time.sleep(max(0.0, poll_interval))
            continue
        state = str(last_status.get("status", "")).lower()
        if state in TERMINAL_SUCCESS or state in TERMINAL_FAILURE:
            if transient_errors:
                last_status["poll_warnings"] = transient_errors[-10:]
            return last_status
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out waiting for Content Agents session {session_id}")
        time.sleep(max(0.0, poll_interval))


def _is_transient_status_poll_error(exc: Exception) -> bool:
    message = str(exc).lower()
    if message.startswith("could not reach "):
        return True
    if message.startswith("http 5") or message.startswith("http 408") or message.startswith("http 429"):
        return True
    return any(
        marker in message
        for marker in (
            "timed out",
            "timeout",
            "temporarily unavailable",
            "connection reset",
            "connection aborted",
            "remote end closed connection",
            "ssl",
        )
    )


def _is_transient_artifact_error(exc: Exception) -> bool:
    message = str(exc).lower()
    if message.startswith("http 404") and ("not available" in message or "not found" in message):
        return True
    if message.startswith("http 5") or message.startswith("http 408") or message.startswith("http 429"):
        return True
    return any(
        marker in message
        for marker in (
            "timed out",
            "timeout",
            "temporarily unavailable",
            "connection reset",
            "connection aborted",
            "remote end closed connection",
            "ssl",
        )
    )


def _filename_from_content_disposition(value: str | None) -> str | None:
    if not value:
        return None
    message = Message()
    message["content-disposition"] = value
    filename = message.get_filename()
    return Path(filename).name if filename else None


def _download_artifact(
    base_url: str,
    token: str | None,
    session_id: str,
    artifact_name: str,
    endpoint: str,
    output_path: Path,
    required: bool,
    timeout: int,
    *,
    allow_response_usd_suffix: bool = False,
    wait_timeout: float = 0.0,
    poll_interval: float = 2.0,
) -> dict[str, Any]:
    url = urljoin(f"{base_url.rstrip('/')}/", f"artifacts/{session_id}/{endpoint}")
    deadline = time.monotonic() + max(0.0, wait_timeout)
    attempts = 0
    while True:
        attempts += 1
        try:
            _, headers, body = _http_request("GET", url, token=token, timeout=timeout)
            filename = _filename_from_content_disposition(
                headers.get("Content-Disposition") or headers.get("content-disposition")
            )
            if allow_response_usd_suffix and filename:
                suffix = Path(filename).suffix.lower()
                if suffix in USD_EXTENSIONS:
                    output_path = output_path.with_suffix(suffix)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(body)
            return {
                "name": artifact_name,
                "url": url,
                "path": str(output_path),
                "required": required,
                "downloaded": True,
                "content_type": headers.get("Content-Type") or headers.get("content-type"),
                "error": None,
                "attempts": attempts,
                "retry_count": attempts - 1,
            }
        except Exception as exc:
            should_retry = (
                required
                and wait_timeout > 0
                and time.monotonic() < deadline
                and _is_transient_artifact_error(exc)
            )
            if should_retry:
                time.sleep(max(0.25, poll_interval))
                continue
            return {
                "name": artifact_name,
                "url": url,
                "path": str(output_path),
                "required": required,
                "downloaded": False,
                "content_type": None,
                "error": str(exc),
                "attempts": attempts,
                "retry_count": attempts - 1,
            }


def _required_output_path(agent_key: str, spec: dict[str, Any], asset_path: Path, output_directory: Path) -> Path:
    if agent_key == "physics" and asset_path.suffix.lower() in USD_EXTENSIONS:
        return output_directory / f"{asset_path.stem}_physics{asset_path.suffix.lower()}"
    return output_directory / f"{asset_path.stem}{spec['output_suffix']}"


def _service_fields(args: argparse.Namespace, agent_key: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    if agent_key == "material":
        email = args.email or os.getenv("USER_EMAIL")
        if email:
            fields["user_email"] = email
        if args.prompt:
            fields["user_prompt"] = args.prompt
        fields["optimize_usd"] = "true" if args.optimize_usd else "false"
        if not args.optimize_usd:
            fields["skip_instances"] = "true" if args.skip_instances else "false"
        elif args.skip_instances:
            fields["skip_instances"] = "true"
        if args.skip_prototypes:
            fields["skip_prototypes"] = "true"
        if args.skip_existing_materials:
            fields["skip_existing_materials"] = "true"
        if args.layer_only:
            fields["layer_only"] = "true"
    elif agent_key == "physics":
        if args.prompt:
            fields["user_prompt"] = args.prompt
        if args.render_backend:
            fields["render_backend"] = args.render_backend
        fields["optimize_usd"] = "true" if args.optimize_usd else "false"
        fields["enable_deinstance"] = "true" if args.enable_deinstance else "false"
        fields["enable_split"] = "true" if args.enable_split else "false"
    elif agent_key == "texture":
        if args.prompt:
            fields["user_prompt"] = args.prompt
        if args.material_textures:
            fields["material_textures_json"] = args.material_textures
    return fields


def _inspect_usd_topology(asset_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "inspected": False,
        "reason": None,
        "default_prim_path": None,
        "mesh_count": 0,
        "geom_subset_count": 0,
        "mesh_with_geom_subset_count": 0,
        "instance_count": 0,
        "instance_proxy_count": 0,
        "prototype_count": 0,
        "has_composed_component_topology": False,
        "component_topology_reasons": [],
    }
    try:
        from pxr import Usd, UsdGeom
    except Exception as exc:
        external = _inspect_usd_topology_external(asset_path)
        if external.get("inspected"):
            external["inspection_runtime"] = "uv-python-3.12"
            return external
        result["reason"] = (
            f"OpenUSD Python APIs are unavailable: {exc}. "
            + str(external.get("reason") or "No alternate OpenUSD Python runtime inspected the stage.")
        )
        return result

    try:
        stage = Usd.Stage.Open(str(asset_path))
    except Exception as exc:
        result["reason"] = f"Could not open USD stage: {exc}"
        return result
    if stage is None:
        result["reason"] = "Could not open USD stage"
        return result

    default_prim = stage.GetDefaultPrim()
    if not default_prim:
        result["reason"] = "Stage has no default prim"
        return result

    result["inspected"] = True
    result["default_prim_path"] = str(default_prim.GetPath())
    try:
        result["prototype_count"] = len(stage.GetPrototypes())
    except Exception:
        result["prototype_count"] = 0

    mesh_paths_with_subsets: set[str] = set()
    for prim in Usd.PrimRange(default_prim):
        if not prim.IsActive():
            continue
        if prim.IsA(UsdGeom.Mesh):
            result["mesh_count"] += 1
        if prim.IsInstance():
            result["instance_count"] += 1
        if prim.IsInstanceProxy():
            result["instance_proxy_count"] += 1

        is_geom_subset = prim.GetTypeName() == "GeomSubset"
        try:
            is_geom_subset = is_geom_subset or bool(UsdGeom.Subset(prim))
        except Exception:
            pass
        if is_geom_subset:
            result["geom_subset_count"] += 1
            parent = prim.GetParent()
            if parent and parent.IsA(UsdGeom.Mesh):
                mesh_paths_with_subsets.add(str(parent.GetPath()))

    result["mesh_with_geom_subset_count"] = len(mesh_paths_with_subsets)
    if result["geom_subset_count"]:
        result["component_topology_reasons"].append("geom_subsets")
    if result["instance_count"] or result["instance_proxy_count"] or result["prototype_count"]:
        result["component_topology_reasons"].append("instances_or_prototypes")
    result["has_composed_component_topology"] = bool(result["component_topology_reasons"])
    return result


def _apply_physics_auto_optimizer(args: argparse.Namespace, topology: dict[str, Any]) -> dict[str, Any]:
    auto_enabled = bool(args.auto_optimize_composed_usd and topology.get("has_composed_component_topology"))
    if auto_enabled:
        args.optimize_usd = True
        args.enable_deinstance = True
        args.enable_split = True
    return {
        "auto_optimize_composed_usd": bool(args.auto_optimize_composed_usd),
        "auto_enabled": auto_enabled,
        "auto_reasons": list(topology.get("component_topology_reasons") or []),
        "optimize_usd": bool(args.optimize_usd),
        "enable_deinstance": bool(args.enable_deinstance),
        "enable_split": bool(args.enable_split),
    }


def _apply_material_auto_optimizer(args: argparse.Namespace, topology: dict[str, Any]) -> dict[str, Any]:
    requested_optimize_usd = args.optimize_usd
    optimize_usd = True if requested_optimize_usd is None else bool(requested_optimize_usd)
    auto_reasons: list[str] = []
    instance_only_geometry = bool(
        topology.get("inspected")
        and topology.get("mesh_count") == 0
        and (
            topology.get("instance_count")
            or topology.get("instance_proxy_count")
            or topology.get("prototype_count")
        )
    )
    auto_disabled_optimizer = bool(
        requested_optimize_usd is None
        and instance_only_geometry
        and not args.skip_instances
    )
    if auto_disabled_optimizer:
        optimize_usd = False
        auto_reasons.append("instance_only_geometry")
    args.optimize_usd = optimize_usd
    return {
        "requested_optimize_usd": requested_optimize_usd,
        "default_optimize_usd": requested_optimize_usd is None,
        "auto_disabled_optimizer": auto_disabled_optimizer,
        "auto_reasons": auto_reasons,
        "optimize_usd": bool(args.optimize_usd),
        "skip_instances": bool(args.skip_instances),
        "skip_prototypes": bool(args.skip_prototypes),
        "skip_existing_materials": bool(args.skip_existing_materials),
    }


def _is_crate_usd(path: Path) -> bool:
    try:
        return path.read_bytes()[:8] == b"PXR-USDC"
    except OSError:
        return False


def _convert_physics_output_to_usd(source_path: Path, output_path: Path) -> tuple[bool, str, Path]:
    if _is_crate_usd(source_path) and source_path.suffix.lower() == ".usd":
        return True, f"Physics output is already crate-backed USD: {source_path}", source_path
    try:
        from pxr import Usd
    except Exception as exc:
        return False, f"OpenUSD Python APIs are unavailable: {exc}", output_path
    stage = Usd.Stage.Open(str(source_path))
    if stage is None:
        return False, f"Could not open physics output stage for crate conversion: {source_path}", output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not stage.GetRootLayer().Export(str(output_path)):
        return False, f"OpenUSD failed to export crate USD: {output_path}", output_path
    if not output_path.exists() or output_path.stat().st_size == 0:
        return False, f"OpenUSD export did not produce a non-empty file: {output_path}", output_path
    return True, f"Converted physics output to {output_path}", output_path


def _walk_text(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, dict):
        text: list[str] = []
        for key, item in value.items():
            text.append(str(key))
            text.extend(_walk_text(item))
        return text
    if isinstance(value, list | tuple | set):
        text = []
        for item in value:
            text.extend(_walk_text(item))
        return text
    return [str(value)]


def _report_text(report: dict[str, Any]) -> str:
    fields = [
        report.get("errors"),
        report.get("warnings"),
        report.get("checks"),
        report.get("service_status"),
        report.get("service_results"),
        report.get("usd_topology"),
        report.get("material_optimizer"),
    ]
    return "\n".join(part for field in fields for part in _walk_text(field)).lower()


def _is_material_zero_image_failure(report: dict[str, Any]) -> bool:
    text = _report_text(report)
    return MATERIAL_ZERO_IMAGE_MARKERS[0] in text or (MATERIAL_ZERO_IMAGE_MARKERS[1] in text and "0 images" in text)


def _attempt_summary(report: dict[str, Any], label: str) -> dict[str, Any]:
    return {
        "label": label,
        "passed": bool(report.get("passed")),
        "status": report.get("status"),
        "session_id": report.get("session_id"),
        "output_usd_path": report.get("output_usd_path"),
        "upload_asset_path": report.get("upload_asset_path"),
        "upload_packaging": report.get("upload_packaging"),
        "material_upload_info": report.get("material_upload_info"),
        "material_output_cleanup": report.get("material_output_cleanup"),
        "material_optimizer": report.get("material_optimizer"),
        "physics_upload_info": report.get("physics_upload_info"),
        "physics_optimizer": report.get("physics_optimizer"),
        "service_status": report.get("service_status"),
        "service_results": report.get("service_results"),
        "errors": list(report.get("errors") or []),
        "warnings": list(report.get("warnings") or []),
    }


def _maybe_retry_material_without_optimizer(report: dict[str, Any], args: argparse.Namespace) -> dict[str, Any] | None:
    if report.get("skill") != "material-agent-client":
        return None
    if getattr(args, "_material_zero_image_retry_attempt", False):
        return None
    if args.optimize_usd is not True:
        return None
    if not _is_material_zero_image_failure(report):
        return None

    retry_args = argparse.Namespace(**vars(args))
    retry_args.optimize_usd = False
    retry_args.skip_instances = False
    retry_args._material_zero_image_retry_attempt = True
    retry_report = run(retry_args)
    existing_attempts = retry_report.get("attempts") if isinstance(retry_report.get("attempts"), list) else []
    retry_report["attempts"] = [
        _attempt_summary(report, "initial_optimize_usd_true"),
        *existing_attempts,
        _attempt_summary(retry_report, "retry_optimize_usd_false"),
    ]
    retry_report.setdefault("warnings", []).append(
        "Retried Material Agent with optimize_usd=false and skip_instances=false after a zero-render optimized path failure."
    )
    if not retry_report.get("passed"):
        retry_report.setdefault("errors", []).append(
            "Material Agent zero-render retry with optimize_usd=false did not recover the run."
        )
    return retry_report


def _is_physics_optimizer_failure(report: dict[str, Any]) -> bool:
    service_status = report.get("service_status")
    if isinstance(service_status, dict):
        current_step = service_status.get("current_step")
        if isinstance(current_step, dict):
            step_text = "\n".join(_walk_text(current_step)).lower()
            if "optimize_usd" in step_text:
                return True
        completed_steps = service_status.get("completed_steps")
        if isinstance(completed_steps, list) and not completed_steps and str(service_status.get("status", "")).lower() in TERMINAL_FAILURE:
            text = _report_text(report)
            if "content agents session status: failed" in text and "optimize_usd" in text:
                return True
    text = _report_text(report)
    return "optimize_usd" in text and any(marker in text for marker in PHYSICS_OPTIMIZER_FAILURE_MARKERS[1:])


def _is_scene_optimizer_permission_failure(report: dict[str, Any]) -> bool:
    text = _report_text(report)
    return _is_physics_optimizer_failure(report) and all(marker in text for marker in SCENE_OPTIMIZER_PERMISSION_MARKERS)


def _should_attempt_physics_scene_optimizer_repair(report: dict[str, Any]) -> bool:
    if _is_scene_optimizer_permission_failure(report):
        return True
    topology = report.get("usd_topology")
    return bool(
        _is_physics_optimizer_failure(report)
        and isinstance(topology, dict)
        and topology.get("has_composed_component_topology")
    )


def _physics_scene_optimizer_container_candidates() -> list[str]:
    candidates: list[str] = []
    for name in ("CONTENT_AGENTS_PHYSICS_AGENT_CONTAINER", "PHYSICS_AGENT_CONTAINER"):
        value = os.getenv(name)
        if value:
            candidates.append(value)
    candidates.extend(PHYSICS_SCENE_OPTIMIZER_CONTAINER_CANDIDATES)
    return list(dict.fromkeys(candidates))


def _repair_physics_scene_optimizer_permissions() -> dict[str, Any]:
    docker = shutil.which("docker")
    result: dict[str, Any] = {
        "attempted": bool(docker),
        "repaired": False,
        "container": None,
        "command": None,
        "errors": [],
    }
    if not docker:
        result["errors"].append("docker was not found on PATH")
        return result

    for container in _physics_scene_optimizer_container_candidates():
        command = [
            docker,
            "exec",
            "--user",
            "root",
            container,
            "chmod",
            "-R",
            "a+rX",
            "/app/.build-resources/scene_optimizer_core",
        ]
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        if completed.returncode == 0:
            result.update(
                {
                    "attempted": True,
                    "repaired": True,
                    "container": container,
                    "command": ["docker", *command[1:]],
                }
            )
            return result
        detail = (completed.stderr or completed.stdout or "").strip()
        result["errors"].append(f"{container}: exit {completed.returncode}: {detail[:300]}")
    return result


def _maybe_repair_and_retry_physics_scene_optimizer(report: dict[str, Any], args: argparse.Namespace) -> dict[str, Any] | None:
    if report.get("skill") != "physics-agent-client":
        return None
    if getattr(args, "_physics_so_permission_repair_attempt", False):
        return None
    if args.optimize_usd is not True:
        return None
    if not _should_attempt_physics_scene_optimizer_repair(report):
        return None

    repair = _repair_physics_scene_optimizer_permissions()
    report["physics_scene_optimizer_permission_repair"] = repair
    if not repair.get("repaired"):
        report.setdefault("warnings", []).append(
            "Could not repair local Physics Agent Scene Optimizer permissions; keeping the optimized failure as the primary result."
        )
        return None

    retry_args = argparse.Namespace(**vars(args))
    retry_args._physics_so_permission_repair_attempt = True
    retry_report = run(retry_args)
    existing_attempts = retry_report.get("attempts") if isinstance(retry_report.get("attempts"), list) else []
    retry_report["attempts"] = [
        _attempt_summary(report, "initial_physics_optimize_usd_true"),
        *existing_attempts,
        _attempt_summary(retry_report, "retry_physics_optimize_usd_true_after_so_permission_repair"),
    ]
    retry_report["physics_scene_optimizer_permission_repair"] = repair
    retry_report.setdefault("warnings", []).append(
        "Repaired local Physics Agent Scene Optimizer permissions and retried with optimize_usd still enabled."
    )
    if not retry_report.get("passed"):
        retry_report.setdefault("errors", []).append(
            "Physics Agent retry after Scene Optimizer permission repair did not recover the run."
        )
    return retry_report


def _maybe_retry_physics_without_optimizer(report: dict[str, Any], args: argparse.Namespace) -> dict[str, Any] | None:
    if report.get("skill") != "physics-agent-client":
        return None
    if getattr(args, "_physics_optimizer_retry_attempt", False):
        return None
    if args.optimize_usd is not True:
        return None
    if not _is_physics_optimizer_failure(report):
        return None
    topology = report.get("usd_topology")
    if isinstance(topology, dict) and topology.get("has_composed_component_topology"):
        report.setdefault("warnings", []).append(
            "Skipped optimize_usd=false Physics Agent retry because composed USD topology still needs optimizer deinstance/split before apply_physics."
        )
        return None

    retry_args = argparse.Namespace(**vars(args))
    retry_args.optimize_usd = False
    retry_args.enable_deinstance = False
    retry_args.enable_split = False
    retry_args.auto_optimize_composed_usd = False
    retry_args._physics_optimizer_retry_attempt = True
    retry_report = run(retry_args)
    existing_attempts = retry_report.get("attempts") if isinstance(retry_report.get("attempts"), list) else []
    retry_report["attempts"] = [
        _attempt_summary(report, "initial_physics_optimize_usd_true"),
        *existing_attempts,
        _attempt_summary(retry_report, "retry_physics_optimize_usd_false"),
    ]
    retry_report.setdefault("warnings", []).append(
        "Retried Physics Agent with optimize_usd=false, enable_deinstance=false, and enable_split=false after the optimized path failed."
    )
    if not retry_report.get("passed"):
        retry_report.setdefault("errors", []).append(
            "Physics Agent retry with optimize_usd=false did not recover the run."
        )
    return retry_report


def _report_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# {report['skill']} Report",
        "",
        f"- Asset: `{report['asset_path']}`",
        f"- Agent: `{report['agent']}`",
        f"- Passed: `{report['passed']}`",
        f"- Status: `{report['status']}`",
        f"- Session: `{report.get('session_id')}`",
        f"- Output USD: `{report.get('output_usd_path')}`",
        f"- Next step: `{report['next_step']}`",
        "",
        "## Checks",
        "",
    ]
    for check in report["checks"]:
        state = "PASS" if check["passed"] else "FAIL"
        lines.append(f"- `{state}` `{check['name']}`: {check['message']}")
    lines.extend(["", "## Artifacts", ""])
    for artifact in report.get("artifacts", []):
        state = "downloaded" if artifact["downloaded"] else "missing"
        lines.append(f"- `{artifact['name']}`: {state} `{artifact.get('path')}`")
    if not report.get("artifacts"):
        lines.append("- None")
    if report.get("errors"):
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in report["errors"])
    if report.get("warnings"):
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
    cleanup = report.get("material_output_cleanup")
    if isinstance(cleanup, dict):
        lines.extend(["", "## Material Output Cleanup", ""])
        if cleanup.get("skipped_reason"):
            lines.append(f"- Skipped: {cleanup['skipped_reason']}")
        elif cleanup.get("warning"):
            lines.append(f"- Warning: {cleanup['warning']}")
        else:
            lines.append(f"- Removed stale material count: `{cleanup.get('removed_material_count', 0)}`")
            lines.append(f"- Repaired bound shader count: `{cleanup.get('repaired_bound_shader_count', 0)}`")
            for material in cleanup.get("removed_materials") or []:
                lines.append(f"- Removed `{material}`")
    lines.append("")
    return "\n".join(lines)


def _emit_report(report: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(report, report_path, markdown_report_path, _report_markdown(report))


def _base_report(
    args: argparse.Namespace,
    spec: dict[str, Any],
    base_url: str | None,
    command: list[str],
    output_usd_path: Path,
) -> dict[str, Any]:
    return {
        "asset_path": str(args.asset_path.resolve()),
        "skill": _skill_name(),
        "agent": spec["agent"],
        "tool": "NVIDIA Omniverse Content Agents service API",
        "passed": False,
        "status": "FAIL",
        "operation": "service_pipeline",
        "base_url": base_url,
        "session_id": None,
        "output_directory": str(args.output_directory.resolve()),
        "output_usd_path": str(output_usd_path),
        "upload_asset_path": None,
        "upload_dependency_count": 0,
        "upload_info": None,
        "material_upload_info": None,
        "material_output_cleanup": None,
        "physics_upload_info": None,
        "upload_packaging": None,
        "command": command,
        "prompt": args.prompt,
        "checks": [],
        "artifacts": [],
        "service_status": None,
        "service_results": None,
        "usd_topology": None,
        "material_optimizer": None,
        "physics_optimizer": None,
        "attempts": [],
        "warnings": [],
        "errors": [],
        "next_step": spec["next_step"],
    }


def _command(
    args: argparse.Namespace,
    *,
    agent_key: str,
    asset_path: Path,
    output_directory: Path,
    base_url: str | None,
    token: str | None,
) -> list[str]:
    command = ["python3", str(Path(__file__).resolve()), str(asset_path), str(output_directory), "--base-url", base_url or "<missing>"]
    if token:
        command.extend(["--token", "<redacted>"])
    if args.prompt:
        command.extend(["--prompt", args.prompt])
    if agent_key == "material":
        if args.optimize_usd:
            command.append("--optimize-usd")
        else:
            command.append("--no-optimize-usd")
        if args.skip_instances:
            command.append("--skip-instances")
        if args.skip_prototypes:
            command.append("--skip-prototypes")
        if args.skip_existing_materials:
            command.append("--skip-existing-materials")
        if args.layer_only:
            command.append("--layer-only")
        if not args.material_output_cleanup:
            command.append("--no-material-output-cleanup")
    elif agent_key == "physics":
        if args.render_backend:
            command.extend(["--render-backend", args.render_backend])
        if args.optimize_usd:
            command.append("--optimize-usd")
        if args.enable_deinstance:
            command.append("--enable-deinstance")
        else:
            command.append("--disable-deinstance")
        if args.enable_split:
            command.append("--enable-split")
        if args.convert_output_to_usd:
            command.append("--convert-output-to-usd")
        if not args.auto_optimize_composed_usd:
            command.append("--no-auto-optimize-composed-usd")
    elif agent_key == "texture" and args.material_textures:
        command.extend(["--material-textures", args.material_textures])
    return command


def run(args: argparse.Namespace) -> dict[str, Any]:
    spec = _spec()
    agent_key = spec["agent_key"]
    asset_path = args.asset_path.resolve()
    output_directory = args.output_directory.resolve()
    base_url, base_url_source = _resolve_base_url(args.base_url, spec)
    token = args.token or _env_or_file_first(spec["token_env"])
    output_usd_path = _required_output_path(agent_key, spec, asset_path, output_directory)
    report = _base_report(args, spec, base_url, [], output_usd_path)
    checks = report["checks"]

    if preflight_required() and args.base_url is None:
        preflight_check = preflight_status_check(_skill_name(), agent_key)
        checks.append(preflight_check)
        if not preflight_check["passed"]:
            report["status"] = "BLOCKED"
            report["errors"] = [preflight_check["message"]]
            return report

    checks.append(_check("asset_exists", asset_path.exists(), "Asset path exists" if asset_path.exists() else "Asset path does not exist"))
    if not asset_path.exists():
        report["errors"] = [check["message"] for check in checks if not check["passed"]]
        return report

    supported = asset_path.suffix.lower() in USD_EXTENSIONS
    checks.append(
        _check(
            "supported_usd_extension",
            supported,
            "Asset uses a supported USD extension" if supported else "Asset must be .usd, .usda, .usdc, or .usdz",
        )
    )
    if not supported:
        report["errors"] = [check["message"] for check in checks if not check["passed"]]
        return report

    if agent_key == "material":
        topology = _inspect_usd_topology(asset_path)
        report["usd_topology"] = topology
        optimizer = _apply_material_auto_optimizer(args, topology)
        report["material_optimizer"] = optimizer
        if optimizer["auto_disabled_optimizer"]:
            checks.append(
                _check(
                    "material_instance_traversal_enabled",
                    True,
                    "Disabled Material Agent optimize_usd and kept skip_instances=false for instance/prototype-only USD topology",
                    "info",
                )
            )
        elif topology.get("inspected"):
            checks.append(
                _check(
                    "material_optimizer_default_enabled",
                    True,
                    "Using Material Agent optimize_usd path after USD topology inspection",
                    "info",
                )
            )
        else:
            checks.append(
                _check(
                    "material_optimizer_inspection_skipped",
                    True,
                    str(topology.get("reason") or "USD topology inspection was skipped; using Material Agent optimize_usd default"),
                    "info",
                )
            )
    elif agent_key == "physics":
        topology = _inspect_usd_topology(asset_path)
        report["usd_topology"] = topology
        optimizer = _apply_physics_auto_optimizer(args, topology)
        report["physics_optimizer"] = optimizer
        if optimizer["auto_enabled"]:
            checks.append(
                _check(
                    "physics_auto_optimizer_enabled",
                    True,
                    "Enabled optimize_usd, deinstance, and split for composed USD topology: "
                    + ", ".join(optimizer["auto_reasons"]),
                    "info",
                )
            )
        elif topology.get("inspected"):
            checks.append(
                _check(
                    "physics_auto_optimizer_not_needed",
                    True,
                    "No GeomSubset, instance, or prototype topology detected for automatic Physics Agent optimization",
                    "info",
                )
            )
        else:
            checks.append(
                _check(
                    "physics_auto_optimizer_inspection_skipped",
                    True,
                    str(topology.get("reason") or "USD topology inspection was skipped"),
                    "info",
                )
            )

    report["command"] = _command(
        args,
        agent_key=agent_key,
        asset_path=asset_path,
        output_directory=output_directory,
        base_url=base_url,
        token=token,
    )

    checks.append(
        _check(
            "base_url_available",
            bool(base_url),
            f"Using Content Agents service {base_url}"
            if base_url
            else f"Set --base-url or one of {', '.join(spec['default_env'])}",
        )
    )
    if base_url_source:
        checks.append(_check(f"base_url_from_{base_url_source}", True, f"Resolved base URL from {base_url_source}", "info"))
    if not base_url:
        report["status"] = "BLOCKED"
        report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
        return report

    if agent_key == "texture" and args.material_textures:
        try:
            json.loads(args.material_textures)
        except json.JSONDecodeError as exc:
            checks.append(_check("material_textures_json_valid", False, f"Invalid --material-textures JSON: {exc}"))
            report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
            return report
        checks.append(_check("material_textures_json_valid", True, "Material texture config JSON is valid", "info"))

    output_directory.mkdir(parents=True, exist_ok=True)
    material_upload_info: dict[str, Any] | None = None
    if agent_key == "material":
        asset_path, material_upload_info = _stage_material_upload_asset(asset_path)
        report["material_upload_info"] = material_upload_info
        if material_upload_info.get("warning"):
            checks.append(_check("material_upload_prep_skipped", True, material_upload_info["warning"], "info"))
        elif material_upload_info.get("staged"):
            if material_upload_info.get("stripped_mdl_source_assets"):
                checks.append(
                    _check(
                        "material_upload_mdl_source_assets_stripped",
                        True,
                        "Staged Material Agent upload without "
                        f"{material_upload_info['stripped_mdl_source_assets']} MDL sourceAsset references",
                        "info",
                    )
                )
            if material_upload_info.get("cleared_unresolved_service_asset_paths"):
                checks.append(
                    _check(
                        "material_upload_unresolved_service_asset_paths_cleared",
                        True,
                        "Staged Material Agent upload without "
                        f"{material_upload_info['cleared_unresolved_service_asset_paths']} service-internal asset paths",
                        "info",
                    )
                )

    physics_upload_info: dict[str, Any] | None = None
    if agent_key == "physics":
        asset_path, physics_upload_info = _stage_physics_upload_asset(asset_path)
        report["physics_upload_info"] = physics_upload_info
        if physics_upload_info.get("warning"):
            checks.append(_check("physics_upload_prep_skipped", True, physics_upload_info["warning"], "info"))
        elif physics_upload_info.get("staged"):
            if physics_upload_info.get("stripped_mdl_source_assets"):
                checks.append(
                    _check(
                        "physics_upload_mdl_source_assets_stripped",
                        True,
                        "Staged Physics Agent upload without "
                        f"{physics_upload_info['stripped_mdl_source_assets']} MDL sourceAsset references",
                        "info",
                    )
                )
            if physics_upload_info.get("cleared_unresolved_service_asset_paths"):
                checks.append(
                    _check(
                        "physics_upload_unresolved_service_asset_paths_cleared",
                        True,
                        "Staged Physics Agent upload without "
                        f"{physics_upload_info['cleared_unresolved_service_asset_paths']} service-internal asset paths",
                        "info",
                    )
                )

    try:
        upload_asset_path, upload_info = _prepare_upload_asset(asset_path, output_directory)
    except Exception as exc:
        checks.append(_check("upload_asset_prepared", False, str(exc)))
        report["upload_asset_path"] = str(asset_path)
        report["upload_packaging"] = "failed"
        report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
        return report

    report["upload_asset_path"] = str(upload_asset_path)
    report["upload_packaging"] = upload_info["packaging"]
    report["upload_dependency_count"] = upload_info["dependency_count"]
    report["upload_info"] = upload_info
    if upload_info["inspection_error"]:
        checks.append(_check("upload_dependency_inspection_skipped", True, upload_info["inspection_error"], "info"))
    elif upload_info["packaging"] == "usdz":
        checks.append(
            _check(
                "upload_asset_packaged",
                True,
                f"Packaged {upload_info['dependency_count']} USD dependencies into {upload_asset_path} for Content Agents upload",
                "info",
            )
        )
    elif upload_info["packaging"] == "already_usdz":
        checks.append(_check("upload_asset_already_packaged", True, "Input asset is already a USDZ package", "info"))
    else:
        checks.append(_check("upload_asset_single_file", True, "No external USD dependencies detected for upload", "info"))

    session_id: str | None = None
    try:
        session_id = _post_pipeline(upload_asset_path, base_url, token, _service_fields(args, agent_key), args.request_timeout)
        report["session_id"] = session_id
        checks.append(_check("session_started", True, f"Started Content Agents session {session_id}", "info"))
        service_status = _wait_for_status(
            base_url,
            token,
            session_id,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            request_timeout=args.request_timeout,
        )
        report["service_status"] = service_status
        poll_warnings = service_status.get("poll_warnings")
        if isinstance(poll_warnings, list):
            for warning in poll_warnings:
                report["warnings"].append(f"Recovered transient status poll error: {warning}")
        state = str(service_status.get("status", "")).lower()
        checks.append(_check("session_completed", state in TERMINAL_SUCCESS, f"Content Agents session status: {service_status.get('status')}"))
        try:
            report["service_results"] = _json_request(
                "GET",
                urljoin(f"{base_url.rstrip('/')}/", f"pipeline/{session_id}/results"),
                token=token,
                timeout=args.request_timeout,
            )
        except Exception as exc:
            report["warnings"].append(f"Could not fetch service results: {exc}")
    except Exception as exc:
        checks.append(_check("service_pipeline_completed", False, str(exc)))
        report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
        retry_report = _maybe_retry_material_without_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        retry_report = _maybe_repair_and_retry_physics_scene_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        retry_report = _maybe_retry_physics_without_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        return report

    if any(check["severity"] == "error" and not check["passed"] for check in checks):
        report["errors"] = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
        retry_report = _maybe_retry_material_without_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        retry_report = _maybe_repair_and_retry_physics_scene_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        retry_report = _maybe_retry_physics_without_optimizer(report, args)
        if retry_report is not None:
            return retry_report
        return report

    artifacts = report["artifacts"]
    required_artifact = _download_artifact(
        base_url,
        token,
        session_id,
        spec["output_label"],
        spec["output_endpoint"],
        output_usd_path,
        True,
        args.request_timeout * 2,
        allow_response_usd_suffix=agent_key == "physics",
        wait_timeout=args.artifact_timeout,
        poll_interval=args.poll_interval,
    )
    artifacts.append(required_artifact)
    if required_artifact.get("retry_count"):
        report["warnings"].append(
            f"Required artifact {spec['output_label']} became available after "
            f"{required_artifact['retry_count']} retry attempt(s)."
        )
    if required_artifact["downloaded"] and required_artifact["path"]:
        output_usd_path = Path(required_artifact["path"])
        report["output_usd_path"] = str(output_usd_path)

    if agent_key == "material" and args.material_output_cleanup and required_artifact["downloaded"] and output_usd_path:
        cleanup = cleanup_material_output(output_usd_path)
        report["material_output_cleanup"] = cleanup
        if cleanup.get("warning"):
            checks.append(_check("material_output_cleanup_warning", True, cleanup["warning"], "info"))
            report["warnings"].append(str(cleanup["warning"]))
        elif cleanup.get("skipped_reason"):
            checks.append(_check("material_output_cleanup_skipped", True, str(cleanup["skipped_reason"]), "info"))
        elif cleanup.get("removed_material_count") or cleanup.get("repaired_bound_shader_count"):
            checks.append(
                _check(
                    "material_output_broken_source_assets_cleaned",
                    True,
                    "Removed "
                    f"{cleanup.get('removed_material_count', 0)} unbound material subtree(s) and repaired "
                    f"{cleanup.get('repaired_bound_shader_count', 0)} bound shader(s) with broken sourceAsset references",
                    "info",
                )
            )
        else:
            checks.append(
                _check(
                    "material_output_cleanup_noop",
                    True,
                    "No unbound material subtrees with broken sourceAsset shader references were found",
                    "info",
                )
            )
        if cleanup.get("kept_bound_invalid_shader_count"):
            report["warnings"].append(
                "Material output cleanup found broken sourceAsset shader references on bound materials and left them unchanged."
            )
    elif agent_key == "material" and not args.material_output_cleanup:
        report["material_output_cleanup"] = {
            "attempted": False,
            "path": str(output_usd_path),
            "skipped_reason": "disabled by --no-material-output-cleanup",
        }

    for artifact_name, endpoint, suffix, required in spec["optional_artifacts"]:
        artifact = _download_artifact(
            base_url,
            token,
            session_id,
            artifact_name,
            endpoint,
            output_directory / f"{asset_path.stem}_{agent_key}_{artifact_name}{suffix}",
            required,
            args.request_timeout * 2,
        )
        artifacts.append(artifact)
        if not artifact["required"] and not artifact["downloaded"]:
            report["warnings"].append(f"Optional artifact {artifact_name} was not downloaded: {artifact['error']}")

    required_missing = [artifact for artifact in artifacts if artifact["required"] and not artifact["downloaded"]]
    checks.append(
        _check(
            "required_artifacts_downloaded",
            not required_missing,
            "Downloaded required output artifact" if not required_missing else "; ".join(artifact["error"] or artifact["name"] for artifact in required_missing),
        )
    )

    if agent_key == "physics" and args.convert_output_to_usd and not required_missing:
        converted, message, converted_path = _convert_physics_output_to_usd(output_usd_path, output_usd_path.with_suffix(".usd"))
        checks.append(_check("physics_output_converted_to_usd", converted, message))
        if converted:
            report["output_usd_path"] = str(converted_path)
            artifacts.append(
                {
                    "name": "physics_usd_crate",
                    "url": "local:usda-to-usd",
                    "path": str(converted_path),
                    "required": True,
                    "downloaded": True,
                    "content_type": "model/vnd.usd",
                    "error": None,
                }
            )

    errors = [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]
    report["errors"] = errors
    report["passed"] = not errors
    report["status"] = "PASS" if not errors else "FAIL"
    if errors:
        report["output_usd_path"] = None
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Portable Content Agents service wrapper.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument(
        "--token",
        help=(
            "Last-resort bearer token fallback. Prefer service-specific token "
            "environment variables or *_FILE variables so secrets do not appear "
            "in process arguments."
        ),
    )
    parser.add_argument("--prompt")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--request-timeout", type=int, default=120)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument(
        "--artifact-timeout",
        type=float,
        default=180.0,
        help="Seconds to retry required artifact downloads after a terminal service status.",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    parser.add_argument("--email")
    optimize_usd = parser.add_mutually_exclusive_group()
    optimize_usd.add_argument("--optimize-usd", dest="optimize_usd", action="store_true")
    optimize_usd.add_argument("--no-optimize-usd", dest="optimize_usd", action="store_false")
    parser.set_defaults(optimize_usd=None)
    parser.add_argument("--skip-instances", action="store_true")
    parser.add_argument("--skip-prototypes", action="store_true")
    parser.add_argument("--skip-existing-materials", action="store_true")
    parser.add_argument("--layer-only", action="store_true")
    parser.add_argument(
        "--no-material-output-cleanup",
        dest="material_output_cleanup",
        action="store_false",
        help=(
            "Disable the post-Material-Agent cleanup that removes unbound material subtrees "
            "and repairs bound shaders with broken sourceAsset references from downloaded USD outputs."
        ),
    )
    parser.set_defaults(material_output_cleanup=True)
    parser.add_argument("--render-backend", choices=("warp", "ovrtx", "remote"))
    deinstance = parser.add_mutually_exclusive_group()
    deinstance.add_argument("--enable-deinstance", dest="enable_deinstance", action="store_true")
    deinstance.add_argument("--disable-deinstance", dest="enable_deinstance", action="store_false")
    parser.set_defaults(enable_deinstance=True)
    parser.add_argument("--enable-split", action="store_true")
    auto_optimize = parser.add_mutually_exclusive_group()
    auto_optimize.add_argument("--auto-optimize-composed-usd", dest="auto_optimize_composed_usd", action="store_true")
    auto_optimize.add_argument("--no-auto-optimize-composed-usd", dest="auto_optimize_composed_usd", action="store_false")
    parser.set_defaults(auto_optimize_composed_usd=True)
    parser.add_argument("--convert-output-to-usd", action="store_true")
    parser.add_argument("--material-textures")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = run(args)
    _emit_report(report, args.report, args.markdown_report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
