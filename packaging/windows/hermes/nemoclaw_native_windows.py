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
import re
from pathlib import Path, PureWindowsPath
import stat
import sys
import tempfile
from types import ModuleType

REVISION = "2237be355906fbe6065ce1815711eee52b2d646e"
MARKER = "nemoclaw-windows-runtime.json"
_MODULES = {
    "tools.environments.local": "tools/environments/local.py",
    "tools.lazy_deps": "tools/lazy_deps.py",
    "tools.browser_tool_install": "tools/browser_tool_install.py",
    "tools.browser_tool_session": "tools/browser_tool_session.py",
    "hermes_cli.update_contract": "hermes_cli/update_contract.py",
}
_active_root: Path | None = None
_get_attributes = None
if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _get_attributes = ctypes.WinDLL("kernel32", use_last_error=True).GetFileAttributesW
    _get_attributes.argtypes = [wintypes.LPCWSTR]
    _get_attributes.restype = wintypes.DWORD


class NativeStartupRefusal(SystemExit):
    """Fail closed: Python site processing otherwise swallows .pth Exceptions."""


def _refuse(message: str) -> None:
    raise NativeStartupRefusal("NemoClaw Windows Hermes: " + message)


def _absolute_path(path: Path) -> Path:
    # This adapter runs inside MXC: GetFinalPathNameByHandle/realpath may be
    # denied even for a readable file. The host validates and protects the
    # installed runtime; here we validate its lexical identity and each path
    # component without changing Python's global path-resolution behavior.
    if (
        not path.is_absolute()
        or len(path.parts) > 64
        or len(str(path)) > 32767
        or "\x00" in str(path)
        or ".." in path.parts
    ):
        _refuse("an installer-owned runtime path is not a bounded absolute path.")
    if path.drive:
        if (
            len(path.drive) != 2
            or not path.drive[0].isascii()
            or not path.drive[0].isalpha()
            or path.drive[1] != ":"
            or any(
                any(character in part for character in ':<>"|?*')
                or part.endswith((".", " "))
                or PureWindowsPath(part).is_reserved()
                for part in path.parts[1:]
            )
        ):
            _refuse("an installer-owned runtime path has an unsupported identity.")
    return path


def _path_kind(path: Path) -> str:
    if _get_attributes is not None:
        # Unlike realpath/lstat in Python 3.11, this query does not need an
        # exclusive handle or final-path resolution. For a symbolic link it
        # returns the link's attributes, so every component is checked below.
        attributes = _get_attributes(str(path))
        if attributes == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        if attributes & (0x400 | 0x40):  # REPARSE_POINT or DEVICE
            _refuse(
                "an installer-owned runtime path has an invalid filesystem identity."
            )
        return "directory" if attributes & 0x10 else "file"
    info = path.lstat()
    if getattr(info, "st_file_attributes", 0) & 0x400:
        _refuse("an installer-owned runtime path contains a reparse point.")
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISREG(info.st_mode):
        return "file"
    _refuse("an installer-owned runtime path has an invalid filesystem identity.")


def _regular_file(path: Path, root: Path) -> Path:
    path = _absolute_path(path)
    root = _absolute_path(root)
    try:
        path.relative_to(root)
        # Check from the volume root downward so intermediate junctions and
        # symlinks are rejected before querying anything beneath them.
        # The installer-owned read-only tree prevents guest replacement races;
        # these checks do not replace that host ownership/lease boundary.
        for current in (*reversed(path.parents), path):
            expected = "file" if current == path else "directory"
            if _path_kind(current) != expected:
                _refuse(
                    "an installer-owned runtime path has an invalid filesystem identity."
                )
    except (OSError, ValueError):
        _refuse(
            "an installer-owned runtime file is unavailable; repair this installation."
        )
    return path


def _discover_root(module_path: Path) -> Path:
    location = _absolute_path(module_path)
    _regular_file(location, Path(location.anchor))
    for parent in list(location.parents)[:12]:
        marker = parent / MARKER
        try:
            _path_kind(marker)
        except FileNotFoundError:
            continue
        except OSError:
            _refuse("the native deployment marker is unavailable.")
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


def _prebuilt_node(root: Path) -> dict | None:
    contract = root / "nemoclaw-hermes-node.json"
    try:
        _path_kind(contract)
    except FileNotFoundError:
        return None  # The separately labeled component-only probe has no Node outputs.
    _regular_file(contract, root)
    with contract.open("rb") as stream:
        data = stream.read(8193)
    if len(data) > 8192:
        _refuse("the production Node contract exceeds its bound.")
    record = json.loads(data)
    if (
        type(record) is not dict
        or type(record.get("schemaVersion")) is not int
        or record.get("schemaVersion") != 1
        or record.get("upstreamCommit") != REVISION
        or record.get("profile") != "official-prebuilt-cli-web-tui"
        or record.get("tui") != "hermes-agent/ui-tui/dist/entry.js"
        or record.get("web") != "hermes-agent/hermes_cli/web_dist/index.html"
        or record.get("agentBrowser") != "agent-browser/bin/agent-browser-win32-x64.exe"
        or record.get("browserUse") != "0.13.10"
        or not isinstance(record.get("chromium"), str)
        or not re.fullmatch(
            r"browsers/chromium-[0-9]+/chrome-win64/chrome\.exe", record["chromium"]
        )
    ):
        _refuse("the production Node contract differs from the installed profile.")
    return {
        key: _regular_file(root / record[key], root)
        for key in ("tui", "web", "chromium", "agentBrowser")
    }


def _install_prebuilt_node(root: Path) -> None:
    files = _prebuilt_node(root)
    if files is None:
        return
    # Official Docker/Nix prebuilt branches bypass source compilation and lazy npm.
    os.environ["HERMES_TUI_DIR"] = str(files["tui"].parent.parent)
    os.environ["HERMES_WEB_DIST"] = str(files["web"].parent)
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(root / "browsers")
    os.environ["AGENT_BROWSER_EXECUTABLE_PATH"] = str(files["chromium"])


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


class _BrowserSessionOs:
    """Keep the canonical browser algorithm, inheriting its owned state's DACL."""

    def __init__(self, original, socket_root):
        self.original = original
        self.socket_root = socket_root

    def makedirs(self, name, mode=0o777, exist_ok=False):
        authority = os.environ.get("NEMOCLAW_AGENT_HOME")
        if mode != 0o700 or not authority:
            return self.original.makedirs(name, mode=mode, exist_ok=exist_ok)
        # This is the host-supplied private writable state root, already bound
        # by the native state owner/MXC policy. The canonical socket root may be
        # the state root itself or its temp child; do not assume a TMP spelling.
        state = _absolute_path(Path(authority))
        root = _absolute_path(Path(self.socket_root()))
        target = _absolute_path(Path(name))
        try:
            root.relative_to(state)
        except ValueError:
            _refuse("the browser socket root is outside its owned private state.")
        if (
            target.parent != root
            or not re.fullmatch(r"agent-browser-[A-Za-z0-9_-]{1,64}", target.name)
            or exist_ok is not True
        ):
            _refuse("the browser session directory identity is unsupported.")
        for current in (*reversed(target.parents), target):
            try:
                kind = _path_kind(current)
            except FileNotFoundError:
                if current == target:
                    break
                raise
            if kind != "directory":
                _refuse("the browser directory has an invalid filesystem identity.")
        # Python 3.11.10+ turns 0700 into an explicit owner/admin-only Windows
        # DACL, dropping the inherited sandbox capability. Ordinary creation
        # inherits the already restricted parent; no existing ACL is rewritten.
        return self.original.makedirs(name, mode=0o777, exist_ok=exist_ok)

    def __getattr__(self, name):
        return getattr(self.original, name)


def _adapt_module(module: ModuleType, root: Path, bash: Path) -> None:
    if module.__name__ == "tools.environments.local":
        original = module._find_bash

        def only_owned_candidates(_custom):
            return [str(_regular_file(bash, root))]

        def owned_bash():
            result = original()
            if _regular_file(Path(result), root) != _regular_file(bash, root):
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
    elif module.__name__ == "tools.browser_tool_install":
        files = _prebuilt_node(root)
        if files is None:
            _refuse("the installed production browser chain is missing.")
        executable = files["agentBrowser"]
        validated = False
        module._resolve_npx_bin = lambda: None

        def owned_browser(*, validate=True):
            nonlocal validated
            result = str(_regular_file(executable, root))
            # Keep upstream's runnable check, but never enter its npx/Ensure
            # installer fallback when the immutable official binary cannot run.
            if validate and not validated:
                if not module.agent_browser_runnable(result):
                    raise FileNotFoundError(
                        "The installed Hermes browser executable could not run. Repair NemoClaw."
                    )
                validated = True
            return result

        module._find_agent_browser = owned_browser
    elif module.__name__ == "tools.browser_tool_session":
        module.os = _BrowserSessionOs(module.os, module._bt._socket_safe_tmpdir)
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
        if _regular_file(Path(spec.origin), self.root) != expected:
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
        _install_prebuilt_node(root)
        _install_temp_directories()
        sys.meta_path.insert(0, _NativeFinder(root, bash))
        _active_root = root
    except NativeStartupRefusal:
        raise
    except Exception:
        _refuse("native startup policy could not be initialized safely.")
