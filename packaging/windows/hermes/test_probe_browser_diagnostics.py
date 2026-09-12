# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Portable controls for fixed browser logging; no real runtime/browser is executed."""

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "personal_probe", Path(__file__).with_name("probe-personal-python.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class BrowserDiagnostics(unittest.TestCase):
    def setUp(self):
        native_spec = importlib.util.spec_from_file_location(
            "fixture_native_policy",
            Path(__file__).with_name("nemoclaw_native_windows.py"),
        )
        self.native = importlib.util.module_from_spec(native_spec)
        native_spec.loader.exec_module(self.native)
        modules = patch.dict(sys.modules, {"nemoclaw_native_windows": self.native})
        modules.start()
        self.addCleanup(modules.stop)

    def test_logging_uses_each_owned_state_and_does_not_enable_stderr_or_other_flags(
        self,
    ):
        paths = []
        with tempfile.TemporaryDirectory() as directory:
            for name in ["primary", "direct", "stock", "host"]:
                state = Path(directory) / name
                env = {
                    "NEMOCLAW_AGENT_HOME": str(state),
                    "TEMP": str(state / "temp"),
                    "AGENT_BROWSER_ARGS": "--enable-logging=stderr",
                }
                with patch.dict(os.environ, env, clear=True):
                    selected, file = owner.configure_browser_logging()
                    self.assertEqual(selected, state)
                    self.assertEqual(file, state / "temp/chrome.log")
                    self.assertEqual(os.environ["CHROME_LOG_FILE"], str(file))
                    self.assertEqual(
                        os.environ["AGENT_BROWSER_ARGS"], "--enable-logging"
                    )
                    paths.append(file)
            self.assertEqual(len(set(paths)), 4)
            with patch.dict(
                os.environ, {**env, "AGENT_BROWSER_ARGS": "--no-sandbox"}, clear=True
            ):
                with self.assertRaises(ValueError):
                    owner.configure_browser_logging()
            with patch.dict(
                os.environ,
                {**env, "TEMP": str(Path(directory) / "foreign")},
                clear=True,
            ):
                with self.assertRaises(ValueError):
                    owner.configure_browser_logging()

    def test_log_reads_are_bounded_and_record_the_observed_tail_without_mutating_it(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            file = state / "chrome.log"
            data = b"prefix" + b"x" * 5000
            file.write_bytes(data)
            with patch.object(
                owner, "owned_file", side_effect=lambda path, root: Path(path)
            ):
                record = owner.browser_log_tail(file, state)
                missing = owner.browser_log_tail(state / "missing", state)
            self.assertEqual(record["observedTailBytes"], 4096)
            self.assertEqual(
                record["observedTailSha256"], hashlib.sha256(data[-4096:]).hexdigest()
            )
            self.assertTrue(record["truncated"])
            self.assertEqual(record["text"], data[-4096:].decode())
            self.assertFalse(missing["present"])
            self.assertEqual(file.read_bytes(), data)

    def test_serialized_aggregate_bound_handles_unicode_and_marks_rendered_truncation(
        self,
    ):
        value = {
            "chromeLogging": {
                "arguments": "--enable-logging",
                "file": "owned/chrome.log",
            },
            "logs": {
                name: {"text": "🦀" * 4096, "observedTailBytes": 4096}
                for name in ["chrome", "browserHarness"]
            },
        }
        record = owner.bounded_browser_diagnostics(value)
        self.assertLessEqual(len(json.dumps(record).encode()), 12 * 1024)
        self.assertTrue(record["aggregateTruncated"])
        self.assertTrue(
            any(row.get("renderedTailTruncated") for row in record["logs"].values())
        )
        self.assertEqual(record["chromeLogging"]["arguments"], "--enable-logging")

    def test_existing_shutdown_samples_log_before_restart_and_still_stops_when_reader_fails(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            log = state / "harness.log"
            log.write_text("daemon failure before cleanup")
            package = ModuleType("browser_harness")
            admin = ModuleType("browser_harness.admin")
            calls = []
            admin.ipc = SimpleNamespace(
                log_path=lambda name: log, ping=lambda *a, **k: False
            )

            def restart(*, name):
                calls.append(name)
                log.unlink(missing_ok=True)

            admin.restart_daemon = restart
            native = ModuleType("nemoclaw_native_windows")
            native._regular_file = lambda path, root: Path(path)
            native.NativeStartupRefusal = self.native.NativeStartupRefusal
            code = owner.browser_shutdown_code("nc-fixture", state, True)
            for failure in [False, OSError, self.native.NativeStartupRefusal]:
                log.write_text("daemon failure before cleanup")
                if failure:

                    def refuse(*_):
                        raise failure("controlled reader failure")

                    native._regular_file = refuse
                output = io.StringIO()
                with (
                    patch.dict(
                        sys.modules,
                        {
                            "browser_harness": package,
                            "browser_harness.admin": admin,
                            "nemoclaw_native_windows": native,
                        },
                    ),
                    redirect_stdout(output),
                ):
                    exec(code, {})
                lines = output.getvalue().splitlines()
                row = json.loads(lines[0].split("=", 1)[1])
                self.assertEqual(lines[-1], "HARNESS_STOPPED")
                self.assertFalse(log.exists())
                if failure:
                    self.assertIn("controlled reader failure", row["readError"])
                else:
                    self.assertEqual(row["text"], "daemon failure before cleanup")
            self.assertEqual(calls, ["nc-fixture", "nc-fixture", "nc-fixture"])
            self.assertNotIn(
                "NEMOCLAW_BROWSER_HARNESS_LOG",
                owner.browser_shutdown_code("nc-fixture", state, False),
            )

    def test_real_native_refusal_is_secondary_for_a_missing_optional_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = owner.browser_log_tail(root / "missing.log", root)
            self.assertFalse(record["present"])
            self.assertIn("NativeStartupRefusal", record["readError"])
            failure = ValueError("the original browser failure")
            failure.nemoclaw_browser_diagnostics = owner.bounded_browser_diagnostics(
                {"logs": {"chrome": record}}
            )
            self.assertEqual(str(failure), "the original browser failure")

    def test_main_keeps_original_failure_separate_from_diagnostic_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            failure = ValueError("the original browser operation failed")
            failure.nemoclaw_browser_diagnostics = {
                "logs": {"chrome": {"text": "retained file diagnostics"}}
            }
            output = io.StringIO()
            with (
                patch.object(owner, "os", SimpleNamespace(name="nt")),
                patch.object(owner, "owned_runtime", return_value=root),
                patch.object(owner, "browser_check", side_effect=failure),
                patch.object(sys, "argv", ["probe", "browser", str(root), "a" * 24]),
                redirect_stdout(output),
            ):
                self.assertEqual(owner.main(), 1)
            result = json.loads(output.getvalue().split("=", 1)[1])
            self.assertIn("the original browser operation failed", result["error"])
            self.assertNotIn("retained file diagnostics", result["error"])
            self.assertEqual(
                result["browserDiagnostics"], failure.nemoclaw_browser_diagnostics
            )
            self.assertFalse(result["passed"])


if __name__ == "__main__":
    unittest.main()
