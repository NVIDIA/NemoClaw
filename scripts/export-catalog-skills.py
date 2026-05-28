#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Export catalog-safe NemoClaw skills to the NVSkills watched directory.

The repository source of truth remains `.agents/skills/`. This script copies the
checked-in allowlist from `.agents/catalog-skills.yaml` into `skills/`
using deterministic ordering and metadata so CI can detect stale or hand-edited
catalog exports.
"""

from __future__ import annotations

import argparse
import filecmp
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALLOWLIST = Path(".agents/catalog-skills.yaml")
GENERATED_HEADER = """<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generated NemoClaw Catalog Skills

This directory is generated from `.agents/catalog-skills.yaml` and `.agents/skills/`.
Do not edit files here directly. The exporter preserves NVSkills signing artifacts (`skill.oms.sig` and `skill-card.md`) when regenerating an already-signed export.

To update this export, edit the source skills or allowlist, then run:

```bash
python3 scripts/export-catalog-skills.py
```

CI verifies the directory with:

```bash
python3 scripts/export-catalog-skills.py --check
```
"""

PRESERVED_SIGNING_FILES = {"skill.oms.sig", "skill-card.md"}


@dataclass(frozen=True)
class CatalogConfig:
    source: Path
    export: Path
    skills: tuple[str, ...]
    excluded_patterns: tuple[str, ...]
    metadata: dict[str, str]


def repo_path(path: Path) -> str:
    return path.as_posix()


def parse_scalar(value: str) -> str | int:
    stripped = value.strip()
    if stripped.startswith('"') and stripped.endswith('"'):
        return stripped[1:-1]
    if stripped.isdigit():
        return int(stripped)
    return stripped


def load_allowlist_yaml(path: Path) -> dict[str, Any]:
    """Parse the small checked-in allowlist schema without external YAML deps."""
    raw: dict[str, Any] = {"include": [], "exclude": [], "metadata": {}}
    section: str | None = None

    lines = path.read_text(encoding="utf-8").splitlines()
    for line_number, original in enumerate(lines, start=1):
        line = original.split("#", 1)[0].rstrip()
        if not line.strip():
            continue

        if not line.startswith(" "):
            key, separator, value = line.partition(":")
            if not separator:
                raise ValueError(f"{repo_path(path)}:{line_number}: expected key: value")
            key = key.strip()
            if value.strip():
                raw[key] = parse_scalar(value)
                section = None
            else:
                section = key
                raw.setdefault(key, [] if key in {"include", "exclude"} else {})
            continue

        if section in {"include", "exclude"}:
            stripped = line.strip()
            if stripped.startswith("- "):
                key, separator, value = stripped[2:].partition(":")
                if not separator:
                    raise ValueError(
                        f"{repo_path(path)}:{line_number}: expected list item mapping"
                    )
                raw[section].append({key.strip(): parse_scalar(value)})
            elif raw[section] and ":" in stripped:
                key, _, value = stripped.partition(":")
                raw[section][-1][key.strip()] = parse_scalar(value)
            else:
                raise ValueError(f"{repo_path(path)}:{line_number}: unsupported {section} entry")
            continue

        if section == "metadata":
            key, separator, value = line.strip().partition(":")
            if not separator:
                raise ValueError(f"{repo_path(path)}:{line_number}: expected metadata key: value")
            raw["metadata"][key.strip()] = parse_scalar(value)
            continue

        raise ValueError(f"{repo_path(path)}:{line_number}: unsupported nested content")

    return raw


def load_config(path: Path) -> CatalogConfig:
    raw = load_allowlist_yaml(path)

    version = raw.get("version")
    if version != 1:
        raise ValueError(f"{repo_path(path)} version must be 1")

    source = Path(str(raw.get("source", ".agents/skills")))
    export = Path(str(raw.get("export", "skills")))
    for label, candidate in (("source", source), ("export", export)):
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError(f"{repo_path(path)} {label} must be a safe relative path")

    include = raw.get("include")
    exclude = raw.get("exclude", [])
    metadata = raw.get("metadata", {})

    if not isinstance(include, list) or not include:
        raise ValueError(f"{repo_path(path)} include must be a non-empty list")
    if not isinstance(exclude, list):
        raise ValueError(f"{repo_path(path)} exclude must be a list")
    if not isinstance(metadata, dict):
        raise ValueError(f"{repo_path(path)} metadata must be a mapping")

    skills: list[str] = []
    for idx, item in enumerate(include):
        if not isinstance(item, dict) or not isinstance(item.get("skill"), str):
            raise ValueError(f"{repo_path(path)} include[{idx}] must contain a string skill")
        skill = item["skill"].strip()
        if not skill:
            raise ValueError(f"{repo_path(path)} include[{idx}].skill must not be empty")
        skill_path = Path(skill)
        if skill_path.is_absolute() or ".." in skill_path.parts or len(skill_path.parts) != 1:
            raise ValueError(
                f"{repo_path(path)} include[{idx}].skill must be a single directory name"
            )
        skills.append(skill)

    if skills != sorted(skills):
        raise ValueError(f"{repo_path(path)} include must be sorted by skill name")
    if len(set(skills)) != len(skills):
        raise ValueError(f"{repo_path(path)} include contains duplicate skills")

    excluded_patterns: list[str] = []
    for idx, item in enumerate(exclude):
        if not isinstance(item, dict) or not isinstance(item.get("pattern"), str):
            raise ValueError(f"{repo_path(path)} exclude[{idx}] must contain a string pattern")
        excluded_patterns.append(item["pattern"].strip())

    normalized_metadata = {str(key): str(value) for key, value in sorted(metadata.items())}
    return CatalogConfig(
        source=source,
        export=export,
        skills=tuple(skills),
        excluded_patterns=tuple(excluded_patterns),
        metadata=normalized_metadata,
    )


def git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def copy_skill(source_dir: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for root, dirs, files in os.walk(source_dir):
        dirs.sort()
        files.sort()
        rel_root = Path(root).relative_to(source_dir)
        for directory in dirs:
            (target_dir / rel_root / directory).mkdir(parents=True, exist_ok=True)
        for filename in files:
            src = Path(root) / filename
            dst = target_dir / rel_root / filename
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def hash_file(path: Path, base: Path, digest: hashlib._Hash) -> None:
    rel = path.relative_to(base).as_posix()
    digest.update(rel.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")


def hash_tree(paths: list[Path], base: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.relative_to(base).as_posix()):
        hash_file(path, base, digest)
    return digest.hexdigest()


def list_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    files = (path for path in root.rglob("*") if path.is_file())
    return sorted(files, key=lambda item: item.as_posix())


def write_manifest(target_root: Path, config: CatalogConfig, source_root: Path) -> None:
    exported_files = [
        path
        for skill in config.skills
        for path in list_files(target_root / skill)
        if path.name not in PRESERVED_SIGNING_FILES
    ]
    source_files = [path for skill in config.skills for path in list_files(source_root / skill)]
    manifest = {
        "schemaVersion": 1,
        "generatedBy": "scripts/export-catalog-skills.py",
        "source": repo_path(config.source),
        "sourceCommit": git_commit(),
        "sourceContentSha256": hash_tree(source_files, source_root),
        "exportContentSha256": hash_tree(exported_files, target_root),
        "metadata": config.metadata,
        "skills": list(config.skills),
    }
    (target_root / "catalog-metadata.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def preserve_signing_artifacts(
    existing_root: Path, temp_root: Path, skills: tuple[str, ...]
) -> None:
    for skill in skills:
        existing_skill = existing_root / skill
        if not existing_skill.exists():
            continue
        for artifact_name in sorted(PRESERVED_SIGNING_FILES):
            artifact = existing_skill / artifact_name
            if artifact.is_file():
                destination = temp_root / skill / artifact_name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(artifact, destination)


def validate_preserved_signing_artifacts(
    existing_root: Path, temp_root: Path, skills: tuple[str, ...]
) -> None:
    missing: list[str] = []
    for skill in skills:
        existing_skill = existing_root / skill
        if not existing_skill.exists():
            continue
        for artifact_name in sorted(PRESERVED_SIGNING_FILES):
            if (existing_skill / artifact_name).is_file() and not (
                temp_root / skill / artifact_name
            ).is_file():
                missing.append(f"{skill}/{artifact_name}")
    if missing:
        preview = ", ".join(missing[:10])
        suffix = f" (+{len(missing) - 10} more)" if len(missing) > 10 else ""
        raise FileNotFoundError(f"Missing preserved signing artifacts: {preview}{suffix}")


def render_export(config: CatalogConfig, target_root: Path, preserve_from: Path | None = None) -> None:
    source_root = REPO_ROOT / config.source
    if not source_root.is_dir():
        raise FileNotFoundError(f"Source skills directory not found: {repo_path(config.source)}")

    target_root.mkdir(parents=True, exist_ok=True)
    (target_root / "README.md").write_text(GENERATED_HEADER, encoding="utf-8")

    for skill in config.skills:
        source_skill = source_root / skill
        if not source_skill.is_dir():
            raise FileNotFoundError(f"Allowlisted skill not found: {repo_path(config.source / skill)}")
        for pattern in config.excluded_patterns:
            if fnmatch.fnmatch(skill, pattern):
                raise ValueError(f"Allowlisted skill {skill!r} matches excluded pattern {pattern!r}")
        copy_skill(source_skill, target_root / skill)

    if preserve_from is not None:
        preserve_signing_artifacts(preserve_from, target_root, config.skills)
        validate_preserved_signing_artifacts(preserve_from, target_root, config.skills)

    write_manifest(target_root, config, source_root)


def dircmp_diff(left: Path, right: Path) -> list[str]:
    messages: list[str] = []

    def visit(cmp: filecmp.dircmp[str]) -> None:
        for name in sorted(cmp.left_only):
            messages.append(f"unexpected: {(Path(cmp.left) / name).relative_to(left).as_posix()}")
        for name in sorted(cmp.right_only):
            messages.append(f"missing: {(Path(cmp.right) / name).relative_to(right).as_posix()}")
        for name in sorted(cmp.diff_files):
            messages.append(f"stale: {(Path(cmp.left) / name).relative_to(left).as_posix()}")
        for subdir in sorted(cmp.subdirs):
            visit(cmp.subdirs[subdir])

    visit(filecmp.dircmp(left, right))
    return messages


def replace_directory(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))


def export_catalog(allowlist: Path, check: bool, allow_missing: bool) -> int:
    config = load_config(allowlist)
    export_root = REPO_ROOT / config.export

    with tempfile.TemporaryDirectory(prefix="nemoclaw-catalog-skills-") as tmp:
        expected = Path(tmp) / "expected"
        render_export(config, expected, preserve_from=export_root if export_root.exists() else None)

        if check:
            if not export_root.exists():
                if allow_missing:
                    print(
                        f"Catalog export is not present yet: {repo_path(config.export)} "
                        "(allowed by --allow-missing)",
                    )
                    return 0
                print(f"Catalog export is missing: {repo_path(config.export)}", file=sys.stderr)
                return 1
            diffs = dircmp_diff(export_root, expected)
            if diffs:
                print("Catalog skills export is stale. Run:", file=sys.stderr)
                print("  python3 scripts/export-catalog-skills.py", file=sys.stderr)
                for diff in diffs[:50]:
                    print(f"  - {diff}", file=sys.stderr)
                if len(diffs) > 50:
                    print(f"  ... {len(diffs) - 50} more difference(s)", file=sys.stderr)
                return 1
            print(f"Catalog skills export is current: {repo_path(config.export)}")
            return 0

        replace_directory(expected, export_root)
        print(f"Exported {len(config.skills)} catalog skill(s) to {repo_path(config.export)}")
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST,
        help="Catalog skill allowlist YAML (default: .agents/catalog-skills.yaml)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check whether the generated export is current without writing files",
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="In --check mode, pass when the export directory has not been created yet",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    allowlist = args.allowlist if args.allowlist.is_absolute() else REPO_ROOT / args.allowlist
    return export_catalog(allowlist, bool(args.check), bool(args.allow_missing))


if __name__ == "__main__":
    raise SystemExit(main())
