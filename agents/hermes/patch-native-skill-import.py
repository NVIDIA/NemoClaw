# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Add native staged-skill import to pinned Hermes Agent 0.20.6."""

from __future__ import annotations

import argparse
from pathlib import Path

MARKER = "# NemoClaw native local skill import (#10210)."
PARSER_ANCHOR = '    skills_inspect = skills_subparsers.add_parser(\n        "inspect", help="Preview a skill without installing"\n    )\n'
FUNCTION_ANCHOR = "\ndef do_inspect(identifier: str, console: Optional[Console] = None) -> None:\n"
ROUTER_ANCHOR = '    elif action == "inspect":\n        do_inspect(args.identifier)\n'
UNINSTALL_ANCHOR = '    elif action == "uninstall":\n        do_uninstall(args.name, skip_confirm=getattr(args, "yes", False))\n'

PARSER = '''    # NemoClaw native local skill import (#10210).
    skills_import_local = skills_subparsers.add_parser(
        "import-local", help="Import a staged local skill through Hermes-owned state"
    )
    skills_import_local.add_argument("path", help="Staged local skill directory")
    skills_import_local.add_argument("--name", required=True, help="Expected skill name")
    skills_import_local.add_argument("--expected-digest", required=True, help="Expected normalized skill digest")

'''

FUNCTION = r'''
# NemoClaw native local skill import (#10210).
def do_import_local(skill_path: str, expected_name: str, expected_digest: str, console: Optional[Console] = None) -> bool:
    """Import a staged regular-file skill through Hermes' own lock and loader."""
    import hashlib
    import json
    import os
    import re
    import shutil
    import stat
    import uuid

    c = console or _console
    if (
        not expected_name
        or len(expected_name) > 255
        or expected_name in {".", "..", ".hub"}
        or re.fullmatch(r"[A-Za-z0-9._-]+", expected_name) is None
    ):
        c.print("[bold red]Error:[/] Invalid staged skill name.")
        return False
    if len(expected_digest) != 64 or any(character not in "0123456789abcdef" for character in expected_digest):
        c.print("[bold red]Error:[/] Expected digest must be a lowercase SHA-256 value.")
        return False

    import yaml

    from agent.skill_utils import is_external_skill_path
    from tools.skills_guard import format_scan_report, scan_skill_cached, should_allow_install
    from tools.skills_hub import (
        HubLockFile,
        SKILLS_DIR,
        SkillBundle,
        install_from_quarantine,
        quarantine_bundle,
    )
    from tools.skills_tool import skill_view

    skills_root = Path(SKILLS_DIR).resolve()
    destination = skills_root / expected_name
    if destination.parent != skills_root or destination.name != expected_name:
        c.print("[bold red]Error:[/] Skill target escapes Hermes native state.")
        return False

    source = Path(skill_path).expanduser()
    try:
        if source.is_symlink() or not source.is_dir():
            raise OSError("staged skill is not a regular directory")
        source = source.resolve(strict=True)
    except OSError as exc:
        c.print(f"[bold red]Error:[/] Cannot read staged skill: {exc}")
        return False

    files = {}
    file_modes = {}
    try:
        for directory, dirnames, filenames, directory_fd in os.fwalk(source, topdown=True, follow_symlinks=False):
            for dirname in dirnames:
                metadata = os.stat(dirname, dir_fd=directory_fd, follow_symlinks=False)
                if not stat.S_ISDIR(metadata.st_mode):
                    raise ValueError(f"unsupported staged path: {Path(directory) / dirname}")
            for filename in filenames:
                descriptor = os.open(
                    filename,
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=directory_fd,
                )
                try:
                    before = os.fstat(descriptor)
                    if not stat.S_ISREG(before.st_mode):
                        raise ValueError(f"unsupported staged path: {Path(directory) / filename}")
                    with os.fdopen(descriptor, "rb", closefd=False) as opened:
                        content = opened.read()
                    after = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
                    if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
                        raise ValueError(f"staged path changed while reading: {Path(directory) / filename}")
                    relative = (Path(directory) / filename).relative_to(source).as_posix()
                    files[relative] = content
                    file_modes[relative] = "755" if before.st_mode & 0o111 else "644"
                finally:
                    os.close(descriptor)
    except (OSError, ValueError) as exc:
        c.print(f"[bold red]Error:[/] Cannot snapshot staged skill: {exc}")
        return False

    manifest = "".join(
        f"{file_modes[relative]} {hashlib.sha256(files[relative]).hexdigest()}  {relative}\n"
        for relative in sorted(files)
    )
    observed_digest = hashlib.sha256(manifest.encode("utf-8")).hexdigest()
    if observed_digest != expected_digest:
        c.print("[bold red]Error:[/] Staged skill digest changed before native publication.")
        return False

    try:
        text = files["SKILL.md"].decode("utf-8")
    except (KeyError, UnicodeError) as exc:
        c.print(f"[bold red]Error:[/] Cannot read staged SKILL.md: {exc}")
        return False
    lines = text.splitlines()
    closing = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), -1) if lines and lines[0].strip() == "---" else -1
    try:
        metadata = yaml.safe_load("\n".join(lines[1:closing])) if closing > 0 else None
    except yaml.YAMLError as exc:
        c.print(f"[bold red]Error:[/] Invalid SKILL.md frontmatter: {exc}")
        return False
    name = metadata.get("name") if isinstance(metadata, dict) else None
    if name != expected_name:
        c.print("[bold red]Error:[/] Staged skill name does not match the requested name.")
        return False

    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        c.print("[bold red]Error:[/] Existing skill target is not a regular directory.")
        return False
    backup_root = skills_root / ".hub"
    backup_prefix = f"nemoclaw-import-backup.{expected_name}."
    try:
        if backup_root.is_symlink() or (backup_root.exists() and not backup_root.is_dir()):
            raise RuntimeError(f"native skill transaction root requires inspection: {backup_root}")
        backup_root.mkdir(parents=True, exist_ok=True)
        if backup_root.resolve() != (skills_root / ".hub").resolve():
            raise RuntimeError(f"native skill transaction root requires inspection: {backup_root}")
        abandoned_backups = []
        for entry in backup_root.iterdir():
            if not entry.name.startswith(backup_prefix):
                continue
            if entry.is_symlink() or not entry.is_dir() or entry.parent.resolve() != backup_root.resolve():
                raise RuntimeError(f"native skill backup requires inspection: {entry}")
            abandoned_backups.append(entry)
        if len(abandoned_backups) > 1:
            raise RuntimeError(
                "multiple native skill backups require inspection: "
                + ", ".join(str(entry) for entry in sorted(abandoned_backups, key=str))
            )
        abandoned_backup = abandoned_backups[0] if abandoned_backups else None
        if abandoned_backup is not None and not destination.exists():
            os.replace(abandoned_backup, destination)
            abandoned_backup = None
    except Exception as exc:
        c.print(f"[bold red]Error:[/] Cannot reconcile native skill transaction: {exc}")
        return False

    try:
        active = json.loads(skill_view(expected_name, preprocess=False))
    except Exception:
        active = {}
    active_dir = Path(str(active.get("skill_dir") or "")) if active.get("success") else None
    if abandoned_backup is not None:
        if active_dir is None or active_dir.resolve() != destination.resolve():
            c.print(
                f"[bold red]Error:[/] Native skill backup requires inspection: {abandoned_backup}"
            )
            return False
        try:
            shutil.rmtree(abandoned_backup)
        except OSError as exc:
            c.print(
                f"[bold red]Error:[/] Native skill backup requires inspection: {abandoned_backup}: {exc}"
            )
            return False
    if active_dir and is_external_skill_path(active_dir):
        c.print(
            "[bold red]Error:[/] A project or external skill with this name is active; "
            "import into profile state would not replace what Hermes uses."
        )
        return False

    bundle = SkillBundle(
        name=expected_name,
        files=files,
        source="local",
        identifier=f"local-import:{expected_name}",
        trust_level="community",
        metadata={"import": "local"},
    )
    quarantine = None
    try:
        quarantine = quarantine_bundle(bundle)
        scan, provenance = scan_skill_cached(
            quarantine,
            source=bundle.identifier,
            cache_dir=Path(SKILLS_DIR) / ".hub" / "scan-cache",
        )
        c.print(format_scan_report(scan))
        allowed, reason = should_allow_install(scan, force=False)
        if not allowed:
            c.print(f"[bold red]Installation blocked:[/] {reason}")
            shutil.rmtree(quarantine, ignore_errors=True)
            return False
    except Exception as exc:
        c.print(f"[bold red]Error:[/] Native skill scan failed: {exc}")
        if quarantine is not None:
            shutil.rmtree(quarantine, ignore_errors=True)
        return False

    backup = backup_root / f"{backup_prefix}{uuid.uuid4().hex}"
    lock = HubLockFile()
    lock_before = lock.load()
    moved_existing = False
    installed = False
    try:
        if destination.exists():
            os.replace(destination, backup)
            moved_existing = True
        installed_path = install_from_quarantine(
            quarantine,
            expected_name,
            "",
            bundle,
            scan,
            provenance,
        )
        installed = True
        for relative, mode in file_modes.items():
            os.chmod(installed_path / relative, int(mode, 8), follow_symlinks=False)
        installed_entries = []
        installed_files = set()
        for entry in installed_path.rglob("*"):
            if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
                raise RuntimeError(f"unsupported installed skill path: {entry}")
            if entry.is_file():
                relative = entry.relative_to(installed_path).as_posix()
                installed_files.add(relative)
                mode = "755" if entry.stat(follow_symlinks=False).st_mode & 0o111 else "644"
                installed_entries.append(
                    (relative, f"{mode} {hashlib.sha256(entry.read_bytes()).hexdigest()}  {relative}\n")
                )
        installed_manifest = "".join(line for _, line in sorted(installed_entries))
        if installed_files != set(files) or hashlib.sha256(installed_manifest.encode("utf-8")).hexdigest() != expected_digest:
            raise RuntimeError("installed skill digest changed before native commit")
        from agent.prompt_builder import clear_skills_system_prompt_cache

        clear_skills_system_prompt_cache(clear_snapshot=True)
        observed = json.loads(skill_view(expected_name, preprocess=False))
        observed_dir = Path(str(observed.get("skill_dir") or "")).resolve()
        if not observed.get("success") or observed_dir != installed_path.resolve():
            raise RuntimeError("Hermes did not resolve the imported profile skill as active")
        if moved_existing:
            shutil.rmtree(backup)
            moved_existing = False
        print(
            "NEMOCLAW_NATIVE_SKILL_IMPORT="
            + json.dumps(
                {
                    "status": "installed",
                    "name": expected_name,
                    "path": str(installed_path.resolve()),
                    "digest": expected_digest,
                },
                separators=(",", ":"),
            )
        )
        return True
    except Exception as exc:
        rollback_issues = []
        failed_install = backup_root / f"nemoclaw-import-failed.{expected_name}.{uuid.uuid4().hex}"
        if installed and destination.exists():
            try:
                os.replace(destination, failed_install)
                installed = False
            except OSError as rollback_exc:
                rollback_issues.append(
                    f"active target requires inspection: {destination}: {rollback_exc}"
                )
        try:
            lock.save(lock_before)
        except Exception as rollback_exc:
            rollback_issues.append(f"Skills Hub lock requires inspection: {rollback_exc}")
        if moved_existing and backup.exists() and not destination.exists():
            try:
                os.replace(backup, destination)
                moved_existing = False
            except OSError as rollback_exc:
                rollback_issues.append(
                    f"prior skill backup requires inspection: {backup}: {rollback_exc}"
                )
        if failed_install.exists():
            try:
                shutil.rmtree(failed_install)
            except OSError as rollback_exc:
                rollback_issues.append(
                    f"quarantined failed install retained at {failed_install}: {rollback_exc}"
                )
        c.print(f"[bold red]Error:[/] Native skill import failed: {exc}")
        if rollback_issues:
            c.print(
                "[bold red]Error:[/] Native skill rollback requires inspection: "
                + "; ".join(rollback_issues)
            )
        return False
    finally:
        shutil.rmtree(quarantine, ignore_errors=True)
'''

ROUTER = '''    # NemoClaw native local skill import (#10210).
    elif action == "import-local":
        if not do_import_local(args.path, args.name, args.expected_digest):
            raise SystemExit(1)
'''

UNINSTALL = '''    # NemoClaw native local skill import (#10210).
    elif action == "uninstall":
        from tools.skills_hub import HubLockFile

        before = HubLockFile().get_installed(args.name)
        if not before:
            _console.print(f"[bold red]Error:[/] '{args.name}' is not managed by Hermes skill state.\\n")
            raise SystemExit(1)
        do_uninstall(args.name, skip_confirm=getattr(args, "yes", False))
        if HubLockFile().get_installed(args.name):
            raise SystemExit(1)
'''


def _replace_once(source: str, anchor: str, replacement: str, label: str) -> str:
    """Replace one exact reviewed Hermes source anchor."""
    count = source.count(anchor)
    if count != 1:
        raise SystemExit(f"ERROR: Hermes native skill import {label} anchor count is {count}, expected 1")
    return source.replace(anchor, replacement, 1)


def patch(parser_path: Path, hub_path: Path) -> None:
    """Patch the pinned Hermes parser and skill-state implementation."""
    parser_source = parser_path.read_text(encoding="utf-8")
    hub_source = hub_path.read_text(encoding="utf-8")
    if MARKER in parser_source or MARKER in hub_source:
        if (
            parser_source.count(MARKER) != 1
            or hub_source.count(MARKER) != 3
            or PARSER not in parser_source
            or FUNCTION not in hub_source
            or ROUTER not in hub_source
            or UNINSTALL not in hub_source
        ):
            raise SystemExit("ERROR: Hermes native skill import patch is partial")
        return
    parser_source = _replace_once(parser_source, PARSER_ANCHOR, f"{PARSER}{PARSER_ANCHOR}", "parser")
    hub_source = _replace_once(hub_source, FUNCTION_ANCHOR, f"\n{FUNCTION}\ndef do_inspect(identifier: str, console: Optional[Console] = None) -> None:\n", "function")
    hub_source = _replace_once(hub_source, ROUTER_ANCHOR, f"{ROUTER}{ROUTER_ANCHOR}", "router")
    hub_source = _replace_once(hub_source, UNINSTALL_ANCHOR, UNINSTALL, "uninstall")
    compile(parser_source, str(parser_path), "exec")
    compile(hub_source, str(hub_path), "exec")
    parser_path.write_text(parser_source, encoding="utf-8")
    hub_path.write_text(hub_source, encoding="utf-8")


def main() -> int:
    """Patch installed Hermes skills modules."""
    parser = argparse.ArgumentParser()
    parser.add_argument("parser_path")
    parser.add_argument("hub_path")
    args = parser.parse_args()
    patch(Path(args.parser_path), Path(args.hub_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
