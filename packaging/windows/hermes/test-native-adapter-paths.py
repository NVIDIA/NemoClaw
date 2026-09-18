# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Actual-file adapter path controls; Windows/MXC execution is a separate gate."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import stat
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).absolute().with_name("nemoclaw_native_windows.py")
spec = importlib.util.spec_from_file_location("native_adapter_path_controls", SOURCE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
browser_spec = importlib.util.spec_from_file_location(
    "browser_use_adapter_controls", SOURCE.with_name("nemoclaw_browser_use.py")
)
browser_adapter = importlib.util.module_from_spec(browser_spec)
browser_spec.loader.exec_module(browser_adapter)


class AdapterPathControls(unittest.TestCase):
    def browser_fixture(self):
        module = ModuleType(browser_adapter.MODULE)
        module.__file__ = str(self.root / "hermes-agent" / browser_adapter.RELATIVE)
        module._find_cli = lambda: self.fail("The unowned resolver was called")
        for relative, content in (
            ("hermes-agent/" + browser_adapter.RELATIVE, b"owned Hermes policy"),
            (browser_adapter.PYTHON, b"owned interpreter fixture"),
            (browser_adapter.CLI, b"owned CLI fixture"),
            (browser_adapter.ENTRY_POINTS, b"owned entrypoint fixture"),
        ):
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        return module

    def test_browser_module_route_preserves_owned_command_without_realpath(self):
        module = self.browser_fixture()
        with (
            patch.object(adapter, "_active_root", self.root),
            patch.object(
                browser_adapter,
                "CLI_SHA256",
                hashlib.sha256(b"owned CLI fixture").hexdigest(),
            ),
            patch.object(
                browser_adapter,
                "ENTRY_POINTS_SHA256",
                hashlib.sha256(b"owned entrypoint fixture").hexdigest(),
            ),
            patch.object(Path, "resolve", side_effect=PermissionError("WinError 5")),
            patch.object(
                os.path, "realpath", side_effect=PermissionError("WinError 5")
            ),
        ):
            result = browser_adapter.adapt(module, self.root, adapter)
            expected = [
                str(self.root / browser_adapter.PYTHON),
                "-I",
                "-B",
                "-m",
                "browser_use.cli",
            ]
            self.assertEqual(module._find_cli(), expected)
            self.assertEqual(result["command"], expected)
            self.assertFalse(result["runtimeBytesModified"])
            (self.root / browser_adapter.PYTHON).unlink()
            with self.assertRaises(adapter.NativeStartupRefusal):
                module._find_cli()

    def test_browser_entry_read_failure_uses_primary_startup_refusal(self):
        module = self.browser_fixture()
        with (
            patch.object(adapter, "_active_root", self.root),
            patch.object(Path, "read_bytes", side_effect=PermissionError("WinError 5")),
            self.assertRaises(adapter.NativeStartupRefusal),
        ):
            browser_adapter.adapt(module, self.root, adapter)

    def test_browser_companion_reuses_native_loader_and_is_idempotent(self):
        fake = ModuleType("nemoclaw_native_windows")
        fake._active_root = self.root
        fake._MODULES = {}
        calls = []
        fake._adapt_module = lambda *args: calls.append(args)
        fake._refuse = adapter._refuse
        with (
            patch.dict(sys.modules, {"nemoclaw_native_windows": fake}),
            patch.object(browser_adapter, "os", SimpleNamespace(name="nt")),
            patch.object(browser_adapter, "_installed_root", None),
            patch.object(browser_adapter, "adapt") as adapt,
        ):
            browser_adapter.install()
            installed = fake._adapt_module
            browser_adapter.install()
            self.assertIs(installed, fake._adapt_module)
            self.assertEqual(
                fake._MODULES, {browser_adapter.MODULE: browser_adapter.RELATIVE}
            )
            target = ModuleType(browser_adapter.MODULE)
            fake._adapt_module(target, self.root, self.bash)
            self.assertEqual(calls, [(target, self.root, self.bash)])
            adapt.assert_called_once_with(target, self.root, fake)

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="native-adapter-path-")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        self.hook = (
            self.root / "hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py"
        )
        self.hook.parent.mkdir(parents=True)
        self.hook.write_bytes(SOURCE.read_bytes())
        self.marker = self.root / adapter.MARKER
        self.record = {
            "schemaVersion": 1,
            "manager": "nemoclaw-windows",
            "hermesRevision": adapter.REVISION,
            "layoutVersion": 1,
        }
        self.marker.write_text(json.dumps(self.record))
        self.bash = self.root / "git/bin/bash.exe"
        for file in (
            self.bash,
            self.root / "git/usr/bin/bash.exe",
            self.root / "git/usr/bin/msys-2.0.dll",
        ):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"owned-file-fixture")

    def test_readable_startup_file_does_not_require_realpath(self):
        with (
            patch.object(
                Path, "resolve", side_effect=PermissionError("controlled WinError 5")
            ),
            patch.object(
                os.path,
                "realpath",
                side_effect=PermissionError("controlled WinError 5"),
            ),
        ):
            self.assertEqual(adapter._discover_root(self.hook), self.root)
            self.assertEqual(adapter._regular_file(self.bash, self.root), self.bash)

    def test_windows_case_variants_preserve_component_identity(self):
        root = adapter._absolute_path(
            PureWindowsPath(r"C:\Program Files\NVIDIA\NemoClaw")
        )
        target = adapter._absolute_path(
            PureWindowsPath(r"c:\PROGRAM FILES\nvidia\nemoclaw\git\bin\bash.exe")
        )
        self.assertEqual(target.relative_to(root), PureWindowsPath(r"git\bin\bash.exe"))
        with self.assertRaises(ValueError):
            PureWindowsPath(
                r"C:\Program Files\NVIDIA\NemoClaw-other\bash.exe"
            ).relative_to(root)

    def test_owned_state_walk_omits_only_the_denied_volume_anchor(self):
        state = PureWindowsPath(
            r"C:\NemoClawState-S-1-5-21-100-200-300-1001-hermes"
        )
        target = state / ".hermes" / "logs" / "curator"
        self.assertEqual(
            adapter._owned_state_walk(target, str(state)),
            (
                state,
                state / ".hermes",
                state / ".hermes" / "logs",
                target,
            ),
        )
        self.assertIsNone(
            adapter._owned_state_walk(
                PureWindowsPath(r"C:\Program Files\NVIDIA"), str(state)
            )
        )
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._owned_state_walk(target, r"C:\untrusted-state")

    def test_config_home_link_scan_never_queries_the_denied_volume_anchor(self):
        class ContainedPath(PureWindowsPath):
            def is_symlink(self):
                if str(self) == self.anchor:
                    raise PermissionError("the volume anchor is outside the grant")
                return self.name == "linked"

        state = ContainedPath(
            r"C:\NemoClawState-S-1-5-21-100-200-300-1001-hermes"
        )
        module = ModuleType("hermes_cli.config_home")
        module._directory_links = lambda path: [
            part for part in (*reversed(path.parents), path) if part.is_symlink()
        ]
        with patch.dict(os.environ, {"NEMOCLAW_AGENT_HOME": str(state)}):
            adapter._adapt_module(module, self.root, self.bash)
            self.assertEqual(
                module._directory_links(state / ".hermes" / "linked"),
                [state / ".hermes" / "linked"],
            )

    def test_prebuilt_tui_preserves_validated_main_path_without_volume_realpath(self):
        node = self.root / "node/node.exe"
        entry = self.root / "hermes-agent/ui-tui/dist/entry.js"
        for file in (node, entry):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"owned")
        module = ModuleType("hermes_cli.main_tui_launch")
        module._make_tui_argv = lambda _root, _dev: (
            [str(node), "--expose-gc", str(entry)],
            entry.parent.parent,
        )
        with (
            patch.dict(os.environ, {"HERMES_NODE": str(node)}),
            patch.object(adapter, "_regular_file", side_effect=lambda path, _root: path),
            patch.object(
                adapter,
                "_prebuilt_node",
                return_value={"tui": entry, "web": self.root / "web/index.html"},
            ),
        ):
            adapter._adapt_module(module, self.root, self.bash)
        argv, cwd = module._make_tui_argv(entry.parent.parent, False)
        self.assertEqual(
            argv,
            [str(node), "--preserve-symlinks-main", "--expose-gc", str(entry)],
        )
        self.assertEqual(cwd, entry.parent.parent)
        with self.assertRaises(adapter.NativeStartupRefusal):
            module._make_tui_argv(entry.parent.parent, True)

    def test_relative_traversal_device_stream_and_unbounded_paths_refused(self):
        for value in (
            "git/bash.exe",
            r"C:git\bash.exe",
            r"C:\runtime\..\foreign\bash.exe",
            r"\\?\C:\runtime\bash.exe",
            r"\\server\share\bash.exe",
            r"C:\runtime\bash.exe:stream",
            "C:\\runtime.\\bash.exe",
            "C:\\runtime \\bash.exe",
            "C:\\" + "a\\" * 65 + "bash.exe",
            "C:\\" + "a" * 32768,
        ):
            with (
                self.subTest(value=value[:80]),
                self.assertRaises(adapter.NativeStartupRefusal),
            ):
                adapter._absolute_path(PureWindowsPath(value))

    def test_sibling_is_not_inside_runtime(self):
        sibling = self.root.with_name(self.root.name + "-sibling")
        sibling.mkdir()
        self.addCleanup(sibling.rmdir)
        file = sibling / "bash.exe"
        file.write_bytes(b"foreign")
        self.addCleanup(file.unlink)
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._regular_file(file, self.root)

    def test_missing_or_nonregular_file_refused(self):
        for file in (self.root / "missing", self.bash.parent):
            with (
                self.subTest(file=file),
                self.assertRaises(adapter.NativeStartupRefusal),
            ):
                adapter._regular_file(file, self.root)

    def test_intermediate_symlink_refused_even_when_target_is_inside(self):
        link = self.root / "git-link"
        link.symlink_to(self.root / "git", target_is_directory=True)
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._regular_file(link / "bin/bash.exe", self.root)

    def test_root_symlink_cannot_supply_an_alternate_runtime_identity(self):
        link = self.root / "alias"
        link.symlink_to(self.root / "hermes-agent", target_is_directory=True)
        alias_hook = link / "venv/Lib/site-packages/nemoclaw_native_windows.py"
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._discover_root(alias_hook)

    def test_marker_symlink_refused(self):
        actual = self.root / "actual-marker.json"
        self.marker.rename(actual)
        self.marker.symlink_to(actual)
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._discover_root(self.hook)

    def test_windows_directory_reparse_bit_refused_without_following_it(self):
        actual_lstat = Path.lstat
        directory = self.bash.parent

        def observe(path):
            if path == directory:
                return SimpleNamespace(
                    st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0x400
                )
            return actual_lstat(path)

        with (
            patch.object(adapter, "_get_attributes", None),
            patch.object(Path, "lstat", observe),
            self.assertRaises(adapter.NativeStartupRefusal),
        ):
            adapter._regular_file(self.bash, self.root)

    def test_windows_attribute_walk_rejects_reparse_before_querying_children(self):
        observed = []
        blocked = self.bash.parent

        def attributes(value):
            current = Path(value)
            observed.append(current)
            if current == blocked:
                return 0x410  # DIRECTORY | REPARSE_POINT
            return 0x10 if current != self.bash else 0x20

        with (
            patch.object(adapter, "_get_attributes", attributes),
            patch.object(
                Path,
                "lstat",
                side_effect=AssertionError("Windows query must not fall back to lstat"),
            ),
            self.assertRaises(adapter.NativeStartupRefusal),
        ):
            adapter._regular_file(self.bash, self.root)
        self.assertEqual(observed[-1], blocked)
        self.assertNotIn(self.bash, observed)
        with (
            patch.object(adapter, "_get_attributes", lambda path: 0x40),
            self.assertRaises(adapter.NativeStartupRefusal),
        ):
            adapter._path_kind(self.bash)

    def test_only_declared_volume_mount_reparse_is_allowed(self):
        mount = self.root.parent
        observed = []

        def attributes(value):
            current = Path(value)
            observed.append(current)
            if current == mount:
                return 0x410  # DIRECTORY | REPARSE_POINT
            return 0x20 if current == self.bash else 0x10

        with patch.object(adapter, "_get_attributes", attributes):
            self.assertEqual(
                adapter._regular_file(self.bash, self.root, mount), self.bash
            )
            self.assertEqual(observed[0], mount)
            self.assertNotIn(mount.parent, observed)
            with self.assertRaises(adapter.NativeStartupRefusal):
                adapter._regular_file(self.bash, self.root, self.root)

    def test_installed_mount_requires_exact_host_authority_and_volume_guid(self):
        identity = "a" * 64
        root = PureWindowsPath(
            rf"C:\Program Files\NVIDIA\NemoClaw\runtimes\{identity}\hermes"
        )
        volume = "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\"

        def volume_name(path, output, size):
            self.assertEqual(path, str(root.parent) + "\\")
            self.assertGreaterEqual(size, len(volume) + 1)
            output.value = volume
            return 1

        with (
            patch.dict(os.environ, {"NEMOCLAW_AGENT_RUNTIME": str(root)}),
            patch.object(adapter, "Path", PureWindowsPath),
            patch.object(adapter, "_get_volume_name", volume_name),
        ):
            self.assertEqual(adapter._runtime_volume_mount(root), root.parent)
            with self.assertRaises(adapter.NativeStartupRefusal):
                adapter._runtime_volume_mount(root.with_name("other"))
            with (
                patch.object(adapter, "_get_volume_name", lambda *_args: 0),
                self.assertRaises(adapter.NativeStartupRefusal),
            ):
                adapter._runtime_volume_mount(root)

    def test_windows_attribute_failure_refuses_without_falling_back(self):
        windows_error = SimpleNamespace(
            get_last_error=lambda: 5,
            WinError=lambda code: PermissionError(code, "controlled WinError 5"),
        )
        with (
            patch.object(adapter, "_get_attributes", lambda path: 0xFFFFFFFF),
            patch.object(adapter, "ctypes", windows_error, create=True),
            patch.object(
                Path, "lstat", side_effect=AssertionError("must not fall back")
            ),
            self.assertRaises(adapter.NativeStartupRefusal),
        ):
            adapter._regular_file(self.bash, self.root)

    def test_marker_identity_bounds_and_adapter_location_remain_required(self):
        for contents in (
            json.dumps({**self.record, "hermesRevision": "0" * 40}),
            json.dumps({**self.record, "schemaVersion": True}),
            " " * (16 * 1024 + 1),
        ):
            self.marker.write_text(contents)
            with (
                self.subTest(size=len(contents)),
                self.assertRaises(adapter.NativeStartupRefusal),
            ):
                adapter._discover_root(self.hook)
        self.marker.write_text(json.dumps(self.record))
        foreign_hook = self.root / "foreign.py"
        foreign_hook.write_bytes(SOURCE.read_bytes())
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._discover_root(foreign_hook)

    def test_bash_remains_owned_and_must_actually_start(self):
        module = ModuleType("tools.environments.local")
        module._find_bash = lambda: str(self.bash)
        module._bash_starts = lambda path: True
        adapter._adapt_module(module, self.root, self.bash)
        with patch.object(
            Path, "resolve", side_effect=PermissionError("controlled WinError 5")
        ):
            self.assertEqual(module._find_bash(), str(self.bash))
            module._bash_starts = lambda path: False
            with self.assertRaisesRegex(RuntimeError, "could not start"):
                module._find_bash()
        foreign = ModuleType("tools.environments.local")
        foreign._find_bash = lambda: str(self.root / "git/usr/bin/bash.exe")
        foreign._bash_starts = lambda path: self.fail("foreign shell must not execute")
        adapter._adapt_module(foreign, self.root, self.bash)
        with self.assertRaises(adapter.NativeStartupRefusal):
            foreign._find_bash()

    def test_owned_module_origin_works_without_realpath_or_ambient_search_path(
        self,
    ):
        expected = self.root / "hermes-agent/tools/lazy_deps.py"
        expected.parent.mkdir(parents=True)
        expected.write_text(
            "raise AssertionError('resolution must not execute source')"
        )
        finder = adapter._NativeFinder(self.root, self.bash)
        with patch.object(
            Path, "resolve", side_effect=PermissionError("controlled WinError 5")
        ):
            result = finder.find_spec("tools.lazy_deps", [str(expected.parent)])
            self.assertIsInstance(result.loader, adapter._NativeLoader)
        foreign = self.root / "foreign"
        foreign.mkdir()
        (foreign / "lazy_deps.py").write_text(
            "raise AssertionError('foreign source must not execute')"
        )
        result = finder.find_spec("tools.lazy_deps", [str(foreign)])
        self.assertEqual(Path(result.origin), expected)
        self.assertIsInstance(result.loader, adapter._NativeLoader)

    def test_real_child_startup_policy_with_denied_realpath_keeps_tempfile_operations(
        self,
    ):
        script = """import importlib.util, os, pathlib, sys, tempfile, types
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("owned_adapter", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
# Portable seam substitutes only the adapter platform guard, not global os/path.
module.os = types.SimpleNamespace(name="nt", environ=os.environ)
with patch.object(pathlib.Path, "resolve", side_effect=PermissionError("controlled WinError 5")), patch.object(os.path, "realpath", side_effect=PermissionError("controlled WinError 5")):
    module.install()
    assert module._active_root == pathlib.Path(sys.argv[2])
    with tempfile.TemporaryDirectory(dir=sys.argv[2]) as directory:
        file = pathlib.Path(directory) / "temp.txt"
        file.write_text("owned-parent-temp")
        assert file.read_text() == "owned-parent-temp"
    assert not pathlib.Path(directory).exists()
print("ADAPTER_STARTUP_AND_TEMP_PASS")
"""
        result = subprocess.run(
            [sys.executable, "-I", "-c", script, str(self.hook), str(self.root)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ADAPTER_STARTUP_AND_TEMP_PASS")


if __name__ == "__main__":
    unittest.main()
