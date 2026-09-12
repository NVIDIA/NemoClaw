# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Private-root/browser-namespace controls; actual Windows DACL proof is separate."""

import argparse
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location(
    "browser_adapter_controls", HERE / "nemoclaw_native_windows.py"
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class BrowserInheritanceControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="owned-browser-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.environment = patch.dict(
            os.environ, {"NEMOCLAW_AGENT_HOME": str(self.root)}
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.calls = []
        original = SimpleNamespace(makedirs=self.mkdirs, path=os.path, open=os.open)
        self.proxy = adapter._BrowserSessionOs(original, lambda: str(self.root))

    def mkdirs(self, name, **kwargs):
        self.calls.append((str(name), kwargs))
        return os.makedirs(name, **kwargs)

    def test_actual_state_root_and_temp_child_both_inherit(self):
        for root in [self.root, self.root / "temp"]:
            root.mkdir(exist_ok=True)
            proxy = adapter._BrowserSessionOs(self.proxy.original, lambda: str(root))
            target = root / "agent-browser-h_0123456789"
            proxy.makedirs(target, mode=0o700, exist_ok=True)
            self.assertEqual(self.calls[-1][1], {"mode": 0o777, "exist_ok": True})
            with (target / "_stdout_get").open("w") as stream:
                stream.write("controlled")
            self.assertEqual((target / "_stdout_get").read_text(), "controlled")
            (target / "_stdout_get").unlink()

    def test_global_os_file_operations_and_other_modes_remain_original(self):
        original = os.makedirs
        self.assertIs(self.proxy.path, os.path)
        self.assertIs(self.proxy.open, os.open)
        self.proxy.makedirs(self.root / "other", mode=0o755)
        self.assertEqual(self.calls[-1][1]["mode"], 0o755)
        self.assertIs(os.makedirs, original)

    def test_unbound_host_process_keeps_original_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            self.proxy.makedirs(
                self.root / "agent-browser-h_0", mode=0o700, exist_ok=True
            )
        self.assertEqual(self.calls[-1][1]["mode"], 0o700)

    def test_existing_directory_is_not_repermissioned(self):
        target = self.root / "agent-browser-h_0"
        target.mkdir(mode=0o700)
        before = target.stat().st_mode
        with patch.object(
            os, "chmod", side_effect=AssertionError("No ACL/mode rewrite")
        ):
            self.proxy.makedirs(target, mode=0o700, exist_ok=True)
        self.assertEqual(target.stat().st_mode, before)

    def test_outside_canonical_root_and_invalid_leaf_are_refused_before_creation(self):
        for target in [
            self.root / "other",
            self.root / "agent-browser-..",
            self.root / "nested/agent-browser-h_0",
            self.root / "../agent-browser-h_0",
        ]:
            with (
                self.subTest(target=target),
                self.assertRaises(adapter.NativeStartupRefusal),
            ):
                self.proxy.makedirs(target, mode=0o700, exist_ok=True)
        self.assertEqual(self.calls, [])

    def test_socket_root_outside_host_authority_is_refused(self):
        foreign = self.root.parent
        proxy = adapter._BrowserSessionOs(self.proxy.original, lambda: str(foreign))
        with self.assertRaises(adapter.NativeStartupRefusal):
            proxy.makedirs(foreign / "agent-browser-h_0", mode=0o700, exist_ok=True)
        self.assertEqual(self.calls, [])

    def test_redirected_parent_or_leaf_is_refused(self):
        real = self.root / "real"
        real.mkdir()
        link = self.root / "link"
        link.symlink_to(real, target_is_directory=True)
        for root, leaf in [
            (link, "agent-browser-h_0"),
            (self.root, "agent-browser-h_1"),
        ]:
            if root == self.root:
                (root / leaf).symlink_to(real, target_is_directory=True)
            proxy = adapter._BrowserSessionOs(self.proxy.original, lambda: str(root))
            with self.assertRaises(adapter.NativeStartupRefusal):
                proxy.makedirs(root / leaf, mode=0o700, exist_ok=True)
        self.assertEqual(self.calls, [])

    def test_only_browser_module_receives_local_delegate(self):
        module = ModuleType("tools.browser_tool_session")
        module.os = os
        module._bt = SimpleNamespace(_socket_safe_tmpdir=lambda: str(self.root))
        adapter._adapt_module(module, self.root, self.root / "unused-bash")
        self.assertIsInstance(module.os, adapter._BrowserSessionOs)
        self.assertIs(module.os.original, os)
        self.assertIsNot(module.os, os)

    def test_session_loader_defers_origin_lookup_until_lifecycle_import_finishes(self):
        lifecycle = ModuleType("tools.browser_tool_lifecycle")
        lookups = []

        class OriginProxy:
            def __getattr__(_, name):
                lookups.append(name)
                # This callback exists only after the importing lifecycle module
                # has finished importing browser_tool_session.
                lifecycle._emergency_cleanup_all_sessions
                return lambda: str(self.root)

        module = ModuleType("tools.browser_tool_session")
        module.os = self.proxy.original
        module._bt = OriginProxy()
        loader = adapter._NativeLoader(
            SimpleNamespace(exec_module=lambda module: None),
            self.root,
            self.root / "unused-bash",
        )
        loader.exec_module(module)
        self.assertEqual(lookups, [])
        lifecycle._emergency_cleanup_all_sessions = lambda: None
        target = self.root / "agent-browser-after_import"
        module.os.makedirs(target, mode=0o700, exist_ok=True)
        self.assertEqual(lookups, ["_socket_safe_tmpdir"])
        self.assertTrue(target.is_dir())
        self.assertEqual(self.calls[-1][1], {"mode": 0o777, "exist_ok": True})

    def test_actual_pinned_prepare_algorithm_and_owner_record_remain(self):
        text = SOURCE.read_text()
        self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), EXPECTED_SOURCE)
        tree = ast.parse(text)
        node = next(
            n
            for n in tree.body
            if isinstance(n, ast.FunctionDef)
            and n.name == "_prepare_session_socket_dir"
        )
        owner = []
        namespace = {
            "os": self.proxy,
            "_bt": SimpleNamespace(_socket_safe_tmpdir=lambda: str(self.root)),
            "_lifecycle": SimpleNamespace(
                _write_owner_pid=lambda *args: owner.append(args)
            ),
        }
        exec(
            compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"),
            namespace,
        )
        namespace["os"] = self.proxy.original
        namespace[node.name]("h_before0123")
        self.assertEqual(self.calls[-1][1]["mode"], 0o700)
        owner.clear()
        namespace["os"] = self.proxy
        result = namespace[node.name]("h_0123456789")
        self.assertEqual(result, str(self.root / "agent-browser-h_0123456789"))
        self.assertEqual(owner, [(result, "h_0123456789")])
        self.assertEqual(self.calls[-1][1]["mode"], 0o777)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--source", type=Path, required=True)
    args, remaining = parser.parse_known_args()
    SOURCE = args.source
    EXPECTED_SOURCE = "ca96d518d51119ab9d63ba5bb117d4a4049503667fab87735b2c4181a79e3cc3"
    unittest.main(argv=[__file__, *remaining])
