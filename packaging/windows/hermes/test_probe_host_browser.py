# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Portable owner-boundary controls; no Windows or browser execution is simulated as proof."""

import copy
import ctypes
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "host_browser", Path(__file__).with_name("probe-host-browser.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class FixtureJob:
    """Five deterministic outcomes for the fixed owner's process/cleanup boundary."""

    def __init__(self, mode, result):
        self.mode = mode
        self.calls = []
        self.job = self.process = self.thread = None
        self.pid = 42
        self.streams = []
        self.closed = False
        self.now = 0
        data = ("NEMOCLAW_PERSONAL_RESULT=" + json.dumps(result) + "\n").encode()
        self.data = b"x" * (owner.CAPTURE_BYTES + 1) if mode == "overflow" else data

    def create_job(self):
        self.calls.append("job")
        self.job = 3

    def start(self, *_args):
        self.calls.append("suspended")
        self.process = 1
        self.thread = 2
        self.streams = [io.BytesIO(self.data), io.BytesIO(b"")]

    def assign(self):
        self.calls.append("assign")
        if self.mode == "assign-failure":
            error = OSError("assign denied")
            error.winerror = 5
            raise error

    def resume(self):
        assert self.calls[-1] == "assign"
        self.calls.append("resume")

    def wait(self, milliseconds):
        time.sleep(0)
        self.now += milliseconds / 1000
        if self.mode not in {"timeout", "overflow", "unclosed"}:
            self.closed = True
        return self.closed

    def exit_code(self):
        return 1 if self.mode == "nonzero" else 0

    def active(self):
        return 0 if self.closed else 1

    def terminate(self, assigned):
        self.calls.append(
            "terminate-job" if assigned else "terminate-suspended-process"
        )
        if self.mode != "unclosed":
            self.closed = True

    def close(self, name):
        self.calls.append("close-" + name)
        setattr(self, name, None)

    def sleep(self, seconds):
        self.now += seconds


class HostBrowserOwner(unittest.TestCase):
    def setUp(self):
        nonce = "0123456789abcdef01234567"
        state = "C:\\NemoClawBrowserHost-" + nonce[:12]
        env = {
            key: state + "\\home"
            for key in ["HERMES_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
        }
        env.update(
            NEMOCLAW_AGENT_HOME=state,
            TEMP=state + "\\temp",
            TMP=state + "\\temp",
            GITHUB_ACTIONS="true",
            PYTHONDONTWRITEBYTECODE="1",
            HERMES_DISABLE_LAZY_INSTALLS="1",
        )
        self.identity = {"bytes": 10, "sha256": "a" * 64}
        self.request = {
            "schemaVersion": 1,
            "classification": "canonical-host-browser-request",
            "nonce": nonce,
            "runtimeRoot": r"C:\NemoClawHermesProbe-0123456789ab",
            "probeFile": r"C:\NemoClawPersonalNode-0123456789ab\probe-personal-python.py",
            "stateRoot": state,
            "environment": env,
            "pythonIdentity": self.identity,
            "probeIdentity": self.identity,
        }
        self.result = {
            "schemaVersion": 1,
            "component": "browser",
            "nonce": nonce,
            "passed": True,
        }

    def run_owner(self, mode):
        result = (
            {**self.result, "passed": False, "error": "original browser failure"}
            if mode == "nonzero"
            else self.result
        )
        native = FixtureJob(mode, result)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "owned"
            with (
                patch.object(owner, "Path", lambda _: state),
                patch.object(owner, "identity", return_value=self.identity),
            ):
                report = owner.own_browser(
                    self.request, native, clock=lambda: native.now, sleep=native.sleep
                )
            remains = state.exists()
        return report, native, remains

    def test_success_assigns_before_resume_retains_output_and_waits_for_empty_job(self):
        r, native, remains = self.run_owner("success")
        self.assertEqual(native.calls[:4], ["job", "suspended", "assign", "resume"])
        self.assertTrue(
            r["operationSucceeded"] and r["childrenClosed"] and r["cleanupComplete"]
        )
        self.assertEqual(r["result"], self.result)
        self.assertEqual(r["job"]["activeAfterCleanup"], 0)
        self.assertFalse(r["job"]["forcedTermination"] or remains)
        self.assertTrue(r["diagnosticOnly"])
        self.assertFalse(r["canonicalQualification"] or r["installedAcceptance"])

    def test_nonzero_browser_error_is_retained_even_when_cleanup_succeeds(self):
        r, _, remains = self.run_owner("nonzero")
        self.assertFalse(r["operationSucceeded"])
        self.assertEqual(r["execution"]["exitCode"], 1)
        self.assertEqual(r["result"]["error"], "original browser failure")
        self.assertTrue(r["childrenClosed"] and r["cleanupComplete"])
        self.assertFalse(remains)

    def test_timeout_and_output_overflow_terminate_job_and_keep_bounds(self):
        for mode, flag in [("timeout", "timedOut"), ("overflow", "outputExceeded")]:
            with self.subTest(mode=mode):
                r, native, remains = self.run_owner(mode)
                self.assertTrue(r["execution"][flag])
                self.assertFalse(r["operationSucceeded"])
                self.assertIn("terminate-job", native.calls)
                self.assertEqual(r["job"]["activeAfterCleanup"], 0)
                self.assertTrue(r["childrenClosed"] and r["cleanupComplete"])
                self.assertLessEqual(
                    len(r["execution"]["stdout"].encode()), owner.CAPTURE_BYTES
                )
                self.assertFalse(remains)

    def test_failure_before_resume_terminates_exact_suspended_process(self):
        r, native, remains = self.run_owner("assign-failure")
        self.assertNotIn("resume", native.calls)
        self.assertIn("terminate-suspended-process", native.calls)
        self.assertFalse(r["operationSucceeded"] or r["execution"]["resumed"])
        self.assertEqual(r["primaryError"]["stage"], "assign-job-before-resume")
        self.assertEqual(r["primaryError"]["winerror"], 5)
        self.assertTrue(r["childrenClosed"] and r["cleanupComplete"])
        self.assertFalse(remains)

    def test_unclosed_job_keeps_state_and_cannot_report_success(self):
        r, _, remains = self.run_owner("unclosed")
        self.assertFalse(
            r["operationSucceeded"] or r["childrenClosed"] or r["cleanupComplete"]
        )
        self.assertEqual(r["job"]["activeAfterCleanup"], 1)
        self.assertTrue(remains)

    def test_request_is_fixed_to_browser_and_nonce_owned_state(self):
        command = owner.validate_request(self.request)
        self.assertEqual(command[1:3], ["-I", "-B"])
        self.assertEqual(command[4], "browser")
        for key, value in [
            ("stateRoot", r"C:\other"),
            ("probeFile", r"C:\other.py"),
            ("nonce", "f" * 24),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                owner.validate_request({**self.request, key: value})
        changed = copy.deepcopy(self.request)
        changed["environment"]["TEMP"] = r"C:\other"
        with self.assertRaises(ValueError):
            owner.validate_request(changed)
        with self.assertRaises(ValueError):
            owner.parse_browser(
                "NEMOCLAW_PERSONAL_RESULT=" + json.dumps(self.result), "f" * 24
            )

    def test_win64_layouts_and_failed_wait_preserve_native_stage_error(self):
        self.assertEqual(
            [
                ctypes.sizeof(t)
                for t in [owner.BasicLimits, owner.ExtendedLimits, owner.Accounting]
            ],
            [64, 144, 48],
        )
        native = owner.WindowsJob.__new__(owner.WindowsJob)
        native.process = 1
        native.kernel = SimpleNamespace(WaitForSingleObject=lambda *_: 0xFFFFFFFF)
        error = OSError("fixture native wait error")
        error.winerror = 6
        with (
            patch.object(ctypes, "get_last_error", return_value=6, create=True),
            patch.object(ctypes, "WinError", return_value=error, create=True),
        ):
            with self.assertRaises(OSError) as caught:
                native.wait(0)
        self.assertEqual(owner.detail(caught.exception)["stage"], "WaitForSingleObject")
        self.assertEqual(owner.detail(caught.exception)["winerror"], 6)


if __name__ == "__main__":
    unittest.main()
