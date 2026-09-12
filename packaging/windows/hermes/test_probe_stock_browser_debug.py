# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import ctypes as c
import ast
import importlib.util
import io
import json
import struct
from pathlib import Path
import threading
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "debug_probe", Path(__file__).with_name("probe-stock-browser-debug.py")
)
debug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(debug)


class DebugOwnerControls(unittest.TestCase):
    def test_primary_request_requires_passed_native_bytes_and_original_workload_shape(
        self,
    ):
        runtime = r"C:\NemoClawHermesProbe-274d797050ea"
        nonce = "a" * 24
        state = r"C:\NemoClawMsysProof-aaaaaaaaaaaa-state-start"
        controller = r"C:\NemoClawPersonalNode-aaaaaaaaaaaa"
        native = r"C:\NemoClawPersonalCompat-bbbbbbbbbbbb"
        source = "c" * 40
        identity = {"bytes": 1, "sha256": "d" * 64}
        rows = [
            {"file": name, **identity}
            for name in (
                "NemoClawMsysLauncher.exe",
                "NemoClawMsysCompat-arm64.dll",
                "NemoClawMsysCompat-x64.dll",
            )
        ]
        proof = {
            "passed": True,
            "normalCleanup": True,
            "phase": "two-container-isolation",
            "sourceRevision": source,
            "inputs": {
                "mxcBuild": {
                    "candidateRevision": source,
                    "files": [{"file": "wxc-exec.exe", **identity}],
                },
                "compatibility": {
                    "sourceRevision": source,
                    "status": "built",
                    "files": rows,
                },
            },
        }
        words = [
            native + r"\NemoClawMsysLauncher.exe",
            "--",
            controller + r"\node.exe",
            "--experimental-strip-types",
            "--no-warnings",
            controller + r"\probe-personal-workload.mts",
            runtime,
            state + r"\result.json",
            nonce,
            controller + r"\personal-workload-input.json",
        ]
        policy = {
            "containerId": "nm-aaaaaaaaaaaa-start",
            "process": {
                "cwd": state,
                "timeout": 120000,
                "commandLine": " ".join('"' + word + '"' for word in words),
            },
            "filesystem": {
                "readwritePaths": [state],
                "readonlyPaths": [runtime, controller, native],
            },
            "processContainer": {"leastPrivilege": False},
            "ui": {"disable": False},
        }
        request = {
            "schemaVersion": 1,
            "classification": "personal-MXC-browser-debug-request",
            "executor": r"C:\control\wxc-exec.exe",
            "executorIdentity": identity,
            "policyFile": "policy.json",
            "runtimeRoot": runtime,
            "nonce": nonce,
            "probeFile": controller + r"\probe-personal-python.py",
            "nativeRoot": native,
            "logFile": "native.log",
            "environment": {
                "GITHUB_ACTIONS": "true",
                "NEMOCLAW_MSYS_TOKEN_INSPECTION": "repair-query",
            },
        }

        def run(value, body, native_proof):
            values = {
                "policy.json": json.dumps(body).encode(),
                "proof.json": json.dumps(native_proof).encode(),
            }
            value = {
                **value,
                "policySha256": debug.owner.hashlib.sha256(
                    values["policy.json"]
                ).hexdigest(),
                "nativeProof": {
                    "path": "proof.json",
                    "bytes": len(values["proof.json"]),
                    "sha256": debug.owner.hashlib.sha256(
                        values["proof.json"]
                    ).hexdigest(),
                },
            }

            def identify(path):
                if str(path).endswith(r"\node.exe"):
                    return {
                        "bytes": 1,
                        "sha256": "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
                    }
                return identity

            with (
                mock.patch.object(
                    debug.Path,
                    "read_bytes",
                    autospec=True,
                    side_effect=lambda path: values[str(path)],
                ),
                mock.patch.object(debug.owner, "identity", side_effect=identify),
            ):
                return debug.validate(value)

        self.assertEqual(
            run(request, policy, proof),
            ([request["executor"], "policy.json", "--log-file", "native.log"], state),
        )
        for value, body, native_proof in (
            (request, policy, {**proof, "passed": False}),
            (
                {**request, "executorIdentity": {"bytes": 1, "sha256": "e" * 64}},
                policy,
                proof,
            ),
            (
                request,
                {
                    **policy,
                    "process": {
                        **policy["process"],
                        "commandLine": policy["process"]["commandLine"].replace(
                            "--no-warnings", "--eval"
                        ),
                    },
                },
                proof,
            ),
            ({**request, "environment": {"GITHUB_ACTIONS": "true"}}, policy, proof),
        ):
            with self.assertRaises(ValueError):
                run(value, body, native_proof)

    def test_native_pointer_structures_match_the_64_bit_debug_event_contract(self):
        self.assertEqual(c.sizeof(debug.ExceptionRecord), 152)
        self.assertEqual(c.sizeof(debug.ExceptionInfo), 160)
        self.assertEqual(c.sizeof(debug.DebugEvent), 176)
        self.assertEqual(debug.DebugEvent.data.offset, 16)
        self.assertEqual(c.sizeof(debug.DebugStringInfo), 16)
        self.assertEqual(debug.DebugStringInfo.length.offset, 10)
        self.assertEqual(c.sizeof(debug.ProcessBasic), 48)
        self.assertEqual(debug.ProcessBasic.parent.offset, 40)
        self.assertEqual(
            debug.DebugJob.creation_flags, debug.owner.WindowsJob.creation_flags | 1
        )
        self.assertFalse(debug.DebugJob.creation_flags & 2)
        # TRUE is the documented default. Calling this API before a debug
        # connection would fail before the first useful Windows observation.
        self.assertNotIn("DebugSetProcessKillOnExit", Path(debug.__file__).read_text())

    def test_only_initial_ntdll_breakpoint_is_consumed_all_application_faults_forward(
        self,
    ):
        process = {
            "loaderBreakpoint": False,
            "modules": {
                0x100000000: {"name": "ntdll.dll", "size": 0x1000},
                0x200000000: {"name": "chrome.dll", "size": 0x1000},
            },
        }
        record = debug.ExceptionRecord()
        record.code = 0x80000003
        record.address = 0x100000010
        status, initial, location = debug.exception_disposition(process, record, True)
        self.assertEqual(
            (status, initial, location["rva"]), (debug.DBG_CONTINUE, True, "0x10")
        )
        self.assertEqual(
            debug.exception_disposition(process, record, True)[0], debug.DBG_NOT_HANDLED
        )
        process["loaderBreakpoint"] = False
        record.address = 0x200000020
        self.assertEqual(
            debug.exception_disposition(process, record, True)[0], debug.DBG_NOT_HANDLED
        )
        for code in (0xC0000005, 0xC0000409, 0xE06D7363, 0x4000001F):
            record.code = code
            for first in (True, False):
                self.assertEqual(
                    debug.exception_disposition(process, record, first)[0],
                    debug.DBG_NOT_HANDLED,
                )

    def job(self, events):
        job = debug.DebugJob.__new__(debug.DebugJob)
        job.creating_thread = threading.get_ident()
        job.debug_started = True
        job.debug_complete = False
        job.saw_process = False
        job.events = []
        job.processes = {}
        job.live_debug_pids = set()
        job.event_count = 0
        job.event_history_exceeded = False
        job.observation_errors = []
        job.chrome_seen = False
        job.appcontainer_seen = False
        job.last_fault = job.first_fault = job.first_unhandled = None
        job.handle_cleanup_errors = []
        job.reconciled_exits = []
        job.debug_string_count = 0
        job.observe_startup_handles = lambda *_args: {}
        job.continued = []
        job.wait_calls = 0

        def wait(pointer, _timeout):
            job.wait_calls += 1
            if not events:
                raise AssertionError(
                    "WaitForDebugEventEx called after the last continued exit"
                )
            event = events.pop(0)
            c.memmove(pointer, c.byref(event), c.sizeof(event))
            return 1

        def continued(pid, tid, status):
            job.continued.append((pid, tid, status))
            return 1

        job.kernel = types.SimpleNamespace(
            WaitForDebugEventEx=wait, ContinueDebugEvent=continued
        )
        job.image = lambda file, base, handle: {
            "name": "ntdll.dll" if file == 99 else "chrome.exe",
            "size": 0x1000,
            "base": hex(base or 0),
            "machine": "0x8664",
        }
        job.process_metadata = lambda handle: {
            "parentPid": 7,
            "ownedJobMember": True,
            "isAppContainer": True,
            "chromeRole": "crashpad-handler",
        }
        return job

    def event(self, kind, pid=8):
        event = debug.DebugEvent()
        event.kind = kind
        event.pid = pid
        event.tid = pid + 10
        if kind == 3:
            event.data.process.file = 10
            event.data.process.process = 11
            event.data.process.thread = 12
            event.data.process.base = 0x100000000
        elif kind == 6:
            event.data.dll.file = 99
            event.data.dll.base = 0x200000000
        elif kind == 1:
            event.data.exception.first = 1
            event.data.exception.record.code = 0xC0000409
            event.data.exception.record.address = 0x100000020
        elif kind == 5:
            event.data.exit_code = 0xFFFF7001
        return event

    def test_create_fault_and_exit_have_real_lineage_and_no_poll_after_final_exit(self):
        job = self.job([self.event(3), self.event(6), self.event(1), self.event(5)])
        for _ in range(4):
            job.pump(0)
        self.assertEqual(job.events[0]["chromeRole"], "crashpad-handler")
        self.assertEqual(job.first_fault["code"], "0xc0000409")
        self.assertEqual(job.first_fault["rva"], "0x20")
        self.assertEqual(job.events[-1]["exitCode"], 0xFFFF7001)
        self.assertEqual(job.continued[2][2], debug.DBG_NOT_HANDLED)
        self.assertTrue(job.debug_complete)
        self.assertFalse(job.live_debug_pids)
        job.pump(0)
        self.assertEqual(job.wait_calls, 4)

    def test_observation_failure_still_continues_exit_during_cleanup(self):
        job = self.job([self.event(3), self.event(5)])

        def failure(_handle):
            raise RuntimeError("metadata unavailable")

        job.process_metadata = failure
        job.pump(0)
        self.assertEqual(len(job.observation_errors), 1)
        self.assertIn(8, job.live_debug_pids)
        job.pump(0)
        self.assertTrue(job.debug_complete)
        self.assertEqual(len(job.continued), 2)

    def test_event_bound_does_not_prevent_exit_drain(self):
        job = self.job([self.event(3), self.event(1), self.event(5)])
        with mock.patch.object(debug, "MAX_EVENTS", 1):
            for _ in range(3):
                job.pump(0)
        self.assertTrue(job.debug_complete)
        self.assertEqual(len(job.events), 1)
        self.assertTrue(job.event_history_exceeded)
        self.assertEqual(len(job.observation_errors), 0)
        self.assertEqual(job.first_fault["code"], "0xc0000409")

    def test_chrome_debug_strings_are_bounded_secondary_reads_and_events_continue(self):
        events = [self.event(3)] + [self.event(8) for _ in range(10)] + [self.event(5)]
        for event in events:
            if event.kind == 8:
                event.data.string.address = 0x1234
                event.data.string.unicode = 1
                event.data.string.length = 900
        job = self.job(events)
        job.pump(0)
        job.processes[8]["ownedChrome"] = True
        reads = []

        def read(handle, address, storage, size, copied):
            reads.append((handle, address, size))
            data = ("A" * 512).encode("utf-16-le")
            c.memmove(storage, data, len(data))
            c.cast(copied, c.POINTER(c.c_size_t))[0] = len(data)
            return 1

        job.kernel.ReadProcessMemory = read
        for _ in range(11):
            job.pump(0)
        records = [row["debugString"] for row in job.events if "debugString" in row]
        self.assertEqual(len(records), 8)
        self.assertEqual(reads, [(11, 0x1234, 1024)] * 8)
        self.assertTrue(
            all(row["truncated"] and row["readSucceeded"] for row in records)
        )
        self.assertEqual(len(job.continued), 12)
        self.assertFalse(job.observation_errors)
        self.assertTrue(job.debug_complete)

    def test_debug_string_missing_memory_is_secondary_and_unowned_or_global_bound_is_not_read(
        self,
    ):
        event = self.event(8)
        event.data.string.address = 0x1234
        event.data.string.length = 8
        job = self.job([self.event(3), event, event, event, self.event(5)])
        job.pump(0)
        job.processes[8]["ownedChrome"] = False
        calls = []
        job.kernel.ReadProcessMemory = lambda *_args: calls.append(1) or 0
        job.pump(0)  # No actual owned-Chrome metadata, so payload is ignored.
        self.assertFalse(calls)
        job.processes[8]["ownedChrome"] = True
        with mock.patch.object(
            debug.c, "get_last_error", return_value=299, create=True
        ):
            job.pump(0)
        job.debug_string_count = 16
        job.pump(0)
        job.pump(0)
        records = [row["debugString"] for row in job.events if "debugString" in row]
        self.assertEqual(len(calls), 1)
        self.assertEqual(records[0]["win32Error"], 299)
        self.assertFalse(records[0]["readSucceeded"])
        self.assertEqual(records[0]["text"], "")
        self.assertFalse(job.observation_errors)
        self.assertTrue(job.debug_complete)

    def test_missing_exit_reconciliation_uses_only_same_signaled_process_handle(self):
        job = self.job([self.event(3)])
        job.pump(0)
        calls = []

        def wait(handle, timeout):
            calls.append(("wait", handle, timeout))
            return 0

        def exited(handle, code):
            calls.append(("exit", handle))
            c.cast(code, c.POINTER(c.c_uint32))[0] = 0x80000003
            return 1

        job.kernel.WaitForSingleObject = wait
        job.kernel.GetExitCodeProcess = exited
        job.reconcile_exited_processes()
        self.assertEqual(calls, [("wait", 11, 0), ("exit", 11)])
        self.assertFalse(job.live_debug_pids)
        self.assertTrue(job.debug_complete)
        self.assertEqual(job.reconciled_exits[0]["exitCode"], 0x80000003)
        self.assertFalse(job.reconciled_exits[0]["exitEventObserved"])
        self.assertTrue(job.reconciled_exits[0]["closureProved"])
        self.assertEqual(len(job.continued), 1)  # No synthetic EXIT or close call.

    def reconcile_at_capture_cleanup_boundary(self, job, active=0, closed=True):
        # Execute the real capture caller's guard, without starting a Windows
        # executor or duplicating its cleanup logic in this fixture.
        tree = ast.parse(Path(debug.__file__).read_text())
        guards = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.If)
            and any(
                isinstance(statement, ast.Expr)
                and isinstance(statement.value, ast.Call)
                and isinstance(statement.value.func, ast.Attribute)
                and statement.value.func.attr == "reconcile_exited_processes"
                for statement in node.body
            )
        ]
        self.assertEqual(len(guards), 1)
        code = compile(ast.Module(body=guards, type_ignores=[]), debug.__file__, "exec")
        exec(
            code,
            {"__builtins__": {}},
            {
                "native": job,
                "result": {
                    "execution": {"childClosed": closed},
                    "cleanup": {"activeProcesses": active},
                },
            },
        )

    def test_history_overflow_preserves_identity_and_requires_same_signaled_handle(
        self,
    ):
        self.assertEqual(debug.MAX_EVENTS, 8192)
        for wait_result, query_result, proved in (
            (0, 1, True),
            (258, 1, False),
            (0, 0, False),
        ):
            job = self.job([self.event(3), self.event(1)])
            with mock.patch.object(debug, "MAX_EVENTS", 1):
                job.pump(0)
                job.pump(0)
            self.assertTrue(job.event_history_exceeded)
            self.assertEqual(job.observation_errors, [])
            calls = []

            def wait(handle, timeout):
                calls.append(("wait", handle, timeout))
                return wait_result

            def exited(handle, code):
                calls.append(("exit", handle))
                c.cast(code, c.POINTER(c.c_uint32))[0] = 1
                return query_result

            job.kernel.WaitForSingleObject = wait
            job.kernel.GetExitCodeProcess = exited
            with mock.patch.object(
                debug.c, "get_last_error", return_value=6, create=True
            ):
                self.reconcile_at_capture_cleanup_boundary(job)
            self.assertEqual(calls[0], ("wait", 11, 0))
            self.assertEqual(len(calls), 2 if wait_result == 0 else 1)
            self.assertEqual(job.reconciled_exits[0]["closureProved"], proved)
            self.assertEqual(job.reconciled_exits[0]["createdSequence"], 1)
            self.assertEqual(job.debug_complete, proved)
            self.assertEqual(job.live_debug_pids, set() if proved else {8})
            self.assertTrue(job.event_history_exceeded)  # Diagnostic remains failed.
            self.assertEqual(job.first_fault["code"], "0xc0000409")
            self.assertEqual(job.continued[1][2], debug.DBG_NOT_HANDLED)
            self.assertEqual(len(job.continued), 2)  # No invented EXIT event.

    def test_reconciliation_still_refuses_identity_errors_or_unclosed_nonempty_job(
        self,
    ):
        for failure, active, closed in (
            (True, 0, True),
            (False, 1, True),
            (False, None, True),
            (False, 0, False),
        ):
            job = self.job([self.event(3), self.event(1)])
            if failure:
                job.process_metadata = mock.Mock(
                    side_effect=RuntimeError("actual identity read failed")
                )
            with mock.patch.object(debug, "MAX_EVENTS", 1):
                job.pump(0)
                job.pump(0)
            self.assertTrue(job.event_history_exceeded)
            if failure:
                self.assertTrue(job.observation_errors)
            job.kernel.WaitForSingleObject = mock.Mock(
                side_effect=AssertionError("unqualified handle wait")
            )
            job.kernel.GetExitCodeProcess = mock.Mock(
                side_effect=AssertionError("unqualified exit query")
            )
            self.reconcile_at_capture_cleanup_boundary(
                job, active=active, closed=closed
            )
            job.kernel.WaitForSingleObject.assert_not_called()
            job.kernel.GetExitCodeProcess.assert_not_called()
            self.assertEqual(job.reconciled_exits, [])
            self.assertIn(8, job.live_debug_pids)

    def test_job_absence_wait_timeout_and_query_failures_cannot_prove_exit(self):
        for wait_result, query_result in ((258, 1), (0xFFFFFFFF, 1), (0, 0)):
            job = self.job([self.event(3)])
            job.pump(0)
            job.kernel.WaitForSingleObject = lambda *_args: wait_result
            job.kernel.GetExitCodeProcess = lambda *_args: query_result
            with mock.patch.object(
                debug.c, "get_last_error", return_value=6, create=True
            ):
                job.reconcile_exited_processes()
            self.assertEqual(job.live_debug_pids, {8})
            self.assertFalse(job.debug_complete)
            self.assertFalse(job.reconciled_exits[0]["closureProved"])

    def test_debug_events_cannot_move_to_a_reader_thread(self):
        job = self.job([self.event(3)])
        job.creating_thread = -1
        with self.assertRaisesRegex(ValueError, "creating thread"):
            job.pump(0)
        self.assertEqual(job.wait_calls, 0)

    def test_unknown_emulation_breakpoint_is_recorded_and_not_swallowed(self):
        event = self.event(1)
        event.data.exception.record.code = 0x4000001F
        job = self.job([self.event(3), event, self.event(5)])
        for _ in range(3):
            job.pump(0)
        self.assertTrue(job.first_fault["unclassifiedEmulationBreakpoint"])
        self.assertEqual(job.continued[1][2], debug.DBG_NOT_HANDLED)

    def test_image_file_handle_closes_even_when_header_read_fails(self):
        job = debug.DebugJob.__new__(debug.DebugJob)
        closed = []

        def fail(*_args):
            raise RuntimeError("read failed")

        job.kernel = types.SimpleNamespace(
            GetFinalPathNameByHandleW=fail, CloseHandle=lambda h: closed.append(h) or 1
        )
        image = job.image(44, 0x1000, 11)
        self.assertEqual(closed, [44])
        self.assertEqual(image["error"]["message"], "read failed")

    def test_timeout_cleanup_continues_exit_events_before_job_and_capture_close(self):
        clock = [0.0]
        trace = []

        class Native:
            process = job = thread = None
            pid = 9
            event_count = 0
            event_history_exceeded = False
            events = []
            observation_errors = []
            handle_cleanup_errors = []
            reconciled_exits = []
            first_fault = last_fault = first_unhandled = None
            appcontainer_seen = chrome_seen = True
            streams = []
            live_debug_pids = set()
            exited = False

            def create_job(self):
                self.job = 1

            def start(self, *_args):
                self.process = 2
                self.thread = 3
                self.streams = [
                    io.BytesIO(b"actual failed browser output"),
                    io.BytesIO(b"actual stderr"),
                ]
                self.live_debug_pids = {9, 10}

            def assign(self):
                trace.append("assigned")

            def resume(self):
                trace.append("resumed")

            def wait(self, milliseconds):
                if milliseconds:
                    clock[0] = 121.0
                return self.exited

            def active(self):
                return len(self.live_debug_pids)

            def terminate(self, assigned):
                self.assert_assigned = assigned
                trace.append("terminated-job")

            def pump(self, *_args):
                clock[0] += 0.02
                if self.live_debug_pids:
                    pid = max(self.live_debug_pids)
                    self.live_debug_pids.remove(pid)
                    trace.append("continued-exit-" + str(pid))
                self.exited = not self.live_debug_pids

            def exit_code(self):
                return 1

            def close(self, name):
                assert self.exited
                trace.append("closed-" + name)
                setattr(self, name, None)

        native = Native()
        with (
            mock.patch.object(
                debug, "validate", return_value=(["stock", "policy"], "owned-state")
            ),
            mock.patch.object(debug.time, "monotonic", side_effect=lambda: clock[0]),
            mock.patch.object(
                debug.owner, "identity", return_value={"sha256": debug.STOCK_SHA}
            ),
        ):
            result = debug.capture(
                {"nonce": "a" * 24, "policySha256": "b" * 64, "environment": {}}, native
            )
        self.assertTrue(result["execution"]["timedOut"])
        self.assertTrue(result["childrenClosed"])
        self.assertTrue(result["cleanupComplete"])
        self.assertEqual(result["execution"]["stderr"], "actual stderr")
        self.assertLess(trace.index("continued-exit-9"), trace.index("closed-process"))
        self.assertLess(clock[0], 126)

    def test_initial_client_data_keeps_only_five_numeric_handles(self):
        command = 'chrome.exe --type=crashpad-handler "--initial-client-data=0x10,0x20,0x30,0x40,0x50,0x123456789abc,0xabcdef,0x0"'
        result = debug.initial_client_handles(command)
        self.assertEqual(result, dict(zip(debug.INITIAL_HANDLES, [16, 32, 48, 64, 80])))
        self.assertNotIn(0x123456789ABC, result.values())
        self.assertIsNone(debug.initial_client_handles("chrome.exe"))
        for invalid in [
            command.replace("0x10", "0xffffffff", 1),
            command.replace("0x10", "text", 1),
            command.replace(',0x0"', '"'),
            command + " --initial-client-data=0x1",
        ]:
            with self.assertRaises(ValueError):
                debug.initial_client_handles(invalid)

    def test_win64_startup_prefix_and_snapshot_layout(self):
        self.assertEqual(c.sizeof(debug.SnapshotHandleEntry), 136)
        self.assertEqual(debug.SnapshotHandleEntry.attributes.offset, 24)
        self.assertEqual(debug.SnapshotHandleEntry.specific.offset, 88)
        header = bytearray(56)
        struct.pack_into("<IIII", header, 0, 256, 128, 1, 0)
        for offset, value in (
            (16, 0xFFFFFFFFFFFFFFFF),
            (32, 0x60),
            (40, 0x64),
            (48, 0x70),
        ):
            struct.pack_into("<Q", header, offset, value)
        self.assertEqual(
            debug.startup_handles(header)["values"],
            {
                "console": 0xFFFFFFFFFFFFFFFF,
                "stdin": 0x60,
                "stdout": 0x64,
                "stderr": 0x70,
            },
        )
        with self.assertRaises(ValueError):
            debug.startup_handles(header[:48])
        header[:8] = b"\0" * 8
        with self.assertRaises(ValueError):
            debug.startup_handles(header)

    def test_snapshot_reports_presence_only_after_complete_walk_and_frees_owners(self):
        job = debug.DebugJob.__new__(debug.DebugJob)
        job.snapshot_api = True
        job.handle_cleanup_errors = []
        calls = []
        entries = [0x60]

        def capture(process, flags, context, pointer):
            self.assertEqual((process, flags, context), (123, 0x14, 0))
            pointer._obj.value = 55
            return 0

        def marker(_allocator, pointer):
            pointer._obj.value = 66
            return 0

        def walk(_snapshot, kind, _marker, pointer, size):
            self.assertEqual((kind, size), (2, 136))
            if not entries:
                return 259
            value = pointer._obj
            value.handle = entries.pop()
            value.flags = 4
            value.attributes = 2
            value.access = 0x120089
            return 0

        job.kernel = types.SimpleNamespace(
            PssCaptureSnapshot=capture,
            PssWalkMarkerCreate=marker,
            PssWalkSnapshot=walk,
            PssWalkMarkerFree=lambda h: calls.append(("marker", h.value)) or 0,
            PssFreeSnapshot=lambda p, h: calls.append(("snapshot", p, h.value)) or 0,
            GetCurrentProcess=lambda: 999,
        )
        result = job.handle_snapshot(123, {0x60, 0x64})
        self.assertTrue(result["complete"])
        self.assertTrue(result["rows"]["0x60"]["present"])
        self.assertFalse(result["rows"]["0x64"]["present"])
        self.assertEqual(calls, [("marker", 66), ("snapshot", 999, 55)])

        def capture_failed(_process, _flags, _context, pointer):
            pointer._obj.value = 999  # Failed API outputs do not convey ownership.
            return 5

        calls.clear()
        job.kernel.PssCaptureSnapshot = capture_failed
        refused = job.handle_snapshot(123, {0x60})
        self.assertEqual(refused["captureStatus"], 5)
        self.assertFalse(refused["complete"])
        self.assertEqual(refused["rows"], {})
        self.assertEqual(calls, [])

        def marker_failed(_allocator, pointer):
            pointer._obj.value = 999
            return 8

        job.kernel.PssCaptureSnapshot = capture
        job.kernel.PssWalkMarkerCreate = marker_failed
        refused = job.handle_snapshot(123, {0x60})
        self.assertEqual(refused["markerStatus"], 8)
        self.assertEqual(calls, [("snapshot", 999, 55)])

    def test_character_handle_query_preserves_source_and_identifies_null_device(self):
        job = debug.DebugJob.__new__(debug.DebugJob)
        job.handle_cleanup_errors = []
        closed = []

        def duplicate(source, value, target, output, access, inherit, options):
            self.assertEqual(
                (source, value, target, access, inherit, options),
                (123, 0x60, 999, 0, False, 2),
            )
            output._obj.value = 77
            return 1

        def name_query(_handle, kind, data, _size, _needed):
            self.assertEqual(kind, 1)
            encoded = "\\Device\\Null".encode("utf-16-le")
            name = debug.UnicodeString.from_buffer(data)
            name.length = name.maximum = len(encoded)
            name.buffer = c.addressof(data) + 16
            c.memmove(name.buffer, encoded, len(encoded))
            return 0

        job.kernel = types.SimpleNamespace(
            GetCurrentProcess=lambda: 999,
            DuplicateHandle=duplicate,
            GetFileType=lambda _handle: 2,
            CloseHandle=lambda handle: closed.append(handle.value) or 1,
        )
        job.nt = types.SimpleNamespace(NtQueryObject=name_query)
        with (
            mock.patch.object(c, "set_last_error", create=True),
            mock.patch.object(c, "get_last_error", return_value=6, create=True),
        ):
            result = job.handle_type(123, 0x60)
            self.assertTrue(result["isNullDevice"])
            self.assertEqual(result["fileType"], 2)
            self.assertEqual(closed, [77])
            job.kernel.DuplicateHandle = lambda *_args: 0
            self.assertEqual(job.handle_type(123, 0x60)["duplicateError"], 6)
        self.assertFalse(job.handle_type(123, 0)["duplicateAttempted"])

    def test_handler_create_and_first_invalid_handle_recheck_same_original_values(self):
        fault = self.event(1)
        fault.data.exception.record.code = 0xC0000008
        second = self.event(1)
        second.data.exception.record.code = 0xC0000008
        second.data.exception.first = 0
        job = self.job([self.event(3), fault, second, self.event(5)])
        calls = []

        def observe(_process, _parent, _initial, stage, previous=()):
            calls.append((stage, list(previous)))
            return {"selectedValues": ["0x60", "0x64"]}

        job.observe_startup_handles = observe
        for _ in range(4):
            job.pump(0)
        self.assertEqual(calls, [("create", []), ("invalid-handle", [0x60, 0x64])])
        self.assertTrue(job.debug_complete)
        self.assertEqual(job.continued[1][2], debug.DBG_NOT_HANDLED)


if __name__ == "__main__":
    unittest.main()
