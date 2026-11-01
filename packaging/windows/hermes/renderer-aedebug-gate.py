# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""One postmortem, noninvasive CDB capture of an admitted Personal renderer.

The supplied AeDebug event is never signaled or inherited by CDB. The gate owns
only its own handles and its CDB job; it never controls the target's execution.
Raw minidumps stay in the host-owned diagnostic root for the separate parser.
"""

import argparse
import ctypes as c
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time

STARTED = time.monotonic()
MAX_SECONDS = 20
CLEANUP_SECONDS = 3
CAPTURE_BYTES = 32768
MAX_DUMP_BYTES = 16 * 1024 * 1024
CHROME_SHA = "409805a16d6416087e6b2f778df1cf8f7bbb267d6b99f6b5bb0a618eace234f2"
PYTHON_SHA = "54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b"


def require(value, message):
    if not value:
        raise ValueError(message)


def detail(error, stage=None):
    return {
        "stage": stage or getattr(error, "stage", None),
        "name": type(error).__name__,
        "message": str(error)[:1024],
        "winerror": getattr(error, "winerror", None),
    }


def integer(text):
    require(
        isinstance(text, str)
        and re.fullmatch(r"(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,20})", text),
        "Invalid unsigned argument",
    )
    value = int(text, 16 if text.startswith("0x") else 10)
    require(0 < value < 2**63, "Argument is outside user-handle/address range")
    return value


def jit_address(text):
    require(
        isinstance(text, str) and re.fullmatch(r"(?:0x)?[0-9a-fA-F]{1,16}", text),
        "Invalid hexadecimal JIT_DEBUG_INFO address",
    )
    value = int(text, 16)
    require(0 < value < 2**63, "JIT_DEBUG_INFO address is outside user address range")
    return value


def ordinary(path, directory=False):
    info = Path(path).lstat()
    require(
        not stat.S_ISLNK(info.st_mode)
        and not getattr(info, "st_file_attributes", 0) & 0x400,
        "Reparse/link diagnostic path refused",
    )
    require(
        stat.S_ISDIR(info.st_mode)
        if directory
        else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
        "Unexpected diagnostic filesystem object",
    )
    return info


def read_bounded(path, limit):
    before = ordinary(path)
    require(before.st_size <= limit, "Input exceeds fixed bound")
    with Path(path).open("rb") as stream:
        opened = os.fstat(stream.fileno())
        require(
            (before.st_dev, before.st_ino, before.st_size)
            == (opened.st_dev, opened.st_ino, opened.st_size),
            "Input changed before read",
        )
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    require(
        len(data) <= limit
        and len(data) == after.st_size
        and (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        == (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
        "Input changed during read",
    )
    return data


def config_paths(path):
    match = re.fullmatch(
        r"([A-Za-z]:\\NemoClawRendererPostmortem-([a-f0-9]{12}))\\gate-config\.json",
        path,
    )
    require(match is not None, "Unexpected fixed postmortem config path")
    root, nonce = match.groups()
    for directory in [root, root + "\\reports", root + "\\dumps"]:
        ordinary(directory, True)
    return root, nonce


def validate_config(value, root, nonce):
    require(
        value.get("schemaVersion") == 1
        and value.get("classification") == "renderer-postmortem-gate-config",
        "Unexpected postmortem config",
    )
    require(
        value.get("root") == root
        and value.get("nonce") == nonce
        and re.fullmatch(r"[a-f0-9]{40}", value.get("sourceRevision", "")),
        "Postmortem source/owner binding differs",
    )
    require(
        type(value.get("deadlineMs")) is int and 1000 <= value["deadlineMs"] <= 20000,
        "Postmortem deadline exceeds fixed bound",
    )
    require(
        re.fullmatch(
            r"S-1-15-2(?:-[0-9]{1,10}){7}", value.get("expectedAppContainerSid", "")
        ),
        "Missing exact nonce-derived AppContainer SID",
    )
    for name in ["chromeIdentity", "pythonIdentity", "cdbIdentity", "ownerIdentity"]:
        row = value[name]
        require(
            type(row.get("bytes")) is int
            and 0 < row["bytes"] <= 128 * 1024 * 1024
            and re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", "")),
            "Invalid pinned input identity: " + name,
        )
        require(
            isinstance(row.get("path"), str)
            and re.fullmatch(r"[A-Za-z]:\\[^\x00-\x1f\";]+", row["path"]),
            "Invalid pinned input path",
        )
    chrome = value["chromeIdentity"]
    require(
        re.fullmatch(
            r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}\\browsers\\chromium-1234\\chrome-win64\\chrome\.exe",
            chrome["path"],
        )
        and chrome["bytes"] == 4024832
        and chrome["sha256"] == CHROME_SHA,
        "Expected the unchanged canonical Chrome executable",
    )
    require(
        re.fullmatch(r"0x[0-9a-f]{1,16}", chrome.get("volumeSerialHex", ""))
        and re.fullmatch(r"[0-9a-f]{32}", chrome.get("fileIdHex", "")),
        "Missing canonical Chrome file ID",
    )
    require(
        value["pythonIdentity"]["sha256"] == PYTHON_SHA,
        "Expected already pinned ARM64 host Python",
    )
    require(
        ntpath.basename(value["cdbIdentity"]["path"]).lower() == "cdb.exe"
        and value["cdbIdentity"].get("machine") in (0xAA64, 0x8664),
        "Unexpected preinstalled CDB",
    )
    require(
        value["ownerIdentity"]["path"] == root + "\\probe-host-browser.py",
        "Unexpected fixed WindowsJob owner module",
    )
    return value


def save_new(path, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    require(len(data) <= 128 * 1024, "Gate receipt exceeds bound")
    with Path(path).open("xb") as stream:
        stream.write(data)


class UnicodeString(c.Structure):
    _fields_ = [("length", c.c_uint16), ("maximum", c.c_uint16), ("buffer", c.c_void_p)]


class Windows:
    def __init__(self):
        self.k = c.WinDLL("kernel32", use_last_error=True)
        self.a = c.WinDLL("advapi32", use_last_error=True)
        self.n = c.WinDLL("ntdll")
        self.s = c.WinDLL("shell32", use_last_error=True)
        self.handles = []
        self.close_errors = []
        ptr, u32, boolean = c.c_void_p, c.c_uint32, c.c_int
        for dll, declarations in [
            (
                self.k,
                {
                    "OpenProcess": ([u32, boolean, u32], ptr),
                    "GetCurrentProcess": ([], ptr),
                    "GetCurrentProcessId": ([], u32),
                    "GetProcessTimes": ([ptr, *([c.POINTER(c.c_uint64)] * 4)], boolean),
                    "QueryFullProcessImageNameW": (
                        [ptr, u32, c.c_wchar_p, c.POINTER(u32)],
                        boolean,
                    ),
                    "WaitForSingleObject": ([ptr, u32], u32),
                    "CloseHandle": ([ptr], boolean),
                    "IsProcessInJob": ([ptr, ptr, c.POINTER(boolean)], boolean),
                    "GetHandleInformation": ([ptr, c.POINTER(u32)], boolean),
                    "CreateFileW": ([c.c_wchar_p, u32, u32, ptr, u32, u32, ptr], ptr),
                    "GetFileInformationByHandleEx": ([ptr, c.c_int, ptr, u32], boolean),
                    "LocalFree": ([ptr], ptr),
                    "GetTickCount64": ([], c.c_uint64),
                },
            ),
            (
                self.a,
                {
                    "OpenProcessToken": ([ptr, u32, c.POINTER(ptr)], boolean),
                    "GetTokenInformation": (
                        [ptr, c.c_int, ptr, u32, c.POINTER(u32)],
                        boolean,
                    ),
                    "ConvertSidToStringSidW": ([ptr, c.POINTER(ptr)], boolean),
                },
            ),
            (
                self.n,
                {
                    "NtQueryInformationProcess": (
                        [ptr, c.c_int, ptr, u32, c.POINTER(u32)],
                        c.c_int32,
                    ),
                    "NtQueryObject": (
                        [ptr, c.c_int, ptr, u32, c.POINTER(u32)],
                        c.c_int32,
                    ),
                    "NtQueryEvent": (
                        [ptr, c.c_int, ptr, u32, c.POINTER(u32)],
                        c.c_int32,
                    ),
                },
            ),
            (self.s, {"CommandLineToArgvW": ([c.c_wchar_p, c.POINTER(c.c_int)], ptr)}),
        ]:
            for name, (args, result) in declarations.items():
                function = getattr(dll, name)
                function.argtypes, function.restype = args, result

    @staticmethod
    def checked(value):
        if not value:
            raise c.WinError(c.get_last_error())
        return value

    def own(self, value):
        self.checked(value)
        self.handles.append(value)
        return value

    def close(self, value):
        if self.k.CloseHandle(value):
            if value in self.handles:
                self.handles.remove(value)
            return True
        self.close_errors.append(
            {"stage": "CloseHandle", "winerror": c.get_last_error()}
        )
        return False

    def process(self, pid):
        return self.own(self.k.OpenProcess(0x00101000, False, pid))

    def generation(self, handle):
        times = [c.c_uint64() for _ in range(4)]
        self.checked(self.k.GetProcessTimes(handle, *(c.byref(v) for v in times)))
        return str(times[0].value)

    def image(self, handle):
        buffer = c.create_unicode_buffer(32768)
        length = c.c_uint32(len(buffer))
        self.checked(
            self.k.QueryFullProcessImageNameW(handle, 0, buffer, c.byref(length))
        )
        return buffer.value

    def live(self, handle):
        result = self.k.WaitForSingleObject(handle, 0)
        if result == 0xFFFFFFFF:
            raise c.WinError(c.get_last_error())
        require(result in (0, 258), "Unexpected process wait status")
        return result == 258

    def file(self, row):
        # Deny write/delete while the admitted tool/image decision is in use.
        import msvcrt

        ordinary(row["path"])
        handle = self.k.CreateFileW(
            row["path"], 0x80000000, 1, None, 3, 0x00200000, None
        )
        if handle in (None, c.c_void_p(-1).value):
            raise c.WinError(c.get_last_error())
        self.own(handle)
        raw = c.create_string_buffer(24)
        self.checked(self.k.GetFileInformationByHandleEx(handle, 18, raw, 24))
        file_id = {
            "volumeSerialHex": hex(int.from_bytes(raw.raw[:8], "little")),
            "fileIdHex": raw.raw[8:].hex(),
        }
        # A separate read stream keeps the original guard handle owned throughout.
        with Path(row["path"]).open("rb") as stream:
            info = os.fstat(stream.fileno())
            same = c.create_string_buffer(24)
            self.checked(
                self.k.GetFileInformationByHandleEx(
                    msvcrt.get_osfhandle(stream.fileno()), 18, same, 24
                )
            )
            require(
                same.raw == raw.raw, "Pinned file changed between held/read handles"
            )
            require(info.st_size == row["bytes"], "Pinned file size differs")
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
            require(digest == row["sha256"], "Pinned file digest differs")
        if "fileIdHex" in row:
            require(file_id == {k: row[k] for k in file_id}, "Pinned file ID differs")
        return {**row, **file_id, "held": True}

    @staticmethod
    def unicode(buffer):
        value = UnicodeString.from_buffer(buffer)
        start = c.addressof(buffer)
        require(
            value.length % 2 == 0
            and value.length <= value.maximum
            and value.buffer
            and start <= value.buffer <= start + len(buffer) - value.length,
            "Invalid returned Unicode string",
        )
        return c.wstring_at(value.buffer, value.length // 2)

    def event(self, handle):
        flags = c.c_uint32()
        self.checked(self.k.GetHandleInformation(handle, c.byref(flags)))
        buffer, used = c.create_string_buffer(4096), c.c_uint32()
        status = self.n.NtQueryObject(handle, 2, buffer, len(buffer), c.byref(used))
        require(
            status >= 0,
            "Supplied AeDebug handle type query failed: " + hex(status & 0xFFFFFFFF),
        )
        require(
            self.unicode(buffer) == "Event", "Supplied AeDebug handle is not an event"
        )
        info = (c.c_int32 * 2)()
        status = self.n.NtQueryEvent(handle, 0, info, c.sizeof(info), c.byref(used))
        row = {
            "type": "Event",
            "handleFlags": flags.value,
            "eventType": None,
            "state": None,
            "stateAvailable": False,
            "stateQueryStatus": hex(status & 0xFFFFFFFF),
            "signaledByGate": False,
        }
        # AeDebug's supplied Event need not grant EVENT_QUERY_STATE. No extra
        # rights are requested; its existing type/ownership remain verified.
        if status & 0xFFFFFFFF == 0xC0000022:
            return row
        require(
            status >= 0,
            "Supplied AeDebug event state query failed: " + hex(status & 0xFFFFFFFF),
        )
        require(info[1] == 0, "AeDebug event was already signaled")
        row.update(eventType=info[0], state=info[1], stateAvailable=True)
        return row

    def role(self, handle):
        buffer, used = c.create_string_buffer(65536), c.c_uint32()
        status = self.n.NtQueryInformationProcess(
            handle, 60, buffer, len(buffer), c.byref(used)
        )
        require(
            status >= 0,
            "Renderer command-line query failed: " + hex(status & 0xFFFFFFFF),
        )
        command = self.unicode(buffer)
        count = c.c_int()
        argv = self.checked(self.s.CommandLineToArgvW(command, c.byref(count)))
        try:
            require(0 < count.value <= 512, "Renderer argument count exceeds bound")
            args = [c.cast(argv, c.POINTER(c.c_wchar_p))[i] for i in range(count.value)]
            types = [
                arg for arg in args[1:] if arg.startswith("--type=") or arg == "--type"
            ]
            require(
                types == ["--type=renderer"], "Target is not the exact renderer role"
            )
            return {
                "type": "renderer",
                "commandLineBytes": len(command.encode("utf-16-le")),
                "commandLineSha256": hashlib.sha256(
                    command.encode("utf-16-le")
                ).hexdigest(),
            }
        finally:
            require(
                not self.k.LocalFree(argv), "CommandLineToArgvW allocation close failed"
            )

    def sandbox(self, handle, expected):
        token = c.c_void_p()
        self.checked(self.a.OpenProcessToken(handle, 8, c.byref(token)))
        self.own(token.value)
        try:
            app, used = c.c_uint32(), c.c_uint32()
            self.checked(
                self.a.GetTokenInformation(
                    token, 29, c.byref(app), c.sizeof(app), c.byref(used)
                )
            )
            require(app.value == 1, "Target token is not AppContainer")
            buffer = c.create_string_buffer(4096)
            self.checked(
                self.a.GetTokenInformation(
                    token, 31, buffer, len(buffer), c.byref(used)
                )
            )
            sid = c.c_void_p.from_buffer(buffer).value
            require(
                sid and c.addressof(buffer) <= sid < c.addressof(buffer) + len(buffer),
                "Invalid AppContainer SID pointer",
            )
            text = c.c_void_p()
            self.checked(self.a.ConvertSidToStringSidW(sid, c.byref(text)))
            try:
                actual = c.wstring_at(text.value)
            finally:
                require(not self.k.LocalFree(text), "SID allocation close failed")
            require(
                actual == expected,
                "Target AppContainer SID differs from the exact nonce",
            )
            member = c.c_int()
            self.checked(self.k.IsProcessInJob(handle, None, c.byref(member)))
            require(member.value == 1, "Target has no job membership")
            return {
                "isAppContainer": True,
                "appContainerSid": actual,
                "isProcessInAJob": True,
                "exactMxcJobHandleVerified": False,
            }
        finally:
            self.close(token.value)


def cdb_command(config, pid, jit, created):
    prefix = config["root"] + f"\\dumps\\renderer-{pid}-{created}"
    require(re.fullmatch(r"[0-9]{1,20}", created), "Invalid held renderer generation")
    return [
        config["cdbIdentity"]["path"],
        "-pv",
        "-p",
        str(pid),
        "-c",
        f'.dump /m /j 0x{jit:x} /u "{prefix}.dmp"; qd',
    ], prefix


def admit_renderer(native, config, pid, row):
    target = native.process(pid)
    created = native.generation(target)
    image = native.image(target)
    row.update(
        creationFiletime=created,
        image=image,
        access="0x00101000",
        liveBefore=native.live(target),
    )
    require(
        row["liveBefore"]
        and ntpath.normcase(image) == ntpath.normcase(config["chromeIdentity"]["path"]),
        "Target is not the live canonical Chrome image",
    )
    row["role"] = native.role(target)
    row["sandbox"] = native.sandbox(target, config["expectedAppContainerSid"])
    require(
        native.generation(target) == created and native.live(target),
        "Renderer generation exited during admission",
    )
    return target, created


def claim_capture(config, host, target):
    """At most four admitted captures share this fresh run root; no waiting."""
    for index in range(4):
        name = f"capture-slot-{index}.json"
        row = {
            "schemaVersion": 1,
            "classification": "renderer-postmortem-capture-claim",
            "sourceRevision": config["sourceRevision"],
            "nonce": config["nonce"],
            "slot": index,
            "host": host,
            "target": target,
            "rendererAdmissionComplete": True,
            "captureExecuted": False,
            "hostExitProved": False,
        }
        try:
            save_new(Path(config["root"]) / "reports" / name, row)
        except FileExistsError:
            continue
        return {"slot": index, "name": name}
    raise ValueError("The four owned postmortem capture slots are exhausted")


def cdb_environment(config):
    system = os.environ.get("SystemRoot", "")
    require(
        re.fullmatch(r"[A-Za-z]:\\Windows", system, re.I),
        "Missing actual Windows system root",
    )
    return {
        "SystemRoot": system,
        "WINDIR": system,
        "PATH": ntpath.dirname(config["cdbIdentity"]["path"])
        + ";"
        + system
        + "\\System32",
        "TEMP": config["root"] + "\\dumps",
        "TMP": config["root"] + "\\dumps",
    }


def job_class(owner):
    class CdbJob(owner.WindowsJob):
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
                # The AeDebug event and target/query handles never leave the gate.
                startup.lpAttributeList = {"handle_list": inherited}
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
                    try:
                        self.streams.append(os.fdopen(fd, "rb", buffering=0))
                    except BaseException:
                        os.close(fd)
                        raise
            finally:
                for handle in handles:
                    self.api.CloseHandle(handle)

    return CdbJob


def run_cdb(
    command,
    environment,
    cwd,
    native,
    deadline,
    *,
    clock=time.monotonic,
    sleep=time.sleep,
):
    """Only the debugger's suspended child is assigned, resumed, or terminated."""
    record = {
        "argv": command,
        "started": False,
        "resumed": False,
        "assignedBeforeResume": False,
        "childClosed": True,
        "captureClosed": True,
        "jobActiveAfterCleanup": 0,
        "handlesClosed": True,
        "exitCode": None,
        "timedOut": False,
        "outputExceeded": False,
        "error": None,
        "cleanupErrors": [],
    }
    buffers = [
        {"data": bytearray(), "total": 0, "eof": False, "closed": False, "error": None}
        for _ in range(2)
    ]
    stop, readers, assigned = threading.Event(), [], False
    stage = "create-cdb-job"

    def read(stream, row):
        try:
            while data := stream.read(4096):
                row["total"] += len(data)
                row["data"].extend(data[: max(0, CAPTURE_BYTES - len(row["data"]))])
                if row["total"] > CAPTURE_BYTES:
                    stop.set()
            row["eof"] = True
        except Exception as error:
            row["error"] = detail(error, "capture-cdb")
            stop.set()
        finally:
            try:
                stream.close()
                row["closed"] = True
            except Exception as error:
                row["error"] = detail(error, "close-cdb-pipe")

    try:
        require(clock() + CLEANUP_SECONDS < deadline, "No remaining CDB work budget")
        native.create_job()
        stage = "start-suspended-cdb"
        native.start(command, environment, cwd)
        record.update(
            started=True,
            pid=native.pid,
            childClosed=False,
            captureClosed=False,
            handlesClosed=False,
            jobActiveAfterCleanup=None,
        )
        stage = "assign-cdb-job"
        native.assign()
        assigned = record["assignedBeforeResume"] = True
        for stream, row in zip(native.streams, buffers):
            thread = threading.Thread(target=read, args=(stream, row), daemon=True)
            readers.append(thread)
            thread.start()
        stage = "resume-cdb"
        native.resume()
        record["resumed"] = True
        stage = "wait-cdb"
        while not native.wait(20):
            if stop.is_set() or clock() >= deadline - CLEANUP_SECONDS:
                record["timedOut"] = clock() >= deadline - CLEANUP_SECONDS
                break
        else:
            record["childClosed"] = True
            record["exitCode"] = native.exit_code()
    except Exception as error:
        record["error"] = detail(error, stage)
    finally:
        record["started"] = native.process is not None
        record["pid"] = native.pid
        try:
            if native.process is not None:
                if not native.wait(0) or (assigned and native.active()):
                    native.terminate(assigned)
                    record["debuggerJobTerminated"] = True
                while clock() < deadline and (
                    not native.wait(0) or (assigned and native.active())
                ):
                    sleep(0.01)
                record["childClosed"] = native.wait(0)
                if record["childClosed"]:
                    record["exitCode"] = native.exit_code()
            if native.job is not None:
                record["jobActiveAfterCleanup"] = native.active()
        except Exception as error:
            record["cleanupErrors"].append(detail(error, "close-cdb-tree"))
            record["childClosed"] = False
            record["jobActiveAfterCleanup"] = None
        for reader in readers:
            reader.join(max(0, deadline - clock()))
        if not readers:
            for stream in native.streams:
                try:
                    stream.close()
                except Exception as error:
                    record["cleanupErrors"].append(
                        detail(error, "close-unread-cdb-pipe")
                    )
        record["captureClosed"] = (
            not readers and all(s.closed for s in native.streams)
        ) or (
            len(readers) == 2
            and all(not t.is_alive() for t in readers)
            and all(b["closed"] for b in buffers)
        )
        for name in ["thread", "process", "job"]:
            try:
                native.close(name)
            except Exception as error:
                record["cleanupErrors"].append(detail(error, "close-cdb-" + name))
        record["handlesClosed"] = all(
            getattr(native, name) is None for name in ["thread", "process", "job"]
        )
    record["outputExceeded"] = any(row["total"] > CAPTURE_BYTES for row in buffers)
    record["stdout"], record["stderr"] = [
        bytes(row["data"]).decode("utf-8", "replace") for row in buffers
    ]
    record["captureErrors"] = [row["error"] for row in buffers if row["error"]]
    record["childrenClosed"] = (
        record["childClosed"]
        and record["captureClosed"]
        and record["jobActiveAfterCleanup"] == 0
        and record["handlesClosed"]
    )
    record["operationSucceeded"] = (
        record["started"]
        and record["childrenClosed"]
        and record["exitCode"] == 0
        and not any(
            [
                record["error"],
                record["cleanupErrors"],
                record["captureErrors"],
                record["timedOut"],
                record["outputExceeded"],
            ]
        )
    )
    return record


def dumps_for(prefix):
    parent, stem = Path(prefix).parent, Path(prefix).name
    rows = []
    for index, path in enumerate(parent.iterdir()):
        require(index < 64, "Owned dump directory exceeds bounded observation")
        if path.name.startswith(stem) and path.suffix.lower() == ".dmp":
            require(len(rows) < 2, "Unexpected dump count for this exact renderer")
            info = ordinary(path)
            rows.append(
                {
                    "name": path.name,
                    "bytes": info.st_size,
                    "withinParserBound": 0 < info.st_size <= MAX_DUMP_BYTES,
                    "rawUploadAllowed": False,
                }
            )
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--pid", type=integer, required=True)
    parser.add_argument("--event-handle", type=integer, required=True)
    parser.add_argument("--jit-info", type=jit_address, required=True)
    args = parser.parse_args()
    native, record, result_path, event_owned = None, None, None, False
    exit_code, stage = 1, "admit-config-output"
    try:
        require(
            os.name == "nt" and c.sizeof(c.c_void_p) == 8,
            "Expected 64-bit Windows host Python",
        )
        require(
            args.pid < 2**32 and re.fullmatch(r"[a-f0-9]{64}", args.config_sha256),
            "Invalid postmortem arguments",
        )
        root, nonce = config_paths(args.config)
        raw = read_bounded(args.config, 32768)
        require(
            hashlib.sha256(raw).hexdigest() == args.config_sha256,
            "Immutable config digest differs",
        )
        config = validate_config(json.loads(raw), root, nonce)
        deadline = min(STARTED + MAX_SECONDS, STARTED + config["deadlineMs"] / 1000)
        native = Windows()
        host = {
            "pid": native.k.GetCurrentProcessId(),
            "creationFiletime": native.generation(native.k.GetCurrentProcess()),
            "image": native.image(native.k.GetCurrentProcess()),
        }
        record = {
            "schemaVersion": 1,
            "classification": "renderer-postmortem-gate",
            "diagnosticOnly": True,
            "qualified": False,
            "sourceRevision": config["sourceRevision"],
            "nonce": nonce,
            "configSha256": args.config_sha256,
            "host": host,
            "startedTick": native.k.GetTickCount64(),
            "target": {"pid": args.pid},
            "jitInfoAddress": hex(args.jit_info),
            "eventSignaledByGate": False,
            "eventInheritedByCdb": False,
            "eventHandleClosed": False,
            "targetExecutionChanged": False,
            "admitted": False,
            "error": None,
            "cleanupErrors": [],
            "cdb": None,
        }
        basename = f"{host['pid']}-{host['creationFiletime']}"
        result_path = root + "\\reports\\gate-" + basename + ".json"
        save_new(
            root + "\\reports\\host-" + basename + ".json",
            {
                **record,
                "classification": "renderer-postmortem-gate-host",
                "hostExitProved": False,
            },
        )
        stage = "adopt-aedebug-event"
        # Check its type before taking ownership; no wait that could reset an event.
        record["eventBefore"] = native.event(args.event_handle)
        event_owned = True
        stage = "verify-pinned-inputs"
        record["pythonIdentity"] = native.file(config["pythonIdentity"])
        require(
            ntpath.normcase(host["image"])
            == ntpath.normcase(config["pythonIdentity"]["path"]),
            "Gate host image differs from pinned Python",
        )
        record["chromeIdentity"] = native.file(config["chromeIdentity"])
        record["cdbIdentity"] = native.file(config["cdbIdentity"])
        record["ownerIdentity"] = native.file(config["ownerIdentity"])
        stage = "admit-renderer"
        target, created = admit_renderer(native, config, args.pid, record["target"])
        record["admitted"] = True
        stage = "claim-bounded-capture-slot"
        record["captureClaim"] = claim_capture(config, host, record["target"])
        stage = "load-pinned-windows-owner"
        spec = importlib.util.spec_from_file_location(
            "postmortem_windows_owner", config["ownerIdentity"]["path"]
        )
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        command, prefix = cdb_command(config, args.pid, args.jit_info, created)
        record["dumpPrefix"] = prefix
        stage = "capture-noninvasively"
        record["cdb"] = run_cdb(
            command, cdb_environment(config), root, job_class(owner)(), deadline
        )
        record["target"]["liveAfterCapture"] = native.live(target)
        require(
            native.generation(target) == created, "Held renderer generation changed"
        )
        record["dumps"] = dumps_for(prefix)
        require(
            record["cdb"]["operationSucceeded"], "CDB capture did not complete cleanly"
        )
        require(
            len(record["dumps"]) == 1 and record["dumps"][0]["withinParserBound"],
            "Expected one bounded dump for the existing parser",
        )
        exit_code = 0
    except Exception as error:
        if record is not None:
            record["error"] = detail(error, stage)
        else:
            print(
                json.dumps(
                    {
                        "classification": "renderer-postmortem-gate-admission-failure",
                        "error": detail(error, stage),
                        "hostExitProved": False,
                        "eventSignaledByGate": False,
                    }
                ),
                file=sys.stderr,
            )
    finally:
        if native is not None:
            for handle in native.handles.copy():
                native.close(handle)
            if event_owned:
                try:
                    record["eventAfter"] = native.event(args.event_handle)
                except Exception as error:
                    record["cleanupErrors"].append(
                        detail(error, "observe-final-event-state")
                    )
                record["eventHandleClosed"] = native.close(args.event_handle)
            if record is not None:
                record["cleanupErrors"].extend(native.close_errors)
                record["ownedHandlesClosed"] = (
                    not native.handles and not native.close_errors
                )
                record["completedTick"] = native.k.GetTickCount64()
        if record is not None:
            record["elapsedMs"] = (time.monotonic() - STARTED) * 1000
            record["operationSucceeded"] = (
                exit_code == 0
                and record["eventHandleClosed"]
                and record.get("ownedHandlesClosed") is True
                and not record["cleanupErrors"]
            )
            exit_code = 0 if record["operationSucceeded"] else 1
            try:
                save_new(result_path, record)
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "classification": "renderer-postmortem-gate-receipt-failure",
                            "host": record["host"],
                            "error": detail(error, "save-result"),
                            "hostExitProved": False,
                        }
                    ),
                    file=sys.stderr,
                )
                exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
