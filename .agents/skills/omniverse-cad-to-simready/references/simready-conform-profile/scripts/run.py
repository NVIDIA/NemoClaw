#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import emit_json_report


SKILL = "simready-conform-profile"
DEFAULT_PROFILE = "Prop-Robotics-Neutral"
DEFAULT_PROFILE_VERSION = "1.0.0"
REPAIRABLE_REQUIREMENTS = {"NP.002", "NP.006", "UN.007", "RB.MB.001", "GSP.001"}
CORE_REQUIREMENTS = {"NP.002", "NP.006"}
FET000 = "FET_000_CORE"
FET001 = "FET_001_MINIMAL"
FET004 = "FET_004_SIMULATE_MULTI_BODY_PHYSICS"
FET005 = "FET_005_SIMULATE_GRASP_PHYSICS"


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _reference_script(reference: str, script_name: str = "run.py") -> Path:
    return _skill_root() / "references" / reference / "scripts" / script_name


def _empty_report(asset_path: Path, output_dir: Path, args: argparse.Namespace) -> dict[str, Any]:
    return {
        "input_usd_path": str(asset_path),
        "output_usd_path": str(asset_path),
        "output_dir": str(output_dir),
        "profile": args.profile,
        "profile_version": args.profile_version,
        "validation_report": str(args.validation_report.resolve()) if args.validation_report else None,
        "failed_requirements": [],
        "requirements_repaired": [],
        "requirements_blocked": [],
        "requirements_skipped": [],
        "steps": [],
        "reports": {},
        "passed": False,
        "status": "FAIL",
        "errors": [],
        "warnings": [],
        "next_step": "simready-validate",
    }


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _parse_requirement(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    match = re.search(r"\b[A-Z]+(?:\.[A-Z]+)*\.\d+\b", text)
    return match.group(0) if match else None


def _parse_requirement_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [requirement for item in value if (requirement := _parse_requirement(item))]
    if isinstance(value, str):
        return re.findall(r"\b[A-Z]+(?:\.[A-Z]+)*\.\d+\b", value)
    return []


def _failed_requirements(validation_report: Path | None) -> list[str]:
    if validation_report is None:
        return []
    payload = _load_json(validation_report)
    requirements: set[str] = set()
    for issue in payload.get("issues", []):
        if not isinstance(issue, dict):
            continue
        if requirement := _parse_requirement(issue.get("requirement_id") or issue.get("requirement")):
            requirements.add(requirement)
    for feature in payload.get("feature_results", []):
        if isinstance(feature, dict):
            requirements.update(_parse_requirement_list(feature.get("failing_requirements")))
    for requirement in payload.get("requirement_counts", {}):
        if parsed := _parse_requirement(requirement):
            requirements.add(parsed)
    return sorted(requirements)


def _safe_stem(stem: str) -> str:
    safe = re.sub(r"[^a-z0-9._-]+", "_", stem.lower())
    safe = re.sub(r"_+", "_", safe).strip("._-")
    return safe or "simready_asset"


def _core_output_path(asset_path: Path, output_dir: Path, identifier: str | None) -> Path:
    stem = _safe_stem(identifier or asset_path.stem)
    return output_dir / "fet000-core" / f"{stem}{asset_path.suffix.lower()}"


def _append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        if value and value not in target:
            target.append(value)


def _step_summary(
    *,
    name: str,
    status: str,
    passed: bool,
    input_path: Path,
    output_path: Path | None,
    report_path: Path | None,
    requirements_repaired: list[str] | None = None,
    requirements_blocked: list[str] | None = None,
    requirements_skipped: list[str] | None = None,
    warnings: list[str] | None = None,
    errors: list[str] | None = None,
    reason: str | None = None,
    command: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "passed": passed,
        "input_usd_path": str(input_path),
        "output_usd_path": str(output_path) if output_path is not None else None,
        "report_path": str(report_path) if report_path is not None else None,
        "requirements_repaired": requirements_repaired or [],
        "requirements_blocked": requirements_blocked or [],
        "requirements_skipped": requirements_skipped or [],
        "warnings": warnings or [],
        "errors": errors or [],
        "reason": reason,
        "command": command or [],
    }


def _run_helper(command: list[str], report_path: Path, stdout_path: Path, stderr_path: Path) -> tuple[int, dict[str, Any]]:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
        completed = subprocess.run(command, stdout=stdout_file, stderr=stderr_file, text=True, timeout=300, check=False)
    payload: dict[str, Any] = {}
    if report_path.exists():
        payload = _load_json(report_path)
    return completed.returncode, payload


def _run_fet000(asset_path: Path, output_dir: Path, args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    report_path = output_dir / "fet000-core" / "fet000-core.json"
    output_path = _core_output_path(asset_path, output_dir, args.identifier)
    command = [
        sys.executable,
        str(_reference_script(FET000)),
        str(asset_path),
        "--output",
        str(output_path),
        "--identifier",
        args.identifier or output_path.stem,
        "--profile",
        args.profile,
        "--profile-version",
        args.profile_version,
        "--report",
        str(report_path),
        "--markdown-report",
        str(report_path.with_suffix(".md")),
    ]
    if args.force:
        command.append("--force")
    if args.description:
        command.extend(["--description", args.description])
    if args.source_asset:
        command.extend(["--source-asset", args.source_asset])
    if args.author:
        command.extend(["--author", args.author])
    for tag in args.tags:
        command.extend(["--tag", tag])
    for step in args.pipeline_steps:
        command.extend(["--pipeline-step", step])
    returncode, payload = _run_helper(
        command,
        report_path,
        report_path.with_suffix(".stdout.log"),
        report_path.with_suffix(".stderr.log"),
    )
    repaired = list(payload.get("requirements_repaired", []))
    if payload.get("passed") and output_path.name != asset_path.name and "NP.002" not in repaired:
        repaired.insert(0, "NP.002")
    return _step_summary(
        name=FET000,
        status=str(payload.get("status", "PASS" if returncode == 0 else "FAIL")),
        passed=returncode == 0 and bool(payload.get("passed")),
        input_path=asset_path,
        output_path=Path(payload.get("output_usd_path", output_path)),
        report_path=report_path,
        requirements_repaired=repaired,
        warnings=list(payload.get("warnings", [])),
        errors=list(payload.get("errors", [])),
        command=command,
    ), Path(payload.get("output_usd_path", output_path))


def _run_fet001(asset_path: Path, output_dir: Path, args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    report_path = output_dir / "fet001-minimal" / "fet001-minimal.json"
    command = [
        sys.executable,
        str(_reference_script(FET001)),
        str(asset_path),
        "--output-dir",
        str(report_path.parent),
        "--profile",
        args.profile,
        "--profile-version",
        args.profile_version,
        "--report",
        str(report_path),
        "--markdown-report",
        str(report_path.with_suffix(".md")),
    ]
    if args.force:
        command.append("--force")
    returncode, payload = _run_helper(
        command,
        report_path,
        report_path.with_suffix(".stdout.log"),
        report_path.with_suffix(".stderr.log"),
    )
    return _step_summary(
        name=FET001,
        status=str(payload.get("status", "PASS" if returncode == 0 else "FAIL")),
        passed=returncode == 0 and bool(payload.get("passed")),
        input_path=asset_path,
        output_path=Path(payload.get("output_usd_path", asset_path)),
        report_path=report_path,
        requirements_repaired=list(payload.get("requirements_repaired", [])),
        requirements_blocked=list(payload.get("requirements_blocked", [])),
        warnings=list(payload.get("warnings", [])),
        errors=list(payload.get("errors", [])),
        command=command,
    ), Path(payload.get("output_usd_path", asset_path))


def _run_fet004(asset_path: Path, output_dir: Path, args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    report_path = output_dir / "fet004-multibody" / "fet004-multibody.json"
    command = [
        sys.executable,
        str(_reference_script(FET004)),
        str(asset_path),
        "--output-dir",
        str(report_path.parent),
        "--profile",
        args.profile,
        "--profile-version",
        args.profile_version,
        "--report",
        str(report_path),
        "--markdown-report",
        str(report_path.with_suffix(".md")),
    ]
    if args.force:
        command.append("--force")
    if args.validation_report:
        command.extend(["--validation-report", str(args.validation_report.resolve())])
    returncode, payload = _run_helper(
        command,
        report_path,
        report_path.with_suffix(".stdout.log"),
        report_path.with_suffix(".stderr.log"),
    )
    return _step_summary(
        name=FET004,
        status=str(payload.get("status", "PASS" if returncode == 0 else "FAIL")),
        passed=returncode == 0 and bool(payload.get("passed")),
        input_path=asset_path,
        output_path=Path(payload.get("output_usd_path", asset_path)),
        report_path=report_path,
        requirements_repaired=list(payload.get("requirements_repaired", [])),
        requirements_blocked=list(payload.get("requirements_blocked", [])),
        warnings=list(payload.get("warnings", [])),
        errors=list(payload.get("errors", [])),
        reason=str(payload.get("applicability", "")) or None,
        command=command,
    ), Path(payload.get("output_usd_path", asset_path))


def _run_fet005(asset_path: Path, output_dir: Path, args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    report_path = output_dir / "fet005-grasp" / "fet005-grasp.json"
    if len(args.grasp_points) < 2:
        step = _step_summary(
            name=FET005,
            status="BLOCKED",
            passed=False,
            input_path=asset_path,
            output_path=asset_path,
            report_path=report_path,
            requirements_blocked=["GSP.001"],
            reason="GSP.001 requires at least two explicit --grasp-point values selected from visual evidence.",
        )
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(step, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return step, asset_path

    output_path = report_path.parent / asset_path.name
    command = [
        sys.executable,
        str(_reference_script(FET005, "author_grasp_line.py")),
        str(asset_path),
        "--output",
        str(output_path),
        "--report",
        str(report_path),
        "--markdown-report",
        str(report_path.with_suffix(".md")),
    ]
    if args.force:
        command.append("--force")
    if args.grasp_parent_prim:
        command.extend(["--parent-prim", args.grasp_parent_prim])
    if args.grasp_name:
        command.extend(["--name", args.grasp_name])
    for point in args.grasp_points:
        command.append(f"--point={point}")
    for evidence in args.visual_evidence:
        command.extend(["--visual-evidence", evidence])
    if args.source_asset:
        command.extend(["--source-visual-asset", args.source_asset])
    if args.grasp_rationale:
        command.extend(["--rationale", args.grasp_rationale])
    if args.coordinate_note:
        command.extend(["--coordinate-note", args.coordinate_note])
    returncode, payload = _run_helper(
        command,
        report_path,
        report_path.with_suffix(".stdout.log"),
        report_path.with_suffix(".stderr.log"),
    )
    repaired = ["GSP.001"] if returncode == 0 and payload.get("passed") else []
    blocked = [] if repaired else ["GSP.001"]
    return _step_summary(
        name=FET005,
        status=str(payload.get("status", "PASS" if returncode == 0 else "FAIL")),
        passed=returncode == 0 and bool(payload.get("passed")),
        input_path=asset_path,
        output_path=Path(payload.get("output_usd_path", asset_path)),
        report_path=report_path,
        requirements_repaired=repaired,
        requirements_blocked=blocked,
        warnings=list(payload.get("warnings", [])),
        errors=list(payload.get("errors", [])),
        command=command,
    ), Path(payload.get("output_usd_path", asset_path))


def conform(args: argparse.Namespace) -> dict[str, Any]:
    asset_path = args.asset_path.resolve()
    output_dir = args.output_dir.resolve()
    report = _empty_report(asset_path, output_dir, args)
    if not asset_path.exists():
        report["errors"].append(f"Asset path does not exist: {asset_path}")
        return report

    if args.validation_report and not args.validation_report.exists():
        report["errors"].append(f"Validation report does not exist: {args.validation_report}")
        return report

    failed_requirements = _failed_requirements(args.validation_report)
    selected_requirements = set(failed_requirements)
    if not args.validation_report:
        selected_requirements.update({"NP.002", "NP.006", "UN.007"})
    if args.repair:
        selected_requirements.update(args.repair)
    selected_requirements &= REPAIRABLE_REQUIREMENTS
    report["failed_requirements"] = failed_requirements

    current_path = asset_path
    output_dir.mkdir(parents=True, exist_ok=True)

    if selected_requirements & CORE_REQUIREMENTS:
        step, current_path = _run_fet000(current_path, output_dir, args)
        report["steps"].append(step)
        report["reports"][FET000] = step["report_path"]
        _append_unique(report["requirements_repaired"], step["requirements_repaired"])
        _append_unique(report["requirements_blocked"], step["requirements_blocked"])
        report["warnings"].extend(step["warnings"])
        report["errors"].extend(step["errors"])
        if not step["passed"]:
            report["output_usd_path"] = str(current_path)
            return _finalize(report)
    else:
        report["requirements_skipped"].extend(sorted(CORE_REQUIREMENTS))

    if "UN.007" in selected_requirements:
        step, current_path = _run_fet001(current_path, output_dir, args)
        report["steps"].append(step)
        report["reports"][FET001] = step["report_path"]
        _append_unique(report["requirements_repaired"], step["requirements_repaired"])
        _append_unique(report["requirements_blocked"], step["requirements_blocked"])
        report["warnings"].extend(step["warnings"])
        report["errors"].extend(step["errors"])
        if not step["passed"]:
            report["output_usd_path"] = str(current_path)
            return _finalize(report)
    else:
        report["requirements_skipped"].append("UN.007")

    if "RB.MB.001" in selected_requirements:
        step, current_path = _run_fet004(current_path, output_dir, args)
        report["steps"].append(step)
        report["reports"][FET004] = step["report_path"]
        _append_unique(report["requirements_repaired"], step["requirements_repaired"])
        _append_unique(report["requirements_blocked"], step["requirements_blocked"])
        report["warnings"].extend(step["warnings"])
        report["errors"].extend(step["errors"])
        if not step["passed"]:
            report["output_usd_path"] = str(current_path)
            return _finalize(report)
    else:
        report["requirements_skipped"].append("RB.MB.001")

    if "GSP.001" in selected_requirements:
        step, current_path = _run_fet005(current_path, output_dir, args)
        report["steps"].append(step)
        report["reports"][FET005] = step["report_path"]
        _append_unique(report["requirements_repaired"], step["requirements_repaired"])
        _append_unique(report["requirements_blocked"], step["requirements_blocked"])
        report["warnings"].extend(step["warnings"])
        report["errors"].extend(step["errors"])
    else:
        report["requirements_skipped"].append("GSP.001")

    report["output_usd_path"] = str(current_path)
    return _finalize(report)


def _finalize(report: dict[str, Any]) -> dict[str, Any]:
    blocked = bool(report["requirements_blocked"])
    failed_step = any(step["status"] == "FAIL" for step in report["steps"])
    errors = bool(report["errors"])
    report["passed"] = not blocked and not failed_step and not errors
    report["status"] = "PASS" if report["passed"] else "BLOCKED" if blocked and not failed_step else "FAIL"
    report["requirements_repaired"] = sorted(set(report["requirements_repaired"]))
    report["requirements_blocked"] = sorted(set(report["requirements_blocked"]))
    report["requirements_skipped"] = sorted(set(report["requirements_skipped"]))
    report["next_step"] = "simready-validate"
    return report


def emit(payload: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    lines = [
        "# SimReady Conform Profile Report",
        "",
        f"- Status: `{payload['status']}`",
        f"- Passed: `{payload['passed']}`",
        f"- Output USD: `{payload['output_usd_path']}`",
        f"- Requirements repaired: `{', '.join(payload['requirements_repaired']) or 'none'}`",
        f"- Requirements blocked: `{', '.join(payload['requirements_blocked']) or 'none'}`",
        "",
    ]
    emit_json_report(payload, report_path, markdown_report_path, "\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Route SimReady profile conformance repairs through local FET helpers.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--profile-version", default=DEFAULT_PROFILE_VERSION)
    parser.add_argument("--validation-report", type=Path)
    parser.add_argument("--source-asset")
    parser.add_argument("--identifier")
    parser.add_argument("--description")
    parser.add_argument("--author")
    parser.add_argument("--tag", dest="tags", action="append", default=[])
    parser.add_argument("--pipeline-step", dest="pipeline_steps", action="append", default=[])
    parser.add_argument("--repair", action="append", choices=sorted(REPAIRABLE_REQUIREMENTS), default=[])
    parser.add_argument("--grasp-point", dest="grasp_points", action="append", default=[], help="Explicit x,y,z point for FET005; provide at least two.")
    parser.add_argument("--grasp-parent-prim")
    parser.add_argument("--grasp-name")
    parser.add_argument("--visual-evidence", action="append", default=[])
    parser.add_argument("--grasp-rationale")
    parser.add_argument("--coordinate-note")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args(argv)
    payload = conform(args)
    emit(payload, args.report, args.markdown_report)
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
