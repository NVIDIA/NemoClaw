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
_NATIVE_IMPORT_RECEIPT = Path(".deepagents") / "source-origin.json"


def _read_native_import_receipt(skill_dir: Path, skill_name: str, agent: str) -> str:
    """Read DCode-owned import provenance without following mutable links."""
    import json
    import os
    import stat

    receipt_path = skill_dir / _NATIVE_IMPORT_RECEIPT
    descriptor = None
    try:
        if receipt_path.parent.is_symlink():
            raise OSError("receipt directory is a symbolic link")
        descriptor = os.open(
            receipt_path,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_uid != os.getuid()
        ):
            raise OSError("receipt is not a private regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as opened:
            content = opened.read(4097)
        after = os.stat(receipt_path, follow_symlinks=False)
        if (
            len(content) > 4096
            or not stat.S_ISREG(after.st_mode)
            or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise OSError("receipt changed while reading")
        receipt = json.loads(content)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"native import provenance is unavailable: {exc}") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    expected_keys = {"version", "source", "name", "agent", "digest"}
    digest = receipt.get("digest") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or set(receipt) != expected_keys
        or receipt.get("version") != 1
        or receipt.get("source") != "dcode-native-local-import"
        or receipt.get("name") != skill_name
        or receipt.get("agent") != agent
        or not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise RuntimeError("native import provenance does not match the selected skill")
    return digest


def _import_local(
    source_path: str,
    skill_name: str,
    expected_digest: str,
    *,
    agent: str = "agent",
    replace: bool = False,
) -> None:
    """Import a staged regular-file skill through DCode-owned state resolution."""
    import hashlib
    import json
    import os
    import shutil
    import stat
    import tempfile
    import uuid

    import yaml

    from deepagents_code.config import Settings, console
    from deepagents_code.skills.load import list_skills

    valid, error = _validate_name(skill_name)
    if not valid:
        console.print(f"[bold red]Error:[/bold red] Invalid skill name: {error}")
        raise SystemExit(1)

    if len(expected_digest) != 64 or any(character not in "0123456789abcdef" for character in expected_digest):
        console.print("[bold red]Error:[/bold red] Expected digest must be a lowercase SHA-256 value.")
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

    settings = Settings.from_environment()
    destination_root = settings.ensure_user_skills_dir(agent).resolve()
    destination = destination_root / skill_name
    valid_path, path_error = _validate_skill_path(destination, destination_root)
    if not valid_path:
        console.print(f"[bold red]Error:[/bold red] {path_error}")
        raise SystemExit(1)
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        console.print("[bold red]Error:[/bold red] Existing skill target is not a regular directory.")
        raise SystemExit(1)

    backup_prefix = f".{skill_name}.backup."
    import_prefix = f".{skill_name}.import."
    try:
        abandoned_backups = []
        abandoned_imports = []
        for entry in destination_root.iterdir():
            if entry.name.startswith(backup_prefix) or entry.name.startswith(import_prefix):
                if entry.is_symlink() or not entry.is_dir() or entry.parent.resolve() != destination_root:
                    raise RuntimeError(f"native skill transaction requires inspection: {entry}")
                (abandoned_backups if entry.name.startswith(backup_prefix) else abandoned_imports).append(entry)
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
        console.print(f"[bold red]Error:[/bold red] Cannot reconcile native skill transaction: {exc}")
        raise SystemExit(1) from exc

    def resolve_active_skill():
        return next(
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

    try:
        active = resolve_active_skill()
    except Exception as exc:
        console.print(f"[bold red]Error:[/bold red] Cannot resolve DCode native skill state: {exc}")
        raise SystemExit(1) from exc
    if abandoned_backup is not None:
        expected_file = (destination / "SKILL.md").resolve()
        if not active or Path(str(active.get("path") or "")).resolve() != expected_file:
            console.print(
                f"[bold red]Error:[/bold red] Native skill backup requires inspection: {abandoned_backup}"
            )
            raise SystemExit(1)
        shutil.rmtree(abandoned_backup)
    try:
        for abandoned_import in abandoned_imports:
            shutil.rmtree(abandoned_import)
    except OSError as exc:
        console.print(
            f"[bold red]Error:[/bold red] Native skill import transaction requires inspection: {abandoned_import}"
        )
        raise SystemExit(1) from exc
    if active and active["source"] == "project":
        console.print(
            "[bold red]Error:[/bold red] A project skill with this name is active; "
            "import into user state would not replace what DCode uses."
        )
        raise SystemExit(1)
    if destination.exists() and not replace:
        console.print("[bold red]Error:[/bold red] Skill already exists; pass --replace to update it.")
        raise SystemExit(1)
    transaction_root = Path(tempfile.mkdtemp(prefix=f".{skill_name}.import.", dir=destination_root))
    candidate = transaction_root / skill_name
    backup = destination_root / f".{skill_name}.backup.{uuid.uuid4().hex}"
    moved_existing = False
    published = False
    try:
        candidate.mkdir(mode=0o700)
        manifest_entries = []
        for directory, dirnames, filenames, directory_fd in os.fwalk(source, topdown=True, follow_symlinks=False):
            relative_dir = Path(directory).relative_to(source)
            if relative_dir == Path() and ".deepagents" in dirnames:
                raise ValueError("staged skill contains reserved DCode lifecycle state")
            candidate_dir = candidate / relative_dir
            candidate_dir.mkdir(parents=True, exist_ok=True, mode=0o755)
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
                finally:
                    os.close(descriptor)
                relative = (relative_dir / filename).as_posix()
                mode = 0o755 if before.st_mode & 0o111 else 0o644
                target_file = candidate_dir / filename
                with target_file.open("xb") as copied:
                    copied.write(content)
                os.chmod(target_file, mode, follow_symlinks=False)
                manifest_entries.append(
                    (relative, f"{mode:o} {hashlib.sha256(content).hexdigest()}  {relative}\n")
                )
        manifest = "".join(line for _, line in sorted(manifest_entries))
        observed_digest = hashlib.sha256(manifest.encode("utf-8")).hexdigest()
        if observed_digest != expected_digest:
            raise ValueError("staged skill digest changed before native publication")
        receipt_dir = candidate / _NATIVE_IMPORT_RECEIPT.parent
        receipt_dir.mkdir(mode=0o700)
        receipt_path = candidate / _NATIVE_IMPORT_RECEIPT
        receipt_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "source": "dcode-native-local-import",
                    "name": skill_name,
                    "agent": agent,
                    "digest": expected_digest,
                },
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        os.chmod(receipt_path, 0o600, follow_symlinks=False)
        if destination.exists():
            os.replace(destination, backup)
            moved_existing = True
        os.replace(candidate, destination)
        published = True
        installed_entries = []
        installed_files = set()
        for entry in destination.rglob("*"):
            if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
                raise RuntimeError(f"unsupported installed skill path: {entry}")
            if entry.is_file():
                relative = entry.relative_to(destination).as_posix()
                if relative == _NATIVE_IMPORT_RECEIPT.as_posix():
                    continue
                installed_files.add(relative)
                mode = "755" if entry.stat(follow_symlinks=False).st_mode & 0o111 else "644"
                installed_entries.append(
                    (relative, f"{mode} {hashlib.sha256(entry.read_bytes()).hexdigest()}  {relative}\n")
                )
        installed_manifest = "".join(line for _, line in sorted(installed_entries))
        if installed_files != {entry[0] for entry in manifest_entries} or hashlib.sha256(installed_manifest.encode("utf-8")).hexdigest() != expected_digest:
            raise RuntimeError("installed skill digest changed before native commit")
        if _read_native_import_receipt(destination, skill_name, agent) != expected_digest:
            raise RuntimeError("installed skill provenance does not match its content digest")
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
                {
                    "status": "installed",
                    "name": skill_name,
                    "path": str(destination.resolve()),
                    "digest": expected_digest,
                },
                separators=(",", ":"),
            )
        )
    except Exception as exc:
        rollback_issues = []
        failed_install = transaction_root / skill_name
        if published and destination.exists():
            try:
                os.replace(destination, failed_install)
                published = False
            except OSError as rollback_exc:
                rollback_issues.append(
                    f"active target requires inspection: {destination}: {rollback_exc}"
                )
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
        console.print(f"[bold red]Error:[/bold red] Native skill import failed: {exc}")
        if rollback_issues:
            console.print(
                "[bold red]Error:[/bold red] Native skill rollback requires inspection: "
                + "; ".join(rollback_issues)
            )
        raise SystemExit(1) from exc
    finally:
        shutil.rmtree(transaction_root, ignore_errors=True)


def _remove_imported(
    skill_name: str,
    *,
    agent: str = "agent",
    output_format: str = "text",
) -> None:
    """Remove only a DCode-native import carrying DCode-owned provenance."""
    import os
    import shutil
    import uuid

    from deepagents_code.config import Settings, console
    from deepagents_code.skills.load import list_skills

    valid, error = _validate_name(skill_name)
    if not valid:
        console.print(f"[bold red]Error:[/bold red] Invalid skill name: {error}")
        raise SystemExit(1)
    settings = Settings.from_environment()
    destination_root = settings.ensure_user_skills_dir(agent).resolve()
    destination = destination_root / skill_name
    valid_path, path_error = _validate_skill_path(destination, destination_root)
    if not valid_path:
        console.print(f"[bold red]Error:[/bold red] {path_error}")
        raise SystemExit(1)

    quarantine_prefix = f".{skill_name}.remove."
    recovered = False
    try:
        quarantines = [
            entry for entry in destination_root.iterdir() if entry.name.startswith(quarantine_prefix)
        ]
        if len(quarantines) > 1:
            raise RuntimeError(
                "multiple native removal quarantines require inspection: "
                + ", ".join(str(entry) for entry in sorted(quarantines, key=str))
            )
        for quarantine in quarantines:
            if (
                quarantine.is_symlink()
                or not quarantine.is_dir()
                or quarantine.parent.resolve() != destination_root
            ):
                raise RuntimeError(f"native removal quarantine requires inspection: {quarantine}")
            _read_native_import_receipt(quarantine, skill_name, agent)
            shutil.rmtree(quarantine)
            recovered = True
    except Exception as exc:
        console.print(f"[bold red]Error:[/bold red] Cannot reconcile native skill removal: {exc}")
        raise SystemExit(1) from exc

    if not destination.exists():
        if recovered:
            if output_format == "json":
                from deepagents_code.output import write_json

                write_json(
                    "skills remove-imported",
                    {"name": skill_name, "path": str(destination), "deleted": True},
                )
            else:
                console.print(f"Skill '{skill_name}' removal recovered successfully.")
            return
        console.print(f"[bold red]Error:[/bold red] Skill '{skill_name}' not found.")
        raise SystemExit(1)
    if destination.is_symlink() or not destination.is_dir():
        console.print("[bold red]Error:[/bold red] Imported skill target is not a regular directory.")
        raise SystemExit(1)

    def resolve_active_skill():
        return next(
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

    try:
        active = resolve_active_skill()
    except Exception as exc:
        console.print(f"[bold red]Error:[/bold red] Cannot resolve DCode native skill state: {exc}")
        raise SystemExit(1) from exc
    expected_file = (destination / "SKILL.md").resolve()
    if not active or Path(str(active.get("path") or "")).resolve() != expected_file:
        console.print(
            "[bold red]Error:[/bold red] The selected native import is not DCode's active skill."
        )
        raise SystemExit(1)
    try:
        _read_native_import_receipt(destination, skill_name, agent)
    except RuntimeError as exc:
        console.print(
            "[bold red]Error:[/bold red] Refusing to remove a skill without matching "
            f"DCode-native import provenance: {exc}"
        )
        raise SystemExit(1) from exc

    before = destination.stat(follow_symlinks=False)
    quarantine = destination_root / f"{quarantine_prefix}{uuid.uuid4().hex}"
    try:
        os.replace(destination, quarantine)
        after = quarantine.stat(follow_symlinks=False)
        if (
            quarantine.is_symlink()
            or not quarantine.is_dir()
            or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise RuntimeError("native removal target changed before quarantine")
        _read_native_import_receipt(quarantine, skill_name, agent)
    except Exception as exc:
        rollback_issue = ""
        if quarantine.exists() and not destination.exists():
            try:
                os.replace(quarantine, destination)
            except OSError as rollback_exc:
                rollback_issue = f"; rollback requires inspection: {quarantine}: {rollback_exc}"
        console.print(f"[bold red]Error:[/bold red] Native skill removal failed: {exc}{rollback_issue}")
        raise SystemExit(1) from exc
    try:
        shutil.rmtree(quarantine)
    except OSError as exc:
        console.print(
            "[bold red]Error:[/bold red] Native skill removal committed, but cleanup requires "
            f"inspection: {quarantine}: {exc}"
        )
        raise SystemExit(1) from exc

    try:
        remaining = resolve_active_skill()
    except Exception as exc:
        console.print(
            "[bold red]Error:[/bold red] Native skill removal committed, but DCode state "
            f"verification failed: {exc}"
        )
        raise SystemExit(1) from exc
    if remaining:
        console.print(
            "[bold red]Error:[/bold red] Native removal revealed another active same-name skill "
            f"at {remaining.get('path')}."
        )
        raise SystemExit(1)
    if output_format == "json":
        from deepagents_code.output import write_json

        write_json(
            "skills remove-imported",
            {"name": skill_name, "path": str(destination), "deleted": True},
        )
        return
    console.print(f"Skill '{skill_name}' removed successfully.")
'''

PARSER = """    # NemoClaw native local skill import (#10210).
    import_parser = skills_subparsers.add_parser(
        "import",
        help="Import a staged local skill into DCode-owned user state",
    )
    import_parser.add_argument("path", help="Staged local skill directory")
    import_parser.add_argument("--name", required=True, help="Expected skill name")
    import_parser.add_argument("--agent", default="agent", help="Agent identifier for skills")
    import_parser.add_argument("--replace", action="store_true", help="Replace an existing user skill")
    import_parser.add_argument("--expected-digest", required=True, help="Expected normalized skill digest")

    remove_imported_parser = skills_subparsers.add_parser(
        "remove-imported",
        help="Remove a DCode-native local import",
    )
    if add_output_args is not None:
        add_output_args(remove_imported_parser)
    remove_imported_parser.add_argument("name", help="Name of the imported skill")
    remove_imported_parser.add_argument("--agent", default="agent", help="Agent identifier for skills")

"""

DISPATCH = """    # NemoClaw native local skill import (#10210).
    elif args.skills_command == "import":
        _import_local(
            args.path,
            args.name,
            args.expected_digest,
            agent=args.agent,
            replace=args.replace,
        )
    elif args.skills_command == "remove-imported":
        _remove_imported(
            args.name,
            agent=args.agent,
            output_format=getattr(args, "output_format", "text"),
        )
"""


def _replace_once(source: str, anchor: str, replacement: str, label: str) -> str:
    """Replace one exact reviewed anchor or fail closed."""
    count = source.count(anchor)
    if count != 1:
        raise SystemExit(
            f"ERROR: Deep Agents Code skill import {label} anchor count is {count}, expected 1"
        )
    return source.replace(anchor, replacement, 1)


def patch(path: Path) -> None:
    """Patch and compile-check the pinned skills command module."""
    source = path.read_text(encoding="utf-8")
    if MARKER in source:
        if (
            source.count(MARKER) != 3
            or FUNCTION not in source
            or PARSER not in source
            or DISPATCH not in source
        ):
            raise SystemExit(
                "ERROR: Deep Agents Code native skill import patch is partial"
            )
        return
    source = _replace_once(
        source, FUNCTION_ANCHOR, f"\n{FUNCTION}\ndef _info(\n", "function"
    )
    source = _replace_once(source, PARSER_ANCHOR, f"{PARSER}{PARSER_ANCHOR}", "parser")
    source = _replace_once(
        source, DISPATCH_ANCHOR, f"{DISPATCH}{DISPATCH_ANCHOR}", "dispatch"
    )
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
