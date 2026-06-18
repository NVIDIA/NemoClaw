#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import emit_json_report

from preflight_manifest import (
    load_preflight_manifest,
    manifest_path_value,
    preflight_required,
    preflight_status_check,
    ready_executable_from_runtime,
    ready_path_from_runtime,
    ready_path_from_upstream,
    runtime_entry,
)


SKILL = "simready-validate"
TOOL = "simready-validate"
DEFAULT_PROFILE = "Prop-Robotics-Neutral"
DEFAULT_PROFILE_VERSION = "1.0.0"
DEFAULT_UPSTREAM_ROOT = Path.home() / ".physical-ai-skill-hub" / "upstreams"
DEFAULT_FOUNDATION_REPO_URL = "https://github.com/NVIDIA/simready-foundation"
DEFAULT_FOUNDATION_BRANCH = "main"
DEFAULT_SIMREADY_VALIDATE_REQUIREMENT = "simready-validate>=2026.4.8"
NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT = "RB.MB.001"
SIMREADY_RUNTIME_EXTRA_REQUIREMENTS = [
    "numpy>=1.24,<3",
]
USD_EXCHANGE_SDK_FALLBACK_REQUIREMENTS = [
    "usd-exchange>=2.3.0",
    "omniverse-asset-validator",
    "omniverse-usd-profiles>=1.10.22",
]


def _checkout_name_from_repo_url(repo_url: str) -> str:
    name = urlparse(repo_url).path.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return name


DEFAULT_FOUNDATION_CHECKOUT = _checkout_name_from_repo_url(DEFAULT_FOUNDATION_REPO_URL)


def _empty_counts() -> dict[str, int]:
    return {"ERROR": 0, "FAILURE": 0, "WARNING": 0, "INFO": 0}


def _empty_topology(reason: str | None = None) -> dict[str, Any]:
    return {
        "inspected": False,
        "reason": reason,
        "default_prim_path": None,
        "mesh_count": 0,
        "geom_subset_count": 0,
        "mesh_with_geom_subset_count": 0,
        "component_count": None,
        "single_prim_or_geomsubset": False,
    }


def _inspect_asset_topology(asset_path: Path) -> dict[str, Any]:
    try:
        from pxr import Usd, UsdGeom
    except Exception as exc:
        return _empty_topology(f"OpenUSD Python APIs are unavailable: {exc}")

    try:
        stage = Usd.Stage.Open(str(asset_path))
    except Exception as exc:
        return _empty_topology(f"Could not open USD stage: {exc}")
    if stage is None:
        return _empty_topology("Could not open USD stage")

    default_prim = stage.GetDefaultPrim()
    root = default_prim if default_prim and default_prim.IsValid() else stage.GetPseudoRoot()
    mesh_count = 0
    geom_subset_count = 0
    mesh_paths_with_subsets: set[str] = set()
    for prim in Usd.PrimRange(root):
        if not prim.IsActive():
            continue
        if prim.IsA(UsdGeom.Mesh):
            mesh_count += 1
        is_geom_subset = prim.GetTypeName() == "GeomSubset"
        try:
            is_geom_subset = is_geom_subset or bool(UsdGeom.Subset(prim))
        except Exception:
            pass
        if is_geom_subset:
            geom_subset_count += 1
            parent = prim.GetParent()
            if parent and parent.IsA(UsdGeom.Mesh):
                mesh_paths_with_subsets.add(str(parent.GetPath()))

    component_count = 0
    if mesh_count == 1:
        component_count = max(geom_subset_count, 1)
    elif mesh_count > 1:
        component_count = mesh_count

    return {
        "inspected": True,
        "reason": None,
        "default_prim_path": str(default_prim.GetPath()) if default_prim and default_prim.IsValid() else None,
        "mesh_count": mesh_count,
        "geom_subset_count": geom_subset_count,
        "mesh_with_geom_subset_count": len(mesh_paths_with_subsets),
        "component_count": component_count,
        "single_prim_or_geomsubset": component_count == 1,
    }


def _issue_requirement_id(issue: dict[str, Any]) -> str | None:
    for key in ("requirement_id", "requirement"):
        value = issue.get(key)
        if value:
            return str(value)
    text = str(issue.get("message", ""))
    match = re.search(r"\b[A-Z]+(?:\.[A-Z]+)*\.\d+\b", text)
    return match.group(0) if match else None


def _recount_issues(issues: list[dict[str, Any]]) -> dict[str, int]:
    issue_counts = _empty_counts()
    for issue in issues:
        severity = str(issue.get("severity", "INFO")).upper()
        issue_counts[severity] = issue_counts.get(severity, 0) + 1
    return issue_counts


def _issue_messages(issues: list[dict[str, Any]], severities: set[str]) -> list[str]:
    return [
        str(issue.get("message", issue))
        for issue in issues
        if str(issue.get("severity", "")).upper() in severities
    ]


def _apply_single_component_rbmb001_policy(report: dict[str, Any], asset_path: Path) -> dict[str, Any]:
    topology = _inspect_asset_topology(asset_path)
    issues = [issue for issue in report.get("issues", []) if isinstance(issue, dict)]
    ignored_issues: list[dict[str, Any]] = []
    remaining_issues: list[dict[str, Any]] = []
    can_ignore_rbmb001 = bool(topology.get("single_prim_or_geomsubset"))

    for issue in issues:
        if can_ignore_rbmb001 and _issue_requirement_id(issue) == NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT:
            ignored = dict(issue)
            ignored["nonblocking_reason"] = (
                f"{NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT} is non-blocking for assets with a single mesh "
                "component or a single GeomSubset component."
            )
            ignored_issues.append(ignored)
        else:
            remaining_issues.append(issue)

    ignored_requirements = sorted(
        {
            str(_issue_requirement_id(issue))
            for issue in ignored_issues
            if _issue_requirement_id(issue)
        }
    )
    report["asset_topology"] = topology
    report["ignored_issues"] = ignored_issues
    report["validation_policy"] = {
        "single_component_rb_mb_001_nonblocking": can_ignore_rbmb001,
        "ignored_requirements": ignored_requirements,
    }

    if not ignored_issues:
        return report

    report["issues"] = remaining_issues
    report["issue_counts"] = _recount_issues(remaining_issues)
    requirement_counts = dict(report.get("requirement_counts", {}))
    for requirement_id in ignored_requirements:
        requirement_counts.pop(requirement_id, None)
    report["requirement_counts"] = requirement_counts

    for feature in report.get("feature_results", []):
        if not isinstance(feature, dict):
            continue
        failing_requirements = _parse_failing_requirements(feature.get("failing_requirements"))
        if NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT not in failing_requirements:
            continue
        remaining = [
            requirement
            for requirement in failing_requirements
            if requirement != NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT
        ]
        feature["failing_requirements"] = remaining
        ignored = _parse_failing_requirements(feature.get("ignored_requirements"))
        if NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT not in ignored:
            ignored.append(NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT)
        feature["ignored_requirements"] = ignored
        if not remaining:
            feature["passed"] = True

    errors = _issue_messages(remaining_issues, {"ERROR", "FAILURE"})
    warnings = _issue_messages(remaining_issues, {"WARNING"})
    warnings.append(
        f"Ignored non-blocking {NONBLOCKING_SINGLE_COMPONENT_REQUIREMENT} for single-component asset topology "
        f"(mesh_count={topology.get('mesh_count')}, geom_subset_count={topology.get('geom_subset_count')})."
    )
    passed = not errors
    report["errors"] = errors
    report["warnings"] = warnings
    report["passed"] = passed
    report["status"] = "PASS" if passed else "FAIL"
    if passed:
        for profile_result in report.get("profile_results", []):
            if isinstance(profile_result, dict):
                profile_result["passed"] = True
    report["next_step"] = "simready-profile-validation-complete" if passed else "simready-conform-profile"
    return report


def _blocked_report(asset_path: Path | None, command: list[str], profile: str, profile_version: str, error: str) -> dict[str, Any]:
    return {
        "asset_path": str(asset_path.resolve()) if asset_path else "",
        "validator_skill": SKILL,
        "validator_tool": TOOL,
        "passed": False,
        "status": "BLOCKED",
        "profile_name": profile,
        "profile_target": {"name": profile, "version": profile_version},
        "command": command,
        "available_profiles": [],
        "profile_results": [],
        "feature_results": [],
        "requirement_counts": {},
        "issue_counts": _empty_counts(),
        "issues": [],
        "warnings": [],
        "errors": [error],
        "next_step": "fix-simready-profile-validation",
    }


def _normalize_report(
    asset_path: Path,
    command: list[str],
    profile: str,
    profile_version: str,
    payload: dict[str, Any],
    completed: subprocess.CompletedProcess[str],
) -> dict[str, Any]:
    issues = payload.get("issues", [])
    if not isinstance(issues, list):
        issues = []
    issue_counts = _empty_counts()
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        severity = str(issue.get("severity", "INFO")).upper()
        issue_counts[severity] = issue_counts.get(severity, 0) + 1
    errors = [
        str(issue.get("message", issue))
        for issue in issues
        if isinstance(issue, dict) and str(issue.get("severity", "")).upper() in {"ERROR", "FAILURE"}
    ]
    if completed.returncode != 0 and not errors:
        errors.append(completed.stderr.strip() or completed.stdout.strip() or f"{TOOL} exited with {completed.returncode}")
    warnings = [
        str(issue.get("message", issue))
        for issue in issues
        if isinstance(issue, dict) and str(issue.get("severity", "")).upper() == "WARNING"
    ]
    status = str(payload.get("status", "PASS" if not errors else "FAIL")).upper()
    report = {
        "asset_path": str(asset_path.resolve()),
        "validator_skill": SKILL,
        "validator_tool": TOOL,
        "passed": not errors,
        "status": "PASS" if not errors else status,
        "profile_name": str(payload.get("profile_name", profile)),
        "profile_target": payload.get("profile_target", {"name": profile, "version": profile_version}),
        "command": command,
        "available_profiles": payload.get("available_profiles", []),
        "profile_results": payload.get("profile_results", []),
        "feature_results": payload.get("feature_results", []),
        "requirement_counts": payload.get("requirement_counts", {}),
        "issue_counts": issue_counts,
        "issues": issues,
        "warnings": warnings,
        "errors": errors,
        "next_step": payload.get("next_step", "simready-conform-profile" if errors else "simready-profile-validation-complete"),
    }
    return _apply_single_component_rbmb001_policy(report, asset_path)


def _runtime_venv_dir() -> Path:
    override = os.environ.get("PHYSICAL_AI_SIMREADY_VALIDATE_VENV")
    if override:
        return Path(override).expanduser().resolve()
    manifest, _, _ = load_preflight_manifest()
    venv_dir = manifest_path_value(runtime_entry(manifest, "simready_validate"), "venv")
    if venv_dir is not None:
        return venv_dir
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")).expanduser()
    return (cache_home / "physical-ai-skill-hub" / "simready-validate-venv").resolve()


def _venv_bin_dir(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts" if os.name == "nt" else "bin")


def _venv_python(venv_dir: Path) -> Path:
    return _venv_bin_dir(venv_dir) / ("python.exe" if os.name == "nt" else "python")


def _venv_executable(venv_dir: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return _venv_bin_dir(venv_dir) / f"{TOOL}{suffix}"


def _runtime_dependencies_ready(python: Path) -> bool:
    completed = subprocess.run(
        [str(python), "-c", "import numpy"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return completed.returncode == 0


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


def _foundation_requirements(requirements_path: Path) -> tuple[list[str], list[str]]:
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


def _foundation_requirements_path(root: Path) -> Path:
    candidates = [
        root / "requirements.txt",
        root / "nv_core" / "validator_sample" / "requirements.txt",
    ]
    return next((path for path in candidates if path.is_file()), candidates[0])


def _is_aarch64() -> bool:
    return platform.machine().lower() in {"aarch64", "arm64"}


def _should_try_usd_exchange_fallback(install_detail: str) -> bool:
    if not _is_aarch64():
        return False
    lowered = install_detail.lower()
    return "usd-core" in lowered or "no matching distribution" in lowered or "resolutionimpossible" in lowered


def _run_pip_install(python: Path, args: list[str], *, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _install_cli_with_usd_exchange_sdk_runtime(
    python: Path,
    executable: Path,
    requirements_path: Path,
) -> str | None:
    simready_requirements, other_requirements = _foundation_requirements(requirements_path)
    runtime_requirements = _dedupe_requirements([*USD_EXCHANGE_SDK_FALLBACK_REQUIREMENTS, *other_requirements, *SIMREADY_RUNTIME_EXTRA_REQUIREMENTS])
    runtime_install = _run_pip_install(python, runtime_requirements)
    if runtime_install.returncode != 0:
        detail = runtime_install.stderr.strip() or runtime_install.stdout.strip()
        return f"Failed to install USD Exchange SDK fallback runtime: {detail}"

    simready_install = _run_pip_install(python, ["--no-deps", *simready_requirements])
    if simready_install.returncode != 0:
        detail = simready_install.stderr.strip() or simready_install.stdout.strip()
        return f"Failed to install {TOOL} with USD Exchange SDK fallback runtime: {detail}"
    if not executable.is_file():
        return f"Installed USD Exchange SDK fallback runtime, but {executable} was not created"
    return None


def _install_cli_from_foundation_repo(foundation_root: Path | None) -> tuple[str | None, str | None]:
    root = foundation_root or _resolve_foundation_root(None)
    if root is None:
        return None, (
            f"{TOOL} CLI was not found on PATH, and no SimReady Foundation checkout was found at "
            f"$SIMREADY_FOUNDATION_ROOT, $PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/{DEFAULT_FOUNDATION_CHECKOUT}, "
            f"or $HOME/.physical-ai-skill-hub/upstreams/{DEFAULT_FOUNDATION_CHECKOUT} "
            f"checked out to {DEFAULT_FOUNDATION_BRANCH}"
        )
    requirements_path = _foundation_requirements_path(root)
    if not requirements_path.is_file():
        return None, f"{TOOL} CLI was not found on PATH, and {requirements_path} does not exist"

    venv_dir = _runtime_venv_dir()
    executable = _venv_executable(venv_dir)
    if executable.is_file() and _runtime_dependencies_ready(_venv_python(venv_dir)):
        return str(executable), None

    venv_dir.parent.mkdir(parents=True, exist_ok=True)
    create = subprocess.run(
        [sys.executable, "-m", "venv", str(venv_dir)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if create.returncode != 0:
        detail = create.stderr.strip() or create.stdout.strip()
        return None, f"Failed to create {TOOL} runtime venv at {venv_dir}: {detail}"

    python = _venv_python(venv_dir)
    install = _run_pip_install(python, ["-r", str(requirements_path), *SIMREADY_RUNTIME_EXTRA_REQUIREMENTS])
    if install.returncode != 0:
        detail = install.stderr.strip() or install.stdout.strip()
        if _should_try_usd_exchange_fallback(detail):
            fallback_error = _install_cli_with_usd_exchange_sdk_runtime(python, executable, requirements_path)
            if fallback_error is None:
                return str(executable), None
            return None, f"Failed to install {TOOL} from {requirements_path}: {detail}\n{fallback_error}"
        return None, f"Failed to install {TOOL} from {requirements_path}: {detail}"
    if not executable.is_file():
        return None, f"Installed {requirements_path}, but {executable} was not created"
    return str(executable), None


def _resolve_cli(foundation_root: Path | None) -> tuple[str | None, str | None]:
    manifest, _, _ = load_preflight_manifest()
    manifest_executable = ready_executable_from_runtime(manifest, "simready_validate")
    if manifest_executable is not None:
        return manifest_executable, None
    executable = shutil.which(TOOL)
    if executable is not None:
        return executable, None
    return _install_cli_from_foundation_repo(foundation_root)


def _parse_failing_requirements(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            import ast

            parsed = ast.literal_eval(text)
        except Exception:
            return [text]
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
        return [str(parsed)]
    return [str(value)]


def _normalize_feature_summary_report(
    asset_path: Path,
    command: list[str],
    profile: str,
    profile_version: str,
    payload: dict[str, Any],
    completed: subprocess.CompletedProcess[str],
) -> dict[str, Any]:
    entry = payload.get(str(asset_path)) or payload.get(str(asset_path.resolve()))
    if not isinstance(entry, dict) and payload:
        first_value = next(iter(payload.values()))
        entry = first_value if isinstance(first_value, dict) else {}
    if not isinstance(entry, dict):
        entry = {}

    profile_name = str(entry.get("profile_id", profile))
    resolved_profile_version = str(entry.get("profile_version", profile_version))
    feature_results: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    requirement_counts: dict[str, int] = {}
    features_summary = entry.get("features_summary", {})
    if isinstance(features_summary, dict):
        for feature_id, feature_payload in features_summary.items():
            if not isinstance(feature_payload, dict):
                continue
            failing_requirements = _parse_failing_requirements(feature_payload.get("failing requirements"))
            passed = bool(feature_payload.get("passed")) and not failing_requirements
            feature_results.append(
                {
                    "feature_id": str(feature_id),
                    "version": str(feature_payload.get("version", "")),
                    "passed": passed,
                    "failing_requirements": failing_requirements,
                    "dependencies": feature_payload.get("dependencies"),
                }
            )
            for requirement_id in failing_requirements:
                requirement_counts[requirement_id] = requirement_counts.get(requirement_id, 0) + 1
                issues.append(
                    {
                        "severity": "FAILURE",
                        "feature_id": str(feature_id),
                        "requirement_id": requirement_id,
                        "message": f"{feature_id} failed requirement {requirement_id}",
                    }
                )

    issue_counts = _empty_counts()
    issue_counts["FAILURE"] = len(issues)
    errors = [str(issue["message"]) for issue in issues]
    if completed.returncode != 0 and not errors:
        errors.append(completed.stderr.strip() or completed.stdout.strip() or f"{TOOL} exited with {completed.returncode}")
    passed = not errors
    report = {
        "asset_path": str(asset_path.resolve()),
        "validator_skill": SKILL,
        "validator_tool": TOOL,
        "passed": passed,
        "status": "PASS" if passed else "FAIL",
        "profile_name": profile_name,
        "profile_target": {"name": profile_name, "version": resolved_profile_version},
        "command": command,
        "available_profiles": [],
        "profile_results": [{"profile_id": profile_name, "profile_version": resolved_profile_version, "passed": passed}],
        "feature_results": feature_results,
        "requirement_counts": requirement_counts,
        "issue_counts": issue_counts,
        "issues": issues,
        "warnings": [],
        "errors": errors,
        "next_step": "simready-profile-validation-complete" if passed else "simready-conform-profile",
    }
    return _apply_single_component_rbmb001_policy(report, asset_path)


def _normalize_runtime_payload(
    asset_path: Path,
    command: list[str],
    profile: str,
    profile_version: str,
    payload: dict[str, Any],
    completed: subprocess.CompletedProcess[str],
) -> dict[str, Any]:
    if "issues" in payload or "profile_results" in payload or "feature_results" in payload:
        return _normalize_report(asset_path, command, profile, profile_version, payload, completed)
    return _normalize_feature_summary_report(asset_path, command, profile, profile_version, payload, completed)


def _resolve_foundation_root(explicit: Path | None) -> Path | None:
    if explicit:
        return explicit
    manifest, _, _ = load_preflight_manifest()
    manifest_root = ready_path_from_runtime(manifest, "simready_validate") or ready_path_from_upstream(manifest, "simready_foundation")
    if manifest_root is not None:
        return manifest_root
    env_value = os.getenv("SIMREADY_FOUNDATION_ROOT")
    if env_value:
        return Path(env_value)
    upstream_root = Path(os.getenv("PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT", str(DEFAULT_UPSTREAM_ROOT)))
    candidate = upstream_root / DEFAULT_FOUNDATION_CHECKOUT
    return candidate if candidate.exists() else None


def _resolve_spec_root(foundation_root: Path | None, explicit: Path | None) -> Path | None:
    if explicit:
        return explicit
    env_value = os.getenv("SIMREADY_FOUNDATION_SPEC_ROOT")
    if env_value:
        return Path(env_value)
    if foundation_root:
        candidate = foundation_root / "nv_core" / "sr_specs" / "docs"
        return candidate if candidate.exists() else None
    return None


def _cli_help(executable: str) -> str:
    completed = subprocess.run([executable, "--help"], capture_output=True, text=True, timeout=30, check=False)
    return f"{completed.stdout}\n{completed.stderr}"


def _build_command(
    executable: str,
    asset_path: Path,
    *,
    profile: str,
    profile_version: str,
    foundation_root: Path | None,
    foundation_spec_root: Path | None,
    output_path: Path,
) -> list[str]:
    help_text = _cli_help(executable)
    if "--json-output" in help_text:
        command = [executable, str(asset_path), "--profile", profile, "--profile-version", profile_version]
        if foundation_root:
            command.extend(["--foundation-root", str(foundation_root)])
        if foundation_spec_root:
            command.extend(["--foundation-spec-root", str(foundation_spec_root)])
        command.extend(["--json-output", str(output_path)])
        return command

    command = [executable, str(asset_path), "--profile", profile, "--version", profile_version]
    if foundation_spec_root:
        capabilities = foundation_spec_root / "capabilities"
        features = foundation_spec_root / "features"
        profiles = foundation_spec_root / "profiles" / "profiles.toml"
        if capabilities.exists():
            command.extend(["--rules-path", str(capabilities)])
        if features.exists():
            command.extend(["--features-path", str(features)])
        if profiles.exists():
            command.extend(["--profiles-path", str(profiles)])
    command.extend(["--output", str(output_path)])
    return command


def validate_profile(
    asset_path: Path,
    *,
    profile: str,
    profile_version: str,
    foundation_root: Path | None,
    foundation_spec_root: Path | None,
) -> dict[str, Any]:
    if preflight_required() and foundation_root is None:
        preflight_check = preflight_status_check("simready-validate", "simready_validate")
        if not preflight_check["passed"]:
            return _blocked_report(
                asset_path,
                [TOOL, str(asset_path), "--profile", profile, "--profile-version", profile_version],
                profile,
                profile_version,
                preflight_check["message"],
            )
    foundation_root = _resolve_foundation_root(foundation_root)
    foundation_spec_root = _resolve_spec_root(foundation_root, foundation_spec_root)
    command = [TOOL, str(asset_path), "--profile", profile, "--profile-version", profile_version]
    executable, cli_error = _resolve_cli(foundation_root)
    if executable is None:
        return _blocked_report(asset_path, command, profile, profile_version, cli_error or f"{TOOL} CLI is required but was not found on PATH")
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "simready-profile-report.json"
        run_command = _build_command(
            executable,
            asset_path,
            profile=profile,
            profile_version=profile_version,
            foundation_root=foundation_root,
            foundation_spec_root=foundation_spec_root,
            output_path=output_path,
        )
        completed = subprocess.run(run_command, capture_output=True, text=True, timeout=300, check=False)
        if not output_path.exists():
            return _blocked_report(asset_path, run_command, profile, profile_version, f"{TOOL} did not produce JSON output")
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    return _normalize_runtime_payload(asset_path, run_command, profile, profile_version, payload, completed)


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(
        payload,
        report_path,
        markdown_report_path,
        f"# SimReady Profile Validation Report\n\n- Passed: `{payload['passed']}`",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate an OpenUSD asset against a SimReady Foundation profile.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--profile-version", default=DEFAULT_PROFILE_VERSION)
    parser.add_argument("--foundation-root", type=Path)
    parser.add_argument("--foundation-spec-root", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = validate_profile(
        args.asset_path,
        profile=args.profile,
        profile_version=args.profile_version,
        foundation_root=args.foundation_root,
        foundation_spec_root=args.foundation_spec_root,
    )
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
