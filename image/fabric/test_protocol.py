# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The provisioning contract rejects unsafe work and preserves observations."""

import asyncio
import copy
import io
import json
import os
import signal
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import fabric
from nemo_fabric import FabricConfigError, FabricRuntimeError

CONFIG = {"metadata": {"name": "main"}, "harness": {"adapter_id": "vendor.new"}}


class ProtocolLifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runtime = SimpleNamespace(
            runtime_id="owned", status="active", stop=AsyncMock(), invoke=AsyncMock()
        )
        self.api = SimpleNamespace(plan=Mock(), start_runtime=AsyncMock(return_value=self.runtime))
        self.patch = patch("backend.Fabric", return_value=self.api)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.host = fabric.RuntimeHost("main")

    async def call(self, operation, **kwargs):
        if operation in ("prepare", "configure"):
            kwargs.setdefault("config", copy.deepcopy(CONFIG))
            kwargs.setdefault("expected_generation", self.host.snapshot()["generation"])
        return await self.host.handle({"operation": operation, "agent": "main", **kwargs})

    async def test_validate_uses_planner_without_a_runtime_or_lifecycle_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            provenance = Path(directory) / "provenance.json"
            provenance.write_text(json.dumps({"fabric_revision": "a" * 40}))
            with patch("fabric.PROVENANCE", str(provenance)):
                response = await self.call("validate", config=CONFIG)
        self.assertEqual(response["status"], "succeeded")
        self.assertEqual(response["changed"], False)
        self.assertEqual(response["result"]["valid"], True)
        self.assertEqual(response["result"]["adapter"], "vendor.new")
        self.assertEqual(response["result"]["fabric_revision"], "a" * 40)
        self.assertIn("authentication", response["result"]["unverified"])
        self.api.plan.assert_called_once()
        self.api.start_runtime.assert_not_awaited()
        self.runtime.stop.assert_not_awaited()

    async def test_missing_adapter_evidence_is_unknown_but_invalid_configuration_is_false(self):
        for code, valid, diagnostic in (
            ("adapter_capability_unverified", None, "validation_unavailable"),
            (None, False, "fabric_validate_failed"),
        ):
            self.api.plan.side_effect = FabricConfigError("PRIVATE", code=code)
            response = await self.call("validate", config=CONFIG)
            self.assertIs(response["result"]["valid"], valid)
            self.assertEqual(response["error"]["code"], diagnostic)
            self.assertFalse(response["changed"])
            self.assertEqual(response["error"]["effects"], "none")
            self.assertNotIn("PRIVATE", json.dumps(response))
        self.api.start_runtime.assert_not_awaited()
        self.runtime.stop.assert_not_awaited()

    async def test_prepare_stops_unchanged_configuration_and_clears_readback(self):
        started = await self.call("configure")
        prepared = await self.call("prepare")
        self.assertEqual(prepared["status"], "succeeded")
        self.assertTrue(prepared["result"]["prepared"])
        self.assertEqual(prepared["result"]["runtime_state"], "stopped")
        self.assertIsNone(prepared["result"]["applied_config"])
        self.assertNotEqual(prepared["result"]["generation"], started["result"]["generation"])
        self.runtime.stop.assert_awaited_once()

    async def test_configure_noop_and_already_stopped_prepare_preserve_generation(self):
        before = self.host.snapshot()["generation"]
        prepared = await self.call("prepare")
        self.assertFalse(prepared["changed"])
        self.assertEqual(prepared["result"]["generation"], before)
        first = await self.call("configure")
        second = await self.call("configure")
        self.assertFalse(second["changed"])
        self.assertEqual(first["result"], second["result"])
        self.api.start_runtime.assert_awaited_once()
        self.runtime.stop.assert_not_awaited()

    async def test_competing_writers_cannot_both_use_the_same_generation(self):
        token = self.host.snapshot()["generation"]
        first, second = await asyncio.gather(
            self.call("configure", expected_generation=token),
            self.call("configure", expected_generation=token),
        )
        first, second = sorted(
            (first, second), key=lambda response: response["status"] != "succeeded"
        )
        self.assertEqual(first["status"], "succeeded")
        self.assertEqual(second["error"]["code"], "stale_generation")
        self.assertEqual(second["error"]["effects"], "none")
        self.assertFalse(second["changed"])
        self.api.start_runtime.assert_awaited_once()

    async def test_failed_start_invalidates_generation_without_publishing_config(self):
        before = self.host.snapshot()["generation"]
        self.api.start_runtime.side_effect = FabricRuntimeError("SECRET", stage="start")
        response = await self.call("configure")
        self.assertEqual(response["status"], "failed")
        self.assertNotEqual(response["result"]["generation"], before)
        self.assertIsNone(response["result"]["applied_config"])
        self.assertEqual(response["result"]["runtime_state"], "unknown")
        self.assertEqual(response["error"]["effects"], "unknown")
        self.assertNotIn("SECRET", json.dumps(response))
        restarted = fabric.RuntimeHost("main")
        self.assertNotEqual(restarted.snapshot()["generation"], before)

    async def test_rejected_configuration_preserves_generation_and_running_agent(self):
        await self.call("configure")
        before = self.host.snapshot()
        self.api.plan.side_effect = FabricConfigError("SECRET")
        response = await self.call("configure")
        self.assertEqual(response["status"], "failed")
        self.assertFalse(response["changed"])
        self.assertEqual(response["error"]["effects"], "none")
        self.assertEqual(self.host.snapshot(), before)
        self.runtime.stop.assert_not_awaited()

    async def test_check_during_stop_returns_the_associated_snapshot_without_waiting(self):
        await self.call("configure")
        entered, finish = asyncio.Event(), asyncio.Event()

        async def stop():
            entered.set()
            await finish.wait()

        self.runtime.stop.side_effect = stop
        preparing = asyncio.create_task(self.call("prepare"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            response = await asyncio.wait_for(self.call("check", level="ready"), 1)
            self.assertEqual(response["status"], "unsupported")
            self.assertEqual(response["result"]["applied_config"], CONFIG)
            self.assertEqual(response["result"]["runtime_id"], "owned")
            self.assertEqual(response["result"]["runtime_state"], "unknown")
            self.assertIsNone(response["result"]["health"])
            finish.set()
            await preparing
            self.assertIsNone(self.host.snapshot()["applied_config"])
        finally:
            preparing.cancel()
            await asyncio.gather(preparing, return_exceptions=True)

    async def test_check_during_invoke_is_unsupported_without_queueing_or_replaying(self):
        await self.call("configure")
        entered, finish = asyncio.Event(), asyncio.Event()
        native = {"status": "succeeded", "output": {"arbitrary": [3, 4]}}

        async def invoke(**kwargs):
            entered.set()
            await finish.wait()
            return SimpleNamespace(to_mapping=lambda: native)

        self.runtime.invoke.side_effect = invoke
        invoking = asyncio.create_task(self.call("invoke", input={"prompt": "private"}))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            response = await asyncio.wait_for(self.call("check", level="live"), 1)
            self.assertEqual(response["status"], "unsupported")
            self.assertEqual(response["result"]["runtime_state"], "running")
            finish.set()
            result = await invoking
            self.assertIsNone(result["changed"])
            self.assertEqual(result["result"]["fabric_result"], native)
            self.runtime.invoke.assert_awaited_once()
        finally:
            invoking.cancel()
            await asyncio.gather(invoking, return_exceptions=True)

    async def test_operational_and_streaming_never_invoke(self):
        await self.call("configure")
        response = await self.call("check", level="operational")
        self.assertEqual(response["status"], "unsupported")
        for key in ("stream", "streaming"):
            response = await self.call("invoke", input={key: True})
            self.assertEqual(response["status"], "unsupported")
        self.runtime.invoke.assert_not_awaited()

    async def test_socket_check_requires_an_explicit_level(self):
        before = self.host.snapshot()
        response = await self.call("check")
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["code"], "invalid_request")
        self.assertFalse(response["changed"])
        self.assertEqual(self.host.snapshot(), before)
        self.api.plan.assert_not_called()
        self.api.start_runtime.assert_not_awaited()

    async def test_wrong_agent_and_unknown_fields_do_not_change_runtime(self):
        token = self.host.snapshot()["generation"]
        for extra in ({"agent": "other"}, {"extra": True}, {"expected_generation": ""}):
            response = await self.host.handle(
                {
                    "operation": "configure",
                    "agent": "main",
                    "config": CONFIG,
                    "expected_generation": token,
                    **extra,
                }
            )
            self.assertEqual(response["status"], "failed")
            self.assertFalse(response["changed"])
        self.api.start_runtime.assert_not_awaited()


class CommandArguments(unittest.TestCase):
    def test_check_defaults_to_live_before_sending_the_request(self):
        self.assertEqual(
            fabric.parse_command(["check", "--agent", "main"]),
            {"operation": "check", "agent": "main", "level": "live"},
        )

    def test_named_files_are_read_without_touching_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "config.json"
            source.write_text(json.dumps(CONFIG))
            with patch("sys.stdin", new=Mock(read=Mock(side_effect=AssertionError("stdin")))):
                request = fabric.parse_command(
                    [
                        "configure",
                        "--agent",
                        "main",
                        "--config",
                        str(source),
                        "--expected-generation",
                        "opaque",
                    ]
                )
        self.assertEqual(
            request,
            {
                "operation": "configure",
                "agent": "main",
                "config": CONFIG,
                "expected_generation": "opaque",
            },
        )

    def test_unknown_duplicate_missing_and_conflicting_flags_are_safe_errors(self):
        for arguments in (
            [],
            ["SECRET"],
            ["check"],
            ["check", "--agent"],
            ["check", "--agent", "main", "--agent", "main"],
            ["check", "--agent", "main", "--config", "SECRET"],
            ["check", "--agent", "main", "--live", "--ready"],
            ["check", "--agent", "main", "--unknown"],
        ):
            with (
                self.subTest(arguments=arguments),
                self.assertRaises(fabric.ProtocolError) as error,
            ):
                fabric.parse_command(arguments)
            self.assertNotIn("SECRET", str(error.exception))

    def test_input_files_reject_invalid_or_oversized_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            for content in (
                b"[]",
                b"null",
                b"{",
                b"{} {}",
                b"\xff",
                b'{"x":NaN}',
                b" " * (fabric.REQUEST_LIMIT + 1),
            ):
                path.write_bytes(content)
                with self.subTest(content=content[:10]), self.assertRaises(fabric.ProtocolError):
                    fabric.parse_command(["invoke", "--agent", "main", "--input", str(path)])
            with self.assertRaises(fabric.ProtocolError):
                fabric.parse_command(
                    ["invoke", "--agent", "main", "--input", str(path / "missing")]
                )

    def test_dash_reads_one_object_from_stdin_for_each_input_flag(self):
        for operation, flag, field, value, extra in (
            ("validate", "--config", "config", CONFIG, []),
            ("configure", "--config", "config", CONFIG, ["--expected-generation", "opaque"]),
            ("invoke", "--input", "input", {"message": "hello"}, []),
        ):
            stdin = SimpleNamespace(
                buffer=io.BytesIO(json.dumps(value).encode()), isatty=lambda: False
            )
            with self.subTest(operation=operation), patch("sys.stdin", new=stdin):
                request = fabric.parse_command([operation, "--agent", "main", flag, "-", *extra])
            self.assertEqual(request[field], value)
            self.assertEqual(stdin.buffer.read(), b"")

    def test_stdin_rejects_invalid_or_oversized_json_and_never_reads_a_terminal(self):
        for content in (
            b"",
            b"[]",
            b"{} {}",
            b"\xff",
            b'{"x":NaN}',
            b'{"a":1,"a":2}',
            b" " * (fabric.REQUEST_LIMIT + 1),
        ):
            stdin = SimpleNamespace(buffer=io.BytesIO(content), isatty=lambda: False)
            with (
                self.subTest(content=content[:10]),
                patch("sys.stdin", new=stdin),
                self.assertRaises(fabric.ProtocolError) as error,
            ):
                fabric.parse_command(["invoke", "--agent", "main", "--input", "-"])
            self.assertEqual(error.exception.code, "invalid_input")
        unread = Mock(read=Mock(side_effect=AssertionError("terminal stdin was read")))
        for stdin in (None, SimpleNamespace(buffer=unread, isatty=lambda: True)):
            with (
                self.subTest(stdin=stdin),
                patch("sys.stdin", new=stdin),
                self.assertRaises(fabric.ProtocolError) as error,
            ):
                fabric.parse_command(["validate", "--agent", "main", "--config", "-"])
            self.assertEqual(error.exception.code, "invalid_input")

    def test_only_an_exact_dash_selects_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "-"
            path.write_text(json.dumps({"message": "file"}))
            with patch("sys.stdin", new=Mock(buffer=Mock(read=Mock(side_effect=AssertionError)))):
                request = fabric.parse_command(["invoke", "--agent", "main", "--input", str(path)])
        self.assertEqual(request["input"], {"message": "file"})

    def test_handled_cli_errors_emit_one_safe_envelope_and_exit_one(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = fabric.main(["configure", "--agent", "main", "--config", "PRIVATE"])
        self.assertEqual(code, 1)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        response = json.loads(output.getvalue())
        self.assertEqual(set(response), {"operation", "status", "changed", "result", "error"})
        self.assertEqual(response["status"], "failed")
        self.assertNotIn("PRIVATE", output.getvalue())


class SocketContract(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, request, reply):
        with tempfile.TemporaryDirectory() as directory:
            socket = str(Path(directory) / "fabric.sock")
            calls = []

            async def respond(reader, writer):
                calls.append(await reader.readline())
                writer.write(reply)
                await writer.drain()
                writer.close()

            async with await asyncio.start_unix_server(respond, socket):
                with patch("fabric.SOCKET", socket):
                    result = await fabric.client(request)
            return result, calls

    async def test_malformed_truncated_or_oversized_invocation_results_are_unknown_and_never_replayed(
        self,
    ):
        request = {"operation": "invoke", "agent": "main", "input": {"prompt": "private"}}
        for reply in (b"{}", b"{}\n", b"SECRET\n", b" " * fabric.RESULT_LIMIT + b"\n"):
            response, calls = await self.exchange(request, reply)
            self.assertEqual(len(calls), 1)
            self.assertEqual(response["status"], "failed")
            self.assertEqual(response["error"]["effects"], "unknown")
            self.assertIsNone(response["changed"])
            self.assertNotIn("SECRET", json.dumps(response))

    async def test_success_without_the_commands_success_condition_is_invalid(self):
        for operation, result, fields in (
            ("validate", {"valid": False}, {"config": CONFIG}),
            (
                "configure",
                {"runtime_state": "stopped"},
                {"config": CONFIG, "expected_generation": "token"},
            ),
            ("prepare", {"prepared": False}, {"config": CONFIG, "expected_generation": "token"}),
            ("check", {"health": None}, {"level": "live"}),
            ("invoke", {"fabric_result": {"status": "failed"}}, {"input": {}}),
        ):
            response, calls = await self.exchange(
                {"operation": operation, "agent": "main", **fields},
                fabric.encode(fabric.envelope(operation, result)),
            )
            self.assertEqual(response["status"], "failed")
            self.assertEqual(response["error"]["code"], "invalid_response")
            self.assertEqual(len(calls), 1)

    async def test_success_observations_must_have_the_documented_json_types(self):
        for operation, result, fields, changed in (
            ("check", {"health": False}, {"level": "live"}, False),
            (
                "invoke",
                {"runtime_id": [], "fabric_result": {"status": "succeeded"}},
                {"input": {}},
                None,
            ),
            (
                "configure",
                {"runtime_id": ["bad"], "runtime_state": "running", "generation": "token"},
                {"config": CONFIG, "expected_generation": "token"},
                True,
            ),
        ):
            response, _ = await self.exchange(
                {"operation": operation, "agent": "main", **fields},
                fabric.encode(fabric.envelope(operation, result, changed=changed)),
            )
            self.assertEqual(response["error"]["code"], "invalid_response")

    async def test_peer_diagnostics_are_replaced_with_fixed_safe_messages(self):
        native = fabric.envelope(
            "configure", error=fabric.ProtocolError("fabric_start_failed", "start")
        )
        native["error"]["message"] = "SECRET"
        request = {
            "operation": "configure",
            "agent": "main",
            "config": CONFIG,
            "expected_generation": "opaque",
        }
        response, _ = await self.exchange(request, fabric.encode(native))
        self.assertEqual(response["error"]["code"], "fabric_start_failed")
        self.assertNotIn("SECRET", json.dumps(response))

    async def test_unknown_peer_diagnostic_stage_is_invalid_without_replaying(self):
        request = {
            "operation": "configure",
            "agent": "main",
            "config": CONFIG,
            "expected_generation": "opaque",
        }
        for stage in ("SECRET", None, []):
            with self.subTest(stage=stage):
                native = fabric.envelope(
                    "configure", error=fabric.ProtocolError("fabric_start_failed", "start")
                )
                native["error"]["stage"] = stage
                response, calls = await self.exchange(request, fabric.encode(native))
                self.assertEqual(response["error"]["code"], "invalid_response")
                self.assertEqual(response["error"]["effects"], "unknown")
                self.assertIsNone(response["changed"])
                self.assertEqual(len(calls), 1)
                self.assertNotIn("SECRET", json.dumps(response))

    async def test_response_limit_includes_its_newline(self):
        response = fabric.envelope(
            "invoke",
            {"runtime_id": "owned", "fabric_result": {"status": "succeeded", "output": ""}},
            changed=None,
        )
        response["result"]["fabric_result"]["output"] = "a" * (
            fabric.RESULT_LIMIT - len(fabric.encode(response))
        )
        request = {"operation": "invoke", "agent": "main", "input": {}}
        encoded = fabric.bounded_response(response)
        self.assertEqual(len(encoded), fabric.RESULT_LIMIT)
        accepted, _ = await self.exchange(request, encoded)
        self.assertEqual(accepted["status"], "succeeded")
        response["result"]["fabric_result"]["output"] += "a"
        rejected = fabric.decode_object(fabric.bounded_response(response))
        self.assertEqual(rejected["error"]["code"], "response_too_large")
        self.assertEqual(rejected["error"]["effects"], "unknown")
        self.assertIsNone(rejected["changed"])

    async def test_request_limit_includes_its_newline(self):
        request = {"operation": "invoke", "agent": "main", "input": {"prompt": ""}}
        request["input"]["prompt"] = "a" * (fabric.REQUEST_LIMIT - len(fabric.encode(request)))
        self.assertEqual(len(fabric.encode(request)), fabric.REQUEST_LIMIT)
        fabric.validate_request(request)
        request["input"]["prompt"] += "a"
        with self.assertRaises(fabric.ProtocolError) as error:
            fabric.validate_request(request)
        self.assertEqual(error.exception.code, "request_too_large")

    async def test_unreachable_host_never_looks_stopped(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.SOCKET", str(Path(directory) / "absent")),
        ):
            response = await fabric.client({"operation": "check", "agent": "main", "level": "live"})
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["result"]["runtime_state"], "unknown")
        self.assertIsNone(response["result"]["generation"])
        self.assertIsNone(response["result"]["health"])

    async def test_operational_is_unsupported_without_a_host_but_invalid_peer_responses_still_fail(
        self,
    ):
        request = {"operation": "check", "agent": "main", "level": "operational"}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.SOCKET", str(Path(directory) / "absent")),
        ):
            response = await fabric.client(request)
        self.assertEqual(response["status"], "unsupported")
        self.assertEqual(response["error"]["code"], "operational_unsupported")
        self.assertEqual(response["result"]["runtime_state"], "unknown")
        self.assertIsNone(response["result"]["generation"])
        malformed, _ = await self.exchange(request, b"{}\n")
        self.assertEqual(malformed["status"], "failed")
        self.assertEqual(malformed["error"]["code"], "invalid_response")


class HostOwnership(unittest.IsolatedAsyncioTestCase):
    async def start_host(self, directory, stop):
        serving = asyncio.create_task(fabric.serve("main", Path(directory), stop))
        socket = Path(fabric.SOCKET)
        async with asyncio.timeout(1):
            while not socket.exists():
                if serving.done():
                    await serving
                await asyncio.sleep(0.001)
        return serving

    async def test_second_host_cannot_touch_active_socket_and_shutdown_retains_files(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.SOCKET", str(Path(directory) / "fabric.sock")),
        ):
            stop = asyncio.Event()
            serving = await self.start_host(directory, stop)
            retained = Path(directory) / "workspace" / "retained"
            retained.write_text("keep")
            try:
                socket = Path(fabric.SOCKET)
                identity = socket.stat().st_ino
                self.assertEqual(socket.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(BlockingIOError):
                    await fabric.serve("main", Path(directory), asyncio.Event())
                self.assertEqual(socket.stat().st_ino, identity)
                response = await fabric.client(
                    {"operation": "check", "agent": "main", "level": "live"}
                )
                self.assertEqual(response["status"], "unsupported")
                self.assertEqual(response["result"]["runtime_state"], "stopped")
            finally:
                stop.set()
                self.assertEqual(await asyncio.wait_for(serving, 1), 0)
            self.assertFalse(socket.exists())
            self.assertEqual(retained.read_text(), "keep")

    async def test_shutdown_removes_only_the_socket_it_created(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.SOCKET", str(Path(directory) / "fabric.sock")),
        ):
            stop = asyncio.Event()
            serving = await self.start_host(directory, stop)
            socket = Path(fabric.SOCKET)
            socket.unlink()
            replacement = await asyncio.start_unix_server(
                lambda reader, writer: writer.close(), socket
            )
            try:
                stop.set()
                self.assertEqual(await asyncio.wait_for(serving, 1), 0)
                self.assertTrue(socket.exists())
            finally:
                replacement.close()
                await replacement.wait_closed()

    async def test_shutdown_is_bounded_and_rejects_new_work(self):
        entered = asyncio.Event()

        async def stop():
            entered.set()
            await asyncio.Event().wait()

        host = fabric.RuntimeHost("main")
        host.runtime = SimpleNamespace(
            runtime_id="owned", status="active", stop=AsyncMock(side_effect=stop)
        )
        host.state = "running"
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("fabric.SOCKET", str(Path(directory) / "fabric.sock")),
            patch("fabric.RuntimeHost", return_value=host),
            patch("fabric.SHUTDOWN_SECONDS", 0.02),
        ):
            stop_event = asyncio.Event()
            serving = await self.start_host(directory, stop_event)
            stop_event.set()
            await asyncio.wait_for(entered.wait(), 1)
            response = await host.handle({"operation": "invoke", "agent": "main", "input": {}})
            self.assertEqual(response["error"]["code"], "host_stopping")
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(serving, 1)
            self.assertFalse(Path(fabric.SOCKET).exists())

    async def test_signal_shutdown_bounds_an_uncancellable_native_planner_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            socket = root / "fabric.sock"
            script = "\n".join(
                [
                    "import asyncio, functools, pathlib, threading",
                    "from types import SimpleNamespace",
                    "import fabric",
                    "fabric.SHUTDOWN_SECONDS = 0.15",
                    "root = pathlib.Path(" + repr(directory) + ")",
                    "fabric.SOCKET = str(root / 'fabric.sock')",
                    "def plan(*args, **kwargs):",
                    "    (root / 'entered').touch()",
                    "    threading.Event().wait()",
                    "__import__('backend').Fabric = lambda: SimpleNamespace(plan=plan)",
                    "fabric.serve = functools.partial(fabric.serve, directory=root)",
                    "raise SystemExit(fabric.main(['serve', '--agent', 'main']))",
                ]
            )
            env = dict(os.environ)
            env["PYTHONPATH"] = (
                str(Path(fabric.__file__).parent) + os.pathsep + env.get("PYTHONPATH", "")
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                script,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                async with asyncio.timeout(3):
                    while not socket.exists():
                        await asyncio.sleep(0.005)
                    reader, writer = await asyncio.open_unix_connection(str(socket))
                    writer.write(
                        fabric.encode({"operation": "validate", "agent": "main", "config": CONFIG})
                    )
                    await writer.drain()
                    while not (root / "entered").exists():
                        await asyncio.sleep(0.005)
                    process.send_signal(signal.SIGTERM)
                    await process.wait()
                    writer.close()
                self.assertEqual(process.returncode, 1)
                self.assertEqual(await process.stdout.read(), b"")
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()


if __name__ == "__main__":
    unittest.main()
