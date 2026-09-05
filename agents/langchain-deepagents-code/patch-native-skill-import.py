# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Add a native local-skill import command to pinned Deep Agents Code 0.1.55."""

from __future__ import annotations

import argparse
from pathlib import Path

MARKER = "# NemoClaw native local skill import (#10210)."
FUNCTION_ANCHOR = "\ndef _info(\n"
PARSER_ANCHOR = "    # Skills info\n"
DISPATCH_ANCHOR = '    elif args.skills_command == "info":\n'

FUNCTION = r'''
# NemoClaw native local skill import (#10210).
def _import_local(
    source_path: str,
    skill_name: str,
    *,
    agent: str = "agent",
    replace: bool = False,
) -> None:
    """Import a staged regular-file skill through DCode-owned state resolution."""
    import json
    import os
    import shutil
    import tempfile
    import uuid

    import yaml

    from deepagents_code.config import Settings, console
    from deepagents_code.skills.load import list_skills

    valid, error = _validate_name(skill_name)
    if not valid:
        console.print(f"[bold red]Error:[/bold red] Invalid skill name: {error}")
        raise SystemExit(1)

    source = Path(source_path).expanduser()
    try:
        if source.is_symlink() or not source.is_dir():
            raise OSError("staged skill is not a regular directory")
        source = source.resolve(strict=True)
    except OSError as exc:
        console.print(f"[bold red]Error:[/bold red] Cannot read staged skill: {exc}")
        raise SystemExit(1) from exc
    skill_file = source / "SKILL.md"
    try:
        if skill_file.is_symlink() or not skill_file.is_file():
            raise OSError("SKILL.md is not a regular file")
        text = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        console.print(f"[bold red]Error:[/bold red] Cannot read staged SKILL.md: {exc}")
        raise SystemExit(1) from exc
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        console.print("[bold red]Error:[/bold red] Staged SKILL.md has no YAML frontmatter.")
        raise SystemExit(1)
    closing = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), -1)
    try:
        metadata = yaml.safe_load("\n".join(lines[1:closing])) if closing > 0 else None
    except yaml.YAMLError as exc:
        console.print(f"[bold red]Error:[/bold red] Invalid SKILL.md frontmatter: {exc}")
        raise SystemExit(1) from exc
    if not isinstance(metadata, dict) or metadata.get("name") != skill_name:
        console.print("[bold red]Error:[/bold red] Staged skill name does not match the requested name.")
        raise SystemExit(1)

    for entry in source.rglob("*"):
        if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
            console.print(f"[bold red]Error:[/bold red] Unsupported staged skill path: {entry}")
            raise SystemExit(1)

    settings = Settings.from_environment()
    destination_root = settings.ensure_user_skills_dir(agent).resolve()
    destination = destination_root / skill_name
    valid_path, path_error = _validate_skill_path(destination, destination_root)
    if not valid_path:
        console.print(f"[bold red]Error:[/bold red] {path_error}")
        raise SystemExit(1)

    active = next(
        (
            skill
            for skill in list_skills(
                built_in_skills_dir=settings.get_built_in_skills_dir(),
                user_skills_dir=settings.get_user_skills_dir(agent),
                project_skills_dir=settings.get_project_skills_dir(),
                user_agent_skills_dir=settings.get_user_agent_skills_dir(),
                project_agent_skills_dir=settings.get_project_agent_skills_dir(),
            )
            if skill["name"] == skill_name
        ),
        None,
    )
    if active and active["source"] == "project":
        console.print(
            "[bold red]Error:[/bold red] A project skill with this name is active; "
            "import into user state would not replace what DCode uses."
        )
        raise SystemExit(1)
    if destination.exists() and not replace:
        console.print("[bold red]Error:[/bold red] Skill already exists; pass --replace to update it.")
        raise SystemExit(1)
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        console.print("[bold red]Error:[/bold red] Existing skill target is not a regular directory.")
        raise SystemExit(1)

    transaction_root = Path(tempfile.mkdtemp(prefix=f".{skill_name}.import.", dir=destination_root))
    candidate = transaction_root / skill_name
    backup = destination_root / f".{skill_name}.backup.{uuid.uuid4().hex}"
    moved_existing = False
    published = False
    try:
        shutil.copytree(source, candidate, symlinks=False)
        if destination.exists():
            os.replace(destination, backup)
            moved_existing = True
        os.replace(candidate, destination)
        published = True
        observed = next(
            (
                skill
                for skill in list_skills(
                    built_in_skills_dir=settings.get_built_in_skills_dir(),
                    user_skills_dir=settings.get_user_skills_dir(agent),
                    project_skills_dir=settings.get_project_skills_dir(),
                    user_agent_skills_dir=settings.get_user_agent_skills_dir(),
                    project_agent_skills_dir=settings.get_project_agent_skills_dir(),
                )
                if skill["name"] == skill_name
            ),
            None,
        )
        expected_file = (destination / "SKILL.md").resolve()
        if not observed or Path(observed["path"]).resolve() != expected_file:
            raise RuntimeError("DCode did not resolve the imported skill as active")
        if moved_existing:
            shutil.rmtree(backup)
            moved_existing = False
        print(
            "NEMOCLAW_NATIVE_SKILL_IMPORT="
            + json.dumps(
                {"status": "installed", "name": skill_name, "path": str(destination.resolve())},
                separators=(",", ":"),
            )
        )
    except Exception as exc:
        if published and destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        if moved_existing and backup.exists() and not destination.exists():
            os.replace(backup, destination)
            moved_existing = False
        console.print(f"[bold red]Error:[/bold red] Native skill import failed: {exc}")
        raise SystemExit(1) from exc
    finally:
        shutil.rmtree(transaction_root, ignore_errors=True)
        if moved_existing and backup.exists() and not destination.exists():
            os.replace(backup, destination)
'''

PARSER = '''    # NemoClaw native local skill import (#10210).
    import_parser = skills_subparsers.add_parser(
        "import",
        help="Import a staged local skill into DCode-owned user state",
    )
    import_parser.add_argument("path", help="Staged local skill directory")
    import_parser.add_argument("--name", required=True, help="Expected skill name")
    import_parser.add_argument("--agent", default="agent", help="Agent identifier for skills")
    import_parser.add_argument("--replace", action="store_true", help="Replace an existing user skill")

'''

DISPATCH = '''    # NemoClaw native local skill import (#10210).
    elif args.skills_command == "import":
        _import_local(
            args.path,
            args.name,
            agent=args.agent,
            replace=args.replace,
        )
'''


def _replace_once(source: str, anchor: str, replacement: str, label: str) -> str:
    """Replace one exact reviewed anchor or fail closed."""
    count = source.count(anchor)
    if count != 1:
        raise SystemExit(f"ERROR: Deep Agents Code skill import {label} anchor count is {count}, expected 1")
    return source.replace(anchor, replacement, 1)


def patch(path: Path) -> None:
    """Patch and compile-check the pinned skills command module."""
    source = path.read_text(encoding="utf-8")
    if MARKER in source:
        if source.count(MARKER) != 3 or FUNCTION not in source or PARSER not in source or DISPATCH not in source:
            raise SystemExit("ERROR: Deep Agents Code native skill import patch is partial")
        return
    source = _replace_once(source, FUNCTION_ANCHOR, f"\n{FUNCTION}\ndef _info(\n", "function")
    source = _replace_once(source, PARSER_ANCHOR, f"{PARSER}{PARSER_ANCHOR}", "parser")
    source = _replace_once(source, DISPATCH_ANCHOR, f"{DISPATCH}{DISPATCH_ANCHOR}", "dispatch")
    compile(source, str(path), "exec")
    path.write_text(source, encoding="utf-8")


def main() -> int:
    """Patch one installed Deep Agents Code skills command module."""
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    patch(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
