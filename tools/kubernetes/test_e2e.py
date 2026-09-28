# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Behavioral checks for the opt-in local E2E entry point; no live resources."""

import hashlib
import io
import json
import os
import signal
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

import e2e


class LocalTestTests(unittest.TestCase):
    def test_platform_separates_native_bundle_from_linux_agent(self):
        self.assertEqual(e2e.platforms("Darwin", "arm64"), ("darwin_arm64", "linux/arm64"))
        self.assertEqual(e2e.platforms("Linux", "x86_64"), ("linux_amd64", "linux/amd64"))
        self.assertEqual(e2e.platforms("Linux", "aarch64"), ("linux_arm64", "linux/arm64"))
        with self.assertRaises(e2e.Error):
            e2e.platforms("Windows", "AMD64")

    def test_key_is_required_and_removed_from_setup_environment(self):
        for value in [None, "", "  ", "secret\nvalue"]:
            with self.subTest(value=value), self.assertRaises(e2e.Error):
                e2e.environ({} if value is None else {e2e.KEY: value})
        key, env = e2e.environ(
            {e2e.KEY: "private-test-key", "PATH": "/bin", "KUBECONFIG": "ambient"}
        )
        self.assertEqual(key, "private-test-key")
        self.assertNotIn(e2e.KEY, env)
        self.assertNotIn("KUBECONFIG", env)
        self.assertEqual(env["PATH"], "/bin")

    def test_manifest_uses_fresh_identity_explicit_cluster_and_every_image(self):
        template = (e2e.REPO / "examples/kubernetes/managed-development.yaml").read_text()
        digest = "test-agent@sha256:" + "a" * 64
        first = e2e.manifest(template, "kind-nemoclaw-v1-1234abcd", digest, 45678)
        second = e2e.manifest(template, "kind-nemoclaw-v1-1234abcd", digest, 45678)
        self.assertNotEqual(first, second)
        self.assertEqual(first.count(digest), 3)
        self.assertNotIn("registry.example.com", first)
        self.assertIn('context: "kind-nemoclaw-v1-1234abcd"', first)
        self.assertIn("https://127.0.0.1:45678", first)
        self.assertIn("env: NVIDIA_INFERENCE_API_KEY", first)
        self.assertNotIn("../../schemas/", first)
        with self.assertRaises(e2e.Error):
            e2e.manifest(
                template.replace("replace-with-explicit-context", "stale"), "context", digest, 1
            )
        with self.assertRaises(e2e.Error):
            e2e.manifest(template, "context", "test-agent:latest", 1)

    def test_logs_redact_key_in_console_and_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            output = io.StringIO()
            runner = e2e.Runner(state, "private-test-key", {"PATH": os.environ["PATH"]})
            with patch("sys.stdout", output):
                runner.run("redaction check", [e2e.PYTHON, "-c", "print('private-test-' + 'key')"])
            self.assertNotIn("private-test-key", output.getvalue())
            self.assertNotIn("private-test-key", (state / "test.log").read_text())
            self.assertIn("[REDACTED]", output.getvalue())
            self.assertEqual((state / "test.log").stat().st_mode & 0o777, 0o600)

    def test_subprocess_failure_stops_with_stage_and_without_raw_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = e2e.Runner(Path(directory), "private-test-key", {})
            with (
                patch("sys.stdout", io.StringIO()),
                self.assertRaisesRegex(e2e.Error, "failed stage.*9"),
            ):
                runner.run("failed stage", [e2e.PYTHON, "-c", "raise SystemExit(9)"])

    def test_only_test_execution_receives_inference_key(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = e2e.Runner(Path(directory), "private-test-key", {"PATH": os.environ["PATH"]})
            with patch("sys.stdout", io.StringIO()):
                absent = runner.run(
                    "build", [e2e.PYTHON, "-c", f"import os; print({e2e.KEY!r} in os.environ)"]
                )
                present = runner.run(
                    "test",
                    [e2e.PYTHON, "-c", f"import os; print({e2e.KEY!r} in os.environ)"],
                    inference=True,
                )
            self.assertEqual(absent.strip(), "False")
            self.assertEqual(present.strip(), "True")
            self.assertNotIn(e2e.KEY, runner.env)

    def test_existing_foreign_state_cannot_be_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(e2e, "STATE_PARENT", root):
                a, b = e2e.new_state(), e2e.new_state()
            self.assertNotEqual(a, b)
            self.assertEqual(a.stat().st_mode & 0o777, 0o700)
            self.assertFalse((a / "sdk-state").exists())
        with patch.object(e2e, "STATE_PARENT", e2e.REPO / ".build"):
            with self.assertRaises(e2e.Error):
                e2e.new_state()

    def test_no_cluster_cleanup_on_failure_and_only_owned_cleanup_on_success(self):
        for fail, keep in [(False, False), (True, False), (False, True)]:
            with self.subTest(fail=fail, keep=keep), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                runner = e2e.Runner(state, "private-test-key", {})
                calls = []

                def run(stage, args, *, calls=calls, state=state, fail=fail, **kwargs):
                    calls.append((stage, args, kwargs))
                    if stage == "Create isolated kind cluster":
                        (state / "kind").mkdir()
                        (state / "kind/ownership.json").write_text(
                            json.dumps({"cluster": "nemoclaw-v1-1234abcd"})
                        )
                    if stage == "Build lifecycle test binary":
                        binary = state / "compiled-test"
                        binary.write_text("test binary placeholder")
                        return json.dumps(
                            {
                                "reason": "compiler-artifact",
                                "target": {"name": "kubernetes_live"},
                                "profile": {"test": True},
                                "executable": str(binary),
                            }
                        )
                    if stage == "Inspect agent image":
                        return json.dumps(
                            [
                                {
                                    "RepoDigests": [args[-1].split(":")[0] + "@sha256:" + "a" * 64],
                                    "Os": "linux",
                                    "Architecture": "arm64",
                                }
                            ]
                        )
                    if stage == "Run full Kubernetes lifecycle" and fail:
                        raise e2e.Error("inference failed")
                    return ""

                with (
                    patch.object(runner, "run", side_effect=run),
                    patch.object(
                        runner,
                        "preflight",
                        return_value=(["cargo"], ["docker"], "darwin_arm64", "linux/arm64"),
                    ),
                ):
                    if fail:
                        with self.assertRaises(e2e.Error):
                            runner.execute(keep_cluster=keep)
                    else:
                        runner.execute(keep_cluster=keep)
                cleanups = [c for c in calls if c[0] == "Delete completed test cluster"]
                self.assertEqual(len(cleanups), int(not fail and not keep))
                if cleanups:
                    self.assertEqual(
                        cleanups[0][1][-2:], ["--confirm-cluster", "nemoclaw-v1-1234abcd"]
                    )
                lifecycle = next(c for c in calls if c[0] == "Run full Kubernetes lifecycle")
                self.assertTrue(lifecycle[2]["inference"])
                self.assertEqual(lifecycle[1][0], str(state / "kubernetes-live-test"))
                retry = (state / "retry-inference.sh").read_text()
                self.assertNotIn("cargo", retry)
                self.assertNotIn("private-test-key", retry)
                self.assertIn(e2e.RETRY_TEST, retry)
                self.assertNotIn(" -- ", retry)
                self.assertEqual(
                    lifecycle[2]["env"]["NEMOCLAW_CLUSTER_KUBECONFIG"],
                    str(state / "kind/kubeconfig"),
                )
                self.assertFalse((state / "sdk-state").exists())
                self.assertNotIn("private-test-key", (state / "deployment.yaml").read_text())
                for stage, _, kwargs in calls:
                    if stage != "Run full Kubernetes lifecycle":
                        self.assertFalse(kwargs.get("inference", False))

    def test_mac_uses_installed_rustup_pin_even_when_standalone_cargo_precedes_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["Cargo.toml", "docker-bake.hcl"]:
                (root / name).write_text("")
            (root / "tools/kubernetes").mkdir(parents=True)
            (root / "tools/kubernetes/stack.py").write_text("")
            (root / "versions.json").write_text(json.dumps({"rust": "1.98.1"}))
            runner = e2e.Runner(root, "private-test-key", {"PATH": "/standalone-cargo:/bin"})

            def available(args):
                if args[:2] == ["rustup", "which"]:
                    return "/pinned-rust/bin/cargo"
                if args[0] in ["cargo", "rustc"]:
                    return args[0] + (
                        " 1.98.1 (fixture)"
                        if runner.env["PATH"].startswith("/pinned-rust/bin:")
                        else " 1.96.0 (fixture)"
                    )
                if "{{.OSType}}/{{.Architecture}}" in args:
                    return "linux/aarch64"
                return "available"

            with (
                patch.object(e2e, "REPO", root),
                patch("platform.system", return_value="Darwin"),
                patch("platform.machine", return_value="arm64"),
                patch("shutil.which", return_value="/bin/tool"),
                patch.object(runner, "available", side_effect=available),
                patch.object(runner, "prepare_protoc"),
                patch.object(runner, "run") as run,
                patch("sys.stdout", io.StringIO()),
            ):
                _, _, native, image = runner.preflight()
            self.assertEqual((native, image), ("darwin_arm64", "linux/arm64"))
            self.assertTrue(runner.env["PATH"].startswith("/pinned-rust/bin:"))
            run.assert_not_called()

    def test_failed_compilation_keeps_rendered_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            runner = e2e.Runner(state, "private-test-key", {})
            message = {
                "reason": "compiler-message",
                "message": {"rendered": "error: fixture compiler diagnostic\n"},
            }
            program = "print(" + repr(json.dumps(message)) + "); raise SystemExit(1)"
            output = io.StringIO()
            with patch("sys.stdout", output), self.assertRaises(e2e.Error):
                runner.run("compile", [e2e.PYTHON, "-c", program], compiler_output=True)
            self.assertIn("fixture compiler diagnostic", output.getvalue())
            self.assertIn("fixture compiler diagnostic", (state / "test.log").read_text())
            self.assertNotIn("compiler-message", output.getvalue())

    def test_check_only_validates_key_without_creating_state_or_building(self):
        with (
            patch.dict(os.environ, {e2e.KEY: "private-test-key"}, clear=True),
            patch("sys.argv", ["e2e.py", "--check-inference"]),
            patch("sys.stdout", io.StringIO()) as output,
            patch.object(e2e, "check_inference", create=True) as check,
            patch.object(e2e, "new_state") as create,
            patch.object(e2e.Runner, "execute") as execute,
        ):
            self.assertEqual(e2e.main(), 0)
        check.assert_called_once_with("private-test-key")
        create.assert_not_called()
        execute.assert_not_called()
        self.assertNotIn("private-test-key", output.getvalue())
        self.assertIn("accepted", output.getvalue())

    def test_rejected_key_stops_before_build_and_cluster_for_both_modes(self):
        for arguments in [[], ["--check-inference"]]:
            with (
                self.subTest(arguments=arguments),
                patch.dict(os.environ, {e2e.KEY: "private-test-key"}, clear=True),
                patch("sys.argv", ["e2e.py", *arguments]),
                patch("sys.stdout", io.StringIO()) as output,
                patch("sys.stderr", io.StringIO()) as error,
                patch.object(
                    e2e,
                    "check_inference",
                    side_effect=e2e.InferenceCheckError(
                        "HTTP 401: inference authentication rejected"
                    ),
                ) as check,
                patch.object(e2e, "new_state") as create,
                patch.object(e2e.Runner, "execute") as execute,
            ):
                self.assertEqual(e2e.main(), 1)
            create.assert_not_called()
            execute.assert_not_called()
            check.assert_called_once_with("private-test-key")
            self.assertIn("HTTP 401", error.getvalue())
            self.assertNotIn("private-test-key", output.getvalue() + error.getvalue())

    def test_inference_retry_guidance_does_not_claim_to_refresh_key(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "retry-inference.sh").write_text("#!/bin/sh\n")
            runner = e2e.Runner(state, "private-test-key", {})
            with patch("sys.stdout", io.StringIO()) as output:
                runner.failure("HTTP 401")
            self.assertIn("does not update the installed provider credential", output.getvalue())
            self.assertIn("--check-inference", output.getvalue())

    def test_missing_key_fails_before_creating_state_or_starting_processes(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sys.argv", ["e2e.py"]),
            patch("sys.stderr", io.StringIO()),
            patch.object(e2e, "new_state") as create,
        ):
            self.assertEqual(e2e.main(), 1)
            create.assert_not_called()

    def test_pinned_protoc_download_rejects_checksum_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = e2e.Runner(Path(directory), "private-test-key", {})
            pins = {
                "protobuf": "36.1",
                "platforms": {
                    "darwin_arm64": {
                        "protoc": {"url": "https://example.test/pinned.zip", "sha256": "0" * 64}
                    }
                },
            }
            with (
                patch.object(runner, "available", return_value=None),
                patch("urllib.request.urlopen", return_value=io.BytesIO(b"untrusted")),
                patch("sys.stdout", io.StringIO()),
                self.assertRaisesRegex(e2e.Error, "checksum"),
            ):
                runner.prepare_protoc(pins, "darwin_arm64")
            self.assertFalse((Path(directory) / "protoc").exists())

    def test_pinned_protoc_download_sets_executable_absolute_path(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("bin/protoc", "placeholder")
        raw = data.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            runner = e2e.Runner(Path(directory), "private-test-key", {})
            pins = {
                "protobuf": "36.1",
                "platforms": {
                    "darwin_arm64": {
                        "protoc": {
                            "url": "https://example.test/pinned.zip",
                            "sha256": hashlib.sha256(raw).hexdigest(),
                        }
                    }
                },
            }
            with (
                patch.object(runner, "available", side_effect=[None, None, "libprotoc 36.1"]),
                patch("urllib.request.urlopen", return_value=io.BytesIO(raw)),
                patch("sys.stdout", io.StringIO()),
            ):
                runner.prepare_protoc(pins, "darwin_arm64")
            binary = Path(runner.env["PROTOC"])
            self.assertTrue(binary.is_absolute())
            self.assertEqual(binary.stat().st_mode & 0o777, 0o700)

    def test_interruption_terminates_and_reaps_child_process(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = e2e.Runner(Path(directory), "private-test-key", {})
            processes = []
            real_popen = subprocess.Popen

            def capture(*args, **kwargs):
                process = real_popen(*args, **kwargs)
                processes.append(process)
                return process

            def emit(text):
                if "child started" in text:
                    raise KeyboardInterrupt

            with (
                patch.object(runner, "emit", side_effect=emit),
                patch("subprocess.Popen", side_effect=capture),
                self.assertRaises(KeyboardInterrupt),
            ):
                runner.run(
                    "interruptible stage",
                    [
                        e2e.PYTHON,
                        "-u",
                        "-c",
                        "import time; print('child started'); time.sleep(120)",
                    ],
                )
            self.assertIsNotNone(processes[0].poll())
            with self.assertRaises(ProcessLookupError):
                os.killpg(processes[0].pid, 0)

    def test_unresponsive_child_is_killed_after_bounded_grace(self):
        process = Mock(pid=987654)
        process.wait.side_effect = [subprocess.TimeoutExpired("test", 5), -9]
        with patch("os.killpg") as kill:
            e2e.Runner.stop(process)
        self.assertEqual(kill.call_args_list[0].args, (987654, signal.SIGTERM))
        self.assertEqual(kill.call_args_list[1].args, (987654, signal.SIGKILL))
        self.assertEqual(process.wait.call_count, 2)

    def test_partial_cluster_failure_prints_guarded_cleanup_from_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "kind").mkdir()
            (state / "kind/ownership.json").write_text(
                json.dumps({"cluster": "nemoclaw-v1-1234abcd"})
            )
            runner = e2e.Runner(state, "private-test-key", {})
            output = io.StringIO()
            with patch("sys.stdout", output):
                runner.failure("cluster CNI probe failed")
            self.assertIn("--confirm-cluster nemoclaw-v1-1234abcd", output.getvalue())
            self.assertIn("cleanup --state-dir", output.getvalue())


if __name__ == "__main__":
    unittest.main()
