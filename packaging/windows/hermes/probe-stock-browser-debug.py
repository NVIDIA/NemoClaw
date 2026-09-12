# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Observe one pinned stock-MXC browser tree through Windows DEBUG_PROCESS events."""

import argparse
import ctypes as c
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
import struct
import threading
import time

spec = importlib.util.spec_from_file_location(
    "browser_job_owner", Path(__file__).with_name("probe-host-browser.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

STOCK_SHA = "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503"
DBG_CONTINUE = 0x10002
DBG_NOT_HANDLED = 0x80010001
MAX_EVENTS = 8192
MAX_PROCESSES = 128
MAX_MODULES = 1024


class ExceptionRecord(c.Structure):
    _fields_ = [
        ("code", c.c_uint32),
        ("flags", c.c_uint32),
        ("nested", c.c_void_p),
        ("address", c.c_void_p),
        ("count", c.c_uint32),
        ("information", c.c_size_t * 15),
    ]


class ExceptionInfo(c.Structure):
    _fields_ = [("record", ExceptionRecord), ("first", c.c_uint32)]


class ProcessInfo(c.Structure):
    _fields_ = [
        ("file", c.c_void_p),
        ("process", c.c_void_p),
        ("thread", c.c_void_p),
        ("base", c.c_void_p),
        ("debug_offset", c.c_uint32),
        ("debug_size", c.c_uint32),
        ("tls", c.c_void_p),
        ("start", c.c_void_p),
        ("name", c.c_void_p),
        ("unicode", c.c_uint16),
    ]


class LoadInfo(c.Structure):
    _fields_ = [
        ("file", c.c_void_p),
        ("base", c.c_void_p),
        ("debug_offset", c.c_uint32),
        ("debug_size", c.c_uint32),
        ("name", c.c_void_p),
        ("unicode", c.c_uint16),
    ]


class EventData(c.Union):
    _fields_ = [
        ("exception", ExceptionInfo),
        ("process", ProcessInfo),
        ("dll", LoadInfo),
        ("exit_code", c.c_uint32),
        ("unload_base", c.c_void_p),
    ]


class DebugEvent(c.Structure):
    _fields_ = [
        ("kind", c.c_uint32),
        ("pid", c.c_uint32),
        ("tid", c.c_uint32),
        ("data", EventData),
    ]


class ProcessBasic(c.Structure):
    _fields_ = [
        ("exit_status", c.c_int32),
        ("peb", c.c_void_p),
        ("affinity", c.c_size_t),
        ("priority", c.c_int32),
        ("pid", c.c_size_t),
        ("parent", c.c_size_t),
    ]


class UnicodeString(c.Structure):
    _fields_ = [("length", c.c_uint16), ("maximum", c.c_uint16), ("buffer", c.c_void_p)]


def mapped_address(modules, address):
    for base, image in modules.items():
        if image.get("size") and base <= address < base + image["size"]:
            return {
                "module": image["name"],
                "moduleBase": hex(base),
                "rva": hex(address - base),
            }
    return {"module": None, "moduleBase": None, "rva": None}


def exception_disposition(process, record, first):
    location = mapped_address(process["modules"], record.address or 0)
    # Only the first system-loader breakpoint in ntdll is continued as handled.
    # All application exceptions, including later breakpoints, reach their SEH.
    initial = bool(
        first
        and record.code == 0x80000003
        and not process["loaderBreakpoint"]
        and (location["module"] or "").lower() == "ntdll.dll"
    )
    if initial:
        process["loaderBreakpoint"] = True
    return DBG_CONTINUE if initial else DBG_NOT_HANDLED, initial, location


class DebugJob(owner.WindowsJob):
    creation_flags = (
        owner.WindowsJob.creation_flags | 1
    )  # DEBUG_PROCESS, no DEBUG_ONLY_THIS_PROCESS.

    def __init__(self):
        super().__init__()
        self.creating_thread = threading.get_ident()
        self.processes = {}
        self.live_debug_pids = set()
        self.events = []
        self.event_count = 0
        self.observation_errors = []
        self.debug_started = False
        self.saw_process = False
        self.debug_complete = False
        self.chrome_seen = False
        self.appcontainer_seen = False
        self.last_fault = None
        self.first_fault = None
        self.first_unhandled = None
        k = self.kernel
        declarations = {
            "WaitForDebugEventEx": ([c.POINTER(DebugEvent), c.c_uint32], c.c_int),
            "ContinueDebugEvent": ([c.c_uint32, c.c_uint32, c.c_uint32], c.c_int),
            "GetFinalPathNameByHandleW": (
                [c.c_void_p, c.c_wchar_p, c.c_uint32, c.c_uint32],
                c.c_uint32,
            ),
            "K32GetMappedFileNameW": (
                [c.c_void_p, c.c_void_p, c.c_wchar_p, c.c_uint32],
                c.c_uint32,
            ),
            "ReadProcessMemory": (
                [c.c_void_p, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)],
                c.c_int,
            ),
            "GetProcessTimes": ([c.c_void_p, *([c.POINTER(c.c_uint64)] * 4)], c.c_int),
        }
        for name, (args, result) in declarations.items():
            f = getattr(k, name)
            f.argtypes = args
            f.restype = result
        self.nt = c.WinDLL("ntdll")
        self.nt.NtQueryInformationProcess.argtypes = [
            c.c_void_p,
            c.c_uint32,
            c.c_void_p,
            c.c_uint32,
            c.POINTER(c.c_uint32),
        ]
        self.nt.NtQueryInformationProcess.restype = c.c_int32
        self.adv = c.WinDLL("advapi32", use_last_error=True)
        self.adv.OpenProcessToken.argtypes = [
            c.c_void_p,
            c.c_uint32,
            c.POINTER(c.c_void_p),
        ]
        self.adv.OpenProcessToken.restype = c.c_int
        self.adv.GetTokenInformation.argtypes = [
            c.c_void_p,
            c.c_uint32,
            c.c_void_p,
            c.c_uint32,
            c.POINTER(c.c_uint32),
        ]
        self.adv.GetTokenInformation.restype = c.c_int

    def start(self, *args):
        try:
            super().start(*args)
        finally:
            self.debug_started = self.process is not None

    def image(self, handle, base, process):
        value = {"base": hex(base or 0), "name": None, "size": None, "machine": None}
        try:
            path = c.create_unicode_buffer(2048)
            count = (
                self.kernel.GetFinalPathNameByHandleW(handle, path, len(path), 0)
                if handle
                else self.kernel.K32GetMappedFileNameW(process, base, path, len(path))
            )
            if 0 < count < len(path):
                value["name"] = PureWindowsPath(path.value).name
            data = c.create_string_buffer(4096)
            # Read only the mapped PE header. The loader image handle is used
            # for its name, never for I/O that could move a shared file pointer.
            read = c.c_size_t()
            self.checked(
                self.kernel.ReadProcessMemory(
                    process, base, data, len(data), c.byref(read)
                )
            )
            raw = data.raw[: read.value]
            offset = struct.unpack_from("<I", raw, 60)[0]
            owner.require(
                raw[:2] == b"MZ"
                and offset <= len(raw) - 84
                and raw[offset : offset + 4] == b"PE\0\0",
                "Invalid debug image header",
            )
            value["machine"] = hex(struct.unpack_from("<H", raw, offset + 4)[0])
            value["size"] = struct.unpack_from("<I", raw, offset + 80)[0]
        except Exception as error:
            value["error"] = owner.detail(error)
        finally:
            # Image handles belong to this debugger. Event process/thread
            # handles are OS-owned and close only after their continued EXIT.
            if handle:
                self.checked(self.kernel.CloseHandle(handle))
        return value

    def process_metadata(self, handle):
        basic = ProcessBasic()
        needed = c.c_uint32()
        status = self.nt.NtQueryInformationProcess(
            handle, 0, c.byref(basic), c.sizeof(basic), c.byref(needed)
        )
        value = {
            "parentQueryStatus": hex(status & 0xFFFFFFFF),
            "parentPid": basic.parent if status == 0 else None,
        }
        times = [c.c_uint64() for _ in range(4)]
        if self.kernel.GetProcessTimes(handle, *(c.byref(t) for t in times)):
            value["creationFiletime"] = str(times[0].value)
        else:
            value["creationTimeError"] = c.get_last_error()
        member = c.c_int()
        self.checked(self.kernel.IsProcessInJob(handle, self.job, c.byref(member)))
        owner.require(
            member.value != 0, "A debug process is outside the exact owned job"
        )
        value["ownedJobMember"] = True
        token = c.c_void_p()
        if self.adv.OpenProcessToken(handle, 8, c.byref(token)):
            try:
                app = c.c_uint32()
                if self.adv.GetTokenInformation(
                    token, 29, c.byref(app), c.sizeof(app), c.byref(needed)
                ):
                    value["isAppContainer"] = bool(app.value)
                    self.appcontainer_seen |= bool(app.value)
                else:
                    value["tokenQueryError"] = c.get_last_error()
            finally:
                self.checked(self.kernel.CloseHandle(token))
        else:
            value["tokenOpenError"] = c.get_last_error()
        # Query-only bounded command metadata on the handle supplied by the
        # debug event. Keep only the role; no raw command line or memory dump.
        needed = c.c_uint32()
        status = self.nt.NtQueryInformationProcess(handle, 60, None, 0, c.byref(needed))
        value["commandQueryStatus"] = hex(status & 0xFFFFFFFF)
        if 16 <= needed.value <= 32768:
            storage = c.create_string_buffer(needed.value)
            status = self.nt.NtQueryInformationProcess(
                handle, 60, storage, len(storage), c.byref(needed)
            )
            value["commandQueryStatus"] = hex(status & 0xFFFFFFFF)
            if status == 0:
                text = UnicodeString.from_buffer(storage)
                begin, end = c.addressof(storage), c.addressof(storage) + len(storage)
                if (
                    text.buffer
                    and text.length % 2 == 0
                    and begin <= text.buffer <= end
                    and text.length <= end - text.buffer
                ):
                    command = c.string_at(text.buffer, text.length).decode(
                        "utf-16-le", errors="strict"
                    )
                    role = re.search(r'(?:^|\s)"?--type=([a-z-]+)"?(?:\s|$)', command)
                    value["chromeRole"] = role.group(1) if role else None
        return value

    def pump(self, milliseconds=0):
        owner.require(
            threading.get_ident() == self.creating_thread,
            "Debug events must stay on the creating thread",
        )
        if not self.debug_started or self.debug_complete:
            return
        event = DebugEvent()
        if not self.kernel.WaitForDebugEventEx(c.byref(event), milliseconds):
            error = c.get_last_error()
            if error in (121, 258):
                return
            raise c.WinError(error)
        self.event_count += 1
        disposition = DBG_NOT_HANDLED if event.kind == 1 else DBG_CONTINUE
        row = {
            "sequence": self.event_count,
            "monotonicNs": str(time.perf_counter_ns()),
            "kind": event.kind,
            "pid": event.pid,
            "tid": event.tid,
        }
        try:
            if event.kind == 3:
                self.live_debug_pids.add(event.pid)
                self.saw_process = True
                info = event.data.process
                image = self.image(info.file, info.base, info.process)
                owner.require(
                    len(self.processes) < MAX_PROCESSES, "Debug process bound exceeded"
                )
                metadata = self.process_metadata(info.process)
                row["parentCreationSequence"] = self.processes.get(
                    metadata.get("parentPid"), {}
                ).get("createdSequence")
                self.processes[event.pid] = {
                    "handle": info.process,
                    "modules": {info.base or 0: image},
                    "loaderBreakpoint": False,
                    "createdSequence": self.event_count,
                }
                row.update(image=image, **metadata)
                self.chrome_seen |= (image["name"] or "").lower() == "chrome.exe"
            elif event.kind == 6:
                info = event.data.dll
                process = self.processes.get(event.pid)
                image = self.image(
                    info.file, info.base, process["handle"] if process else None
                )
                owner.require(
                    process is not None, "DLL event has no captured process metadata"
                )
                owner.require(
                    len(process["modules"]) < MAX_MODULES, "Debug module bound exceeded"
                )
                process["modules"][info.base or 0] = image
                row["image"] = image
            elif event.kind == 7:
                self.processes[event.pid]["modules"].pop(
                    event.data.unload_base or 0, None
                )
            elif event.kind == 1:
                info = event.data.exception
                disposition, initial, location = exception_disposition(
                    self.processes[event.pid], info.record, bool(info.first)
                )
                row.update(
                    code=hex(info.record.code),
                    flags=hex(info.record.flags),
                    address=hex(info.record.address or 0),
                    firstChance=bool(info.first),
                    initialLoaderBreakpoint=initial,
                    disposition=hex(disposition),
                    **location,
                )
                if not initial:
                    if info.record.code == 0x4000001F:
                        row["unclassifiedEmulationBreakpoint"] = True
                    row["information"] = [
                        hex(info.record.information[i])
                        for i in range(min(info.record.count, 2))
                    ]
                    self.last_fault = dict(row)
                    if self.first_fault is None:
                        self.first_fault = dict(row)
                    if not info.first and self.first_unhandled is None:
                        self.first_unhandled = dict(row)
            elif event.kind == 5:
                row["exitCode"] = event.data.exit_code
                row["exitCodeHex"] = hex(event.data.exit_code)
            # Thread and debug-string events still must be continued. Their
            # handles are OS-owned; debug-string payload is not read.
            if event.kind in (1, 3, 5, 6, 7, 9) and len(self.events) < MAX_EVENTS:
                self.events.append(row)
            owner.require(
                self.event_count != MAX_EVENTS + 1, "Debug event bound exceeded"
            )
        except Exception as error:
            if len(self.observation_errors) < 8:
                self.observation_errors.append(owner.detail(error))
        finally:
            self.checked(
                self.kernel.ContinueDebugEvent(event.pid, event.tid, disposition)
            )
            if event.kind == 5:
                self.processes.pop(event.pid, None)
                self.live_debug_pids.discard(event.pid)
                self.debug_complete = self.saw_process and not self.live_debug_pids

    def wait(self, milliseconds):
        self.pump(milliseconds)
        return super().wait(0)

    def active(self):
        self.pump(0)
        return super().active()


def validate(request):
    owner.require(
        request.get("schemaVersion") == 1
        and request.get("classification") == "stock-MXC-browser-debug-request",
        "Unexpected debug request",
    )
    executor, policy = Path(request["executor"]), Path(request["policyFile"])
    owner.require(
        owner.identity(executor)["sha256"] == STOCK_SHA,
        "Stock executor identity differs",
    )
    data = policy.read_bytes()
    owner.require(len(data) <= 128 * 1024, "MXC request bound exceeded")
    owner.require(
        owner.hashlib.sha256(data).hexdigest() == request["policySha256"],
        "MXC request changed",
    )
    body = json.loads(data)
    nonce = request["nonce"]
    owner.require(
        re.fullmatch(r"[a-f0-9]{24}", nonce)
        and body["containerId"] == "nm-" + nonce[:12] + "-start",
        "Unexpected owned debug profile",
    )
    runtime = request["runtimeRoot"]
    owner.require(
        re.fullmatch(r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}", runtime),
        "Unexpected debug runtime",
    )
    state = str(
        PureWindowsPath(runtime).parent
        / ("NemoClawMsysProof-" + nonce[:12] + "-state-start")
    )
    owner.require(
        body["process"]["cwd"] == state
        and body["filesystem"]["readwritePaths"] == [state],
        "Unexpected owned debug state",
    )
    owner.require(
        body["process"]["timeout"] == 120000
        and body["processContainer"]["leastPrivilege"] is False
        and body["ui"]["disable"] is False,
        "The debug policy differs from Personal",
    )
    probe = request["probeFile"]
    owner.require(
        re.fullmatch(
            re.escape(PureWindowsPath(runtime).drive)
            + r"\\NemoClawPersonalNode-[a-f0-9]{12}\\probe-personal-python\.py",
            probe,
        ),
        "Unexpected fixed browser probe",
    )
    expected = [
        str(PureWindowsPath(runtime) / "hermes-agent/venv/Scripts/python.exe"),
        "-I",
        "-B",
        probe,
        "browser",
        runtime,
        nonce,
    ]
    owner.require(
        body["process"]["commandLine"]
        == " ".join('"' + value + '"' for value in expected),
        "Debug request does not run the canonical browser probe",
    )
    owner.require(
        runtime in body["filesystem"]["readonlyPaths"]
        and str(PureWindowsPath(probe).parent) in body["filesystem"]["readonlyPaths"],
        "Debug inputs must retain their readonly paths",
    )
    environment = request["environment"]
    owner.require(
        environment.get("GITHUB_ACTIONS") == "true"
        and "NEMOCLAW_MSYS_TOKEN_INSPECTION" not in environment,
        "Unexpected debug host environment",
    )
    return [str(executor), str(policy), "--log-file", request["logFile"]], state


def capture(request, native):
    command, state = validate(request)
    started = time.monotonic()
    result = {
        "schemaVersion": 1,
        "classification": "stock-MXC-browser-debug-result",
        "diagnosticOnly": True,
        "canonicalQualification": False,
        "nonce": request["nonce"],
        "policySha256": request["policySha256"],
        "debuggerMayChangeBehavior": True,
        "execution": {
            "executable": command[0],
            "args": command[1:],
            "pid": None,
            "exitCode": None,
            "stdout": "",
            "stderr": "",
            "timedOut": False,
            "outputExceeded": False,
            "childClosed": False,
            "error": None,
        },
        "cleanup": {
            "captureClosed": False,
            "handlesClosed": False,
            "activeProcesses": None,
            "errors": [],
        },
        "childrenClosed": False,
        "cleanupComplete": False,
    }
    buffers = [
        {"bytes": bytearray(), "eof": False, "error": None, "total": 0}
        for _ in range(2)
    ]
    readers = []
    stop = threading.Event()
    assigned = False
    stage = "create-job"

    def read(stream, item):
        try:
            while data := stream.read(8192):
                remaining = max(0, owner.CAPTURE_BYTES - len(item["bytes"]))
                item["bytes"].extend(data[:remaining])
                item["total"] += len(data)
                if len(data) > remaining:
                    stop.set()
            item["eof"] = True
        except Exception as error:
            item["error"] = owner.detail(error)
            stop.set()
        finally:
            stream.close()

    try:
        native.create_job()
        stage = "create-debugged-stock-executor"
        native.start(command, request["environment"], state)
        result["execution"]["pid"] = native.pid
        stage = "assign-job-before-resume"
        native.assign()
        assigned = True
        for stream, item in zip(native.streams, buffers):
            thread = threading.Thread(target=read, args=(stream, item), daemon=True)
            readers.append(thread)
            thread.start()
        stage = "resume-executor"
        native.resume()
        stage = "debug-events"
        while not native.wait(20):
            owner.require(
                not native.observation_errors,
                "Debug event observation failed; see exact metadata error",
            )
            if stop.is_set() or time.monotonic() - started >= 120:
                result["execution"]["timedOut"] = time.monotonic() - started >= 120
                break
    except Exception as error:
        result["execution"]["error"] = {**owner.detail(error), "stage": stage}
    finally:
        deadline = time.monotonic() + 5
        try:
            if native.process:
                if not assigned or not native.wait(0):
                    native.terminate(assigned)
                    result["forcedTermination"] = True
                settle = min(deadline, time.monotonic() + 1)
                while native.active() and time.monotonic() < settle:
                    native.pump(10)
                if native.active():
                    native.terminate(assigned)
                    result["forcedTermination"] = True
                # Continue EXIT events while waiting: kernel shutdown cannot
                # finish while the debugger leaves an exit notification stopped.
                while time.monotonic() < deadline:
                    native.pump(10)
                    if (
                        native.wait(0)
                        and native.active() == 0
                        and not native.live_debug_pids
                    ):
                        break
                result["execution"]["childClosed"] = native.wait(0)
                if result["execution"]["childClosed"]:
                    result["execution"]["exitCode"] = native.exit_code()
            result["cleanup"]["activeProcesses"] = native.active() if native.job else 0
        except Exception as error:
            result["cleanup"]["errors"].append(owner.detail(error))
        for thread in readers:
            thread.join(max(0, deadline - time.monotonic()))
        if not readers:
            for stream in native.streams:
                stream.close()
        result["cleanup"]["captureClosed"] = (
            not native.process
            or len(readers) == 2
            and all(not t.is_alive() for t in readers)
            and all(x["eof"] and x["error"] is None for x in buffers)
        )
        result["childrenClosed"] = (
            (not native.process or result["execution"]["childClosed"])
            and result["cleanup"]["activeProcesses"] == 0
            and not native.live_debug_pids
            and result["cleanup"]["captureClosed"]
        )
        for name in ("thread", "process", "job"):
            try:
                native.close(name)
            except Exception as error:
                result["cleanup"]["errors"].append(owner.detail(error))
        result["cleanup"]["handlesClosed"] = not any(
            (native.thread, native.process, native.job)
        )
        result["cleanupComplete"] = (
            result["childrenClosed"]
            and result["cleanup"]["handlesClosed"]
            and not result["cleanup"]["errors"]
        )
    for name, item in zip(("stdout", "stderr"), buffers):
        result["execution"][name] = bytes(item["bytes"]).decode(
            "utf-8", errors="replace"
        )
    result["execution"]["outputExceeded"] = any(
        x["total"] > owner.CAPTURE_BYTES for x in buffers
    )
    result["execution"]["elapsedMs"] = (time.monotonic() - started) * 1000
    result["events"] = native.events
    result["lastForwardedException"] = native.last_fault
    result["firstForwardedException"] = native.first_fault
    result["firstUnhandledException"] = native.first_unhandled
    result["debugObservationErrors"] = native.observation_errors
    result["appContainerDebugEventsObserved"] = native.appcontainer_seen
    result["chromeDebugEventsObserved"] = native.chrome_seen
    result["remainingDebugProcesses"] = list(native.live_debug_pids)
    result["executorIdentityAfter"] = owner.identity(command[0])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    owner.require(
        os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
        "Debug diagnostic requires disposable Windows CI",
    )
    owner.require(
        not args.output.exists() and args.output.parent.is_dir(),
        "Debug result must be fresh",
    )
    data = args.request.read_bytes()
    owner.require(len(data) <= 128 * 1024, "Debug owner request exceeded its bound")
    record = capture(json.loads(data), DebugJob())
    record["requestSha256"] = owner.hashlib.sha256(data).hexdigest()
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "childrenClosed": record["childrenClosed"],
                "cleanupComplete": record["cleanupComplete"],
            }
        )
    )
    return 0 if record["cleanupComplete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
