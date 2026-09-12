# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import ctypes as c
import importlib.util
import io
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
    def test_native_pointer_structures_match_the_64_bit_debug_event_contract(self):
        self.assertEqual(c.sizeof(debug.ExceptionRecord), 152)
        self.assertEqual(c.sizeof(debug.ExceptionInfo), 160)
        self.assertEqual(c.sizeof(debug.DebugEvent), 176)
        self.assertEqual(debug.DebugEvent.data.offset, 16)
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
        job.observation_errors = []
        job.chrome_seen = False
        job.appcontainer_seen = False
        job.last_fault = job.first_fault = job.first_unhandled = None
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
        self.assertEqual(len(job.observation_errors), 1)
        self.assertEqual(job.first_fault["code"], "0xc0000409")

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
            events = []
            observation_errors = []
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


if __name__ == "__main__":
    unittest.main()
