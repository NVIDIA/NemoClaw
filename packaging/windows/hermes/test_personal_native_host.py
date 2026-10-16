# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fixed-command and ownership controls; no native execution is claimed by these fixtures."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("personal_native_host_controls", "personal-native-host.py")
FIXTURE = load("personal_job_controls", "test_probe_host_browser.py")
SOURCE = "a" * 40
RUNTIME = r"C:\NemoClawHermesProbe-0123456789ab"


class PersonalNativeHost(unittest.TestCase):
    def setUp(self):
        self.env = {
            "GITHUB_ACTIONS": "true", "OS": "Windows_NT", "GITHUB_SHA": SOURCE,
            "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
            "SystemRoot": r"C:\Windows", "COMSPEC": r"C:\Windows\System32\cmd.exe",
            "ProgramFiles": r"C:\Program Files", "GH_TOKEN": "must-not-pass",
            "OPENAI_API_KEY": "must-not-pass", "NEMOCLAW_RUNTIME_JOB_OWNED": "untrusted",
        }
        self.node = r"C:\bootstrap\node.exe"
        self.controller = r"C:\checkout\packaging\windows\hermes\probe-personal-candidate.mts"
        self.receipt = r"C:\evidence\personal-host-owner.json"
        self.values = {name: "C:\\inputs\\" + name[2:] for name in HOST.ARGUMENTS}
        self.values["--runtime-root"] = RUNTIME
        self.values["--output"] = r"C:\evidence\personal-mxc"
        self.arguments = ["--experimental-strip-types", "--no-warnings", self.controller]
        for name, value in self.values.items():
            self.arguments.extend((name, value))

    def test_fixed_controller_retains_exact_arguments_and_only_the_recording_option(self):
        for suffix in ([], ["--record-startup"]):
            self.assertEqual(HOST.validate_arguments(
                self.node, self.arguments + suffix, self.receipt, self.controller), self.values)
        mutations = [
            ["--eval", "arbitrary", self.controller, *self.arguments[3:]],
            [*self.arguments[:2], r"C:\other.mts", *self.arguments[3:]],
            [*self.arguments, "--cold-job-probe"],
            [*self.arguments, "--runtime-root", RUNTIME],
            [*self.arguments[:-2], "--replay-receipt", self.arguments[-1]],
        ]
        for arguments in mutations:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                HOST.validate_arguments(self.node, arguments, self.receipt, self.controller)
        for replacement in (r"\\host\share\runtime", r"C:\inputs\..\other", "C:\\bad\npath", "relative"):
            arguments = list(self.arguments)
            arguments[arguments.index("--mxc") + 1] = replacement
            with self.subTest(path=replacement), self.assertRaises(ValueError):
                HOST.validate_arguments(self.node, arguments, self.receipt, self.controller)
        with self.assertRaises(ValueError):
            HOST.validate_arguments(self.node, self.arguments, r"C:\elsewhere\personal-host-owner.json", self.controller)

    def test_child_environment_retains_ci_and_system_identity_but_not_credentials(self):
        environment = HOST.child_environment(self.env, r"C:\NemoClawPersonalHost-0123456789ab", "f" * 24)
        self.assertEqual(environment["GITHUB_SHA"], SOURCE)
        self.assertEqual(environment["NEMOCLAW_PERSONAL_HOST_OWNER"], "f" * 24)
        self.assertEqual(environment["NEMOCLAW_RUNTIME_JOB_OWNED"], "1")
        self.assertEqual(environment["TEMP"], r"C:\NemoClawPersonalHost-0123456789ab\temp")
        self.assertEqual(environment["PATH"], r"C:\Windows\System32")
        self.assertNotIn("GH_TOKEN", environment)
        self.assertNotIn("OPENAI_API_KEY", environment)
        for key, value in (("GITHUB_ACTIONS", "false"), ("GITHUB_SHA", "main"),
                           ("GITHUB_RUN_ID", "0"), ("GITHUB_RUN_ATTEMPT", ""),
                           ("COMSPEC", r"C:\other.exe")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                HOST.child_environment({**self.env, key: value}, r"C:\state", "f" * 24)

    def test_ordinary_input_has_bounded_bytes_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "record.json"
            file.write_bytes(b'{"value":1}')
            identity, data = HOST.ordinary_identity(file, read_limit=64)
            self.assertEqual(identity, {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            self.assertEqual(HOST.ordinary_identity(file)[0], identity)
            with self.assertRaises(ValueError):
                HOST.ordinary_identity(file, read_limit=1)
            with self.assertRaises((ValueError, OSError)):
                HOST.ordinary_identity(Path(directory))

    @unittest.skipIf(os.name == "nt", "Windows link creation requires separate authority")
    def test_linked_owner_inputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "ordinary"
            original.write_bytes(b"controller")
            (root / "symlink").symlink_to(original)
            with self.assertRaises(ValueError):
                HOST.ordinary_identity(root / "symlink")
            os.link(original, root / "hardlink")
            with self.assertRaises(ValueError):
                HOST.ordinary_identity(original)

    def test_result_is_bound_to_source_and_runtime_without_claiming_installed_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "personal-feasibility.json"
            value = {"schemaVersion": 2, "classification": "canonical-personal-mxc-feasibility",
                     "sourceRevision": SOURCE, "runtime": RUNTIME, "feasibilityPassed": True}
            for key, replacement in ((None, None), ("schemaVersion", True), ("sourceRevision", "b" * 40),
                                     ("runtime", "different"), ("feasibilityPassed", 1)):
                file.write_text(json.dumps(value if key is None else {**value, key: replacement}))
                if key is None:
                    self.assertEqual(HOST.controller_result(file, SOURCE, RUNTIME),
                                     {"passed": True, "file": str(file), **HOST.ordinary_identity(file)[0]})
                else:
                    with self.subTest(key=key), self.assertRaises(ValueError):
                        HOST.controller_result(file, SOURCE, RUNTIME)

    def run_owner(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / "node.exe"
            node.write_bytes(b"never executed; native process fixture")
            receipt = root / "personal-host-owner.json"
            output = root / "personal-mxc"
            values = {**self.values, "--output": str(output)}
            native = FIXTURE.FixtureJob(mode, {})
            start, resume = native.start, native.resume
            captured = {}

            def capture_start(command, environment, cwd):
                captured.update(command=command, environment=environment, cwd=cwd)
                start(command, environment, cwd)

            def publish_result():
                resume()
                output.mkdir()
                (output / "personal-feasibility.json").write_text(json.dumps({
                    "schemaVersion": 2, "classification": "canonical-personal-mxc-feasibility",
                    "sourceRevision": SOURCE, "runtime": RUNTIME, "feasibilityPassed": mode != "nonzero",
                }))

            native.start, native.resume = capture_start, publish_result
            # Win32 effects are fixtures; the fixed argument parser is tested separately.
            with (patch.object(HOST, "validate_arguments", return_value=values),
                  patch.object(HOST, "NODE_SHA256", hashlib.sha256(node.read_bytes()).hexdigest()),
                  patch.object(HOST.OWNER, "Path", lambda _value: root / "owned-state")):
                record = HOST.run_controller(str(node), self.arguments, receipt, self.env, native,
                                             clock=lambda: native.now, sleep=native.sleep)
            self.assertEqual(json.loads(receipt.read_bytes()), record)
            return record, native, captured, (root / "owned-state").exists()

    def test_controller_is_assigned_before_resume_and_natural_completion_retains_its_receipt(self):
        record, native, captured, remains = self.run_owner("success")
        self.assertEqual(native.calls[:4], ["job", "suspended", "assign", "resume"])
        self.assertEqual(captured["environment"]["NEMOCLAW_RUNTIME_JOB_OWNED"], "1")
        self.assertNotIn("GH_TOKEN", captured["environment"])
        self.assertTrue(record["operationSucceeded"])
        self.assertTrue(HOST.host_closed(record, SOURCE, RUNTIME, "123", "2"))
        self.assertFalse(record["canonicalQualification"] or record["installedAcceptance"] or remains)

    def test_failed_workload_and_assignment_preserve_failure_even_after_successful_cleanup(self):
        for mode in ("nonzero", "assign-failure"):
            with self.subTest(mode=mode):
                record, native, _, remains = self.run_owner(mode)
                self.assertFalse(record["operationSucceeded"] or remains)
                self.assertTrue(HOST.host_closed(record, SOURCE, RUNTIME, "123", "2"))
                if mode == "assign-failure":
                    self.assertNotIn("resume", native.calls)
                    self.assertIn("terminate-suspended-process", native.calls)

    def test_timed_out_or_unclosed_controller_cannot_be_promoted(self):
        for mode in ("timeout", "unclosed", "overflow"):
            with self.subTest(mode=mode):
                record, native, _, remains = self.run_owner(mode)
                self.assertFalse(record["operationSucceeded"])
                self.assertIn("terminate-job", native.calls)
                self.assertEqual(HOST.host_closed(record, SOURCE, RUNTIME, "123", "2"), mode != "unclosed")
                self.assertEqual(remains, mode == "unclosed")

    def test_foreign_partial_or_unsettled_owner_cannot_authorize_runtime_removal(self):
        record, _, _, _ = self.run_owner("success")
        mutations = [
            (("sourceRevision",), "b" * 40), (("runtimeRoot",), "other"),
            (("workflowRunId",), "124"), (("workflowRunAttempt",), "3"),
            (("schemaVersion",), True), (("processCreated",), 1),
            (("childrenClosed",), False), (("cleanupComplete",), False),
            (("execution", "childClosed"), False), (("job", "activeAfterCleanup"), 1),
            (("job", "activeAfterCleanup"), False), (("cleanup", "errors"), ["failed"]),
        ]
        mutations.extend((("cleanup", field), False) for field in (
            "captureClosed", "processHandleClosed", "threadHandleClosed", "jobHandleClosed", "stateRemoved"))
        for keys, value in mutations:
            changed = copy.deepcopy(record)
            target = changed
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.subTest(keys=keys, value=value):
                self.assertFalse(HOST.host_closed(changed, SOURCE, RUNTIME, "123", "2"))
        self.assertFalse(HOST.host_closed({}, SOURCE, RUNTIME, "123", "2"))


if __name__ == "__main__":
    unittest.main()
