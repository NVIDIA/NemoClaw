#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import discover_primary_usd, emit_json_report


SKILL = "urdf-usd-converter"
TOOL = "urdf_usd_converter"
SOURCE_FORMAT = "urdf"
NEXT_STEP = "validate-usd-minimum"


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
    sidecar_inputs: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    next_step: str = NEXT_STEP

    @property
    def passed(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
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

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n"

    def to_markdown(self) -> str:
        lines = [
            "# Conversion Report",
            "",
            f"- Source asset: `{self.source_asset_path}`",
            f"- Source format: `{self.source_format}`",
            f"- Converter skill: `{self.converter_skill}`",
            f"- Converter tool: `{self.converter_tool}`",
            f"- Converter command: `{' '.join(self.converter_command)}`",
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
        lines.append("")
        return "\n".join(lines)


def discover_generated_files(output_directory: Path) -> list[str]:
    if not output_directory.exists():
        return []
    return sorted(
        str(path.relative_to(output_directory))
        for path in output_directory.rglob("*")
        if path.is_file()
    )


def probe_source(source_asset: Path) -> dict[str, Any]:
    source_asset = source_asset.resolve()
    suffix = source_asset.suffix.lower()
    supported = suffix == ".urdf"
    warnings: list[str] = []
    if not supported:
        warnings.append(f"urdf_usd_converter expects a .urdf source, not {suffix or 'unknown'}")
    return {
        "source_asset_path": str(source_asset),
        "source_format": SOURCE_FORMAT if supported else "unknown",
        "converter_skill": SKILL,
        "converter_tool": TOOL,
        "supported": supported,
        "warnings": warnings,
        "errors": [],
    }


def run_external_converter(
    source_asset: Path,
    output_directory: Path,
    *,
    packages: Sequence[str] = (),
    no_layer_structure: bool = False,
    no_physics_scene: bool = False,
    comment: str | None = None,
    verbose: bool = False,
) -> ConversionReport:
    source_asset = source_asset.resolve()
    output_directory = output_directory.resolve()
    expected_output = output_directory / f"{source_asset.stem}.usda"
    extra_args: list[str] = []
    if no_layer_structure:
        extra_args.append("--no-layer-structure")
    if no_physics_scene:
        extra_args.append("--no-physics-scene")
    if verbose:
        extra_args.append("--verbose")
    if comment is not None:
        extra_args.extend(["--comment", comment])
    for package in packages:
        extra_args.extend(["--package", package])
    command = [TOOL, str(source_asset), str(output_directory), *extra_args]
    errors: list[str] = []
    warnings: list[str] = []

    if source_asset.suffix.lower() != ".urdf":
        errors.append(f"unsupported URDF source format: {source_asset.suffix.lower() or 'unknown'}")
    if not source_asset.exists():
        errors.append(f"source asset does not exist: {source_asset}")
    if shutil.which(TOOL) is None:
        errors.append(f"{TOOL} CLI is required but was not found on PATH")
    if errors:
        return _report(source_asset, output_directory, expected_output, command, packages, warnings, errors)

    output_directory.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
    if completed.returncode != 0:
        errors.append(completed.stderr.strip() or f"{TOOL} exited with {completed.returncode}")
    primary_usd = discover_primary_usd(output_directory, expected_output)
    if primary_usd is None:
        errors.append(f"converter did not produce an unambiguous primary USD output in: {output_directory}")
        primary_usd = expected_output
    elif primary_usd != expected_output:
        warnings.append(f"Converter produced primary USD `{primary_usd.name}` instead of expected `{expected_output.name}`")
    return _report(source_asset, output_directory, primary_usd, command, packages, warnings, errors)


def _report(
    source_asset: Path,
    output_directory: Path,
    output_usd_path: Path,
    command: list[str],
    packages: Sequence[str],
    warnings: list[str],
    errors: list[str],
) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format=SOURCE_FORMAT,
        converter_skill=SKILL,
        converter_tool=TOOL,
        converter_command=command,
        output_directory=str(output_directory),
        output_usd_path=str(output_usd_path) if output_usd_path.exists() else "",
        generated_files=discover_generated_files(output_directory),
        sidecar_inputs=list(packages),
        warnings=warnings,
        errors=errors,
    )


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


def emit_probe(payload: dict[str, Any], *, report_path: Path | None = None) -> None:
    emit_json_report(payload, report_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convert a URDF asset to OpenUSD and write a conversion report.")
    parser.add_argument("source_asset", type=Path)
    parser.add_argument("output_directory", type=Path, nargs="?")
    parser.add_argument("--probe", action="store_true", help="Report whether urdf_usd_converter claims this source format.")
    parser.add_argument("--no-layer-structure", action="store_true", help="Pass --no-layer-structure through to urdf_usd_converter.")
    parser.add_argument("--no-physics-scene", action="store_true", help="Pass --no-physics-scene through to urdf_usd_converter.")
    parser.add_argument("--comment", help="Pass a USD comment through to urdf_usd_converter.")
    parser.add_argument("--package", action="append", default=[], help="ROS package mapping as name=/path/to/package.")
    parser.add_argument("--verbose", action="store_true", help="Pass verbose logging through to urdf_usd_converter.")
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    if args.probe:
        payload = probe_source(args.source_asset)
        emit_probe(payload, report_path=args.report)
        return 0 if payload["supported"] else 1
    if args.output_directory is None:
        parser.error("output_directory is required unless --probe is used")

    report = run_external_converter(
        args.source_asset,
        args.output_directory,
        packages=args.package,
        no_layer_structure=args.no_layer_structure,
        no_physics_scene=args.no_physics_scene,
        comment=args.comment,
        verbose=args.verbose,
    )
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
