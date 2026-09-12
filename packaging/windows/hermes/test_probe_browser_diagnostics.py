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
                selected, file = owner.configure_browser_logging()
                self.assertEqual(selected, state)
                self.assertEqual(file, state / "temp/chrome.log")
                self.assertEqual(os.environ["CHROME_LOG_FILE"], str(file))

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

    def test_existing_shutdown_samples_log_before_authenticated_cleanup_even_on_reader_refusal(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            log = state / "harness.log"
            package = ModuleType("browser_harness")
            native = ModuleType("nemoclaw_native_windows")
            native.NativeStartupRefusal = self.native.NativeStartupRefusal
            for failure in [False, OSError, self.native.NativeStartupRefusal]:
                log.write_text("daemon failure before cleanup")
                output = io.StringIO()
                calls = []

                def endpoint(name):
                    calls.append(name)
                    self.assertIn("NEMOCLAW_BROWSER_HARNESS_LOG=", output.getvalue())
                    return state / "absent.port"

                ipc = SimpleNamespace(
                    log_path=lambda name: log,
                    port_path=endpoint,
                    pid_path=lambda name: state / "absent.pid",
                )
                package._ipc = ipc
                if failure:

                    def refuse(*_):
                        raise failure("controlled reader failure")

                    native._regular_file = refuse
                else:
                    native._regular_file = lambda path, root: Path(path)
                code = owner.browser_shutdown_code("nc-0123456789ab", state, True)
                with (
                    patch.dict(
                        sys.modules,
                        {"browser_harness": package, "nemoclaw_native_windows": native},
                    ),
                    redirect_stdout(output),
                ):
                    exec(code, {})
                lines = output.getvalue().splitlines()
                row = json.loads(lines[0].split("=", 1)[1])
                shutdown = json.loads(lines[1].split("=", 1)[1])
                self.assertEqual(lines[-1], "HARNESS_STOPPED")
                self.assertTrue(shutdown["complete"] and shutdown["recordsAbsent"])
                self.assertEqual(calls, ["nc-0123456789ab"])
                if failure:
                    self.assertIn("controlled reader failure", row["readError"])
                else:
                    self.assertEqual(row["text"], "daemon failure before cleanup")
            self.assertNotIn(
                "NEMOCLAW_BROWSER_HARNESS_LOG",
                owner.browser_shutdown_code("nc-0123456789ab", state, False),
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


class BrowserPageReadiness(unittest.TestCase):
    def run_code(self, actual, visible=True, helper_error=None):
        calls = []

        def wait_for_element(selector, **options):
            calls.append((selector, options))
            if helper_error is not None:
                raise helper_error
            return visible

        code = owner.browser_page_code("http://127.0.0.1:12345/", "a" * 24)
        context = {
            "new_tab": lambda url: calls.append(url),
            "wait_for_element": wait_for_element,
            "js": lambda expression: actual,
        }
        output = io.StringIO()
        failure = None
        with redirect_stdout(output):
            try:
                exec(code, context)
            except Exception as error:
                failure = error
        return output.getvalue(), failure, calls

    def test_canonical_decorated_title_passes_with_exact_url_and_rendered_nonce(self):
        actual = {
            "url": "http://127.0.0.1:12345/",
            "title": "🐴 Hermes Personal proof",
            "readyState": "complete",
            "sentinel": "a" * 24,
        }
        output, error, calls = self.run_code(actual)
        self.assertIsNone(error)
        self.assertIn("BROWSER_PERSONAL_OK", output)
        self.assertEqual(calls[1], ("#sentinel", {"timeout": 15.0, "visible": True}))
        observation = owner.browser_page_observation({"output": output})
        self.assertEqual(observation, {"visible": True, "actual": actual})

    def test_wrong_navigation_content_or_visibility_reports_stage_and_actual_values(
        self,
    ):
        expected = {
            "url": "http://127.0.0.1:12345/",
            "title": "🐴 Hermes Personal proof",
            "readyState": "complete",
            "sentinel": "a" * 24,
        }
        cases = [
            ({**expected, "url": "about:blank"}, True, "assert-owned-url"),
            ({**expected, "sentinel": "wrong"}, True, "assert-owned-nonce"),
            (expected, False, "assert-rendered-sentinel"),
        ]
        for actual, visible, stage in cases:
            output, error, _ = self.run_code(actual, visible)
            self.assertIsInstance(error, RuntimeError)
            self.assertIn(stage, str(error))
            self.assertIn(repr(actual), str(error))
            self.assertNotIn("BROWSER_PERSONAL_OK", output)
            self.assertEqual(
                owner.browser_page_observation({"output": output})["actual"], actual
            )

    def test_helper_failure_keeps_its_cause_and_is_not_reported_as_a_page_assertion(
        self,
    ):
        original = TimeoutError("controlled canonical helper timeout")
        output, error, _ = self.run_code(None, helper_error=original)
        self.assertIs(error.__cause__, original)
        self.assertIn("wait-rendered-sentinel", str(error))
        self.assertNotIn("BROWSER_PERSONAL_OK", output)
        self.assertIsNone(owner.browser_page_observation({"output": output}))


class BrowserHarnessShutdown(unittest.TestCase):
    def run_case(self, mode="success"):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            port, pid_file = state / "owned.port", state / "owned.pid"
            endpoint = {"port": 12345, "token": "a" * 64}
            expected_pid = (
                2**31 + 4
                if mode == "high-pid"
                else 2**32
                if mode == "overflow-pid"
                else 321
            )
            port.write_text(json.dumps(endpoint))
            pid_file.write_text(str(expected_pid))
            events = []

            class Channel:
                def getpeername(self):
                    return ("127.0.0.1", 12345)

                def settimeout(self, value):
                    self.timeout = value

                def close(self):
                    events.append("socket-close")

            class Process:
                def __init__(self, pid):
                    events.append("retain-handle")
                    self.pid = pid
                    self.stopped = False
                    if mode == "open-denied":
                        raise OSError("controlled process access failure")

                def identity(self):
                    return self.pid, "12345678901234567"

                def wait(self, seconds):
                    if seconds == 0:
                        return False
                    events.append("wait-exit")
                    if mode == "wait-timeout":
                        return False
                    self.stopped = True
                    if mode == "successor":
                        port.write_text(json.dumps({**endpoint, "token": "b" * 64}))
                    return True

                def exit_code(self):
                    return 0

                def close(self):
                    events.append("handle-close")

            calls = []

            def request(channel, token, body):
                self.assertEqual(token, "a" * 64)
                calls.append(body["meta"])
                events.append(body["meta"])
                if body["meta"] == "shutdown":
                    return {"ok": True}
                return {
                    "pong": True,
                    "pid": 999
                    if mode == "changed-pid" and len(calls) > 1
                    else expected_pid,
                    "browser_kind": "cdp",
                }

            def cleanup(name):
                self.assertIn("wait-exit", events)
                events.append("endpoint-cleanup")
                if mode == "unlink-denied":
                    error = PermissionError("controlled endpoint deletion failure")
                    error.winerror = 5
                    raise error
                port.unlink(missing_ok=True)

            ipc = SimpleNamespace(
                port_path=lambda name: port,
                pid_path=lambda name: pid_file,
                connect=lambda name, timeout: (Channel(), "a" * 64),
                request=request,
                cleanup_endpoint=cleanup,
            )
            native = ModuleType("nemoclaw_native_windows")

            class Refusal(SystemExit):
                pass

            native.NativeStartupRefusal = Refusal
            with (
                patch.dict(sys.modules, {"nemoclaw_native_windows": native}),
                patch.object(
                    owner, "owned_file", side_effect=lambda file, root: Path(file)
                ),
            ):
                result = owner.shutdown_browser_harness(
                    "nc-0123456789ab", state, ipc, Process
                )
            return result, events, calls, port.exists(), pid_file.exists()

    def test_authenticated_shutdown_waits_on_retained_process_before_deleting_records(
        self,
    ):
        result, events, calls, port, pid = self.run_case()
        self.assertTrue(
            result["complete"]
            and result["handleClosed"]
            and result["processExitObserved"]
        )
        self.assertEqual(calls, ["ping", "ping", "shutdown"])
        self.assertLess(events.index("retain-handle"), events.index("shutdown"))
        self.assertLess(events.index("wait-exit"), events.index("endpoint-cleanup"))
        self.assertEqual(result["creationFiletime"], "12345678901234567")
        self.assertFalse(port or pid)

    def test_identity_change_access_failure_and_wait_timeout_do_not_delete_records(
        self,
    ):
        for mode in ["changed-pid", "open-denied", "wait-timeout", "successor"]:
            with self.subTest(mode=mode):
                result, events, calls, port, pid = self.run_case(mode)
                self.assertFalse(result["complete"])
                self.assertTrue(port and pid)
                self.assertNotIn("endpoint-cleanup", events)
                if mode in ["changed-pid", "open-denied"]:
                    self.assertNotIn("shutdown", calls)
                if mode != "open-denied":
                    self.assertTrue(result["handleClosed"])

    def test_cleanup_only_failure_retains_successful_page_and_shutdown_stage(self):
        import ast

        tree = ast.parse(Path(owner.__file__).read_text())
        function = next(
            n
            for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == "browser_check"
        )
        branch = next(
            n
            for n in function.body
            if isinstance(n, ast.If)
            and isinstance(n.test, ast.Name)
            and n.test.id == "errors"
        )
        code = compile(
            ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])),
            owner.__file__,
            "exec",
        )
        page = {
            "visible": True,
            "actual": {"url": "http://127.0.0.1:12345/", "sentinel": "a" * 24},
        }
        shutdown = {
            "complete": False,
            "error": {"stage": "remove-exited-daemon-records", "winerror": 5},
        }
        with self.assertRaises(AssertionError) as caught:
            exec(
                code,
                {
                    "errors": ["controlled cleanup failure"],
                    "diagnostics": {
                        "logs": {},
                        "pageObservation": page,
                        "harnessShutdown": shutdown,
                    },
                    "bounded_browser_diagnostics": owner.bounded_browser_diagnostics,
                },
            )
        self.assertEqual(
            caught.exception.nemoclaw_browser_diagnostics["pageObservation"], page
        )
        self.assertEqual(
            caught.exception.nemoclaw_browser_diagnostics["harnessShutdown"], shutdown
        )
        self.assertIn("Browser cleanup failed", str(caught.exception))

    def test_pid_admission_uses_the_full_positive_dword_range(self):
        result, events, calls, port, pid = self.run_case("high-pid")
        self.assertTrue(result["complete"])
        self.assertEqual(result["identifiedPid"], 2**31 + 4)
        result, events, calls, port, pid = self.run_case("overflow-pid")
        self.assertFalse(result["complete"])
        self.assertNotIn("retain-handle", events)
        self.assertTrue(port and pid)

    def test_endpoint_access_error_stays_a_separate_strict_cleanup_failure(self):
        result, events, calls, port, pid = self.run_case("unlink-denied")
        self.assertFalse(result["complete"])
        self.assertTrue(
            result["shutdownAcknowledged"]
            and result["processExitObserved"]
            and result["handleClosed"]
        )
        self.assertEqual(result["error"]["stage"], "remove-exited-daemon-records")
        self.assertEqual(result["error"]["winerror"], 5)
        self.assertTrue(port and pid)


if __name__ == "__main__":
    unittest.main()
