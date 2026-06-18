#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))

from script_utils import subprocess_output, tail_text


SKILL = "omni-asset-validate"
TOOL = "nvidia_usd_validate"
LEGACY_TOOL = "omni_asset_validate"
MODULE_TOOL = "usd_validation_nvidia"
LEGACY_MODULE_TOOL = "omni.asset_validator"
NEXT_STEP = "omni-asset-validate-geometry"
SEVERITIES = ("ERROR", "FAILURE", "WARNING", "INFO")


@dataclass(frozen=True)
class AssetValidatorIssue:
    rule: str
    severity: str
    message: str
    location: str | None = None
    requirement: str | None = None
    suggestion: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule": self.rule,
            "severity": self.severity,
            "message": self.message,
            "location": self.location,
            "requirement": self.requirement,
            "suggestion": self.suggestion,
        }


@dataclass(frozen=True)
class AssetValidatorReport:
    asset_path: str
    validator_skill: str
    validator_tool: str
    passed: bool
    status: str
    command: list[str]
    categories: list[str]
    rules: list[str]
    issue_counts: dict[str, int]
    issues: list[AssetValidatorIssue]
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    next_step: str = NEXT_STEP

    def to_dict(self) -> dict[str, Any]:
        return {
            "asset_path": self.asset_path,
            "validator_skill": self.validator_skill,
            "validator_tool": self.validator_tool,
            "passed": self.passed,
            "status": self.status,
            "command": self.command,
            "categories": self.categories,
            "rules": self.rules,
            "issue_counts": self.issue_counts,
            "issues": [issue.to_dict() for issue in self.issues],
            "warnings": self.warnings,
            "errors": self.errors,
            "next_step": self.next_step,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n"

    def to_markdown(self) -> str:
        lines = [
            "# Asset Validator Report",
            "",
            f"- Asset: `{self.asset_path}`",
            f"- Validator skill: `{self.validator_skill}`",
            f"- Validator tool: `{self.validator_tool}`",
            f"- Passed: `{self.passed}`",
            f"- Status: `{self.status}`",
            f"- Next step: `{self.next_step}`",
            "",
            "## Issue Counts",
            "",
        ]
        for severity in SEVERITIES:
            lines.append(f"- `{severity}`: {self.issue_counts.get(severity, 0)}")
        lines.extend(["", "## Issues", ""])
        for issue in self.issues:
            lines.append(f"- `{issue.severity}` `{issue.rule}`: {issue.message}")
        if not self.issues:
            lines.append("- None")
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in self.errors)
        if not self.errors:
            lines.append("- None")
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in self.warnings)
        if not self.warnings:
            lines.append("- None")
        lines.append("")
        return "\n".join(lines)


def dependency_blocked_report(
    asset_path: Path,
    command: list[str],
    categories: Sequence[str],
    rules: Sequence[str],
    next_step: str,
) -> AssetValidatorReport:
    error = f"{TOOL} CLI or {MODULE_TOOL} Python module from usd-validation-nvidia is required but was not found"
    return AssetValidatorReport(
        asset_path=str(asset_path),
        validator_skill=SKILL,
        validator_tool=TOOL,
        passed=False,
        status="BLOCKED",
        command=command,
        categories=list(categories),
        rules=list(rules),
        issue_counts={severity: 0 for severity in SEVERITIES},
        issues=[],
        warnings=[],
        errors=[error],
        next_step=next_step,
    )


def resolve_validator_command() -> tuple[list[str] | None, list[str], str]:
    executable = shutil.which(TOOL)
    if executable is not None:
        return [executable], [], TOOL
    legacy_executable = shutil.which(LEGACY_TOOL)
    if legacy_executable is not None:
        return [legacy_executable], [
            f"{TOOL} CLI was not found on PATH; using legacy {LEGACY_TOOL} CLI with {legacy_executable}."
        ], LEGACY_TOOL
    for module_tool in (MODULE_TOOL, LEGACY_MODULE_TOOL):
        if importlib.util.find_spec(module_tool) is not None:
            validator_tool = TOOL if module_tool == MODULE_TOOL else LEGACY_TOOL
            return [sys.executable, "-m", module_tool], [
                f"{TOOL} CLI was not found on PATH; using the {module_tool} Python module with {sys.executable}."
            ], validator_tool
    return None, [], TOOL


def flatten_issues(payload: dict[str, Any]) -> list[AssetValidatorIssue]:
    issues: list[AssetValidatorIssue] = []
    for rule_result in payload.get("rules", []):
        rule_name = rule_result.get("rule", {}).get("name", "unknown")
        for issue in rule_result.get("issues", []):
            issues.append(
                AssetValidatorIssue(
                    rule=str(issue.get("rule", {}).get("name", rule_name)),
                    severity=str(issue.get("severity", "UNKNOWN")).upper(),
                    message=str(issue.get("message", "")),
                    location=issue_location(issue),
                    requirement=issue_requirement(issue),
                    suggestion=issue_suggestion(issue),
                )
            )
    return issues


def issue_location(issue: dict[str, Any]) -> str | None:
    location = issue.get("at")
    if isinstance(location, dict):
        path = location.get("path")
        if path is not None:
            return str(path)
    if location is None:
        return None
    return str(location)


def issue_requirement(issue: dict[str, Any]) -> str | None:
    requirement = issue.get("requirement")
    if not isinstance(requirement, dict):
        return None
    code = requirement.get("code")
    if code is None:
        return None
    version = requirement.get("version")
    return f"{code}@{version}" if version else str(code)


def issue_suggestion(issue: dict[str, Any]) -> str | None:
    suggestion = issue.get("suggestion")
    if isinstance(suggestion, dict) and suggestion.get("message"):
        return str(suggestion["message"])
    suggestions = issue.get("suggestions")
    if isinstance(suggestions, list):
        messages = [str(item["message"]) for item in suggestions if isinstance(item, dict) and item.get("message")]
        if messages:
            return "; ".join(messages)
    return None


def validate_with_asset_validator(
    asset_path: Path,
    *,
    categories: Sequence[str] | None = None,
    rules: Sequence[str] | None = None,
    init_rules: bool = True,
    variants: bool = True,
    timeout: int = 120,
    next_step: str = NEXT_STEP,
) -> AssetValidatorReport:
    asset_path = asset_path.resolve()
    categories = list(categories or [])
    rules = list(rules or [])
    command = [TOOL]
    for category in categories:
        command.extend(["--category", category])
    for rule in rules:
        command.extend(["--rule", rule])
    if not init_rules:
        command.append("--no-init-rules")
    if not variants:
        command.append("--no-variants")

    command_base, fallback_warnings, validator_tool = resolve_validator_command()
    if command_base is None:
        return dependency_blocked_report(asset_path, command, categories, rules, next_step)

    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "asset-validator-report.json"
        run_command = [*command_base, *command[1:], "--json-output", str(output_path), str(asset_path)]
        try:
            completed = subprocess.run(run_command, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            return AssetValidatorReport(
                asset_path=str(asset_path),
                validator_skill=SKILL,
                validator_tool=validator_tool,
                passed=False,
                status="TIMEOUT",
                command=run_command,
                categories=categories,
                rules=rules,
                issue_counts={severity: 0 for severity in SEVERITIES},
                issues=[],
                warnings=fallback_warnings,
                errors=[_timeout_error(validator_tool, timeout, exc)],
                next_step=next_step,
            )
        if not output_path.exists():
            return AssetValidatorReport(
                asset_path=str(asset_path),
                validator_skill=SKILL,
                validator_tool=TOOL,
                passed=False,
                status="ERROR",
                command=run_command,
                categories=categories,
                rules=rules,
                issue_counts={severity: 0 for severity in SEVERITIES},
                issues=[],
                warnings=fallback_warnings,
                errors=[f"{validator_tool} did not produce JSON output", completed.stderr.strip()],
                next_step=next_step,
            )
        payload = json.loads(output_path.read_text(encoding="utf-8"))

    issues = flatten_issues(payload)
    issue_counts = {severity: 0 for severity in SEVERITIES}
    for issue in issues:
        issue_counts[issue.severity] = issue_counts.get(issue.severity, 0) + 1
    errors = [f"{issue.rule}: {issue.message}" for issue in issues if issue.severity in {"ERROR", "FAILURE"}]
    warnings = list(fallback_warnings)
    warnings.extend(f"{issue.rule}: {issue.message}" for issue in issues if issue.severity == "WARNING")
    status = str(payload.get("status", "UNKNOWN")).upper()
    if completed.returncode != 0 and not issues:
        errors.append(completed.stderr.strip() or completed.stdout.strip() or f"{TOOL} exited with {completed.returncode}")
    passed = not errors
    if passed:
        status = "PASS"
    elif status == "PASS":
        status = "FAIL"

    return AssetValidatorReport(
        asset_path=str(asset_path),
        validator_skill=SKILL,
        validator_tool=validator_tool,
        passed=passed,
        status=status,
        command=run_command,
        categories=categories,
        rules=rules,
        issue_counts=issue_counts,
        issues=issues,
        warnings=warnings,
        errors=errors,
        next_step=next_step,
    )


def _timeout_error(validator_tool: str, timeout: int, exc: subprocess.TimeoutExpired) -> str:
    detail = subprocess_output(getattr(exc, "stdout", ""), getattr(exc, "stderr", ""))
    message = f"{validator_tool} timed out after {timeout}s. Increase --timeout for large USD assets."
    return f"{message} Output: {tail_text(detail, 2000)}" if detail else message


def emit_report(
    report: AssetValidatorReport,
    *,
    report_path: Path | None = None,
    markdown_report_path: Path | None = None,
) -> None:
    report_json = report.to_json()
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report_json, encoding="utf-8")
    if markdown_report_path is not None:
        markdown_report_path.parent.mkdir(parents=True, exist_ok=True)
        markdown_report_path.write_text(report.to_markdown(), encoding="utf-8")
    print(report_json, end="")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate an OpenUSD asset with NVIDIA Asset Validator.")
    parser.add_argument("asset_path", type=Path)
    parser.add_argument("--category", action="append", default=[])
    parser.add_argument("--rule", action="append", default=[])
    parser.add_argument("--no-init-rules", action="store_true")
    parser.add_argument("--no-variants", action="store_true")
    parser.add_argument("--timeout", type=int, default=120, help="Seconds to wait for Asset Validator before returning a timeout report.")
    parser.add_argument("--next-step", default=NEXT_STEP)
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    report = validate_with_asset_validator(
        args.asset_path,
        categories=args.category,
        rules=args.rule,
        init_rules=not args.no_init_rules,
        variants=not args.no_variants,
        timeout=args.timeout,
        next_step=args.next_step,
    )
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
