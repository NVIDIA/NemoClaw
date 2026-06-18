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
import subprocess
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "shared"))

import kit_app_template_cad
from preflight_manifest import load_preflight_manifest, preflight_required, preflight_status_check, ready_path_from_runtime
from script_utils import emit_json_report, subprocess_output, tail_text
from usd_convert_cad_diagnostics import summarize_usd_convert_cad_validation_failure


SKILL = "usd-convert-cad"
TOOL = "usd-convert-cad"
NEXT_STEP = "validate-usd-minimum"
UPSTREAM_REPO_URL = "https://github.com/NVIDIA-Omniverse/usd-convert-cad"
UPSTREAM_SKILL_URL = "https://github.com/NVIDIA-Omniverse/usd-convert-cad/blob/main/.agents/skills/usd-convert-cad/SKILL.md"
UPSTREAM_ROOT_ENV = "PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT"
INSTALL_HINT = (
    'export PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT="${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}" '
    "&& mkdir -p \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT\" "
    f"&& git clone {UPSTREAM_REPO_URL} \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-cad\" "
    "&& cd \"$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-cad\" "
    "&& OMNI_KIT_ACCEPT_EULA=yes python install.py && python validate.py"
)
USD_OUTPUT_SUFFIXES = {".usd", ".usda", ".usdc", ".usdz"}
UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS = 600
BACKEND_ALIASES = {
    "auto": "auto",
    "cad": "auto",
    "usd-convert-cad": "auto",
    "jt": "jt_core",
    "jt_core": "jt_core",
    "omni.kit.converter.jt_core": "jt_core",
    "dgn": "dgn_core",
    "dgn_core": "dgn_core",
    "omni.kit.converter.dgn_core": "dgn_core",
    "hoops": "hoops_core",
    "hoops_core": "hoops_core",
    "omni.kit.converter.hoops_core": "hoops_core",
}
ARM64_BACKEND_ALIASES = {*BACKEND_ALIASES, "kat", "kit", "kit-app-template"}


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
        if self.diagnostics:
            payload["diagnostics"] = self.diagnostics
        if self.install_hint:
            payload["install_hint"] = self.install_hint
        return payload

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
        if self.diagnostics:
            lines.extend(["", "## Diagnostics", ""])
            for diagnostic in self.diagnostics:
                summary = diagnostic.get("summary") or diagnostic.get("kind") or "diagnostic"
                lines.append(f"- {summary}")
                recovery_hint = diagnostic.get("recovery_hint")
                if recovery_hint:
                    lines.append(f"  Recovery: {recovery_hint}")
        if self.install_hint:
            lines.extend(["", "## Install Hint", "", self.install_hint])
        lines.append("")
        return "\n".join(lines)


def default_upstream_root() -> Path:
    root = os.environ.get(UPSTREAM_ROOT_ENV)
    if root:
        return Path(root).expanduser() / "usd-convert-cad"
    return Path.home() / ".physical-ai-skill-hub" / "upstreams" / "usd-convert-cad"


def resolve_usd_convert_cad_root(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    manifest, _, _ = load_preflight_manifest()
    manifest_root = ready_path_from_runtime(manifest, "usd_convert_cad")
    if manifest_root is not None:
        return manifest_root
    env_root = os.environ.get("USD_CONVERT_CAD_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    default = default_upstream_root().expanduser()
    if default.exists():
        return default.resolve()
    legacy = Path("~/.usd-convert-cad").expanduser()
    if legacy.exists():
        return legacy.resolve()
    return default.resolve()


def discover_generated_files(output_directory: Path) -> list[str]:
    if not output_directory.exists():
        return []
    return sorted(
        str(path.relative_to(output_directory))
        for path in output_directory.rglob("*")
        if path.is_file()
    )


def real_suffix(source_asset: Path) -> str:
    suffix = source_asset.suffix.lower()
    if suffix.lstrip(".").isdigit():
        return Path(source_asset.stem).suffix.lower()
    return suffix


def parse_upstream_cad_suffixes(upstream_root: Path) -> set[str] | None:
    formats_path = upstream_root / "src" / "usd_convert_cad" / "formats.py"
    try:
        module = ast.parse(formats_path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return None

    for node in module.body:
        if isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            names = {node.target.id} if isinstance(node.target, ast.Name) else set()
            value = node.value
        else:
            continue
        if value is None or not names.intersection({"ROUTES", "SUPPORTED_FORMATS"}):
            continue
        return parse_format_info_suffixes(value)
    return None


def parse_format_info_suffixes(value: ast.AST) -> set[str] | None:
    if not isinstance(value, (ast.Tuple, ast.List)):
        return None

    suffixes: set[str] = set()
    for route_node in value.elts:
        if not isinstance(route_node, ast.Call) or not route_node.args:
            return None
        try:
            file_types = ast.literal_eval(route_node.args[0])
        except (ValueError, SyntaxError):
            return None
        if isinstance(file_types, str):
            suffixes.add(file_types.lower())
        else:
            suffixes.update(str(file_type).lower() for file_type in file_types)
    return suffixes or None


def supported_cad_suffixes(upstream_root: Path) -> set[str] | None:
    return parse_upstream_cad_suffixes(upstream_root)


def probe_source(source_asset: Path, *, usd_convert_cad_root: Path | None = None) -> dict[str, Any]:
    source_asset = source_asset.resolve()
    if kit_app_template_cad.is_arm64_host():
        return kit_app_template_cad.probe_source(source_asset)
    if preflight_required() and usd_convert_cad_root is None:
        preflight_check = preflight_status_check("usd-convert-cad", "usd_convert_cad")
        if not preflight_check["passed"]:
            return {
                "source_asset_path": str(source_asset),
                "source_format": "unknown",
                "converter_skill": SKILL,
                "converter_tool": TOOL,
                "supported": False,
                "sidecar_inputs": [],
                "warnings": [],
                "errors": [preflight_check["message"]],
                "install_hint": preflight_check["message"],
            }
    upstream_root = resolve_usd_convert_cad_root(usd_convert_cad_root)
    suffix = real_suffix(source_asset)
    suffixes = supported_cad_suffixes(upstream_root)
    errors: list[str] = []
    warnings = [
        f"Capability lookup is read from upstream usd-convert-cad formats.py: {UPSTREAM_REPO_URL}.",
    ]
    supported = False
    if suffixes is None:
        errors.append(
            "unable to read upstream usd-convert-cad supported formats from "
            f"{upstream_root / 'src' / 'usd_convert_cad' / 'formats.py'}"
        )
    else:
        supported = suffix in suffixes
        if not supported:
            warnings.append(f"upstream usd-convert-cad does not list source suffix: {suffix or 'unknown'}")

    return {
        "source_asset_path": str(source_asset),
        "source_format": "cad" if supported else "unknown",
        "converter_skill": SKILL,
        "converter_tool": TOOL,
        "supported": supported,
        "sidecar_inputs": [str(upstream_root)],
        "warnings": warnings,
        "errors": errors,
        "install_hint": INSTALL_HINT if suffixes is None else "",
    }


def normalize_backend(backend: str) -> tuple[str, str | None]:
    value = backend.strip().lower()
    if value in BACKEND_ALIASES:
        return BACKEND_ALIASES[value], None
    return value, (
        f"unsupported backend: {backend}. CAD conversion is restricted to upstream "
        "NVIDIA usd-convert-cad with Kit converter core extensions."
    )


def cad_to_usd(
    source_asset: Path,
    output_directory: Path,
    *,
    backend: str = "auto",
    usd_convert_cad_root: Path | None = None,
    kit_app_template_root: Path | None = None,
    kit_build_dir: Path | None = None,
    kit_executable: Path | None = None,
    cad_service_extension_dir: Path | None = None,
    config_path: Path | None = None,
    execution_mode: str = "core",
    output_extension: str = ".usd",
    fine: bool = False,
    coarse: bool = False,
    tessellation_chord: float = 0.01,
    tessellation_angle: float = 30.0,
    no_materials: bool = False,
    single_mesh: bool = False,
    no_meter_units: bool = False,
    keep_hidden: bool = False,
    timeout: int = 1800,
) -> ConversionReport:
    source_asset = source_asset.resolve()
    output_directory = output_directory.resolve()
    output_extension = output_extension if output_extension.startswith(".") else f".{output_extension}"
    output_usd_path = output_directory / f"{source_asset.stem}{output_extension}"
    if kit_app_template_cad.is_arm64_host():
        backend_value = backend.strip().lower()
        if backend_value not in ARM64_BACKEND_ALIASES:
            return ConversionReport(
                source_asset_path=str(source_asset),
                source_format="cad",
                converter_skill=SKILL,
                converter_tool="none",
                converter_command=[
                    sys.executable,
                    str(Path(__file__).resolve()),
                    str(source_asset),
                    str(output_directory),
                    "--backend",
                    backend,
                ],
                output_directory=str(output_directory),
                output_usd_path="",
                generated_files=[],
                errors=[
                    f"unsupported backend: {backend}. Linux arm64 CAD conversion is restricted to the Kit App Template CAD Converter fallback."
                ],
                install_hint=kit_app_template_cad.KIT_INSTALL_HINT,
            )
        payload = kit_app_template_cad.convert_with_kit_app_template(
            source_asset,
            output_directory,
            kit_app_template_root=kit_app_template_root,
            kit_build_dir=kit_build_dir,
            kit_executable=kit_executable,
            cad_service_extension_dir=cad_service_extension_dir,
            config_path=config_path,
            output_extension=output_extension,
            execution_mode=execution_mode,
            fine=fine,
            coarse=coarse,
            tessellation_chord=tessellation_chord,
            tessellation_angle=tessellation_angle,
            no_materials=no_materials,
            single_mesh=single_mesh,
            no_meter_units=no_meter_units,
            keep_hidden=keep_hidden,
            timeout=timeout,
        )
        return ConversionReport(**payload)

    upstream_root = resolve_usd_convert_cad_root(usd_convert_cad_root)
    normalized_backend, backend_error = normalize_backend(backend)
    upstream_report = output_directory / f"{source_asset.stem}_usd_convert_cad_status.json"
    upstream_log = upstream_report.with_suffix(".log")
    upstream_validate_log = output_directory / f"{source_asset.stem}_usd_convert_cad_validate.log"
    command = [
        sys.executable,
        str(upstream_root / "convert.py"),
        str(source_asset),
        str(output_usd_path),
        "--report",
        str(upstream_report),
        "--quiet",
        "--log",
        str(upstream_log),
    ]
    warnings = [
        f"Delegating CAD conversion to upstream {TOOL}: {UPSTREAM_REPO_URL}.",
        f"Upstream agent skill reference: {UPSTREAM_SKILL_URL}.",
    ]
    if normalized_backend != "auto":
        warnings.append(
            f"Upstream usd-convert-cad no longer exposes backend selection; using its default converter for requested backend `{backend}`."
        )
    errors: list[str] = []
    if preflight_required() and usd_convert_cad_root is None:
        preflight_check = preflight_status_check("usd-convert-cad", "usd_convert_cad")
        if not preflight_check["passed"]:
            errors.append(preflight_check["message"])
    if backend_error:
        errors.append(backend_error)
    suffixes = supported_cad_suffixes(upstream_root)
    if suffixes is None:
        errors.append(
            "unable to read upstream usd-convert-cad supported formats; "
            "set USD_CONVERT_CAD_ROOT or PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT"
        )
    elif real_suffix(source_asset) not in suffixes:
        errors.append(f"unsupported CAD source format: {real_suffix(source_asset) or 'unknown'}")
    if not source_asset.exists():
        errors.append(f"source asset does not exist: {source_asset}")
    if output_extension.lower() not in USD_OUTPUT_SUFFIXES:
        errors.append(f"unsupported USD output extension: {output_extension}")
    if not upstream_root.exists():
        errors.append(
            f"usd-convert-cad checkout was not found: {upstream_root}. Clone {UPSTREAM_REPO_URL} "
            "there or set USD_CONVERT_CAD_ROOT. You can also set "
            f"{UPSTREAM_ROOT_ENV} to change the shared upstream checkout root."
        )
    elif not (upstream_root / "convert.py").exists():
        errors.append(f"usd-convert-cad convert.py was not found under checkout: {upstream_root}")
    elif not (upstream_root / "validate.py").exists():
        errors.append(f"usd-convert-cad validate.py was not found under checkout: {upstream_root}")
    if errors:
        install_hint = INSTALL_HINT if not upstream_root.exists() or not (upstream_root / "convert.py").exists() else ""
        return _report(source_asset, output_directory, output_usd_path, command, upstream_root, warnings, errors, install_hint)

    output_directory.mkdir(parents=True, exist_ok=True)
    sidecar_inputs = [str(upstream_root), str(upstream_validate_log)]
    validation_error, validation_diagnostic = validate_upstream_usd_convert_cad(upstream_root, upstream_validate_log)
    if validation_error:
        errors.append(validation_error)
        diagnostics = [validation_diagnostic] if validation_diagnostic else []
        return _report(
            source_asset,
            output_directory,
            output_usd_path,
            command,
            upstream_root,
            warnings,
            errors,
            sidecar_inputs=sidecar_inputs,
            diagnostics=diagnostics,
        )

    env = os.environ.copy()
    env.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")
    completed = subprocess.run(
        command,
        cwd=str(upstream_root),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"{TOOL} exited with {completed.returncode}"
        errors.append(detail)
    if not output_usd_path.exists() and not errors:
        errors.append(f"converter did not produce expected USD output: {output_usd_path}")
    for sidecar in (upstream_report, upstream_log):
        if sidecar.exists():
            sidecar_inputs.append(str(sidecar))
    return _report(source_asset, output_directory, output_usd_path, command, upstream_root, warnings, errors, sidecar_inputs=sidecar_inputs)


def validate_upstream_usd_convert_cad(upstream_root: Path, log_path: Path) -> tuple[str | None, dict[str, Any] | None]:
    command = [sys.executable, str(upstream_root / "validate.py")]
    env = os.environ.copy()
    env.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")
    try:
        completed = subprocess.run(
            command,
            cwd=str(upstream_root),
            env=env,
            capture_output=True,
            text=True,
            timeout=UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = subprocess_output(getattr(exc, "stdout", ""), getattr(exc, "stderr", ""))
        _write_text(log_path, output)
        return (
            "upstream usd-convert-cad readiness validation timed out after "
            f"{UPSTREAM_PREFLIGHT_TIMEOUT_SECONDS}s. Resolve the upstream usd-convert-cad runtime and rerun validate.py.",
            None,
        )

    output = subprocess_output(completed.stdout, completed.stderr)
    _write_text(log_path, output)
    if completed.returncode == 0:
        return None, None
    detail = tail_text(output) or f"validate.py exited with {completed.returncode}"
    diagnostic = summarize_usd_convert_cad_validation_failure(output, completed.returncode)
    if diagnostic:
        return (
            "upstream usd-convert-cad readiness validation failed "
            f"(exit {completed.returncode}): {diagnostic['summary']} "
            f"{diagnostic['recovery_hint']} Output: {detail}",
            diagnostic,
        )
    return (
        "upstream usd-convert-cad readiness validation failed "
        f"(exit {completed.returncode}): {detail}. Resolve the upstream usd-convert-cad runtime and rerun validate.py.",
        None,
    )


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((text or "<no output>") + "\n", encoding="utf-8")


def _report(
    source_asset: Path,
    output_directory: Path,
    output_usd_path: Path,
    command: list[str],
    upstream_root: Path,
    warnings: list[str],
    errors: list[str],
    install_hint: str = "",
    *,
    sidecar_inputs: list[str] | None = None,
    diagnostics: list[dict[str, Any]] | None = None,
) -> ConversionReport:
    return ConversionReport(
        source_asset_path=str(source_asset),
        source_format="cad",
        converter_skill=SKILL,
        converter_tool=TOOL,
        converter_command=command,
        output_directory=str(output_directory),
        output_usd_path=str(output_usd_path) if output_usd_path.exists() else "",
        generated_files=discover_generated_files(output_directory),
        sidecar_inputs=sidecar_inputs or [str(upstream_root)],
        warnings=warnings,
        errors=errors,
        diagnostics=diagnostics or [],
        install_hint=install_hint,
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
    parser = argparse.ArgumentParser(description="Convert supported source assets to OpenUSD through upstream usd-convert-cad.")
    parser.add_argument("source_asset", type=Path)
    parser.add_argument("output_directory", type=Path, nargs="?")
    parser.add_argument("--probe", action="store_true", help="Report whether upstream usd-convert-cad claims this source format.")
    parser.add_argument("--backend", default="auto", help=argparse.SUPPRESS)
    parser.add_argument("--usd-convert-cad-root", type=Path)
    parser.add_argument("--kit-app-template-root", type=Path, help="Linux arm64 fallback: local Kit App Template checkout path.")
    parser.add_argument("--kit-build-dir", type=Path, help="Linux arm64 fallback: built Kit App Template _build/<platform>/release directory.")
    parser.add_argument("--kit-executable", type=Path, help="Linux arm64 fallback: built Kit executable.")
    parser.add_argument("--cad-service-extension-dir", type=Path, help="Linux arm64 fallback service mode: omni.services.convert.cad extension directory.")
    parser.add_argument("--config-path", type=Path, help="Linux arm64 fallback: optional CAD Converter config JSON path.")
    parser.add_argument(
        "--execution-mode",
        default="core",
        choices=["core", "service"],
        help="Linux arm64 fallback: use direct CAD core extension APIs or CAD service process scripts.",
    )
    parser.add_argument("--output-extension", default=".usd", choices=sorted(USD_OUTPUT_SUFFIXES))
    quality = parser.add_mutually_exclusive_group()
    quality.add_argument("--fine", action="store_true", help="Linux arm64 fallback: use fine CAD tessellation.")
    quality.add_argument("--coarse", action="store_true", help="Linux arm64 fallback: use coarse CAD tessellation.")
    parser.add_argument("--tessellation-chord", type=float, default=0.01, help="Linux arm64 fallback CAD tessellation chord.")
    parser.add_argument("--tessellation-angle", type=float, default=30.0, help="Linux arm64 fallback CAD tessellation angle in degrees.")
    parser.add_argument("--no-materials", action="store_true", help="Linux arm64 fallback: skip material import.")
    parser.add_argument("--single-mesh", action="store_true", help="Linux arm64 fallback: request one mesh.")
    parser.add_argument("--no-meter-units", action="store_true", help="Linux arm64 fallback: do not force meters per unit.")
    parser.add_argument("--keep-hidden", action="store_true", help="Linux arm64 fallback: convert hidden CAD entities.")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--report", type=Path, help="Write a JSON report to this path.")
    parser.add_argument("--markdown-report", type=Path, help="Write a Markdown report to this path.")
    args = parser.parse_args(argv)

    if args.probe:
        payload = probe_source(args.source_asset, usd_convert_cad_root=args.usd_convert_cad_root)
        emit_probe(payload, report_path=args.report)
        return 0 if payload["supported"] else 1
    if args.output_directory is None:
        parser.error("output_directory is required unless --probe is used")

    report = cad_to_usd(
        args.source_asset,
        args.output_directory,
        backend=args.backend,
        usd_convert_cad_root=args.usd_convert_cad_root,
        kit_app_template_root=args.kit_app_template_root,
        kit_build_dir=args.kit_build_dir,
        kit_executable=args.kit_executable,
        cad_service_extension_dir=args.cad_service_extension_dir,
        config_path=args.config_path,
        execution_mode=args.execution_mode,
        output_extension=args.output_extension,
        fine=args.fine,
        coarse=args.coarse,
        tessellation_chord=args.tessellation_chord,
        tessellation_angle=args.tessellation_angle,
        no_materials=args.no_materials,
        single_mesh=args.single_mesh,
        no_meter_units=args.no_meter_units,
        keep_hidden=args.keep_hidden,
        timeout=args.timeout,
    )
    emit_report(report, report_path=args.report, markdown_report_path=args.markdown_report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
