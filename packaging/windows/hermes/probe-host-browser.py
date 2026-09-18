# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Own one fixed canonical browser probe and all its ordinary Windows-host children."""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import subprocess
import threading
import time

WORK_SECONDS = 120
CLEANUP_SECONDS = 5
CAPTURE_BYTES = 64 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def detail(error):
    return {
        "name": type(error).__name__,
        "message": str(error),
        "stage": getattr(error, "stage", None),
        "winerror": getattr(error, "winerror", None),
    }


def identity(path):
    with Path(path).open("rb") as stream:
        return {
            "bytes": os.fstat(stream.fileno()).st_size,
            "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
        }


def validate_request(request):
    require(
        request.get("schemaVersion") == 1
        and request.get("classification") == "canonical-host-browser-request",
        "Unexpected fixed host-browser request",
    )
    nonce = request["nonce"]
    require(
        isinstance(nonce, str) and re.fullmatch(r"[a-f0-9]{24}", nonce),
        "Invalid host-browser nonce",
    )
    root, probe, state = (request[k] for k in ["runtimeRoot", "probeFile", "stateRoot"])
    require(
        isinstance(root, str)
        and re.fullmatch(r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}", root),
        "Invalid canonical runtime root",
    )
    drive = PureWindowsPath(root).drive
    require(
        isinstance(probe, str)
        and re.fullmatch(
            re.escape(drive)
            + r"\\NemoClawPersonalNode-[a-f0-9]{12}\\probe-personal-python\.py",
            probe,
        ),
        "Unexpected readonly browser probe",
    )
    require(
        state == drive + "\\NemoClawBrowserHost-" + nonce[:12],
        "Unexpected host-browser state root",
    )
    environment = request["environment"]
    require(
        isinstance(environment, dict)
        and all(
            isinstance(k, str)
            and k
            and "=" not in k
            and "\0" not in k
            and isinstance(v, str)
            and "\0" not in v
            for k, v in environment.items()
        ),
        "Invalid child environment",
    )
    require(
        len({k.casefold() for k in environment}) == len(environment),
        "Duplicate Windows environment names",
    )
    expected = {
        key: state + "\\home"
        for key in ["HERMES_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    }
    expected.update(
        NEMOCLAW_AGENT_HOME=state, TEMP=state + "\\temp", TMP=state + "\\temp"
    )
    require(
        all(environment.get(k) == v for k, v in expected.items()),
        "Host state environment differs",
    )
    require(
        environment.get("GITHUB_ACTIONS") == "true"
        and environment.get("PYTHONDONTWRITEBYTECODE") == "1"
        and environment.get("HERMES_DISABLE_LAZY_INSTALLS") == "1",
        "Missing fixed offline/CI browser contract",
    )
    for name in ["pythonIdentity", "probeIdentity"]:
        row = request[name]
        require(
            type(row.get("bytes")) is int
            and row["bytes"] > 0
            and isinstance(row.get("sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]),
            "Invalid input identity: " + name,
        )
    python = str(PureWindowsPath(root) / "hermes-agent/venv/Scripts/python.exe")
    return [python, "-I", "-B", probe, "browser", root, nonce]


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_int64),
        ("job_time", ctypes.c_int64),
        ("flags", ctypes.c_uint32),
        ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t),
        ("active_process_limit", ctypes.c_uint32),
        ("affinity", ctypes.c_size_t),
        ("priority", ctypes.c_uint32),
        ("scheduling", ctypes.c_uint32),
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", BasicLimits),
        ("io", ctypes.c_uint64 * 6),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t),
        ("peak_job_memory", ctypes.c_size_t),
    ]


class Accounting(ctypes.Structure):
    _fields_ = [
        ("times", ctypes.c_int64 * 4),
        ("page_faults", ctypes.c_uint32),
        ("total", ctypes.c_uint32),
        ("active", ctypes.c_uint32),
        ("terminated", ctypes.c_uint32),
    ]


class WindowsJob:
    """Only the Win32 calls needed by this fixed CI browser owner."""

    creation_flags = 0x4 | 0x08000000

    def __init__(self):
        import _winapi

        self.api = _winapi
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        handle, pointer, dword, boolean = (
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_int,
        )
        declarations = {
            "CreateJobObjectW": ([pointer, ctypes.c_wchar_p], handle),
            "SetInformationJobObject": (
                [handle, ctypes.c_int, pointer, dword],
                boolean,
            ),
            "QueryInformationJobObject": (
                [handle, ctypes.c_int, pointer, dword, pointer],
                boolean,
            ),
            "AssignProcessToJobObject": ([handle, handle], boolean),
            "IsProcessInJob": ([handle, handle, ctypes.POINTER(boolean)], boolean),
            "ResumeThread": ([handle], dword),
            "GetExitCodeProcess": ([handle, ctypes.POINTER(dword)], boolean),
            "TerminateJobObject": ([handle, dword], boolean),
            "TerminateProcess": ([handle, dword], boolean),
            "WaitForSingleObject": ([handle, dword], dword),
            "CloseHandle": ([handle], boolean),
        }
        for name, (args, result) in declarations.items():
            function = getattr(self.kernel, name)
            function.argtypes = args
            function.restype = result
        self.job = self.process = self.thread = None
        self.pid = None
        self.streams = []

    def checked(self, value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())
        return value

    def create_job(self):
        self.job = self.checked(self.kernel.CreateJobObjectW(None, None))
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000
        self.checked(
            self.kernel.SetInformationJobObject(
                self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)
            )
        )

    def start(self, command, environment, cwd):
        import msvcrt

        handles = []
        try:
            for _ in range(3):
                handles.extend(self.api.CreatePipe(None, 0))
            (
                input_read,
                input_write,
                output_read,
                output_write,
                error_read,
                error_write,
            ) = handles
            self.api.CloseHandle(input_write)
            handles.remove(input_write)
            inherited = [input_read, output_write, error_write]
            for handle in inherited:
                os.set_handle_inheritable(handle, True)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESTDHANDLES
            startup.hStdInput, startup.hStdOutput, startup.hStdError = inherited
            startup.lpAttributeList = {"handle_list": inherited}
            # CPython adds EXTENDED_STARTUPINFO_PRESENT and CREATE_UNICODE_ENVIRONMENT.
            self.process, self.thread, self.pid, _ = self.api.CreateProcess(
                command[0],
                subprocess.list2cmdline(command),
                None,
                None,
                True,
                self.creation_flags,
                environment,
                cwd,
                startup,
            )
            for handle in inherited:
                self.api.CloseHandle(handle)
                handles.remove(handle)
            for handle in [output_read, error_read]:
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
                handles.remove(handle)
                self.streams.append(os.fdopen(fd, "rb", buffering=0))
        finally:
            for handle in handles:
                self.api.CloseHandle(handle)

    def assign(self):
        self.checked(self.kernel.AssignProcessToJobObject(self.job, self.process))
        member = ctypes.c_int()
        self.checked(
            self.kernel.IsProcessInJob(self.process, self.job, ctypes.byref(member))
        )
        require(member.value != 0, "Host browser child was not assigned to its job")

    def resume(self):
        count = self.kernel.ResumeThread(self.thread)
        if count == 0xFFFFFFFF:
            error = ctypes.WinError(ctypes.get_last_error())
            error.stage = "ResumeThread"
            raise error
        require(
            count == 1, "ResumeThread expected suspend count 1, received " + str(count)
        )

    def wait(self, milliseconds):
        result = self.kernel.WaitForSingleObject(self.process, milliseconds)
        if result == 0xFFFFFFFF:
            error = ctypes.WinError(ctypes.get_last_error())
            error.stage = "WaitForSingleObject"
            raise error
        require(
            result in (0, 258),
            "WaitForSingleObject returned unexpected status " + str(result),
        )
        return result == 0

    def exit_code(self):
        code = ctypes.c_uint32()
        self.checked(self.kernel.GetExitCodeProcess(self.process, ctypes.byref(code)))
        return code.value

    def active(self):
        info = Accounting()
        self.checked(
            self.kernel.QueryInformationJobObject(
                self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None
            )
        )
        return info.active

    def terminate(self, assigned):
        self.checked(
            self.kernel.TerminateJobObject(self.job, 1)
            if assigned
            else self.kernel.TerminateProcess(self.process, 1)
        )

    def close(self, name):
        value = getattr(self, name)
        if value:
            self.checked(self.kernel.CloseHandle(value))
            setattr(self, name, None)


def parse_browser(stdout, nonce):
    rows = [
        line
        for line in stdout.splitlines()
        if line.startswith("NEMOCLAW_PERSONAL_RESULT=")
    ]
    require(len(rows) == 1, "Host browser did not publish exactly one result")
    result = json.loads(rows[0].split("=", 1)[1])
    require(
        result.get("schemaVersion") == 1
        and result.get("component") == "browser"
        and result.get("nonce") == nonce,
        "Host browser result identity differs",
    )
    return result


def own_browser(request, native, *, clock=time.monotonic, sleep=time.sleep):
    command = validate_request(request)
    state = Path(request["stateRoot"])
    started = clock()
    capture = [
        {"data": bytearray(), "bytes": 0, "eof": False, "error": None} for _ in range(2)
    ]
    stop = threading.Event()
    readers = []
    record = {
        "schemaVersion": 1,
        "classification": "canonical-host-browser-diagnostic",
        "diagnosticOnly": True,
        "canonicalQualification": False,
        "installedAcceptance": False,
        "nonce": request["nonce"],
        "runtimeRoot": request["runtimeRoot"],
        "stateRoot": str(state),
        "processCreated": False,
        "operationSucceeded": False,
        "result": None,
        "primaryError": None,
        "execution": {
            "pid": None,
            "exitCode": None,
            "timedOut": False,
            "outputExceeded": False,
            "childClosed": False,
            "resumed": False,
            "stdout": "",
            "stderr": "",
            "error": None,
        },
        "job": {
            "created": False,
            "limitFlags": 8192,
            "assignedBeforeResume": False,
            "rootMembershipVerified": False,
            "activeBeforeCleanup": None,
            "activeAfterCleanup": None,
            "forcedTermination": False,
        },
        "cleanup": {
            "captureClosed": False,
            "processHandleClosed": False,
            "threadHandleClosed": False,
            "jobHandleClosed": False,
            "stateRemoved": False,
            "errors": [],
        },
        "childrenClosed": False,
        "cleanupComplete": False,
    }
    owned = assigned = False
    stage = "verify-inputs"

    def read(stream, target):
        try:
            while data := stream.read(8192):
                remaining = max(0, CAPTURE_BYTES - len(target["data"]))
                target["data"].extend(data[:remaining])
                target["bytes"] += len(data)
                if len(data) > remaining:
                    stop.set()
            target["eof"] = True
        except Exception as error:
            target["error"] = detail(error)
            stop.set()
        finally:
            stream.close()

    try:
        require(
            not state.exists() and not state.is_symlink(),
            "Host browser state must be fresh",
        )
        require(
            identity(command[0]) == request["pythonIdentity"]
            and identity(command[3]) == request["probeIdentity"],
            "The canonical Python or browser probe bytes changed",
        )
        state.mkdir()
        owned = True
        for name in ["home", "temp"]:
            (state / name).mkdir()
        stage = "create-job"
        native.create_job()
        record["job"]["created"] = True
        stage = "create-suspended-browser"
        native.start(command, request["environment"], str(state))
        record["processCreated"] = True
        record["execution"]["pid"] = native.pid
        stage = "assign-job-before-resume"
        native.assign()
        assigned = True
        record["job"]["assignedBeforeResume"] = record["job"][
            "rootMembershipVerified"
        ] = True
        for stream, target in zip(native.streams, capture):
            thread = threading.Thread(target=read, args=(stream, target), daemon=True)
            readers.append(thread)
            thread.start()
        stage = "resume-browser"
        native.resume()
        record["execution"]["resumed"] = True
        stage = "wait-browser"
        while not native.wait(20):
            if stop.is_set() or clock() - started >= WORK_SECONDS:
                record["execution"]["timedOut"] = clock() - started >= WORK_SECONDS
                break
        else:
            record["execution"]["childClosed"] = True
            record["execution"]["exitCode"] = native.exit_code()
    except Exception as error:
        record["primaryError"] = {
            **detail(error),
            "stage": getattr(error, "stage", stage),
        }
    finally:
        cleanup_started = clock()
        deadline = cleanup_started + CLEANUP_SECONDS
        record["processCreated"] = native.process is not None
        record["job"]["created"] = native.job is not None
        try:
            if native.process is not None:
                if not assigned or not record["execution"]["childClosed"]:
                    native.terminate(assigned)
                    record["job"]["forcedTermination"] = True
                record["job"]["activeBeforeCleanup"] = (
                    native.active() if native.job else None
                )
                settle = min(deadline, clock() + 1)
                while assigned and native.active() and clock() < settle:
                    sleep(0.02)
                if assigned and native.active():
                    native.terminate(True)
                    record["job"]["forcedTermination"] = True
                while clock() < deadline:
                    if native.wait(0) and (not native.job or native.active() == 0):
                        break
                    sleep(0.02)
                record["execution"]["childClosed"] = native.wait(0)
                if record["execution"]["childClosed"]:
                    record["execution"]["exitCode"] = native.exit_code()
            if native.job is not None:
                record["job"]["activeAfterCleanup"] = native.active()
        except Exception as error:
            record["cleanup"]["errors"].append(detail(error))
        for thread in readers:
            thread.join(max(0, deadline - clock()))
        if not readers and not record["execution"]["resumed"]:
            for stream in native.streams:
                stream.close()
        record["cleanup"]["captureClosed"] = (
            not record["processCreated"]
            or not readers
            and not record["execution"]["resumed"]
            and all(s.closed for s in native.streams)
            or len(readers) == 2
            and all(not t.is_alive() for t in readers)
            and all(c["eof"] and c["error"] is None for c in capture)
        )
        for key, name in [
            ("threadHandleClosed", "thread"),
            ("processHandleClosed", "process"),
            ("jobHandleClosed", "job"),
        ]:
            try:
                native.close(name)
                record["cleanup"][key] = True
            except Exception as error:
                record["cleanup"]["errors"].append(detail(error))
        for stream in native.streams:
            if not stream.closed and not any(t.is_alive() for t in readers):
                stream.close()
        record["childrenClosed"] = not record["processCreated"] or (
            record["execution"]["childClosed"]
            and record["job"]["activeAfterCleanup"] == 0
            and record["cleanup"]["captureClosed"]
        )
        if owned and record["childrenClosed"]:
            deletion = []

            def remove():
                try:
                    shutil.rmtree(state)
                except Exception as error:
                    deletion.append(detail(error))

            thread = threading.Thread(target=remove, daemon=True)
            thread.start()
            thread.join(max(0, deadline - clock()))
            record["cleanup"]["errors"].extend(deletion)
            record["cleanup"]["stateRemoved"] = (
                not thread.is_alive() and not state.exists()
            )
        record["cleanupComplete"] = (
            record["childrenClosed"]
            and all(
                record["cleanup"][k]
                for k in [
                    "captureClosed",
                    "processHandleClosed",
                    "threadHandleClosed",
                    "jobHandleClosed",
                    "stateRemoved",
                ]
            )
            and not record["cleanup"]["errors"]
        )
        record["cleanupElapsedMs"] = (clock() - cleanup_started) * 1000
    execution = record["execution"]
    execution["stdout"], execution["stderr"] = [
        bytes(c["data"]).decode("utf-8", errors="replace") for c in capture
    ]
    execution["outputExceeded"] = any(c["bytes"] > CAPTURE_BYTES for c in capture)
    execution["elapsedMs"] = (clock() - started) * 1000
    execution["error"] = next((c["error"] for c in capture if c["error"]), None)
    try:
        record["result"] = parse_browser(execution["stdout"], request["nonce"])
        require(
            identity(command[0]) == request["pythonIdentity"]
            and identity(command[3]) == request["probeIdentity"],
            "Host input bytes changed during execution",
        )
        record["operationSucceeded"] = (
            record["result"].get("passed") is True
            and execution["exitCode"] == 0
            and execution["childClosed"]
            and not execution["timedOut"]
            and not execution["outputExceeded"]
            and execution["error"] is None
            and record["primaryError"] is None
            and record["childrenClosed"]
            and record["cleanupComplete"]
        )
    except Exception as error:
        if record["primaryError"] is None:
            record["primaryError"] = detail(error)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(
        os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
        "Host browser diagnostic requires disposable Windows CI",
    )
    require(
        not args.output.exists()
        and not args.output.is_symlink()
        and args.output.parent.is_dir(),
        "Host browser receipt must be fresh",
    )
    raw = args.request.read_bytes()
    require(len(raw) <= 128 * 1024, "Host browser request exceeded its bound")
    record = own_browser(json.loads(raw), WindowsJob())
    record["requestSha256"] = hashlib.sha256(raw).hexdigest()
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
    print(
        json.dumps(
            {
                "receipt": str(args.output),
                "operationSucceeded": record["operationSucceeded"],
                "childrenClosed": record["childrenClosed"],
                "cleanupComplete": record["cleanupComplete"],
            }
        )
    )
    return 0 if record["operationSucceeded"] and record["cleanupComplete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
