# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Test-only interpreter identity and bytecode fixtures; no native payload runs."""

import builtins
import importlib.util
import hashlib
import os
from pathlib import Path
import py_compile
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NATIVE = load("browser_bootstrap_native_controls", "nemoclaw_native_windows.py")
BROWSER = load("browser_bootstrap_adapter_controls", "nemoclaw_browser_use.py")


class BrowserPipeBootstrap(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-browser-bootstrap-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "hermes"
        self.workers = self.base / "workers"
        self.python = self.root / BROWSER.PYTHON
        self.python.parent.mkdir(parents=True)
        self.python.write_bytes(b"identity fixture; never executed")
        self.workers.mkdir()
        self.env = {
            "NEMOCLAW_HERMES_BROWSER_PIPE_PORT": "8124",
            "NEMOCLAW_WORKER_ROOT": str(self.workers),
        }

    def compile(self, code):
        source = self.workers / "hermes-browser-bootstrap.py"
        source.write_text(code)
        py_compile.compile(
            str(source), cfile=str(source.with_suffix(".pyc")), doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
        source.unlink()

    def invoke(self, env=None, executable=None):
        with (
            patch.dict(os.environ, self.env if env is None else env, clear=True),
            patch.object(sys, "executable", str(executable or self.python)),
        ):
            BROWSER._install_pipe_bootstrap(self.root, NATIVE)

    def test_inactive_and_other_interpreter_do_not_load_worker(self):
        self.invoke(env={})
        self.invoke(executable=self.root / "other-python.exe")

    def test_exact_sourceless_worker_loads_without_pythonpath(self):
        self.compile("import builtins; builtins._hermes_browser_test_loaded = True\n")
        with patch.object(builtins, "_hermes_browser_test_loaded", False, create=True):
            self.invoke()
            self.assertTrue(builtins._hermes_browser_test_loaded)
        self.assertEqual(
            [p.name for p in self.workers.iterdir()], ["hermes-browser-bootstrap.pyc"]
        )

    def test_personal_stage_is_exact_and_cannot_replace_an_installed_worker(self):
        nonce = "0123456789abcdef01234567"
        root = r"C:\NemoClawHermesProbe-abcdef012345"
        workers = r"C:\NemoClawPersonalNode-0123456789ab\workers"
        env = {"GITHUB_ACTIONS": "true", "NEMOCLAW_PERSONAL_BROWSER_SESSION": nonce,
               "NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256": "a" * 64,
               "NEMOCLAW_WORKER_ROOT": workers}
        self.assertEqual(str(BROWSER._personal_workers(root, env)), workers)
        for key, value in (("GITHUB_ACTIONS", "false"), ("NEMOCLAW_AGENT_RUNTIME", root),
                           ("NEMOCLAW_PERSONAL_BROWSER_SESSION", "other"),
                           ("NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256", "a"),
                           ("NEMOCLAW_WORKER_ROOT", r"C:\workers")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                BROWSER._personal_workers(root, {**env, key: value})
        with self.assertRaises(ValueError):
            BROWSER._personal_workers(r"C:\installed\runtimes\hash\hermes", env)

    def test_personal_bootstrap_requires_its_exact_staged_bytecode(self):
        self.compile("import builtins; builtins._hermes_browser_test_loaded = True\n")
        bytecode = self.workers / "hermes-browser-bootstrap.pyc"
        env = {**self.env, "NEMOCLAW_PERSONAL_BROWSER_SESSION": "a" * 24,
               "NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256": hashlib.sha256(bytecode.read_bytes()).hexdigest()}
        # The Windows-only stage shape is exercised above; this executes ordinary
        # file admission and the sourceless loader using a disposable local stage.
        with patch.object(BROWSER, "_personal_workers", return_value=self.workers):
            with patch.object(builtins, "_hermes_browser_test_loaded", False, create=True):
                self.invoke(env=env)
                self.assertTrue(builtins._hermes_browser_test_loaded)
            with self.assertRaises(NATIVE.NativeStartupRefusal):
                self.invoke(env={**env, "NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256": "0" * 64})

    def test_missing_worker_and_foreign_worker_root_fail_closed(self):
        with self.assertRaises((NATIVE.NativeStartupRefusal, OSError)):
            self.invoke()
        self.compile("raise AssertionError('must not run')\n")
        for value in ("", str(self.root), "relative-workers"):
            with self.subTest(root=value):
                with self.assertRaises(NATIVE.NativeStartupRefusal):
                    self.invoke(env={**self.env, "NEMOCLAW_WORKER_ROOT": value})

    def test_worker_failure_aborts_startup(self):
        for code in ("raise ValueError('private test detail')\n", "raise SystemExit('test stop')\n"):
            with self.subTest(code=code):
                self.compile(code)
                with self.assertRaises(SystemExit):
                    self.invoke()

    def test_pth_startup_does_not_swallow_a_missing_bootstrap(self):
        with (
            patch.dict(sys.modules, {"nemoclaw_native_windows": NATIVE}),
            patch.object(NATIVE, "_active_root", self.root),
            patch.object(NATIVE, "_MODULES", {}),
            patch.object(NATIVE, "_adapt_module", lambda *args: None),
            patch.object(BROWSER, "_installed_root", None),
            patch.object(BROWSER, "os", SimpleNamespace(name="nt", environ=self.env)),
            patch.object(sys, "executable", str(self.python)),
        ):
            with self.assertRaises(NATIVE.NativeStartupRefusal):
                BROWSER.install()

    @unittest.skipIf(os.name == "nt", "Windows link creation needs separate authority")
    def test_worker_symlink_cannot_redirect_bootstrap(self):
        outside = self.base / "foreign.pyc"
        outside.write_bytes(b"never executed")
        (self.workers / "hermes-browser-bootstrap.pyc").symlink_to(outside)
        with self.assertRaises(NATIVE.NativeStartupRefusal):
            self.invoke()


if __name__ == "__main__":
    unittest.main()
