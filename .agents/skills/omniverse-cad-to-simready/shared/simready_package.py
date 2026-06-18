#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any

from script_utils import check_result_with_code as _check, emit_json_report


PACKAGING_DEFINITION_FILENAME = "com.nvidia.simready.packaging.json"
METADATA_FOLDER = ".metadata"
BOM_FILENAME = "com.nvidia.simready.packaging.bom.json"
ROOT_USDS_FILENAME = "com.nvidia.simready.root_usds.json"
STANDARD_FORMAT_VERSION = "1.0"
SIMREADY_PROFILE_VERSION = "1.0.0"
PACKAGE_ID_PREFIX = "com.nvidia.simready"
PACKAGE_ROOT_USD_SUFFIXES = {".usd", ".usda", ".usdc"}
SUPPORTED_REFERENCED_SUFFIXES = {".usd", ".usda", ".usdc", ".usdz", ".png", ".jpg", ".jpeg", ".exr", ".m4a", ".mp3", ".wav"}
SUPPORTED_PACKAGE_SIDECAR_SUFFIXES = {".json", ".md", ".txt"}
PROFILE_CHOICES = ("Package", "Package-NoBOM")


def _skill_name() -> str:
    return Path(sys.argv[0]).resolve().parents[1].name


def _phase(name: str, checks: list[dict[str, Any]], success_message: str, fail_message: str) -> dict[str, Any]:
    passed = not _errors_from_checks(checks)
    return {
        "name": name,
        "passed": passed,
        "status": "PASS" if passed else "FAIL",
        "message": success_message if passed else fail_message,
        "checks": checks,
    }


def _errors_from_checks(checks: list[dict[str, Any]]) -> list[str]:
    return [check["message"] for check in checks if check["severity"] == "error" and not check["passed"]]


def _warnings_from_checks(checks: list[dict[str, Any]]) -> list[str]:
    return [check["message"] for check in checks if check["severity"] == "warning" and not check["passed"]]


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _hash_bytes(data: bytes) -> dict[str, str]:
    return {"sha256": hashlib.sha256(data).hexdigest()}


def _hash_file(path: Path) -> dict[str, str]:
    return _hash_bytes(path.read_bytes())


def _content_files(package_root: Path) -> list[Path]:
    files: list[Path] = []
    for path in package_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(package_root).as_posix()
        if rel == PACKAGING_DEFINITION_FILENAME:
            continue
        if rel == METADATA_FOLDER or rel.startswith(f"{METADATA_FOLDER}/"):
            continue
        if rel.endswith(".wrapp"):
            continue
        files.append(path)
    return sorted(files, key=lambda value: value.relative_to(package_root).as_posix())


def _build_bom(package_root: Path) -> dict[str, Any]:
    items = []
    for path in _content_files(package_root):
        items.append(
            {
                "relative_path": path.relative_to(package_root).as_posix(),
                "size": path.stat().st_size,
                "hash": _hash_file(path),
            }
        )
    return {
        "format_version": STANDARD_FORMAT_VERSION,
        "content_root": str(package_root),
        "items": items,
    }


def _compute_content_hash(items: list[dict[str, Any]]) -> dict[str, str] | None:
    buffer = bytearray()
    for item in sorted(items, key=lambda value: str(value["relative_path"]).encode("utf-8")):
        sha256 = item.get("hash", {}).get("sha256")
        if not sha256:
            return None
        buffer.extend(str(item["relative_path"]).encode("utf-8"))
        buffer.append(0)
        buffer.extend(bytes.fromhex(sha256))
    return _hash_bytes(bytes(buffer))


def _compute_package_hash(
    package_id: str,
    license_id: str,
    content_hash: dict[str, str],
    metadata_entries: list[dict[str, Any]],
) -> dict[str, str]:
    buffer = bytearray()
    buffer.extend(package_id.encode("utf-8"))
    buffer.append(0)
    buffer.extend(license_id.encode("utf-8"))
    buffer.append(0)
    buffer.extend(bytes.fromhex(content_hash["sha256"]))
    for entry in sorted(metadata_entries, key=lambda value: str(value["name"]).encode("utf-8")):
        buffer.extend(str(entry["name"]).encode("utf-8"))
        buffer.append(0)
        buffer.extend(bytes.fromhex(entry["hash"]["sha256"]))
    return _hash_bytes(bytes(buffer))


def _is_valid_posix_relative_path(value: str) -> bool:
    pure = PurePosixPath(value)
    if "\\" in value or pure.is_absolute():
        return False
    if not value or value.startswith("../") or value == ".." or "/../" in value:
        return False
    return True


def _open_usd(path: Path) -> bool:
    try:
        from pxr import Usd
    except Exception:
        return False
    try:
        return Usd.Stage.Open(str(path)) is not None
    except Exception:
        return False


def _validate_root_usds(package_root: Path, root_usds: list[str] | None) -> tuple[list[dict[str, Any]], list[str]]:
    checks: list[dict[str, Any]] = []
    entries = sorted(root_usds or [])
    checks.append(
        _check(
            "root_usds_declared",
            bool(entries),
            "Root USD entries are declared" if entries else "No root USD entries were declared",
            code="PKG.CONF.002",
        )
    )
    valid_entries: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        duplicate = entry in seen
        seen.add(entry)
        checks.append(_check(f"root_usd_unique:{entry}", not duplicate, f"Root USD entry is unique: {entry}" if not duplicate else f"Duplicate root USD entry: {entry}", code="PKG.CONF.002"))
        rel_ok = _is_valid_posix_relative_path(entry)
        checks.append(_check(f"root_usd_relative:{entry}", rel_ok, f"Root USD entry is relative: {entry}" if rel_ok else f"Root USD entry must be a forward-slash relative package path: {entry}", code="PKG.CONF.002"))
        suffix_ok = Path(entry).suffix.lower() in PACKAGE_ROOT_USD_SUFFIXES
        checks.append(_check(f"root_usd_suffix:{entry}", suffix_ok, f"Root USD entry has supported suffix: {entry}" if suffix_ok else f"Root USD entry must end with .usd, .usda, or .usdc: {entry}", code="PKG.CONF.002"))
        if not rel_ok:
            continue
        path = package_root / PurePosixPath(entry)
        exists = path.is_file()
        checks.append(_check(f"root_usd_exists:{entry}", exists, f"Root USD exists: {entry}" if exists else f"Root USD does not exist: {entry}", code="PKG.CONF.002"))
        if exists:
            opens = _open_usd(path)
            checks.append(_check(f"root_usd_opens:{entry}", opens, f"Root USD opens: {entry}" if opens else f"Root USD cannot be opened: {entry}", code="PKG.CONF.002"))
            if opens:
                valid_entries.append(entry)
    return checks, valid_entries


def _validate_sidecar_types(package_root: Path) -> list[dict[str, Any]]:
    unsupported: list[str] = []
    for path in _content_files(package_root):
        suffix = path.suffix.lower()
        if suffix in SUPPORTED_REFERENCED_SUFFIXES or suffix in SUPPORTED_PACKAGE_SIDECAR_SUFFIXES:
            continue
        unsupported.append(path.relative_to(package_root).as_posix())
    return [
        _check(
            "package_content_file_types",
            not unsupported,
            "Package content file types are supported"
            if not unsupported
            else f"Package contains files outside the MVP supported type set: {unsupported}",
            severity="warning",
            code="AA.002",
        )
    ]


def validate_package_source(package_root: Path, root_usds: list[str] | None) -> dict[str, Any]:
    package_root = package_root.resolve()
    checks = [
        _check(
            "source_is_directory",
            package_root.is_dir(),
            "Source package root exists" if package_root.is_dir() else "Source package root does not exist or is not a directory",
        )
    ]
    if package_root.is_dir():
        root_checks, _ = _validate_root_usds(package_root, root_usds)
        checks.extend(root_checks)
        checks.extend(_validate_sidecar_types(package_root))
    return _phase("pre-validation", checks, "Source passed package candidate checks", "Source failed package candidate checks")


def _write_root_usds_metadata(package_root: Path, root_usds: list[str]) -> Path:
    path = package_root / METADATA_FOLDER / ROOT_USDS_FILENAME
    _write_json(path, {"format_version": STANDARD_FORMAT_VERSION, "entries": sorted(root_usds)})
    return path


def _write_bom_metadata(package_root: Path, bom: dict[str, Any]) -> Path:
    path = package_root / METADATA_FOLDER / BOM_FILENAME
    _write_json(path, bom)
    return path


def _write_conformance_metadata(
    package_root: Path,
    root_usds: list[str],
    pre_checks: list[dict[str, Any]],
    content_hash: dict[str, str] | None,
) -> Path:
    path = package_root / METADATA_FOLDER / f"com.nvidia.simready.conformance.Package-Candidate@{SIMREADY_PROFILE_VERSION}.json"
    payload: dict[str, Any] = {
        "format_version": STANDARD_FORMAT_VERSION,
        "profile": "Package-Candidate",
        "profile_version": SIMREADY_PROFILE_VERSION,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "validator": "nv-core-package-sample/scripts/run.py",
        "assets": [
            {
                "asset": entry,
                "features": [
                    {
                        "portable_simready_package_preflight": {
                            "version": "0.1.0",
                            "passed": not _errors_from_checks(pre_checks),
                            "failing_requirements": sorted({check["code"] for check in pre_checks if check["code"] and not check["passed"]}),
                            "dependencies": [],
                        }
                    }
                ],
            }
            for entry in root_usds
        ],
    }
    if content_hash is not None:
        payload["content_hash"] = content_hash
    _write_json(path, payload)
    return path


def _metadata_entry(path: Path) -> dict[str, Any]:
    return {"name": path.name, "hash": _hash_file(path)}


def _write_package_definition(
    package_root: Path,
    name: str,
    version: str,
    license_id: str,
    metadata_files: list[Path],
    content_hash: dict[str, str] | None,
    overwrite: bool,
) -> Path:
    path = package_root / PACKAGING_DEFINITION_FILENAME
    if path.exists() and not overwrite:
        raise FileExistsError(f"Package definition already exists at {path}; pass --overwrite to replace it")
    metadata_entries = [_metadata_entry(path) for path in sorted(metadata_files, key=lambda value: value.name)]
    package_id = f"{PACKAGE_ID_PREFIX}.{name}.{version}"
    payload: dict[str, Any] = {
        "format_version": STANDARD_FORMAT_VERSION,
        "package_id": package_id,
        "license": license_id,
        "metadata": metadata_entries,
    }
    if content_hash is not None:
        payload["content_hash"] = content_hash
        payload["package_hash"] = _compute_package_hash(package_id, license_id, content_hash, metadata_entries)
    _write_json(path, payload)
    return path


def _base_report(package_root: Path, skill: str, operation: str, backend: str, profile: str) -> dict[str, Any]:
    return {
        "package_root": str(package_root.resolve()),
        "package_definition_path": None,
        "skill": skill,
        "tool": "portable SimReady package script",
        "operation": operation,
        "backend": backend,
        "profile": profile,
        "passed": False,
        "status": "FAIL",
        "checks": [],
        "phases": [],
        "metadata": {},
        "warnings": [],
        "errors": [],
        "command": [],
        "next_step": "report-validation-result",
    }


def _finalize(report: dict[str, Any]) -> dict[str, Any]:
    checks = list(report.get("checks", []))
    for phase in report.get("phases", []):
        checks.extend(phase.get("checks", []))
    errors = list(dict.fromkeys(report.get("errors", []) + _errors_from_checks(checks)))
    warnings = list(dict.fromkeys(report.get("warnings", []) + _warnings_from_checks(checks)))
    report["errors"] = errors
    report["warnings"] = warnings
    report["passed"] = not errors
    report["status"] = "PASS" if not errors else report.get("status", "FAIL")
    if errors and report["status"] == "PASS":
        report["status"] = "FAIL"
    return report


def _run_wrapp_sample(args: argparse.Namespace) -> dict[str, Any]:
    source = args.source.resolve()
    report = _base_report(source, "nv-core-package-sample", "package", "wrapp", "Package")
    sample_dir = args.upstream_sample_dir.resolve() if args.upstream_sample_dir else None
    checks = [
        _check(
            "upstream_sample_dir_provided",
            sample_dir is not None,
            "WRAPP upstream package script directory provided"
            if sample_dir is not None
            else (
                "WRAPP backend requires --upstream-scripts-dir pointing at "
                "skills/simready-foundation-create-package/assets/scripts"
            ),
        )
    ]
    script = sample_dir / "create_simready_package.py" if sample_dir is not None else None
    checks.append(
        _check(
            "upstream_sample_script_exists",
            script is not None and script.is_file(),
            f"Found upstream package sample script: {script}" if script is not None and script.is_file() else "Upstream create_simready_package.py was not found",
        )
    )
    checks.append(_check("wrapp_repo_provided", args.repo is not None, "WRAPP repository path provided" if args.repo else "WRAPP backend requires --repo"))
    checks.append(_check("root_usds_provided", bool(args.root_usd), "Root USD entries provided" if args.root_usd else "WRAPP backend requires at least one --root-usd entry", code="PKG.CONF.002"))
    report["checks"] = checks
    if _errors_from_checks(checks):
        report["status"] = "BLOCKED"
        report["next_step"] = "provide-wrapp-package-inputs"
        return _finalize(report)

    command = [
        sys.executable,
        str(script),
        args.name,
        args.version,
        args.license_id,
        str(source),
        str(args.repo.resolve()),
    ]
    for root_usd in args.root_usd:
        command.extend(["--root-usd", root_usd])
    report["command"] = command
    env = os.environ.copy()
    if sample_dir.parts[-4:] == ("skills", "simready-foundation-create-package", "assets", "scripts"):
        env.setdefault("SIMREADY_FOUNDATIONS_ROOT", str(sample_dir.parents[3]))
    completed = subprocess.run(
        command,
        cwd=sample_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    report["metadata"] = {"stdout": completed.stdout, "stderr": completed.stderr, "returncode": completed.returncode}
    report["checks"].append(_check("upstream_sample_completed", completed.returncode == 0, "Upstream package sample completed" if completed.returncode == 0 else "Upstream package sample failed"))
    report["next_step"] = "nv-core-package-sample-validation" if completed.returncode == 0 else "fix-package-workflow-inputs"
    return _finalize(report)


def create_package(args: argparse.Namespace) -> dict[str, Any]:
    if args.backend == "wrapp":
        return _run_wrapp_sample(args)

    source = args.source.resolve()
    report = _base_report(source, "nv-core-package-sample", "package", "local", "Package")
    report["command"] = [str(Path(__file__).name), str(source), "--name", args.name, "--version", args.version, "--license", args.license_id]

    pre_phase = validate_package_source(source, args.root_usd)
    if not args.skip_pre_validation:
        report["phases"].append(pre_phase)
        if not pre_phase["passed"]:
            report["next_step"] = "fix-package-candidate"
            return _finalize(report)

    try:
        normalized_roots = sorted(args.root_usd)
        root_metadata = _write_root_usds_metadata(source, normalized_roots)
        bom = _build_bom(source)
        content_hash = _compute_content_hash(bom["items"])
        bom_path = _write_bom_metadata(source, bom)
        conformance_path = _write_conformance_metadata(source, normalized_roots, pre_phase["checks"], content_hash)
        metadata_files = [root_metadata, bom_path, conformance_path]
        package_definition = _write_package_definition(
            source,
            args.name,
            args.version,
            args.license_id,
            metadata_files,
            content_hash,
            args.overwrite,
        )
    except Exception as exc:
        create_checks = [_check("package_definition_written", False, f"Package creation failed: {exc}")]
        report["phases"].append(_phase("create", create_checks, "Package definition and metadata were written", str(exc)))
        report["next_step"] = "fix-package-create-inputs"
        return _finalize(report)

    create_checks = [
        _check("package_definition_written", package_definition.is_file(), f"Wrote package definition: {package_definition}"),
        _check("bom_written", bom_path.is_file(), f"Wrote BOM metadata: {bom_path}", code="PKG.BOM.001"),
        _check("root_usds_written", root_metadata.is_file(), f"Wrote root USD metadata: {root_metadata}", code="PKG.CONF.002"),
    ]
    report["phases"].append(_phase("create", create_checks, "Package definition and metadata were written", "Package creation failed"))
    report["package_definition_path"] = str(package_definition)
    report["metadata"] = {
        "package_id": f"{PACKAGE_ID_PREFIX}.{args.name}.{args.version}",
        "root_usds": normalized_roots,
        "metadata_files": [str(path) for path in metadata_files],
        "bom_item_count": len(bom["items"]),
        "content_hash": content_hash,
    }

    if not args.skip_post_validation:
        validation_report = validate_package(package_definition, profile="Package")
        report["phases"].append(
            {
                "name": "post-validation",
                "passed": validation_report["passed"],
                "status": validation_report["status"],
                "message": "Package post-validation passed" if validation_report["passed"] else "Package post-validation failed",
                "checks": validation_report["checks"],
            }
        )
        report["metadata"]["post_validation"] = validation_report["metadata"]
    report["next_step"] = "publish-or-consume-package"
    return _finalize(report)


def _validate_package_definition_fields(path: Path, payload: Any) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    is_object = isinstance(payload, dict)
    checks.append(_check("package_definition_is_object", is_object, "Package definition is a JSON object" if is_object else "Package definition must be a JSON object", code="PKG.DEF.001"))
    if not isinstance(payload, dict):
        return checks
    missing = sorted({"format_version", "package_id", "license"} - set(payload))
    checks.append(_check("package_definition_required_fields", not missing, "Package definition has required fields" if not missing else f"Package definition missing required fields: {missing}", code="PKG.DEF.001"))
    checks.append(_check("format_version_valid", isinstance(payload.get("format_version"), str) and re.fullmatch(r"\d+\.\d+", payload["format_version"]) is not None, "format_version is major.minor" if isinstance(payload.get("format_version"), str) else "format_version must be a major.minor string", code="PKG.DEF.001"))
    package_id = payload.get("package_id")
    forbidden = set('<>:"/\\|?*')
    package_id_ok = isinstance(package_id, str) and bool(package_id) and len(package_id) <= 255 and not any(ch.isspace() or ch in forbidden or ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in package_id)
    checks.append(_check("package_id_valid", package_id_ok, "package_id is valid" if package_id_ok else "package_id is empty, too long, or contains forbidden characters", code="PKG.DEF.001"))
    checks.append(_check("license_valid", isinstance(payload.get("license"), str) and bool(payload.get("license")), "license is present" if payload.get("license") else "license must be a non-empty string", code="PKG.DEF.001"))
    checks.append(_check("package_definition_canonical_location", path.name == PACKAGING_DEFINITION_FILENAME, "Package definition uses the canonical file name" if path.name == PACKAGING_DEFINITION_FILENAME else f"Package definition must be named {PACKAGING_DEFINITION_FILENAME}", code="PKG.DEF.001"))
    return checks


def _validate_metadata_files(package_root: Path, payload: dict[str, Any], require_metadata_dir: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    metadata_dir = package_root / METADATA_FOLDER
    checks.append(_check("metadata_directory_exists", metadata_dir.is_dir(), "Metadata directory exists" if metadata_dir.is_dir() else "Metadata directory is missing", severity="error" if require_metadata_dir else "warning", code="PKG.DEF.001"))
    entries = payload.get("metadata", [])
    if not isinstance(entries, list):
        checks.append(_check("metadata_array_valid", False, "metadata must be an array when present", code="PKG.DEF.001"))
        return checks
    seen: set[str] = set()
    for entry in entries:
        entry_ok = isinstance(entry, dict) and isinstance(entry.get("name"), str) and isinstance(entry.get("hash"), dict)
        checks.append(_check(f"metadata_entry_valid:{entry}", entry_ok, "Metadata entry has name and hash" if entry_ok else f"Metadata entry must include name and hash: {entry}", code="PKG.DEF.001"))
        if not entry_ok:
            continue
        name = entry["name"]
        duplicate = name in seen
        seen.add(name)
        checks.append(_check(f"metadata_entry_unique:{name}", not duplicate, f"Metadata entry is unique: {name}" if not duplicate else f"Duplicate metadata entry: {name}", code="PKG.DEF.001"))
        metadata_file = metadata_dir / name
        exists = metadata_file.is_file()
        checks.append(_check(f"metadata_file_exists:{name}", exists, f"Metadata file exists: {name}" if exists else f"Metadata file listed but missing: {name}", code="PKG.META.001"))
        if exists:
            actual_hash = _hash_file(metadata_file).get("sha256")
            expected_hash = entry["hash"].get("sha256")
            checks.append(_check(f"metadata_hash_matches:{name}", bool(expected_hash) and actual_hash == expected_hash, f"Metadata file hash matches: {name}" if actual_hash == expected_hash else f"Metadata file hash mismatch: {name}", code="PKG.DEF.001"))
    return checks


def _validate_bom(package_root: Path, payload: dict[str, Any], require_bom: bool) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    checks: list[dict[str, Any]] = []
    bom_path = package_root / METADATA_FOLDER / BOM_FILENAME
    exists = bom_path.is_file()
    checks.append(_check("bom_exists", exists, "BOM metadata exists" if exists else "BOM metadata is missing", severity="error" if require_bom else "warning", code="PKG.BOM.001"))
    if not exists:
        return checks, None
    try:
        bom = _read_json(bom_path)
    except Exception as exc:
        checks.append(_check("bom_json_valid", False, f"BOM is not valid JSON: {exc}", code="PKG.BOM.001"))
        return checks, None
    items = bom.get("items") if isinstance(bom, dict) else None
    checks.append(_check("bom_items_array", isinstance(items, list), "BOM items is an array" if isinstance(items, list) else "BOM items must be an array", code="PKG.BOM.001"))
    if not isinstance(items, list):
        return checks, bom if isinstance(bom, dict) else None
    seen: set[str] = set()
    for item in items:
        rel = str(item.get("relative_path", "")) if isinstance(item, dict) else ""
        path_ok = isinstance(item, dict) and _is_valid_posix_relative_path(rel)
        checks.append(_check(f"bom_relative_path:{rel}", path_ok, f"BOM item path is valid: {rel}" if path_ok else f"BOM item path must be a forward-slash relative path: {rel}", code="PKG.BOM.001"))
        duplicate = rel in seen
        seen.add(rel)
        checks.append(_check(f"bom_relative_path_unique:{rel}", not duplicate, f"BOM item path is unique: {rel}" if not duplicate else f"Duplicate BOM item path: {rel}", code="PKG.BOM.001"))
        if not path_ok:
            continue
        path = package_root / PurePosixPath(rel)
        file_exists = path.is_file()
        checks.append(_check(f"bom_file_exists:{rel}", file_exists, f"BOM item file exists: {rel}" if file_exists else f"BOM item file is missing: {rel}", code="PKG.BOM.001"))
        if file_exists:
            checks.append(_check(f"bom_file_size:{rel}", isinstance(item.get("size"), int) and item["size"] == path.stat().st_size, f"BOM item size matches: {rel}" if item.get("size") == path.stat().st_size else f"BOM item size mismatch: {rel}", code="PKG.BOM.001"))
            expected = item.get("hash", {}).get("sha256") if isinstance(item.get("hash"), dict) else None
            actual = _hash_file(path).get("sha256")
            checks.append(_check(f"bom_file_hash:{rel}", bool(expected) and expected == actual, f"BOM item hash matches: {rel}" if expected == actual else f"BOM item sha256 hash mismatch: {rel}", code="PKG.BOM.001"))
    actual_content = {path.relative_to(package_root).as_posix() for path in _content_files(package_root)}
    bom_content = {str(item.get("relative_path", "")) for item in items if isinstance(item, dict)}
    checks.append(_check("bom_complete", actual_content == bom_content, "BOM lists every package content file" if actual_content == bom_content else f"BOM content mismatch; missing={sorted(actual_content - bom_content)}, extra={sorted(bom_content - actual_content)}", code="PKG.BOM.001"))
    computed_content_hash = _compute_content_hash(items)
    content_hash = payload.get("content_hash")
    if isinstance(content_hash, dict) and computed_content_hash is not None:
        checks.append(_check("content_hash_matches", content_hash.get("sha256") == computed_content_hash.get("sha256"), "content_hash matches BOM items" if content_hash.get("sha256") == computed_content_hash.get("sha256") else "content_hash does not match BOM items", code="PKG.HASH.001"))
    return checks, bom


def _root_usds_metadata(package_root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    path = package_root / METADATA_FOLDER / ROOT_USDS_FILENAME
    if not path.is_file():
        discovered = sorted(p.relative_to(package_root).as_posix() for p in package_root.rglob("*") if p.is_file() and p.suffix.lower() in PACKAGE_ROOT_USD_SUFFIXES and METADATA_FOLDER not in p.parts)
        return [_check("root_usds_metadata_exists", False, "Root USD metadata is missing", severity="warning", code="PKG.CONF.002")], discovered
    try:
        payload = _read_json(path)
    except Exception as exc:
        return [_check("root_usds_json_valid", False, f"Root USD metadata is not valid JSON: {exc}", code="PKG.CONF.002")], []
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return [_check("root_usds_entries_array", False, "Root USD metadata must include entries array", code="PKG.CONF.002")], []
    return _validate_root_usds(package_root, [str(entry) for entry in entries])


def _validate_package_hash(payload: dict[str, Any]) -> list[dict[str, Any]]:
    package_hash = payload.get("package_hash")
    content_hash = payload.get("content_hash")
    entries = payload.get("metadata", [])
    if package_hash is None:
        return [_check("package_hash_available", False, "package_hash is not present", severity="warning", code="PKG.HASH.001")]
    can_compute = isinstance(payload.get("package_id"), str) and isinstance(payload.get("license"), str) and isinstance(content_hash, dict) and isinstance(content_hash.get("sha256"), str) and isinstance(entries, list)
    if not can_compute:
        return [_check("package_hash_computable", False, "package_hash cannot be computed from package definition fields", code="PKG.HASH.001")]
    computed = _compute_package_hash(payload["package_id"], payload["license"], content_hash, entries)
    return [_check("package_hash_matches", package_hash.get("sha256") == computed.get("sha256"), "package_hash matches package definition" if package_hash.get("sha256") == computed.get("sha256") else "package_hash does not match package definition", code="PKG.HASH.001")]


def validate_package(package_definition: Path, *, profile: str) -> dict[str, Any]:
    package_definition = package_definition.resolve()
    package_root = package_definition.parent
    report = _base_report(package_root, "nv-core-package-sample-validation", "validate", "local", profile)
    report["package_definition_path"] = str(package_definition)
    checks = report["checks"]
    exists = package_definition.is_file()
    checks.append(_check("package_definition_exists", exists, "Package definition exists" if exists else "Package definition does not exist", code="PKG.DEF.001"))
    if not exists:
        return _finalize(report)
    try:
        payload = _read_json(package_definition)
    except Exception as exc:
        checks.append(_check("package_definition_json_valid", False, f"Package definition is not valid JSON: {exc}", code="PKG.DEF.001"))
        return _finalize(report)
    checks.append(_check("package_definition_json_valid", True, "Package definition is valid JSON", code="PKG.DEF.001"))
    checks.extend(_validate_package_definition_fields(package_definition, payload))
    metadata = {"package_id": None, "metadata_entries": [], "bom_item_count": 0, "root_usds": []}
    if isinstance(payload, dict):
        metadata["package_id"] = payload.get("package_id")
        metadata["metadata_entries"] = [entry.get("name") for entry in payload.get("metadata", []) if isinstance(entry, dict)]
        checks.extend(_validate_metadata_files(package_root, payload, require_metadata_dir=profile == "Package"))
        bom_checks, bom = _validate_bom(package_root, payload, require_bom=profile == "Package")
        checks.extend(bom_checks)
        if bom and isinstance(bom.get("items"), list):
            metadata["bom_item_count"] = len(bom["items"])
        root_checks, root_entries = _root_usds_metadata(package_root)
        checks.extend(root_checks)
        metadata["root_usds"] = root_entries
        checks.extend(_validate_sidecar_types(package_root))
        checks.extend(_validate_package_hash(payload))
    report["metadata"] = metadata
    report["next_step"] = "publish-or-consume-package"
    return _finalize(report)


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# SimReady Package Report",
        "",
        f"- Package root: `{report['package_root']}`",
        f"- Package definition: `{report['package_definition_path']}`",
        f"- Skill: `{report['skill']}`",
        f"- Operation: `{report['operation']}`",
        f"- Backend: `{report['backend']}`",
        f"- Profile: `{report['profile']}`",
        f"- Passed: `{report['passed']}`",
        f"- Status: `{report['status']}`",
        f"- Next step: `{report['next_step']}`",
        "",
        "## Checks",
        "",
    ]
    checks = list(report.get("checks", []))
    for phase in report.get("phases", []):
        checks.extend(phase.get("checks", []))
    for check in checks:
        state = "PASS" if check["passed"] else "FAIL"
        code = f" `{check['code']}`" if check.get("code") else ""
        lines.append(f"- `{state}` `{check['name']}`{code}: {check['message']}")
    if report["errors"]:
        lines.extend(["", "## Errors", ""])
        lines.extend(f"- {error}" for error in report["errors"])
    if report["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
    lines.append("")
    return "\n".join(lines)


def _emit(report: dict[str, Any], report_path: Path | None, markdown_report_path: Path | None) -> None:
    emit_json_report(report, report_path, markdown_report_path, _markdown(report))


def _package_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a SimReady package definition and metadata.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--license", dest="license_id", required=True)
    parser.add_argument("--root-usd", action="append", default=[])
    parser.add_argument("--backend", choices=("local", "wrapp"), default="local")
    parser.add_argument("--repo", type=Path)
    parser.add_argument(
        "--upstream-sample-dir",
        "--upstream-scripts-dir",
        dest="upstream_sample_dir",
        type=Path,
    )
    parser.add_argument("--skip-pre-validation", action="store_true")
    parser.add_argument("--skip-post-validation", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    return parser


def _validate_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate a SimReady package definition and metadata.")
    parser.add_argument("package_definition", type=Path)
    parser.add_argument("--profile", choices=PROFILE_CHOICES, default="Package")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    if _skill_name() == "nv-core-package-sample-validation":
        args = _validate_parser().parse_args(argv)
        report = validate_package(args.package_definition, profile=args.profile)
    else:
        args = _package_parser().parse_args(argv)
        report = create_package(args)
    _emit(report, args.report, args.markdown_report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
