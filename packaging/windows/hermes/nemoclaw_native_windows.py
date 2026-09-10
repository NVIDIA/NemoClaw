# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Additive startup policy for the official Hermes environment shipped by NemoClaw.

Loaded by an early .pth in installer-owned Python environments. No upstream
module is imported eagerly or edited. Non-Windows interpreters are unchanged.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import ModuleType

REVISION = "2237be355906fbe6065ce1815711eee52b2d646e"
MARKER = "nemoclaw-windows-runtime.json"
_MODULES = {
    "tools.environments.local": "tools/environments/local.py",
    "tools.lazy_deps": "tools/lazy_deps.py",
    "hermes_cli.update_contract": "hermes_cli/update_contract.py",
}
_active_root: Path | None = None


class NativeStartupRefusal(SystemExit):
    """Fail closed: Python site processing otherwise swallows .pth Exceptions."""


def _refuse(message: str) -> None:
    raise NativeStartupRefusal("NemoClaw Windows Hermes: " + message)


def _regular_file(path: Path, root: Path) -> Path:
    try:
        info = path.lstat()
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError):
        _refuse(
            "an installer-owned runtime file is unavailable; repair this installation."
        )
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        _refuse("an installer-owned runtime file has an invalid filesystem identity.")
    return resolved


def _discover_root(module_path: Path) -> Path:
    location = module_path.resolve(strict=True)
    for parent in list(location.parents)[:12]:
        marker = parent / MARKER
        if not marker.exists():
            continue
        _regular_file(marker, parent)
        with marker.open("rb") as stream:
            encoded = stream.read(16 * 1024 + 1)
        if len(encoded) > 16 * 1024:
            _refuse("the native deployment marker exceeds its bound.")
        try:
            record = json.loads(encoded)
        except (ValueError, UnicodeError):
            _refuse("the native deployment marker is invalid.")
        if (
            type(record) is not dict
            or type(record.get("schemaVersion")) is not int
            or record.get("schemaVersion") != 1
            or record.get("manager") != "nemoclaw-windows"
            or record.get("hermesRevision") != REVISION
            or type(record.get("layoutVersion")) is not int
            or record.get("layoutVersion") != 1
        ):
            _refuse("the native deployment marker does not match this adapter.")
        relative = location.relative_to(parent)
        if relative.parts[0] not in {"hermes-agent", "tools"}:
            _refuse("the startup adapter is outside its installed Python environment.")
        return parent
    _refuse("the installer-owned deployment marker is missing.")


class _TempfileOs:
    """Delegate the official tempfile algorithm, changing only directory mode."""

    def __init__(self, original):
        self.original = original

    def mkdir(self, path, mode=0o777, *, dir_fd=None):
        return self.original.mkdir(path, 0o777, dir_fd=dir_fd)

    def __getattr__(self, name):
        return getattr(self.original, name)


def _install_temp_directories() -> None:
    # A module-local OS delegate avoids changing global os/Path behavior or
    # copying a Python-version-specific tempfile retry/naming algorithm.
    # All file operations and the official return/error semantics are retained.
    if not hasattr(tempfile, "_os") or not callable(tempfile._os.mkdir):
        _refuse("the installed Python tempfile interface is unsupported.")
    tempfile._os = _TempfileOs(tempfile._os)


def _adapt_module(module: ModuleType, root: Path, bash: Path) -> None:
    if module.__name__ == "tools.environments.local":
        original = module._find_bash

        def only_owned_candidates(_custom):
            return [str(_regular_file(bash, root))]

        def owned_bash():
            result = original()
            if Path(result).resolve(strict=True) != _regular_file(bash, root):
                _refuse(
                    "the shell resolver selected a runtime outside this installation."
                )
            if not module._bash_starts(result):
                raise RuntimeError(
                    "The installed Hermes Git Bash could not start. Repair NemoClaw."
                )
            return result

        module._windows_bash_candidates = only_owned_candidates
        module._find_bash = owned_bash
        module._git_bash_bin_dirs_cache = None
    elif module.__name__ == "tools.lazy_deps":
        # Config security.allow_lazy_installs:false and the upstream environment
        # switch remain set by the launcher. This native deployment admission
        # also refuses a durable-target or unreadable-config bypass.
        module._allow_lazy_installs = lambda: False
    elif module.__name__ == "hermes_cli.update_contract":

        def refuse_update(_project_root):
            return module.UpdateRefusal(
                code="windows-native",
                message="This Hermes runtime is managed by NemoClaw for Windows. Use NemoClaw Setup to update or repair it.",
                update_command="Open NemoClaw Setup",
            )

        module.evaluate_update_admission = refuse_update


class _NativeLoader:
    def __init__(self, loader, root: Path, bash: Path):
        self.loader = loader
        self.root = root
        self.bash = bash

    def create_module(self, spec):
        creator = getattr(self.loader, "create_module", None)
        return creator(spec) if creator else None

    def exec_module(self, module):
        self.loader.exec_module(module)
        _adapt_module(module, self.root, self.bash)

    def __getattr__(self, name):
        return getattr(self.loader, name)


class _NativeFinder(importlib.abc.MetaPathFinder):
    def __init__(self, root: Path, bash: Path):
        self.root = root
        self.bash = bash

    def find_spec(self, fullname, path=None, target=None):
        relative = _MODULES.get(fullname)
        if relative is None:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        expected = _regular_file(self.root / "hermes-agent" / relative, self.root)
        if spec is None or spec.loader is None or not spec.origin:
            _refuse("an official Hermes policy module could not be resolved.")
        if Path(spec.origin).resolve(strict=True) != expected:
            _refuse(
                "an official Hermes policy module resolved outside this installation."
            )
        spec.loader = _NativeLoader(spec.loader, self.root, self.bash)
        return spec


def install() -> None:
    """Initialize once, before Hermes imports, including normal child interpreters."""
    global _active_root
    if os.name != "nt" or _active_root is not None:
        return
    try:
        root = _discover_root(Path(__file__))
        bash = _regular_file(root / "git" / "bin" / "bash.exe", root)
        _regular_file(root / "git" / "usr" / "bin" / "bash.exe", root)
        _regular_file(root / "git" / "usr" / "bin" / "msys-2.0.dll", root)
        if any(name in sys.modules for name in _MODULES):
            _refuse("the startup adapter must load before Hermes policy modules.")
        os.environ["HERMES_GIT_BASH_PATH"] = str(bash)
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        _install_temp_directories()
        sys.meta_path.insert(0, _NativeFinder(root, bash))
        _active_root = root
    except NativeStartupRefusal:
        raise
    except Exception:
        _refuse("native startup policy could not be initialized safely.")
