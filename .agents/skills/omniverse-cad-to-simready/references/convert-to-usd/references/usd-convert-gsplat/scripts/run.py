#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

from script_utils import emit_json_report

from preflight_manifest import (
    load_preflight_manifest,
    preflight_required,
    preflight_status_check,
    ready_executable_from_runtime,
    ready_path_from_runtime,
    ready_path_from_upstream,
)


SKILL = "usd-convert-gsplat"
TOOL = "gsplat2USD"
NEXT_STEP = "validate-usd-minimum"
USD_OUTPUT_SUFFIXES = {".usd", ".usda", ".usdc", ".usdz"}
UPSTREAM_REPO_URL = "https://github.com/NVIDIA-Omniverse/usd-convert-gsplat"
UPSTREAM_ROOT_ENV = "PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT"


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


def default_upstream_root() -> Path:
    root = os.environ.get(UPSTREAM_ROOT_ENV)
    if root:
        return Path(root).expanduser() / "usd-convert-gsplat"
    return Path.home() / ".physical-ai-skill-hub" / "upstreams" / "usd-convert-gsplat"


def resolve_usd_convert_gsplat_root() -> Path:
    env_root = os.environ.get("USD_CONVERT_GSPLAT_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    manifest, _, _ = load_preflight_manifest()
    manifest_root = ready_path_from_runtime(manifest, "usd_convert_gsplat") or ready_path_from_upstream(manifest, "usd_convert_gsplat")
    if manifest_root is not None:
        return manifest_root
    return default_upstream_root().expanduser().resolve()


def resolve_gsplat_executable() -> str | None:
    manifest, _, _ = load_preflight_manifest()
    executable = ready_executable_from_runtime(manifest, "usd_convert_gsplat")
    return executable or shutil.which(TOOL)


def parse_upstream_gsplat_suffixes(upstream_root: Path) -> set[str] | None:
    cli_path = upstream_root / "source" / "python" / "usd_convert_gsplat" / "cli.py"
    try:
        module = ast.parse(cli_path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return None

    suffixes: set[str] = set()
    for node in ast.walk(module):
        if not isinstance(node, ast.Compare):
            continue
        if not isinstance(node.left, ast.Name) or node.left.id != "ext":
            continue
        if len(node.ops) != 1 or not isinstance(node.ops[0], ast.Eq):
            continue
        if len(node.comparators) != 1 or not isinstance(node.comparators[0], ast.Constant):
            continue
        value = node.comparators[0].value
        if isinstance(value, str) and value.startswith("."):
            suffixes.add(value.lower())
    return suffixes or None


def supported_gsplat_suffixes() -> set[str] | None:
    return parse_upstream_gsplat_suffixes(resolve_usd_convert_gsplat_root())


def probe_source(source_asset: Path) -> dict[str, Any]:
    source_asset = source_asset.resolve()
    if preflight_required():
        preflight_check = preflight_status_check("usd-convert-gsplat", "usd_convert_gsplat")
        if not preflight_check["passed"]:
            return {
                "source_asset_path": str(source_asset),
                "source_format": "unknown",
                "converter_skill": SKILL,
                "converter_tool": TOOL,
                "supported": False,
                "warnings": [],
                "errors": [preflight_check["message"]],
            }
    suffixes = supported_gsplat_suffixes()
    suffix = source_asset.suffix.lower()
    errors: list[str] = []
    warnings = [f"Capability lookup is read from upstream gsplat CLI source: {UPSTREAM_REPO_URL}."]
    supported = False
    if suffixes is None:
        errors.append(
            "unable to read upstream usd-convert-gsplat supported formats from "
            f"{resolve_usd_convert_gsplat_root() / 'source' / 'python' / 'usd_convert_gsplat' / 'cli.py'}"
        )
    else:
        supported = suffix in suffixes
        if not supported:
            warnings.append(f"upstream usd-convert-gsplat does not list source suffix: {suffix or 'unknown'}")
    return {
        "source_asset_path": str(source_asset),
        "source_format": "gsplat" if supported else "unknown",
        "converter_skill": SKILL,
        "converter_tool": TOOL,
        "supported": supported,
        "warnings": warnings,
        "errors": errors,
    }


def convert_gsplat_to_usd(
    source_asset: Path,
    output_directory: Path,
    *,
    output_extension: str = ".usda",
    prim_name: str | None = None,
    generate_sh: bool = False,
    generate_scales: bool = False,
    up_axis: str = "Y",
    rotate_x: float = 0.0,
    rotate_y: float = 0.0,
    rotate_z: float = 0.0,
) -> ConversionReport:
    source_asset = source_asset.resolve()
    output_directory = output_directory.resolve()
    output_extension = output_extension if output_extension.startswith(".") else f".{output_extension}"
    output_usd_path = output_directory / f"{source_asset.stem}{output_extension}"
    executable = resolve_gsplat_executable()
    command = [executable or TOOL, "-i", str(source_asset), "-o", str(output_usd_path), "--up-axis", up_axis]
    if prim_name:
        command.extend(["--name", prim_name])
    if generate_sh:
        command.append("--generateSh")
    if generate_scales:
        command.append("--generateScales")
    for axis, value in (("x", rotate_x), ("y", rotate_y), ("z", rotate_z)):
        if value:
            command.extend([f"--rotate-{axis}", str(value)])

    errors: list[str] = []
    warnings: list[str] = []
    suffixes = supported_gsplat_suffixes()
    if suffixes is None:
        errors.append(
            "unable to read upstream usd-convert-gsplat supported formats; "
            "set USD_CONVERT_GSPLAT_ROOT or PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT"
        )
    elif source_asset.suffix.lower() not in suffixes:
        errors.append(f"unsupported Gaussian splat source format: {source_asset.suffix.lower() or 'unknown'}")
    if output_extension.lower() not in USD_OUTPUT_SUFFIXES:
        errors.append(f"unsupported USD output extension: {output_extension}")
    if not source_asset.exists():
        errors.append(f"source asset does not exist: {source_asset}")
    if executable is None:
        errors.append(f"{TOOL} CLI is required but was not found on PATH")
    if preflight_required():
        preflight_check = preflight_status_check("usd-convert-gsplat", "usd_convert_gsplat")
        if not preflight_check["passed"]:
            errors.append(preflight_check["message"])
    if errors:
        return ConversionReport(
            source_asset_path=str(source_asset),
            source_format="gsplat" if suffixes is not None and source_asset.suffix.lower() in suffixes else "unknown",
            converter_skill=SKILL,
            converter_tool=TOOL,
            converter_command=command,
            output_directory=str(output_directory),
            output_usd_path="",
            generated_files=discover_generated_files(output_directory),
            warnings=warnings,
            errors=errors,
        )

    output_directory.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
    if completed.returncode != 0:
        errors.append(completed.stderr.strip() or f"{TOOL} exited with {completed.returncode}")
    if not output_usd_path.exists():
        errors.append(f"converter did not produce expected USD output: {output_usd_path}")
    if completed.stderr.strip() and completed.returncode == 0:
        warnings.append(completed.stderr.strip())

    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="gsplat",
        converter_skill=SKILL,
        converter_tool=TOOL,
        converter_command=command,
        output_directory=str(output_directory),
        output_usd_path=str(output_usd_path) if output_usd_path.exists() else "",
        generated_files=discover_generated_files(output_directory),
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
    parser = argparse.ArgumentParser(description="Convert Gaussian splat PLY or SPZ assets to OpenUSD.")
    parser.add_argument("source_asset", type=Path)
    parser.add_argument("output_directory", type=Path, nargs="?")
    parser.add_argument("--probe", action="store_true", help="Report whether upstream usd-convert-gsplat claims this source format.")
    parser.add_argument("--output-extension", default=".usda", choices=sorted(USD_OUTPUT_SUFFIXES))
    parser.add_argument("--name", dest="prim_name", help="USD prim name. Defaults to the source filename stem.")
    parser.add_argument("--generate-sh", action="store_true", help="Generate DC spherical harmonics from RGB when f_dc is absent.")
    parser.add_argument("--generate-scales", action="store_true", help="Generate scales from local spacing when scale_0/1/2 are absent.")
    parser.add_argument("--up-axis", choices=("Y", "Z"), default="Y")
    parser.add_argument("--rotate-x", type=float, default=0.0)
    parser.add_argument("--rotate-y", type=float, default=0.0)
    parser.add_argument("--rotate-z", type=float, default=0.0)
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    if args.probe:
        payload = probe_source(args.source_asset)
        emit_probe(payload, report_path=args.report)
        return 0 if payload["supported"] else 1
    if args.output_directory is None:
        parser.error("output_directory is required unless --probe is used")

    report = convert_gsplat_to_usd(
        args.source_asset,
        args.output_directory,
        output_extension=args.output_extension,
        prim_name=args.prim_name,
        generate_sh=args.generate_sh,
        generate_scales=args.generate_scales,
        up_axis=args.up_axis,
        rotate_x=args.rotate_x,
        rotate_y=args.rotate_y,
        rotate_z=args.rotate_z,
    )
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
