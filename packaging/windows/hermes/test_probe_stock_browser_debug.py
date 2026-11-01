# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import ctypes as c
import ast
import importlib.util
import io
import json
import struct
from pathlib import Path
import tempfile
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
    def test_renderer_packet_and_result_identity_boundaries(self):
        packet = debug.renderer_context_packet(
            0x12, 0x13, 8, 9, "1234", [(0x1000, 0x100, "ntdll.dll")]
        )
        self.assertEqual(
            packet,
            b"NEMOCLAW_RENDERER_CONTEXT_V1\n0x12 0x13 8 9 1234\n1\n0x1000 0x100 ntdll.dll\n",
        )
        for modules in [[(1, 1, "../escape")], [(1, 1, "x")] * 257]:
            with self.assertRaises(ValueError):
                debug.renderer_context_packet(1, 2, 8, 9, "1234", modules)
        expected = {"pid": 8, "tid": 9, "creationFiletime": "1234"}
        value = {
            "schemaVersion": 1,
            "classification": "owned-renderer-thread-context",
            "helperMachine": "0x8664",
            "requested": expected,
            "observed": {**expected, "threadProcessId": 8},
            "identityMatched": True,
            "stack": {
                "unwound": False,
                "readBytes": 8,
                "requestedBytes": 16,
                "candidates": [],
            },
        }
        self.assertIs(debug.context_result(value, expected), value)
        value["observed"]["creationFiletime"] = "1235"
        with self.assertRaises(ValueError):
            debug.context_result(value, expected)

    def test_renderer_first_chance_initial_thread_once_and_helper_failure_continues(
        self,
    ):
        job = self.job([])
        job.renderer_context = {"helper": {"path": "helper"}}
        job.renderer_context_deadline = 99
        job.renderer_context_threads = {
            (8, 9): {
                "handle": 42,
                "tid": 9,
                "creationFiletime": "1234",
                "createdSequence": 1,
                "threadCreatedSequence": 1,
                "initialThread": True,
            }
        }
        job.renderer_context_seen = set()
        job.renderer_context_observations = []
        job.renderer_context_helpers_closed = True
        process = {
            "handle": 41,
            "modules": {0x1000: {"size": 0x100, "name": "ntdll.dll"}},
            "loaderBreakpoint": True,
            "createdSequence": 1,
            "rendererContextIdentity": {
                "creationFiletime": "1234",
                "createdSequence": 1,
                "initialTid": 9,
            },
        }
        event = self.event(1)
        event.tid = 10
        event.data.exception.first = 1
        event.data.exception.record.code = 0xC0000008
        with mock.patch.object(
            debug,
            "invoke_renderer_context",
            return_value={"safeToContinue": False, "error": {"stage": "timeout"}},
        ) as call:
            self.assertIsNone(job.observe_renderer_context(event, process))
            event.tid = 9
            self.assertEqual(job.observe_renderer_context(event, process), 0)
            self.assertFalse(job.renderer_context_helpers_closed)
            self.assertIsNone(job.observe_renderer_context(event, process))
            self.assertEqual(call.call_count, 1)
        self.assertEqual(
            debug.exception_disposition(process, event.data.exception.record, True)[0],
            debug.DBG_NOT_HANDLED,
        )
        self.assertFalse(job.renderer_context_observations[0]["fatalExceptionProved"])
        job.kernel.CloseHandle = lambda handle: handle == 42
        job.close_renderer_thread(8)
        self.assertEqual(job.renderer_context_threads, {})

    def test_renderer_helper_owns_timeout_overflow_and_pre_resume_failure(self):
        class Child:
            def __init__(self):
                self.job = self.process = self.thread = None
                self.streams = []
                self.input = None
                self.pid = 99
                self.dead = False

            def create_job(self):
                self.job = 1

            def start(self, *_args):
                self.process, self.thread = 2, 3

                class ShortInput(io.BytesIO):
                    def write(self, data):
                        chunks.append(bytes(data[:3]))
                        return super().write(data[:3])

                self.input = ShortInput()
                self.streams = [
                    io.BytesIO(b"" if failure == "timeout" else b"x" * 17000),
                    io.BytesIO(),
                ]

            def assign(self):
                if failure is True:
                    raise ValueError("assign before resume")

            def resume(self):
                resumed.append(True)

            def wait(self, _timeout):
                return self.dead

            def active(self):
                return int(not self.dead and self.process is not None)

            def terminate(self, assigned):
                self.dead = True

            def exit_code(self):
                return 1

            def close(self, name):
                setattr(self, name, None)

        def duplicate(_a, _b, _c, pointer, rights, inherit, flags):
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = 20 + len(dups)
            dups.append((rights, inherit, flags))
            return 1

        for failure in (False, True, "timeout"):
            dups, resumed, closed, chunks = [], [], [], []
            kernel = types.SimpleNamespace(
                GetCurrentProcess=lambda: 1,
                DuplicateHandle=duplicate,
                CloseHandle=lambda h: closed.append(h) or 1,
            )
            with (
                mock.patch.object(debug, "ContextHelperJob", Child),
                mock.patch.object(
                    debug.owner,
                    "identity",
                    return_value={"bytes": 1, "sha256": "a" * 64},
                ),
            ):
                result = debug.invoke_renderer_context(
                    {"helper": {"path": "helper.exe", "bytes": 1, "sha256": "a" * 64}},
                    kernel,
                    8,
                    9,
                    8,
                    9,
                    "1234",
                    [],
                    debug.time.monotonic() + 1,
                )
            self.assertTrue(result["safeToContinue"], result)
            self.assertEqual(dups, [(0x1010, True, 0), (0x808, True, 0)])
            self.assertEqual(len(closed), 2)
            if failure is True:
                self.assertEqual(resumed, [])
                self.assertIn("assign", result["error"]["message"])
            else:
                if failure == "timeout":
                    self.assertTrue(result["timedOut"])
                else:
                    self.assertTrue(result["outputExceeded"])
                self.assertEqual(len(b"".join(chunks)), result["requestBytes"])

    def test_context_pipe_fd_failure_closes_transferred_fd(self):
        job = debug.ContextHelperJob.__new__(debug.ContextHelperJob)
        job.streams = []
        job.creation_flags = 4
        handles = iter([(1, 2), (3, 4), (5, 6)])
        closed = []
        job.api = types.SimpleNamespace(
            CreatePipe=lambda *_: next(handles),
            CloseHandle=lambda handle: closed.append(handle),
            CreateProcess=lambda *_: (10, 11, 12, 13),
        )
        startup = types.SimpleNamespace()
        fake_msvcrt = types.SimpleNamespace(open_osfhandle=lambda *_: 77)
        with (
            mock.patch.dict("sys.modules", {"msvcrt": fake_msvcrt}),
            mock.patch("subprocess.STARTUPINFO", return_value=startup, create=True),
            mock.patch("subprocess.STARTF_USESTDHANDLES", 256, create=True),
            mock.patch.object(debug.os, "set_handle_inheritable", create=True),
            mock.patch.object(debug.os, "O_BINARY", 0, create=True),
            mock.patch.object(debug.os, "fdopen", side_effect=OSError("fdopen")),
            mock.patch.object(debug.os, "close") as close_fd,
        ):
            with self.assertRaisesRegex(OSError, "fdopen"):
                job.start(["helper.exe"], {}, ".", [20, 21])
        close_fd.assert_called_once_with(77)
        self.assertEqual(job.process, 10)  # Parent still owns actual created process.
        self.assertCountEqual(closed, [1, 4, 6, 3, 5])

    def test_context_pid_reuse_never_overwrites_unclosed_thread(self):
        job = self.job([])
        job.renderer_context = {"chromePath": "C:\\chrome.exe"}
        job.renderer_context_threads = {
            (8, 9): {
                "handle": 42,
                "tid": 9,
                "creationFiletime": "1",
                "createdSequence": 1,
                "threadCreatedSequence": 1,
                "initialThread": True,
            }
        }
        job.kernel.CloseHandle = lambda handle: 0
        event = self.event(3)
        with mock.patch.object(debug.c, "get_last_error", return_value=6, create=True):
            record = job.retain_renderer_thread(event, {}, {"chromeRole": "renderer"})
        self.assertFalse(record["retained"])
        self.assertEqual(job.renderer_context_threads[(8, 9)]["handle"], 42)
        self.assertEqual(job.handle_cleanup_errors[0]["win32Error"], 6)

    def test_noninitial_second_chance_uses_event_handle_and_forwards_then_closes(self):
        create = self.event(2)
        create.tid = 10
        create.data.thread.thread = 77  # Borrowed CREATE_THREAD handle.
        fault = self.event(1)
        fault.tid = 10
        fault.data.exception.record.code = 0xC0000008
        fault.data.exception.record.flags = 0x88
        fault.data.exception.record.address = 0x1080
        fault.data.exception.first = 0
        thread_exit = self.event(4)
        thread_exit.tid = 10
        process_exit = self.event(5)
        events = [create, fault, fault, thread_exit, process_exit]
        job = self.job(events)
        job.event_count = 1
        job.saw_process = True
        job.live_debug_pids = {8}
        job.renderer_context = {"helper": {"path": "helper"}}
        job.renderer_context_deadline = 99
        job.renderer_context_seen = set()
        job.renderer_context_observations = []
        job.renderer_context_threads_total = 1
        job.renderer_context_thread_limit_hits = 0
        job.renderer_context_helpers_closed = True
        job.renderer_context_threads = {
            (8, 9): {
                "handle": 42,
                "tid": 9,
                "creationFiletime": "1234",
                "createdSequence": 1,
                "threadCreatedSequence": 1,
                "initialThread": True,
            }
        }
        job.processes[8] = {
            "handle": 41,
            "modules": {0x1000: {"size": 0x100, "name": "ntdll.dll"}},
            "createdSequence": 1,
            "loaderBreakpoint": True,
            "chromeRole": "renderer",
            "rendererContextIdentity": {
                "createdSequence": 1,
                "creationFiletime": "1234",
                "initialTid": 9,
            },
        }
        duplicated, closed = [], []

        def duplicate(current, borrowed, target, pointer, access, inherit, flags):
            duplicated.append((borrowed, access, inherit, flags))
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = 100
            return 1

        job.kernel.GetCurrentProcess = lambda: 1
        job.kernel.DuplicateHandle = duplicate
        job.kernel.CloseHandle = lambda handle: closed.append(handle) or 1
        with mock.patch.object(
            debug,
            "invoke_renderer_context",
            side_effect=lambda *_args: {"safeToContinue": True},
        ) as capture:
            for _ in range(5):
                job.pump()
        self.assertEqual(duplicated, [(77, 0x808, False, 0)])
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(capture.call_args.args[2:7], (41, 100, 8, 10, "1234"))
        self.assertEqual(closed, [100, 42])
        self.assertNotIn(77, closed)
        self.assertEqual(job.renderer_context_threads, {})
        observation = job.renderer_context_observations[0]
        self.assertFalse(observation["firstChance"])
        self.assertFalse(observation["initialThread"])
        self.assertEqual(observation["processCreationSequence"], 1)
        self.assertEqual(observation["threadCreationSequence"], 2)
        self.assertEqual(job.continued[1:3], [(8, 10, debug.DBG_NOT_HANDLED)] * 2)
        self.assertEqual(
            len([e for e in job.events if "rendererContextThreadClosures" in e]), 2
        )
        self.assertEqual(job.observation_errors, [])

    def test_renderer_thread_generation_phase_limits_and_unbound_refusal(self):
        job = self.job([])
        job.renderer_context = {"helper": {"path": "helper"}}
        job.renderer_context_deadline = 99
        job.renderer_context_seen = set()
        job.renderer_context_observations = []
        job.renderer_context_helpers_closed = True
        job.renderer_context_threads = {}
        job.renderer_context_threads_total = 0
        job.renderer_context_thread_limit_hits = 0
        process = {
            "handle": 41,
            "modules": {},
            "createdSequence": 1,
            "rendererContextIdentity": {
                "createdSequence": 1,
                "creationFiletime": "1234",
                "initialTid": 9,
            },
        }
        calls, closed = [], []

        def duplicate(_a, borrowed, _b, pointer, rights, inherit, flags):
            calls.append((borrowed, rights, inherit, flags))
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = 100 + len(calls)
            return 1

        job.kernel.GetCurrentProcess = lambda: 1
        job.kernel.DuplicateHandle = duplicate
        job.kernel.CloseHandle = lambda handle: closed.append(handle) or 1
        event = self.event(2)
        event.tid = 10
        self.assertIsNone(
            job.retain_context_thread_handle(event, {"createdSequence": 1}, 77, False)
        )
        self.assertEqual(calls, [])
        with (
            mock.patch.object(debug, "MAX_RENDERER_THREADS_LIVE", 1),
            mock.patch.object(debug, "MAX_RENDERER_THREADS_TOTAL", 2),
        ):
            job.event_count = 2
            self.assertTrue(
                job.retain_context_thread_handle(event, process, 77, False)["retained"]
            )
            event.tid = 11
            self.assertFalse(
                job.retain_context_thread_handle(event, process, 78, False)["retained"]
            )
            event.tid = 10
            job.event_count = 3
            self.assertTrue(
                job.retain_context_thread_handle(event, process, 79, False)["retained"]
            )
            self.assertEqual(closed, [101])  # Old TID generation released first.
            self.assertEqual(
                job.renderer_context_threads[(8, 10)]["threadCreatedSequence"], 3
            )
            job.close_renderer_thread(8, 10)
            self.assertFalse(
                job.retain_context_thread_handle(event, process, 80, False)["retained"]
            )
        self.assertEqual(len(calls), 2)
        self.assertEqual(job.renderer_context_thread_limit_hits, 2)
        job.renderer_context_threads[(8, 10)] = {
            "handle": 103,
            "tid": 10,
            "creationFiletime": "1234",
            "createdSequence": 1,
            "threadCreatedSequence": 4,
            "initialThread": False,
        }
        event.kind = 1
        event.data.exception.record.code = 0xC0000008
        with mock.patch.object(
            debug,
            "invoke_renderer_context",
            side_effect=lambda *_args: {"safeToContinue": True},
        ) as capture:
            for phase in (1, 0, 0):
                event.data.exception.first = phase
                job.observe_renderer_context(event, process)
            self.assertEqual(capture.call_count, 2)
            self.assertEqual(
                [x["firstChance"] for x in job.renderer_context_observations],
                [True, False],
            )
            # Changing process generation cannot consume the held old thread.
            self.assertIsNone(
                job.observe_renderer_context(event, {**process, "createdSequence": 2})
            )
            job.renderer_context_seen.update({("extra", 1), ("extra", 2)})
            job.renderer_context_threads[(8, 10)]["threadCreatedSequence"] = 5
            self.assertIsNone(job.observe_renderer_context(event, process))
            self.assertEqual(capture.call_count, 2)
        job.close_renderer_thread(8)
        self.assertEqual(job.renderer_context_threads, {})

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
        self.assertEqual(
            run({**request, "mode": "personal-job-only"}, policy, proof),
            ([request["executor"], "policy.json", "--log-file", "native.log"], state),
        )
        for invalid in (
            {**request, "mode": None},
            {**request, "mode": "stock-job-only"},
            {
                **request,
                "mode": "personal-job-only",
                "classification": "stock-MXC-browser-debug-request",
            },
        ):
            with self.assertRaisesRegex(ValueError, "full Personal request"):
                run(invalid, policy, proof)
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
            for mode in ({}, {"mode": "personal-job-only"}):
                with self.assertRaises(ValueError):
                    run({**value, **mode}, body, native_proof)

    def test_native_pointer_structures_match_the_64_bit_debug_event_contract(self):
        self.assertEqual(c.sizeof(debug.ThreadInfo), 24)
        self.assertEqual(debug.ThreadInfo.thread.offset, 0)
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
                "job_only": False,
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

    def test_personal_job_only_uses_plain_owner_and_retains_cleanup_failures(self):
        for failure in (None, "query", "close"):
            trace = []

            class Native:
                creation_flags = debug.owner.WindowsJob.creation_flags
                process = job = thread = None
                pid = 9
                streams = []

                def query(self, handle, kind, pointer, size, needed):
                    self_test.assertEqual(handle, self.job)
                    trace.append(("query", kind, size))
                    if failure == "query":
                        return 0
                    info_type = c.c_uint32 if kind == 4 else debug.owner.ExtendedLimits
                    self_test.assertEqual(size, c.sizeof(info_type))
                    info = c.cast(pointer, c.POINTER(info_type)).contents
                    if kind == 4:
                        info.value = 0
                    else:
                        info.basic.flags = 0x2000
                    c.cast(needed, c.POINTER(c.c_uint32))[0] = size
                    return 1

                def create_job(self):
                    self.job = 1
                    self.kernel = types.SimpleNamespace(
                        QueryInformationJobObject=self.query
                    )

                def start(self, *_args):
                    trace.append("start")
                    self.process, self.thread = 2, 3
                    self.streams = [
                        io.BytesIO(b"full workload"),
                        io.BytesIO(b"original failure"),
                    ]

                def assign(self):
                    trace.append("assign")

                def resume(self):
                    trace.append("resume")

                def wait(self, milliseconds):
                    return True

                def active(self):
                    return 0

                def exit_code(self):
                    return 1

                def close(self, name):
                    trace.append("close-" + name)
                    if failure == "close" and name == "job":
                        raise RuntimeError("owned job close failed")
                    setattr(self, name, None)

            self_test = self
            native = Native()
            with tempfile.TemporaryDirectory() as directory:
                request_path, output = (
                    Path(directory) / "request.json",
                    Path(directory) / "result.json",
                )
                request_path.write_text(
                    json.dumps(
                        {
                            "classification": "personal-MXC-browser-debug-request",
                            "mode": "personal-job-only",
                            "nonce": "a" * 24,
                            "policySha256": "b" * 64,
                            "environment": {},
                        }
                    )
                )
                with (
                    mock.patch(
                        "sys.argv",
                        [
                            debug.__file__,
                            "--request",
                            str(request_path),
                            "--output",
                            str(output),
                        ],
                    ),
                    mock.patch.object(
                        debug,
                        "os",
                        types.SimpleNamespace(
                            name="nt", environ={"GITHUB_ACTIONS": "true"}
                        ),
                    ),
                    mock.patch.object(
                        debug.owner, "WindowsJob", return_value=native
                    ) as constructor,
                    mock.patch.object(
                        debug,
                        "DebugJob",
                        side_effect=AssertionError("debugger constructed"),
                    ),
                    mock.patch.object(
                        debug,
                        "validate",
                        return_value=(["executor", "policy"], "state"),
                    ),
                    mock.patch.object(
                        debug.owner, "identity", return_value={"sha256": "c" * 64}
                    ),
                    mock.patch.object(
                        debug.c, "get_last_error", return_value=5, create=True
                    ),
                    mock.patch("sys.stdout", io.StringIO()),
                ):
                    self.assertEqual(debug.main(), 1 if failure == "close" else 0)
                constructor.assert_called_once_with()
                result = json.loads(output.read_text())
            self.assertEqual(trace[2:5], ["start", "assign", "resume"])
            self.assertEqual(
                result["classification"], "owned-Personal-job-only-diagnostic"
            )
            self.assertFalse(result["debuggerMayChangeBehavior"])
            self.assertFalse(result["debugEventsCollected"])
            self.assertTrue(result["childrenClosed"])
            self.assertEqual(result["cleanupComplete"], failure != "close")
            self.assertEqual(result["execution"]["exitCode"], 1)
            self.assertEqual(result["execution"]["stderr"], "original failure")
            self.assertEqual(
                result["captureLimits"], {"stdout": 65536, "stderr": 327680}
            )
            self.assertEqual(result["ownedJob"]["creationFlags"], 0x08000004)
            for key, flags in (("uiRestrictions", 0), ("extendedLimits", 0x2000)):
                self.assertEqual(
                    result["ownedJob"][key]["complete"], failure != "query"
                )
                self.assertEqual(
                    result["ownedJob"][key]["flags"],
                    None if failure == "query" else flags,
                )
            for key in (
                "events",
                "eventHistory",
                "firstUnhandledException",
                "remainingDebugProcesses",
                "reconciledDebugProcessExits",
            ):
                self.assertNotIn(key, result)

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
