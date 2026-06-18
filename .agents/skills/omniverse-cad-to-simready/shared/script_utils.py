#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any


USD_LAYER_SUFFIXES = frozenset({".usd", ".usda", ".usdc", ".usdz"})


def resolve_output_path(
    asset_path: Path,
    output: Path | None,
    output_dir: Path | None,
    in_place: bool,
    *,
    default_stem_suffix: str,
) -> Path:
    if in_place:
        return asset_path
    if output is not None:
        return output
    if output_dir is not None:
        return output_dir / asset_path.name
    return asset_path.with_name(f"{asset_path.stem}{default_stem_suffix}{asset_path.suffix}")


def decode_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def subprocess_output(stdout: str | bytes | None, stderr: str | bytes | None) -> str:
    parts = [decode_output(stdout).strip(), decode_output(stderr).strip()]
    return "\n".join(part for part in parts if part)


def tail_text(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return "..." + text[-limit:]


def check_result(
    name: str,
    passed: bool,
    message: str,
    severity: str = "error",
    code: str | None = None,
    *,
    include_code: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": name,
        "passed": passed,
        "severity": severity,
        "message": message,
    }
    if include_code or code is not None:
        payload["code"] = code
    return payload


def check_result_with_code(
    name: str,
    passed: bool,
    message: str,
    severity: str = "error",
    code: str | None = None,
) -> dict[str, Any]:
    return check_result(name, passed, message, severity, code, include_code=True)


def emit_json_report(
    payload: dict[str, Any],
    report_path: Path | None = None,
    markdown_report_path: Path | None = None,
    markdown_text: str | None = None,
    *,
    print_output: bool = True,
) -> None:
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(text, encoding="utf-8")
    if markdown_report_path is not None:
        markdown_report_path.parent.mkdir(parents=True, exist_ok=True)
        markdown_report_path.write_text((markdown_text or "").rstrip() + "\n", encoding="utf-8")
    if print_output:
        print(text, end="")


def discover_primary_usd(output_directory: Path, expected_output: Path) -> Path | None:
    if expected_output.exists():
        return expected_output
    if not output_directory.exists():
        return None
    candidates = sorted(
        path
        for path in output_directory.iterdir()
        if path.is_file() and path.suffix.lower() in USD_LAYER_SUFFIXES
    )
    if len(candidates) == 1:
        return candidates[0]
    return None


def issue_counts(issues: list[dict[str, Any]], severities: tuple[str, ...]) -> dict[str, int]:
    counts = {severity: 0 for severity in severities}
    for issue in issues:
        severity = str(issue.get("severity", "UNKNOWN")).upper()
        counts[severity] = counts.get(severity, 0) + 1
    return counts


def usd_bounds_metadata(
    Usd: Any,
    UsdGeom: Any,
    stage: Any,
    *,
    meters_per_unit: float | None,
    use_extents_hint: bool,
    fallback_to_pseudo_root: bool,
    empty_as_null: bool,
) -> dict[str, Any]:
    root = stage.GetDefaultPrim()
    if fallback_to_pseudo_root and (not root or not root.IsValid()):
        root = stage.GetPseudoRoot()

    purposes = [UsdGeom.Tokens.default_, UsdGeom.Tokens.render, UsdGeom.Tokens.proxy]
    bbox_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), purposes, useExtentsHint=use_extents_hint)
    aligned_box = bbox_cache.ComputeWorldBound(root).ComputeAlignedBox()
    if empty_as_null and aligned_box.IsEmpty():
        return {
            "stage_units": None,
            "meters": None,
        }

    minimum = _vec3_to_list(aligned_box.GetMin())
    maximum = _vec3_to_list(aligned_box.GetMax())
    size = [maximum[index] - minimum[index] for index in range(3)]
    center = [(minimum[index] + maximum[index]) / 2.0 for index in range(3)]
    stage_units = {
        "min": minimum,
        "max": maximum,
        "size": size,
        "center": center,
    }
    meters = None
    if meters_per_unit is not None:
        meters = {
            key: [value * meters_per_unit for value in values]
            for key, values in stage_units.items()
        }
    return {
        "stage_units": stage_units,
        "meters": meters,
    }


def _vec3_to_list(value: Any) -> list[float]:
    return [float(value[index]) for index in range(3)]


def asset_validation_report(
    *,
    asset_path: Path,
    validator_skill: str,
    validator_tool: str,
    category: str,
    command: list[str],
    issues: list[dict[str, Any]],
    warnings: list[str],
    errors: list[str],
    status: str,
    next_step: str,
    severities: tuple[str, ...],
) -> dict[str, Any]:
    return {
        "asset_path": str(asset_path),
        "validator_skill": validator_skill,
        "validator_tool": validator_tool,
        "passed": not errors,
        "status": "PASS" if not errors else status,
        "command": command,
        "categories": [category],
        "rules": [],
        "issue_counts": issue_counts(issues, severities),
        "issues": issues,
        "warnings": warnings,
        "errors": errors,
        "next_step": next_step,
    }


def flatten_asset_validation_issues(payload: dict[str, Any]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for rule_result in payload.get("rules", []):
        rule_name = rule_result.get("rule", {}).get("name", "unknown")
        for issue in rule_result.get("issues", []):
            flattened.append(
                {
                    "rule": str(issue.get("rule", {}).get("name", rule_name)),
                    "severity": str(issue.get("severity", "UNKNOWN")).upper(),
                    "message": str(issue.get("message", "")),
                    "location": _issue_location(issue),
                    "requirement": _issue_requirement(issue),
                    "suggestion": _issue_suggestion(issue),
                }
            )
    return flattened


def run_asset_validator_category(
    *,
    asset_path: Path,
    next_step: str,
    timeout: int,
    validator_skill: str,
    validator_tool: str,
    module_tool: str,
    category: str,
    severities: tuple[str, ...],
) -> dict[str, Any]:
    asset_path = asset_path.resolve()
    command = [validator_tool, "--category", category]
    command_base, fallback_warnings = _resolve_validator_command(validator_tool, module_tool)
    if command_base is None:
        return asset_validation_report(
            asset_path=asset_path,
            validator_skill=validator_skill,
            validator_tool=validator_tool,
            category=category,
            command=command,
            issues=[],
            warnings=[],
            errors=[f"{validator_tool} CLI is required but was not found on PATH"],
            status="BLOCKED",
            next_step=next_step,
            severities=severities,
        )
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "asset-validator-report.json"
        run_command = [*command_base, "--category", category, "--json-output", str(output_path), str(asset_path)]
        try:
            completed = subprocess.run(run_command, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            return asset_validation_report(
                asset_path=asset_path,
                validator_skill=validator_skill,
                validator_tool=validator_tool,
                category=category,
                command=run_command,
                issues=[],
                warnings=fallback_warnings,
                errors=[_asset_validator_timeout_error(validator_tool, timeout, exc)],
                status="TIMEOUT",
                next_step=next_step,
                severities=severities,
            )
        if not output_path.exists():
            return asset_validation_report(
                asset_path=asset_path,
                validator_skill=validator_skill,
                validator_tool=validator_tool,
                category=category,
                command=run_command,
                issues=[],
                warnings=fallback_warnings,
                errors=[f"{validator_tool} did not produce JSON output", completed.stderr.strip()],
                status="ERROR",
                next_step=next_step,
                severities=severities,
            )
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    issues = flatten_asset_validation_issues(payload)
    errors = [f"{issue['rule']}: {issue['message']}" for issue in issues if issue["severity"] in {"ERROR", "FAILURE"}]
    warnings = list(fallback_warnings)
    warnings.extend(f"{issue['rule']}: {issue['message']}" for issue in issues if issue["severity"] == "WARNING")
    if completed.returncode != 0 and not issues:
        errors.append(completed.stderr.strip() or completed.stdout.strip() or f"{validator_tool} exited with {completed.returncode}")
    return asset_validation_report(
        asset_path=asset_path,
        validator_skill=validator_skill,
        validator_tool=validator_tool,
        category=category,
        command=run_command,
        issues=issues,
        warnings=warnings,
        errors=errors,
        status=str(payload.get("status", "UNKNOWN")).upper(),
        next_step=next_step,
        severities=severities,
    )


def _resolve_validator_command(tool: str, module_tool: str) -> tuple[list[str] | None, list[str]]:
    executable = shutil.which(tool)
    if executable is not None:
        return [executable], []
    if importlib.util.find_spec(module_tool) is not None:
        return [sys.executable, "-m", module_tool], [
            f"{tool} CLI was not found on PATH; using the {module_tool} Python module with {sys.executable}."
        ]
    return None, []


def _asset_validator_timeout_error(tool: str, timeout: int, exc: subprocess.TimeoutExpired) -> str:
    detail = subprocess_output(getattr(exc, "stdout", ""), getattr(exc, "stderr", ""))
    message = f"{tool} timed out after {timeout}s. Increase --timeout for large USD assets."
    return f"{message} Output: {tail_text(detail, 2000)}" if detail else message


def _issue_location(issue: dict[str, Any]) -> str | None:
    location = issue.get("at")
    if isinstance(location, dict):
        path = location.get("path")
        if path is not None:
            return str(path)
    if location is None:
        return None
    return str(location)


def _issue_requirement(issue: dict[str, Any]) -> str | None:
    requirement = issue.get("requirement")
    if not isinstance(requirement, dict):
        return None
    code = requirement.get("code")
    if code is None:
        return None
    version = requirement.get("version")
    return f"{code}@{version}" if version else str(code)


def _issue_suggestion(issue: dict[str, Any]) -> str | None:
    suggestion = issue.get("suggestion")
    if isinstance(suggestion, dict) and suggestion.get("message"):
        return str(suggestion["message"])
    suggestions = issue.get("suggestions")
    if isinstance(suggestions, list):
        messages = [str(item["message"]) for item in suggestions if isinstance(item, dict) and item.get("message")]
        if messages:
            return "; ".join(messages)
    return None
