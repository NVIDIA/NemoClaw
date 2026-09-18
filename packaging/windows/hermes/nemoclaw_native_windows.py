# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Additive startup policy for the official Hermes environment shipped by NemoClaw.

Loaded by an early .pth in installer-owned Python environments. No upstream
module is imported eagerly or edited. Non-Windows interpreters are unchanged.
"""

from __future__ import annotations

import ctypes
import importlib.abc
import importlib.util
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
    "hermes_cli.config_home": "hermes_cli/config_home.py",
    "hermes_cli.main_tui_launch": "hermes_cli/main_tui_launch.py",
    "tools.environments.local": "tools/environments/local.py",
    "tools.lazy_deps": "tools/lazy_deps.py",
    "tools.browser_tool_install": "tools/browser_tool_install.py",
    "tools.browser_tool_session": "tools/browser_tool_session.py",
    "hermes_cli.update_contract": "hermes_cli/update_contract.py",
}
_active_root: Path | None = None
_get_attributes = None
_get_volume_name = None
if os.name == "nt":
    from ctypes import wintypes

    _get_attributes = ctypes.WinDLL("kernel32", use_last_error=True).GetFileAttributesW
    _get_attributes.argtypes = [wintypes.LPCWSTR]
    _get_attributes.restype = wintypes.DWORD
    _get_volume_name = ctypes.WinDLL(
        "kernel32", use_last_error=True
    ).GetVolumeNameForVolumeMountPointW
    _get_volume_name.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    _get_volume_name.restype = wintypes.BOOL


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


def _same_path(left: Path, right: Path) -> bool:
    return str(left).replace("/", "\\").rstrip("\\").casefold() == str(
        right
    ).replace("/", "\\").rstrip("\\").casefold()


def _owned_state_walk(path: Path, authority: str | None) -> tuple[Path, ...] | None:
    """Return only the host-attested state-root portion of an absolute path walk."""
    if not authority:
        return None
    candidate = _absolute_path(path)
    state = _absolute_path(type(path)(authority))
    if re.fullmatch(
        r"[A-Za-z]:\\NemoClawState-S-1-(?:[0-9]+-)*[0-9]+-hermes",
        str(state).replace("/", "\\"),
    ) is None:
        _refuse("the host-supplied native state identity is invalid.")
    try:
        candidate.relative_to(state)
    except ValueError:
        return None
    walk = (*reversed(candidate.parents), candidate)
    try:
        start = next(
            index for index, current in enumerate(walk) if _same_path(current, state)
        )
    except StopIteration:
        _refuse("the native state path is outside its host authority.")
    # The native state owner already created and holds this ordinary directory
    # directly below the validated SystemDrive root. MXC grants the exact state
    # subtree, while querying the volume anchor itself is deliberately denied.
    return walk[start:]


def _runtime_volume_mount(root: Path) -> Path | None:
    authority = os.environ.get("NEMOCLAW_AGENT_RUNTIME")
    if authority is None:
        return None
    expected = _absolute_path(Path(authority))
    if not _same_path(root, expected):
        _refuse("the host runtime authority differs from the installed deployment.")
    mount = root.parent
    if (
        root.name.casefold() != "hermes"
        or re.fullmatch(r"[a-f0-9]{64}", mount.name) is None
        or mount.parent.name.casefold() != "runtimes"
        or _get_volume_name is None
    ):
        _refuse("the installed runtime mount identity is invalid.")
    volume = ctypes.create_unicode_buffer(64)
    mount_path = str(mount).rstrip("\\/") + "\\"
    if _get_volume_name(mount_path, volume, len(volume)) == 0 or re.fullmatch(
        r"\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\", volume.value
    ) is None:
        _refuse("the installed runtime is not an exact volume mount.")
    return mount


def _path_kind(path: Path, allowed_mount: Path | None = None) -> str:
    if _get_attributes is not None:
        # Unlike realpath/lstat in Python 3.11, this query does not need an
        # exclusive handle or final-path resolution. For a symbolic link it
        # returns the link's attributes, so every component is checked below.
        attributes = _get_attributes(str(path))
        if attributes == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        if attributes & 0x40:  # DEVICE
            _refuse(
                "an installer-owned runtime path has an invalid filesystem identity."
            )
        if attributes & 0x400 and (
            allowed_mount is None or not _same_path(path, allowed_mount)
        ):
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


def _regular_file(
    path: Path, root: Path, allowed_mount: Path | None = None
) -> Path:
    path = _absolute_path(path)
    root = _absolute_path(root)
    if allowed_mount is None:
        allowed_mount = _runtime_volume_mount(root)
    try:
        path.relative_to(root)
        walk = [*reversed(path.parents), path]
        if allowed_mount is not None:
            allowed_mount = _absolute_path(allowed_mount)
            if not _same_path(root.parent, allowed_mount):
                _refuse(
                    "an installer-owned runtime path has an invalid filesystem identity."
                )
            path.relative_to(allowed_mount)
            start = next(
                index
                for index, current in enumerate(walk)
                if _same_path(current, allowed_mount)
            )
            walk = walk[start:]
        # Check from the volume root downward so intermediate junctions and
        # symlinks are rejected before querying anything beneath them.
        # The installer-owned read-only tree prevents guest replacement races;
        # these checks do not replace that host ownership/lease boundary.
        for current in walk:
            expected = "file" if current == path else "directory"
            if _path_kind(current, allowed_mount) != expected:
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
        mount = _runtime_volume_mount(parent)
        _regular_file(location, parent, mount)
        _regular_file(marker, parent, mount)
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
        or record.get("browserUse") != "0.13.10"
    ):
        _refuse("the production Node contract differs from the installed profile.")
    edge = record.get("browserHost") == "native-edge-cdp"
    if edge:
        if "chromium" in record or "agentBrowser" in record:
            _refuse("the native Edge profile cannot select bundled Chromium.")
    elif not isinstance(record.get("chromium"), str) or not re.fullmatch(
        r"browsers/chromium-[0-9]+/chrome-win64/chrome\.exe", record["chromium"]
    ):
        _refuse("the production browser contract differs from the installed profile.")
    selected = ("tui", "web") if edge else ("tui", "web", "chromium", "agentBrowser")
    return {
        key: _regular_file(root / record[key], root)
        for key in selected
    }


def _install_prebuilt_node(root: Path) -> None:
    files = _prebuilt_node(root)
    if files is None:
        return
    # Official Docker/Nix prebuilt branches bypass source compilation and lazy npm.
    os.environ["HERMES_TUI_DIR"] = str(files["tui"].parent.parent)
    os.environ["HERMES_WEB_DIST"] = str(files["web"].parent)
    edge_cdp = os.environ.get("BROWSER_CDP_URL")
    if edge_cdp:
        if "chromium" in files:
            _refuse("the installed runtime did not select native Microsoft Edge.")
        if not re.fullmatch(
            r"ws://127\.0\.0\.1:[1-9][0-9]{0,4}/devtools/browser/[A-Za-z0-9-]{1,128}",
            edge_cdp,
        ):
            _refuse("the native Microsoft Edge CDP endpoint is invalid.")
        # The official Hermes browser interface connects through the guarded
        # CDP override. No local Chrome/Chromium executable is selected.
        os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
        os.environ.pop("AGENT_BROWSER_EXECUTABLE_PATH", None)
    else:
        if "chromium" not in files:
            _refuse("the native Microsoft Edge CDP channel is unavailable.")
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
    if module.__name__ == "hermes_cli.config_home":
        original = module._directory_links

        def owned_directory_links(path):
            walk = _owned_state_walk(path, os.environ.get("NEMOCLAW_AGENT_HOME"))
            if walk is None:
                return original(path)
            return [part for part in walk if part.is_symlink()]

        module._directory_links = owned_directory_links
    elif module.__name__ == "hermes_cli.main_tui_launch":
        files = _prebuilt_node(root)
        node_value = os.environ.get("HERMES_NODE")
        if files is None or not node_value:
            _refuse("the installed prebuilt TUI launch contract is missing.")
        node = _regular_file(Path(node_value), root)
        entry = files["tui"]
        tui_root = entry.parent.parent
        original = module._make_tui_argv

        def owned_tui_argv(tui_dir, tui_dev):
            argv, cwd = original(tui_dir, tui_dev)
            if (
                tui_dev
                or argv != [str(node), "--expose-gc", str(entry)]
                or not _same_path(Path(cwd), tui_root)
            ):
                _refuse("the official prebuilt TUI launch command changed.")
            # Node's default main-module realpath walk queries the otherwise
            # ungranted volume anchor. The immutable entry path was validated
            # above, so preserve only the main spelling; dependency resolution
            # and every runtime/file grant remain unchanged.
            return [str(node), "--preserve-symlinks-main", *argv[1:]], cwd

        module._make_tui_argv = owned_tui_argv
    elif module.__name__ == "tools.environments.local":
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
        executable = files.get("agentBrowser")
        validated = False
        module._resolve_npx_bin = lambda: None

        def owned_browser(*, validate=True):
            nonlocal validated
            if executable is None:
                raise FileNotFoundError(
                    "The native ARM64 profile uses browser_exec through Microsoft Edge."
                )
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
        # The upstream origin proxy may still be inside the lifecycle import.
        module.os = _BrowserSessionOs(
            module.os, lambda: module._bt._socket_safe_tmpdir()
        )
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
        expected = _regular_file(self.root / "hermes-agent" / relative, self.root)
        # Editable-install finders may retain a relative origin after the
        # runtime is moved into its sealed volume. Select the exact allowlisted
        # file directly instead of admitting an ambient search-path result.
        spec = importlib.util.spec_from_file_location(fullname, expected)
        if (
            spec is None
            or spec.loader is None
            or not spec.origin
            or not _same_path(Path(spec.origin), expected)
        ):
            _refuse("an official Hermes policy module could not be resolved.")
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
