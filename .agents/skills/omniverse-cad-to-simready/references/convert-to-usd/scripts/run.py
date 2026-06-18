#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Route a source asset by asking upstream converter references for support.

Usage:
    python3 scripts/run.py <source_asset> <output_directory> [--report PATH]
    python3 scripts/run.py <source_asset> <output_directory> [--markdown-report PATH]

Arguments:
    source_asset            Path to the input file or directory to convert.
    output_directory        Directory to write the generated USD artifact and reports.
    --report PATH           Optional path to write the normalized conversion report (JSON).
    --markdown-report PATH  Optional path to write the normalized conversion report (Markdown).

Exit codes:
    0 - conversion succeeded or source is already USD
    1 - expected failure (unsupported source format or missing required converter)
    2 - unexpected error (crash or malformed input)
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field, replace
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any
import zipfile


SKILL = "convert-to-usd"
NEXT_STEP = "validate-usd-minimum"
PROBE_TIMEOUT_SECONDS = 30
CONVERSION_TIMEOUT_SECONDS = 1900
REFERENCE_ORDER = (
    "urdf-usd-converter",
    "mujoco-usd-converter",
    "usd-convert-gsplat",
    "usd-convert-cad",
)


@dataclass(frozen=True)
class ProbeResult:
    converter_skill: str
    converter_tool: str
    source_format: str
    supported: bool
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    install_hint: str = ""


@dataclass(frozen=True)
class SourceSelection:
    source_asset: Path
    warnings: list[str] = field(default_factory=list)
    selected_probe: ProbeResult | None = None
    probes: list[ProbeResult] = field(default_factory=list)


@dataclass(frozen=True)
class ConversionReport:
    source_asset_path: str
    source_format: str
    converter_skill: str
    converter_tool: str
    converter_command: list[str]
    output_directory: str
    output_usd_path: str
    generated_files: list[str]
    converter_reference: str = ""
    sidecar_inputs: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    install_hint: str = ""
    next_step: str = NEXT_STEP

    @property
    def passed(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "source_asset_path": self.source_asset_path,
            "source_format": self.source_format,
            "converter_skill": self.converter_skill,
            "converter_tool": self.converter_tool,
            "converter_command": self.converter_command,
            "output_directory": self.output_directory,
            "output_usd_path": self.output_usd_path,
            "generated_files": self.generated_files,
            "sidecar_inputs": self.sidecar_inputs,
            "warnings": self.warnings,
            "errors": self.errors,
            "next_step": self.next_step,
        }
        if self.converter_reference:
            payload["converter_reference"] = self.converter_reference
        if self.diagnostics:
            payload["diagnostics"] = self.diagnostics
        if self.install_hint:
            payload["install_hint"] = self.install_hint
        return payload

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n"

    def to_markdown(self) -> str:
        command = " ".join(self.converter_command)
        lines = [
            "# Conversion Report",
            "",
            f"- Source asset: `{self.source_asset_path}`",
            f"- Source format: `{self.source_format}`",
            f"- Converter skill: `{self.converter_skill}`",
            f"- Converter tool: `{self.converter_tool}`",
            f"- Converter command: `{command}`",
            f"- Output directory: `{self.output_directory}`",
            f"- Output USD: `{self.output_usd_path}`",
            f"- Next step: `{self.next_step}`",
            "",
            "## Generated Files",
            "",
        ]
        lines.extend(f"- `{path}`" for path in self.generated_files)
        if not self.generated_files:
            lines.append("- None")
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in self.warnings)
        if not self.warnings:
            lines.append("- None")
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in self.errors)
        if not self.errors:
            lines.append("- None")
        if self.install_hint:
            lines.extend(["", "## Install Hint", "", self.install_hint])
        lines.append("")
        return "\n".join(lines)


def reference_root() -> Path:
    return Path(__file__).resolve().parents[1] / "references"


def reference_run_script(converter_skill: str) -> Path:
    return reference_root() / converter_skill / "scripts" / "run.py"


def is_existing_usd(source_asset: Path) -> bool:
    if not source_asset.is_file():
        return False
    try:
        with source_asset.open("rb") as file:
            header = file.read(16)
    except OSError:
        return False
    if header.startswith(b"#usda") or header.startswith(b"PXR-USDC"):
        return True
    if zipfile.is_zipfile(source_asset):
        try:
            with zipfile.ZipFile(source_asset) as archive:
                for name in archive.namelist():
                    with archive.open(name) as member:
                        member_header = member.read(16)
                    if member_header.startswith(b"#usda") or member_header.startswith(b"PXR-USDC"):
                        return True
                return False
        except zipfile.BadZipFile:
            return False
    return False


def already_usd_report(source_asset: Path, output_directory: Path) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="usd",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path=str(source_asset),
        generated_files=[],
        warnings=["Source asset is already USD; conversion skipped"],
    )


def missing_source_report(source_asset: Path, output_directory: Path) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="unknown",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        errors=["Source asset does not exist"],
    )


def run_probe(source_asset: Path, converter_skill: str) -> ProbeResult:
    script = reference_run_script(converter_skill)
    if not script.exists():
        return ProbeResult(
            converter_skill=converter_skill,
            converter_tool="none",
            source_format="unknown",
            supported=False,
            errors=[f"converter reference script is missing: {script}"],
        )

    command = [sys.executable, str(script), str(source_asset), "--probe"]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ProbeResult(
            converter_skill=converter_skill,
            converter_tool=converter_skill,
            source_format="unknown",
            supported=False,
            errors=[f"converter probe timed out after {PROBE_TIMEOUT_SECONDS}s: {converter_skill}"],
        )

    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
        return ProbeResult(
            converter_skill=converter_skill,
            converter_tool=converter_skill,
            source_format="unknown",
            supported=False,
            errors=[f"converter probe did not return JSON for {converter_skill}: {detail}"],
        )

    return ProbeResult(
        converter_skill=str(payload.get("converter_skill") or converter_skill),
        converter_tool=str(payload.get("converter_tool") or converter_skill),
        source_format=str(payload.get("source_format") or "unknown"),
        supported=bool(payload.get("supported")),
        warnings=[str(warning) for warning in payload.get("warnings", [])],
        errors=[str(error) for error in payload.get("errors", [])],
        install_hint=str(payload.get("install_hint") or ""),
    )


def probe_warnings(probes: list[ProbeResult]) -> list[str]:
    warnings: list[str] = []
    for probe in probes:
        status = "supported" if probe.supported else "not supported"
        warnings.append(f"Probe {probe.converter_skill}: {status} ({probe.source_format})")
        warnings.extend(f"{probe.converter_skill}: {warning}" for warning in probe.warnings)
        warnings.extend(f"{probe.converter_skill}: {error}" for error in probe.errors)
    return warnings


def select_converter(source_asset: Path) -> tuple[str | None, ProbeResult | None, list[ProbeResult]]:
    probes = [run_probe(source_asset, converter_skill) for converter_skill in REFERENCE_ORDER]
    supported = [probe for probe in probes if probe.supported]
    if not supported:
        return None, None, probes
    selected = supported[0]
    return selected.converter_skill, selected, probes


def source_relative_label(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def supported_source_label(selection: SourceSelection, root: Path) -> str:
    label = source_relative_label(selection.source_asset, root)
    if selection.selected_probe is None:
        return f"`{label}` (existing USD)"
    return f"`{label}` ({selection.selected_probe.converter_skill}, {selection.selected_probe.source_format})"


def report_with_warnings(report: ConversionReport, warnings: list[str]) -> ConversionReport:
    if not warnings:
        return report
    return replace(report, warnings=[*warnings, *report.warnings])


def directory_inspection_report(source_directory: Path, output_directory: Path, error: str) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_directory),
        source_format="unknown",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        errors=[error],
    )


def unsupported_directory_report(
    source_directory: Path,
    output_directory: Path,
    inspected_count: int,
    probes: list[ProbeResult],
) -> ConversionReport:
    install_hint = next((probe.install_hint for probe in probes if probe.install_hint), "")
    if inspected_count == 0:
        detail = "no files"
        error = "directory source is empty; expected exactly one supported source file"
    else:
        detail = f"{inspected_count} file(s)"
        error = (
            "directory source does not contain a supported source file among "
            f"{inspected_count} inspected file(s)"
        )
    return ConversionReport(
        source_asset_path=str(source_directory),
        source_format="unknown",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        warnings=[f"Inspected directory source `{source_directory}` and found {detail}."],
        errors=[error],
        install_hint=install_hint,
    )


def ambiguous_directory_report(
    source_directory: Path,
    output_directory: Path,
    selections: list[SourceSelection],
) -> ConversionReport:
    candidates = ", ".join(supported_source_label(selection, source_directory) for selection in selections)
    return ConversionReport(
        source_asset_path=str(source_directory),
        source_format="unknown",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        errors=[
            "directory source is ambiguous because multiple supported source files were found: "
            f"{candidates}. Pass one source file explicitly."
        ],
    )


def select_directory_source(
    source_directory: Path,
    output_directory: Path,
) -> tuple[SourceSelection | None, ConversionReport | None]:
    try:
        files = sorted(
            (path for path in source_directory.rglob("*") if path.is_file()),
            key=lambda path: source_relative_label(path, source_directory),
        )
    except OSError as exc:
        return None, directory_inspection_report(
            source_directory,
            output_directory,
            f"could not inspect directory source: {exc}",
        )

    selections: list[SourceSelection] = []
    probes: list[ProbeResult] = []
    for path in files:
        if is_existing_usd(path):
            selections.append(SourceSelection(source_asset=path))
            continue
        _, selected_probe, source_probes = select_converter(path)
        probes.extend(source_probes)
        if selected_probe is not None:
            selections.append(
                SourceSelection(source_asset=path, selected_probe=selected_probe, probes=source_probes)
            )

    if not selections:
        return None, unsupported_directory_report(source_directory, output_directory, len(files), probes)
    if len(selections) > 1:
        return None, ambiguous_directory_report(source_directory, output_directory, selections)

    selection = selections[0]
    label = source_relative_label(selection.source_asset, source_directory)
    warning = f"Directory source contained exactly one supported source file; selected `{label}` for conversion."
    return replace(selection, warnings=[warning]), None


def run_converter(source_asset: Path, output_directory: Path, converter_skill: str) -> ConversionReport:
    script = reference_run_script(converter_skill)
    with tempfile.TemporaryDirectory(prefix="convert-to-usd-") as temp_dir:
        report_path = Path(temp_dir) / "conversion.json"
        command = [
            sys.executable,
            str(script),
            str(source_asset),
            str(output_directory),
            "--report",
            str(report_path),
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=CONVERSION_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ConversionReport(
                source_asset_path=str(source_asset),
                source_format="unknown",
                converter_skill=converter_skill,
                converter_reference=converter_skill,
                converter_tool=converter_skill,
                converter_command=command,
                output_directory=str(output_directory),
                output_usd_path="",
                generated_files=[],
                errors=[f"converter timed out after {CONVERSION_TIMEOUT_SECONDS}s: {converter_skill}"],
            )

        if report_path.exists():
            try:
                payload = json.loads(report_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                return malformed_converter_report(source_asset, output_directory, converter_skill, command, f"invalid JSON report: {exc}")
        else:
            detail = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
            return malformed_converter_report(source_asset, output_directory, converter_skill, command, f"missing converter report: {detail}")

    return report_from_payload(payload, converter_skill)


def malformed_converter_report(
    source_asset: Path,
    output_directory: Path,
    converter_skill: str,
    command: list[str],
    error: str,
) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="unknown",
        converter_skill=converter_skill,
        converter_reference=converter_skill,
        converter_tool=converter_skill,
        converter_command=command,
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        errors=[error],
    )


def report_from_payload(payload: dict[str, Any], converter_skill: str) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(payload.get("source_asset_path") or ""),
        source_format=str(payload.get("source_format") or "unknown"),
        converter_skill=str(payload.get("converter_skill") or converter_skill),
        converter_reference=str(payload.get("converter_reference") or payload.get("converter_skill") or converter_skill),
        converter_tool=str(payload.get("converter_tool") or converter_skill),
        converter_command=[str(part) for part in payload.get("converter_command", [])],
        output_directory=str(payload.get("output_directory") or ""),
        output_usd_path=str(payload.get("output_usd_path") or ""),
        generated_files=[str(path) for path in payload.get("generated_files", [])],
        sidecar_inputs=[str(path) for path in payload.get("sidecar_inputs", [])],
        warnings=[str(warning) for warning in payload.get("warnings", [])],
        errors=[str(error) for error in payload.get("errors", [])],
        diagnostics=[diagnostic for diagnostic in payload.get("diagnostics", []) if isinstance(diagnostic, dict)],
        install_hint=str(payload.get("install_hint") or ""),
        next_step=str(payload.get("next_step") or NEXT_STEP),
    )


def append_selection_warnings(report: ConversionReport, selected: ProbeResult, probes: list[ProbeResult]) -> ConversionReport:
    supported = [probe.converter_skill for probe in probes if probe.supported]
    warnings = list(report.warnings)
    warnings.append(f"Router selected `{selected.converter_skill}` from upstream converter capability probes.")
    if len(supported) > 1:
        warnings.append(
            "Multiple converter references reported support; selected by converter-reference priority: "
            + ", ".join(supported)
        )
    return ConversionReport(
        source_asset_path=report.source_asset_path,
        source_format=report.source_format,
        converter_skill=report.converter_skill,
        converter_reference=report.converter_reference,
        converter_tool=report.converter_tool,
        converter_command=report.converter_command,
        output_directory=report.output_directory,
        output_usd_path=report.output_usd_path,
        generated_files=report.generated_files,
        sidecar_inputs=report.sidecar_inputs,
        warnings=warnings,
        errors=report.errors,
        diagnostics=report.diagnostics,
        install_hint=report.install_hint,
        next_step=report.next_step,
    )


def unsupported_report(source_asset: Path, output_directory: Path, probes: list[ProbeResult]) -> ConversionReport:
    install_hint = next((probe.install_hint for probe in probes if probe.install_hint), "")
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="unknown",
        converter_skill=SKILL,
        converter_tool="none",
        converter_command=[],
        output_directory=str(output_directory),
        output_usd_path="",
        generated_files=[],
        warnings=probe_warnings(probes),
        errors=["no converter reference reported support for this source asset"],
        install_hint=install_hint,
    )


def convert_to_usd(source_asset: Path, output_directory: Path) -> ConversionReport:
    source_asset = source_asset.resolve()
    output_directory = output_directory.resolve()
    directory_warnings: list[str] = []
    selected_probe: ProbeResult | None = None
    probes: list[ProbeResult] = []

    if not source_asset.exists():
        return missing_source_report(source_asset, output_directory)
    if source_asset.is_dir():
        selection, report = select_directory_source(source_asset, output_directory)
        if report is not None:
            return report
        if selection is None:
            return unsupported_directory_report(source_asset, output_directory, 0, [])
        source_asset = selection.source_asset
        directory_warnings = selection.warnings
        selected_probe = selection.selected_probe
        probes = selection.probes
    if is_existing_usd(source_asset):
        return report_with_warnings(already_usd_report(source_asset, output_directory), directory_warnings)

    if selected_probe is None:
        converter_skill, selected_probe, probes = select_converter(source_asset)
    else:
        converter_skill = selected_probe.converter_skill
    if converter_skill is None or selected_probe is None:
        return unsupported_report(source_asset, output_directory, probes)

    report = run_converter(source_asset, output_directory, converter_skill)
    return report_with_warnings(append_selection_warnings(report, selected_probe, probes), directory_warnings)


def emit_report(
    report: ConversionReport,
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
    parser = argparse.ArgumentParser(description="Route a source asset by querying upstream converter references.")
    parser.add_argument("source_asset", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    report = convert_to_usd(args.source_asset, args.output_directory)
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
