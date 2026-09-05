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

'''

FUNCTION = r'''
# NemoClaw native local skill import (#10210).
def do_import_local(skill_path: str, expected_name: str, console: Optional[Console] = None) -> bool:
    """Import a staged regular-file skill through Hermes' own lock and loader."""
    import json
    import os
    import shutil
    import uuid

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

    c = console or _console
    source = Path(skill_path).expanduser()
    try:
        if source.is_symlink() or not source.is_dir():
            raise OSError("staged skill is not a regular directory")
        source = source.resolve(strict=True)
        skill_file = source / "SKILL.md"
        if skill_file.is_symlink() or not skill_file.is_file():
            raise OSError("SKILL.md is not a regular file")
        text = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        c.print(f"[bold red]Error:[/] Cannot read staged skill: {exc}")
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

    files = {}
    try:
        for entry in source.rglob("*"):
            if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
                raise ValueError(f"unsupported staged path: {entry}")
            if entry.is_file():
                files[entry.relative_to(source).as_posix()] = entry.read_bytes()
    except (OSError, ValueError) as exc:
        c.print(f"[bold red]Error:[/] Cannot import staged skill: {exc}")
        return False

    try:
        active = json.loads(skill_view(expected_name, preprocess=False))
    except Exception:
        active = {}
    active_dir = Path(str(active.get("skill_dir") or "")) if active.get("success") else None
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

    skills_root = Path(SKILLS_DIR).resolve()
    destination = skills_root / expected_name
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        c.print("[bold red]Error:[/] Existing skill target is not a regular directory.")
        shutil.rmtree(quarantine, ignore_errors=True)
        return False
    backup = skills_root / f".{expected_name}.backup.{uuid.uuid4().hex}"
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
        try:
            from agent.prompt_builder import clear_skills_system_prompt_cache

            clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception:
            pass
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
                {"status": "installed", "name": expected_name, "path": str(installed_path.resolve())},
                separators=(",", ":"),
            )
        )
        return True
    except Exception as exc:
        if installed and destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        lock.save(lock_before)
        if moved_existing and backup.exists() and not destination.exists():
            os.replace(backup, destination)
            moved_existing = False
        c.print(f"[bold red]Error:[/] Native skill import failed: {exc}")
        return False
    finally:
        shutil.rmtree(quarantine, ignore_errors=True)
        if moved_existing and backup.exists() and not destination.exists():
            os.replace(backup, destination)
'''

ROUTER = '''    # NemoClaw native local skill import (#10210).
    elif action == "import-local":
        if not do_import_local(args.path, args.name):
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
