# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import ast
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import types
import unittest
import unittest.mock as mock

spec = importlib.util.spec_from_file_location(
    "gate", Path(__file__).with_name("renderer-aedebug-gate.py")
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def config():
    root = r"C:\NemoClawRendererPostmortem-0123456789ab"
    identity = {"path": r"C:\tools\python.exe", "bytes": 100, "sha256": gate.PYTHON_SHA}
    return {
        "schemaVersion": 1,
        "classification": "renderer-postmortem-gate-config",
        "sourceRevision": "a" * 40,
        "nonce": "0123456789ab",
        "root": root,
        "deadlineMs": 20000,
        "expectedAppContainerSid": "S-1-15-2-1-2-3-4-5-6-7",
        "pythonIdentity": identity,
        "chromeIdentity": {
            "path": r"C:\NemoClawHermesProbe-274d797050ea\browsers\chromium-1234\chrome-win64\chrome.exe",
            "bytes": 4024832,
            "sha256": gate.CHROME_SHA,
            "volumeSerialHex": "0x1234",
            "fileIdHex": "1" * 32,
        },
        "cdbIdentity": {
            **identity,
            "path": r"C:\Program Files (x86)\Windows Kits\10\Debuggers\arm64\cdb.exe",
            "machine": 0xAA64,
        },
        "ownerIdentity": {**identity, "path": root + r"\probe-host-browser.py"},
    }


class FakeJob:
    def __init__(self, *, mode="success", stdout=b"Dump complete\n", stderr=b""):
        self.mode = mode
        self.process = self.thread = self.job = self.pid = None
        self.streams = []
        self.output = stdout, stderr
        self.calls = []
        self.dead = False

    def create_job(self):
        self.calls.append("create")
        self.job = 1

    def start(self, command, environment, cwd):
        self.calls.append("start")
        self.process, self.thread, self.pid = 2, 3, 4
        self.streams = [io.BytesIO(value) for value in self.output]
        if self.mode == "partial-start":
            raise OSError("pipe setup failed after process creation")

    def assign(self):
        self.calls.append("assign")

    def resume(self):
        self.calls.append("resume")
        if self.mode in ("success", "nonzero"):
            self.dead = True

    def wait(self, ms):
        return self.dead

    def exit_code(self):
        return 7 if self.mode == "nonzero" else 0

    def active(self):
        return 0 if self.dead else int(self.process is not None)

    def terminate(self, assigned):
        self.calls.append(("terminate", assigned))
        self.dead = True

    def close(self, name):
        self.calls.append(("close", name))
        setattr(self, name, None)


class GateControls(unittest.TestCase):
    def test_fixed_config_and_argv(self):
        value = config()
        self.assertIs(gate.validate_config(value, value["root"], value["nonce"]), value)
        command, prefix = gate.cdb_command(value, 17, 0x1234, "5678")
        self.assertEqual(command[1:5], ["-pv", "-p", "17", "-c"])
        self.assertEqual(command[5], f'.dump /m /j 0x1234 /u "{prefix}.dmp"; qd')
        self.assertEqual(prefix, value["root"] + r"\dumps\renderer-17-5678")
        for key, bad in [
            ("deadlineMs", 20001),
            ("expectedAppContainerSid", "S-1-15-2-1"),
            ("nonce", "f" * 12),
        ]:
            changed = copy.deepcopy(value)
            changed[key] = bad
            with self.assertRaises(ValueError):
                gate.validate_config(changed, value["root"], value["nonce"])
        for field in ["chromeIdentity", "pythonIdentity"]:
            changed = copy.deepcopy(value)
            changed[field]["sha256"] = "f" * 64
            with self.assertRaises(ValueError):
                gate.validate_config(changed, value["root"], value["nonce"])
        for text in ["0", "-1", "1;qd", "0xffffffffffffffff"]:
            with self.assertRaises(ValueError):
                gate.integer(text)
        self.assertEqual(gate.integer("0x12"), 18)
        self.assertEqual(gate.jit_address("0000000000000012"), 18)
        self.assertEqual(gate.jit_address("0x12"), 18)

    def test_dump_discovery_keeps_extensionless_prefix_and_exact_parser_bound(self):
        self.assertEqual(gate.MAX_DUMP_BYTES, 16 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory) / "renderer-17-5678"
            for suffix, size in [
                ("_one.dmp", gate.MAX_DUMP_BYTES),
                ("_two.dmp", gate.MAX_DUMP_BYTES + 1),
            ]:
                with Path(str(prefix) + suffix).open("xb") as stream:
                    stream.truncate(size)
            rows = {row["name"]: row for row in gate.dumps_for(str(prefix))}
            self.assertTrue(rows[prefix.name + "_one.dmp"]["withinParserBound"])
            self.assertFalse(rows[prefix.name + "_two.dmp"]["withinParserBound"])

    def test_exact_role_generation_and_sandbox_admission_fail_closed(self):
        value = config()

        def fake():
            result = mock.Mock()
            result.process.return_value = 12
            result.generation.return_value = "54321"
            result.image.return_value = value["chromeIdentity"]["path"].upper()
            result.live.return_value = True
            result.role.return_value = {"type": "renderer"}
            result.sandbox.return_value = {
                "appContainerSid": value["expectedAppContainerSid"],
                "isProcessInAJob": True,
                "exactMxcJobHandleVerified": False,
            }
            return result

        native, row = fake(), {}
        self.assertEqual(gate.admit_renderer(native, value, 17, row), (12, "54321"))
        native.sandbox.assert_called_once_with(12, value["expectedAppContainerSid"])
        self.assertFalse(row["sandbox"]["exactMxcJobHandleVerified"])
        for field, result in [("image", r"C:\other\chrome.exe"), ("live", False)]:
            native = fake()
            getattr(native, field).return_value = result
            with self.assertRaises(ValueError):
                gate.admit_renderer(native, value, 17, {})
            native.role.assert_not_called()
        native = fake()
        native.generation.side_effect = ["54321", "54322"]
        with self.assertRaises(ValueError):
            gate.admit_renderer(native, value, 17, {})
        for method in ["role", "sandbox"]:
            native = fake()
            getattr(native, method).side_effect = ValueError("identity differs")
            with self.assertRaisesRegex(ValueError, "identity differs"):
                gate.admit_renderer(native, value, 17, {})

    def test_cdb_success_nonzero_and_actual_ownership_order(self):
        for mode in ["success", "nonzero"]:
            native = FakeJob(mode=mode)
            row = gate.run_cdb(["cdb"], {}, ".", native, gate.time.monotonic() + 10)
            self.assertEqual(native.calls[:4], ["create", "start", "assign", "resume"])
            self.assertTrue(row["childrenClosed"])
            self.assertTrue(row["captureClosed"])
            self.assertEqual(row["stdout"], "Dump complete\n")
            self.assertEqual(row["operationSucceeded"], mode == "success")
            self.assertNotIn(
                "terminate", [x for x in native.calls if isinstance(x, str)]
            )

    def test_timeout_and_overflow_close_only_owned_cdb_job(self):
        for mode, output in [
            ("timeout", b""),
            ("overflow", b"x" * (gate.CAPTURE_BYTES + 1)),
        ]:
            native = FakeJob(mode=mode, stdout=output)
            ticks = iter([0, 8, 8, 8, 8, 8])
            row = gate.run_cdb(
                ["cdb"], {}, ".", native, 10, clock=lambda: next(ticks, 8)
            )
            self.assertIn(("terminate", True), native.calls)
            self.assertTrue(row["childrenClosed"])
            self.assertFalse(row["operationSucceeded"])
            self.assertLessEqual(len(row["stdout"]), gate.CAPTURE_BYTES)
            self.assertTrue(row["timedOut"] or row["outputExceeded"])

    def test_partial_start_preserves_error_and_closes_created_process(self):
        native = FakeJob(mode="partial-start")
        row = gate.run_cdb(["cdb"], {}, ".", native, gate.time.monotonic() + 10)
        self.assertTrue(row["started"])
        self.assertFalse(row["resumed"])
        self.assertIn(("terminate", False), native.calls)
        self.assertTrue(row["childrenClosed"])
        self.assertEqual(row["error"]["stage"], "start-suspended-cdb")
        self.assertIn("pipe setup failed", row["error"]["message"])
        self.assertFalse(row["operationSucceeded"])

    def test_fd_transfer_failure_closes_owned_descriptor_and_excludes_event(self):
        api = mock.Mock()
        api.CreatePipe.side_effect = [(1, 2), (3, 4), (5, 6)]
        api.CreateProcess.return_value = (100, 101, 102, 103)
        native = gate.job_class(types.SimpleNamespace(WindowsJob=object))()
        native.api, native.creation_flags, native.streams = api, 4, []
        msvcrt = types.SimpleNamespace(open_osfhandle=mock.Mock(return_value=44))
        with (
            mock.patch.dict(gate.sys.modules, {"msvcrt": msvcrt}),
            mock.patch.object(
                gate.subprocess,
                "STARTUPINFO",
                create=True,
                return_value=types.SimpleNamespace(),
            ),
            mock.patch.object(
                gate.subprocess, "STARTF_USESTDHANDLES", 256, create=True
            ),
            mock.patch.object(gate.os, "set_handle_inheritable", create=True),
            mock.patch.object(gate.os, "O_BINARY", 0, create=True),
            mock.patch.object(gate.os, "fdopen", side_effect=OSError("fdopen failed")),
            mock.patch.object(gate.os, "close") as close,
        ):
            with self.assertRaisesRegex(OSError, "fdopen failed"):
                native.start(["cdb"], {}, ".")
        close.assert_called_once_with(44)
        self.assertEqual(native.process, 100)
        self.assertEqual(native.pid, 102)
        startup = api.CreateProcess.call_args.args[-1]
        self.assertEqual(startup.lpAttributeList, {"handle_list": [1, 4, 6]})
        self.assertCountEqual(
            [call.args[0] for call in api.CloseHandle.call_args_list], [2, 1, 4, 6, 5]
        )

    def test_capture_error_preserves_partial_failure_with_known_pipe_closure(self):
        class BadRead(io.BytesIO):
            def read(self, size):
                raise OSError("capture failed")

        native = FakeJob()
        original_start = native.start

        def start(*args):
            original_start(*args)
            native.streams[0].close()
            native.streams[0] = BadRead()

        native.start = start
        row = gate.run_cdb(["cdb"], {}, ".", native, gate.time.monotonic() + 10)
        self.assertTrue(row["childrenClosed"])
        self.assertTrue(row["captureClosed"])
        self.assertFalse(row["operationSucceeded"])
        self.assertEqual(row["captureErrors"][0]["message"], "capture failed")

    def test_input_size_link_and_receipt_exclusive_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_bytes(b"abcd")
            self.assertEqual(gate.read_bounded(path, 4), b"abcd")
            with self.assertRaises(ValueError):
                gate.read_bounded(path, 3)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                gate.read_bounded(link, 4)
            receipt = Path(directory) / "receipt.json"
            gate.save_new(receipt, {"a": 1})
            with self.assertRaises(FileExistsError):
                gate.save_new(receipt, {"a": 2})

    def test_four_exclusive_capture_slots_preserve_owner_generations(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "reports").mkdir()
            value = {**config(), "root": directory}
            host = {"pid": 11, "creationFiletime": "1234", "image": "python"}
            target = {"pid": 12, "creationFiletime": "5678"}
            for index in range(4):
                claim = gate.claim_capture(value, host, target)
                self.assertEqual(claim["slot"], index)
                row = gate.json.loads(
                    (Path(directory) / "reports" / claim["name"]).read_text()
                )
                self.assertEqual(row["host"], host)
                self.assertEqual(row["target"], target)
                self.assertFalse(row["captureExecuted"])
            before = {
                path.name: path.read_bytes()
                for path in (Path(directory) / "reports").iterdir()
            }
            with self.assertRaisesRegex(ValueError, "four owned"):
                gate.claim_capture(value, host, target)
            self.assertEqual(
                before,
                {
                    path.name: path.read_bytes()
                    for path in (Path(directory) / "reports").iterdir()
                },
            )

    def test_no_target_controls_and_event_never_forwarded_or_waited(self):
        source = Path(gate.__file__).read_text()
        tree = ast.parse(source)
        calls = [
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        ]
        for forbidden in [
            "SetEvent",
            "ResetEvent",
            "DebugActiveProcess",
            "DebugActiveProcessStop",
            "OpenThread",
            "WriteProcessMemory",
            "SetThreadContext",
            "AdjustTokenPrivileges",
        ]:
            self.assertNotIn(forbidden, calls)
        self.assertNotIn('"-g"', source)
        self.assertIn('startup.lpAttributeList = {"handle_list": inherited}', source)
        self.assertIn('"NtQueryEvent"', source)
        self.assertNotIn(
            "WaitForSingleObject(handle",
            source[source.index("    def event(") : source.index("    def role(")],
        )
        with mock.patch.dict(
            gate.os.environ,
            {
                "SystemRoot": r"C:\Windows",
                "_NT_SYMBOL_PATH": "secret",
                "TOKEN": "secret",
            },
            clear=True,
        ):
            environment = gate.cdb_environment(config())
        self.assertNotIn("TOKEN", environment)
        self.assertNotIn("_NT_SYMBOL_PATH", environment)
        native = object.__new__(gate.Windows)
        native.k = types.SimpleNamespace(GetHandleInformation=mock.Mock(return_value=1))
        native.n = types.SimpleNamespace(
            NtQueryObject=mock.Mock(return_value=0),
            NtQueryEvent=mock.Mock(return_value=-1073741790),
        )
        native.unicode = mock.Mock(return_value="Event")
        row = native.event(123)
        self.assertEqual(row["stateQueryStatus"], "0xc0000022")
        self.assertIsNone(row["state"])
        self.assertFalse(row["stateAvailable"])
        self.assertFalse(row["signaledByGate"])

        def event_state(handle, kind, info, size, used):
            info[0], info[1] = 0, 0
            return 0

        native.n.NtQueryEvent.side_effect = event_state
        self.assertEqual(native.event(123)["state"], 0)

        def signaled(handle, kind, info, size, used):
            info[0], info[1] = 0, 1
            return 0

        native.n.NtQueryEvent.side_effect = signaled
        with self.assertRaisesRegex(ValueError, "already signaled"):
            native.event(123)
        native.n.NtQueryEvent.side_effect = None
        native.n.NtQueryEvent.return_value = -1073741816
        with self.assertRaisesRegex(ValueError, "state query failed"):
            native.event(123)
        native.unicode.return_value = "File"
        native.n.NtQueryEvent.reset_mock()
        with self.assertRaisesRegex(ValueError, "not an event"):
            native.event(123)
        native.n.NtQueryEvent.assert_not_called()


if __name__ == "__main__":
    unittest.main()
