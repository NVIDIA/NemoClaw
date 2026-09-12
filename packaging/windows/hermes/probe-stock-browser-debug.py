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
MAX_HANDLE_SCAN = 512
INITIAL_HANDLES = (
    "requestCrashDump",
    "requestNonCrashDump",
    "nonCrashDumpCompleted",
    "firstPipeInstance",
    "clientProcess",
)


def initial_client_handles(command):
    matches = re.findall(
        r'(?:^|\s)"?--initial-client-data=([^"\s]+)"?(?=\s|$)', command
    )
    if not matches:
        return None
    owner.require(len(matches) == 1, "Repeated initial-client-data")
    parts = matches[0].split(",")
    owner.require(
        len(parts) == 8
        and all(re.fullmatch(r"0x[0-9a-fA-F]{1,16}", value) for value in parts),
        "Unexpected numeric initial-client-data",
    )
    values = [int(value, 16) for value in parts[:5]]
    owner.require(
        all(0 <= value < 0xFFFFFFFF for value in values),
        "Unexpected initial-client handle width",
    )
    return dict(
        zip(INITIAL_HANDLES, values)
    )  # The three client addresses are intentionally not retained.


class SnapshotHandleEntry(c.Structure):
    _fields_ = [
        ("handle", c.c_void_p),
        ("flags", c.c_uint32),
        ("object_type", c.c_uint32),
        ("capture_time", c.c_uint64),
        ("attributes", c.c_uint32),
        ("access", c.c_uint32),
        ("handle_count", c.c_uint32),
        ("pointer_count", c.c_uint32),
        ("paged", c.c_uint32),
        ("nonpaged", c.c_uint32),
        ("creation_time", c.c_uint64),
        ("type_length", c.c_uint16),
        ("type_name", c.c_void_p),
        ("name_length", c.c_uint16),
        ("name", c.c_void_p),
        ("specific", c.c_uint64 * 6),
    ]


def startup_handles(header):
    owner.require(len(header) == 56, "Incomplete Win64 process-parameter prefix")
    maximum, length, flags, _debug = struct.unpack_from("<IIII", header)
    owner.require(
        56 <= length <= maximum <= 1024 * 1024,
        "Unexpected Win64 process-parameter length",
    )
    return {
        "parameterFlags": flags,
        "consoleFlags": struct.unpack_from("<I", header, 24)[0],
        "values": {
            key: struct.unpack_from("<Q", header, offset)[0]
            for key, offset in (
                ("console", 16),
                ("stdin", 32),
                ("stdout", 40),
                ("stderr", 48),
            )
        },
    }


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


class DebugStringInfo(c.Structure):
    _fields_ = [
        ("address", c.c_void_p),
        ("unicode", c.c_uint16),
        ("length", c.c_uint16),
    ]


class EventData(c.Union):
    _fields_ = [
        ("exception", ExceptionInfo),
        ("process", ProcessInfo),
        ("dll", LoadInfo),
        ("exit_code", c.c_uint32),
        ("unload_base", c.c_void_p),
        ("string", DebugStringInfo),
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
        self.event_history_exceeded = False
        self.observation_errors = []
        self.debug_started = False
        self.saw_process = False
        self.debug_complete = False
        self.chrome_seen = False
        self.appcontainer_seen = False
        self.last_fault = None
        self.first_fault = None
        self.first_unhandled = None
        self.handle_observations = 0
        self.handle_cleanup_errors = []
        self.reconciled_exits = []
        self.debug_string_count = 0
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
        self.kernel.GetCurrentProcess.restype = c.c_void_p
        self.kernel.DuplicateHandle.argtypes = [
            c.c_void_p,
            c.c_void_p,
            c.c_void_p,
            c.POINTER(c.c_void_p),
            c.c_uint32,
            c.c_int,
            c.c_uint32,
        ]
        self.kernel.DuplicateHandle.restype = c.c_int
        self.kernel.GetFileType.argtypes = [c.c_void_p]
        self.kernel.GetFileType.restype = c.c_uint32
        self.nt.NtQueryObject.argtypes = [
            c.c_void_p,
            c.c_uint32,
            c.c_void_p,
            c.c_uint32,
            c.POINTER(c.c_uint32),
        ]
        self.nt.NtQueryObject.restype = c.c_int32
        self.snapshot_api = all(
            hasattr(self.kernel, name)
            for name in (
                "PssCaptureSnapshot",
                "PssWalkMarkerCreate",
                "PssWalkSnapshot",
                "PssWalkMarkerFree",
                "PssFreeSnapshot",
            )
        )
        if self.snapshot_api:
            for name, args in {
                "PssCaptureSnapshot": [
                    c.c_void_p,
                    c.c_uint32,
                    c.c_uint32,
                    c.POINTER(c.c_void_p),
                ],
                "PssWalkMarkerCreate": [c.c_void_p, c.POINTER(c.c_void_p)],
                "PssWalkSnapshot": [
                    c.c_void_p,
                    c.c_uint32,
                    c.c_void_p,
                    c.c_void_p,
                    c.c_uint32,
                ],
                "PssWalkMarkerFree": [c.c_void_p],
                "PssFreeSnapshot": [c.c_void_p, c.c_void_p],
            }.items():
                method = getattr(self.kernel, name)
                method.argtypes = args
                method.restype = c.c_uint32

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
                    if value["chromeRole"] == "utility":
                        services = re.findall(
                            r'(?:^|\s)"?--utility-sub-type=([A-Za-z0-9_.-]{1,128})"?(?=\s|$)',
                            command,
                        )
                        value["utilitySubType"] = (
                            services[0] if len(services) == 1 else None
                        )
                    if value["chromeRole"] == "crashpad-handler":
                        value["initialClientHandles"] = initial_client_handles(command)
        return value

    def read_memory(self, process, address, size):
        data = c.create_string_buffer(size)
        read = c.c_size_t()
        self.checked(
            self.kernel.ReadProcessMemory(process, address, data, size, c.byref(read))
        )
        owner.require(read.value == size, "Incomplete startup metadata read")
        return data.raw

    def startup_state(self, process):
        try:
            basic = ProcessBasic()
            needed = c.c_uint32()
            status = self.nt.NtQueryInformationProcess(
                process, 0, c.byref(basic), c.sizeof(basic), c.byref(needed)
            )
            owner.require(
                status == 0 and basic.peb,
                "ProcessBasicInformation status " + hex(status & 0xFFFFFFFF),
            )
            parameters = struct.unpack(
                "<Q", self.read_memory(process, basic.peb + 0x20, 8)
            )[0]
            owner.require(
                parameters != 0 and parameters % 8 == 0,
                "Invalid Win64 process-parameter pointer",
            )
            return {
                "layout": "Win64 process parameters console/std prefix",
                **startup_handles(self.read_memory(process, parameters, 56)),
            }
        except Exception as error:
            return {"error": owner.detail(error), "values": {}}

    def handle_snapshot(self, process, wanted):
        result = {
            "available": self.snapshot_api,
            "captureFlags": 0x14,
            "complete": False,
            "rows": {},
            "cleanupErrors": [],
        }
        if not self.snapshot_api:
            return result
        snapshot, marker = c.c_void_p(), c.c_void_p()
        captured = marker_created = False
        try:
            result["captureStatus"] = self.kernel.PssCaptureSnapshot(
                process, 0x14, 0, c.byref(snapshot)
            )
            if result["captureStatus"] != 0:
                return result
            captured = True
            result["markerStatus"] = self.kernel.PssWalkMarkerCreate(
                None, c.byref(marker)
            )
            if result["markerStatus"] != 0:
                return result
            marker_created = True
            for _ in range(MAX_HANDLE_SCAN):
                entry = SnapshotHandleEntry()
                status = self.kernel.PssWalkSnapshot(
                    snapshot, 2, marker, c.byref(entry), c.sizeof(entry)
                )
                result["walkStatus"] = status
                if status == 259:
                    result["complete"] = True
                    break
                if status != 0:
                    break
                value = entry.handle or 0
                if value in wanted:
                    row = {"present": True, "validFields": entry.flags}
                    if entry.flags & 4:
                        row.update(
                            attributes=entry.attributes, grantedAccess=hex(entry.access)
                        )
                    if entry.flags & 1:
                        row["objectType"] = entry.object_type
                    result["rows"][hex(value)] = row
            if result["complete"]:
                for value in wanted:
                    result["rows"].setdefault(hex(value), {"present": False})
        finally:
            if marker_created and marker.value:
                status = self.kernel.PssWalkMarkerFree(marker)
                if status:
                    error = {"PssWalkMarkerFree": status}
                    result["cleanupErrors"].append(error)
                    if len(self.handle_cleanup_errors) < 8:
                        self.handle_cleanup_errors.append(error)
            if captured and snapshot.value:
                status = self.kernel.PssFreeSnapshot(
                    self.kernel.GetCurrentProcess(), snapshot
                )
                if status:
                    error = {"PssFreeSnapshot": status}
                    result["cleanupErrors"].append(error)
                    if len(self.handle_cleanup_errors) < 8:
                        self.handle_cleanup_errors.append(error)
        return result

    def handle_type(self, process, value):
        if value == 0 or value >= 0xFFFFFFFFFFFFFFF0:
            return {"pseudoOrNull": True, "duplicateAttempted": False}
        duplicate = c.c_void_p()
        result = {"duplicateAttempted": True}
        if not self.kernel.DuplicateHandle(
            process,
            value,
            self.kernel.GetCurrentProcess(),
            c.byref(duplicate),
            0,
            False,
            2,
        ):
            result["duplicateError"] = c.get_last_error()
            result["sourceHandleExists"] = (
                False if result["duplicateError"] == 6 else None
            )
            return result
        result["duplicateError"] = 0
        result["sourceHandleExists"] = True
        try:
            c.set_last_error(0)
            kind = self.kernel.GetFileType(duplicate)
            result["fileType"] = kind
            result["fileTypeError"] = c.get_last_error() if kind == 0 else 0
            if (
                kind == 2
            ):  # Only character handles need a bounded NUL-versus-console name check.
                data = c.create_string_buffer(1024)
                needed = c.c_uint32()
                status = self.nt.NtQueryObject(
                    duplicate, 1, data, len(data), c.byref(needed)
                )
                result["nameQueryStatus"] = hex(status & 0xFFFFFFFF)
                if status == 0:
                    name = UnicodeString.from_buffer(data)
                    begin = c.addressof(data)
                    end = begin + len(data)
                    if (
                        name.buffer
                        and name.length % 2 == 0
                        and begin <= name.buffer <= end
                        and name.length <= end - name.buffer
                    ):
                        text = c.string_at(name.buffer, name.length).decode(
                            "utf-16-le", errors="strict"
                        )
                        result["isNullDevice"] = text.casefold() == "\\device\\null"
                        result["characterObjectName"] = text[:256]
        finally:
            if not self.kernel.CloseHandle(duplicate):
                result["duplicateCloseError"] = c.get_last_error()
                if len(self.handle_cleanup_errors) < 8:
                    self.handle_cleanup_errors.append(
                        {"duplicateCloseError": result["duplicateCloseError"]}
                    )
        return result

    def observe_startup_handles(self, process, parent, initial, stage, previous=()):
        if self.handle_observations >= 16:
            return {"bounded": True}
        self.handle_observations += 1
        result = {
            "stage": stage,
            "queryOnly": True,
            "parentMayRunConcurrently": True,
            "initialClientHandles": {
                key: hex(value) for key, value in (initial or {}).items()
            },
            "processes": {},
        }
        states = {"handler": self.startup_state(process)}
        if parent:
            states["parent"] = self.startup_state(parent)
        wanted = set((initial or {}).values()) | set(previous)
        for state in states.values():
            wanted.update(state["values"].values())
        result["selectedValues"] = [hex(value) for value in sorted(wanted)]
        for role, handle in (("handler", process), ("parent", parent)):
            if not handle:
                continue
            state = states[role]
            snapshot = self.handle_snapshot(handle, wanted)
            result["processes"][role] = {
                "startup": {
                    **state,
                    "values": {
                        key: hex(value) for key, value in state["values"].items()
                    },
                },
                "snapshot": snapshot,
                "selectedHandles": {
                    hex(value): self.handle_type(handle, value)
                    for value in sorted(wanted)
                },
            }
        return result

    def chrome_startup_metadata(self, handle, image, metadata):
        # Optional metadata on the already owned CREATE_PROCESS handle only.
        # Capture failures consume their slot and never become observer failures.
        if (image.get("name") or "").lower() != "chrome.exe" or metadata.get(
            "ownedJobMember"
        ) is not True:
            return None
        role = metadata.get("chromeRole")
        if role is None:
            role = "browser" if "chromeRole" in metadata else "unknown"
        counts = getattr(self, "startup_policy_counts", {})
        if counts.get(role, 0) >= 2 or sum(counts.values()) >= 10:
            return None
        counts[role] = counts.get(role, 0) + 1
        self.startup_policy_counts = counts
        result = {
            "stage": "CREATE_PROCESS_DEBUG_EVENT",
            "readOnly": True,
            "chromeRole": role,
            "utilitySubType": metadata.get("utilitySubType"),
            "roleSample": counts[role],
            "totalSample": sum(counts.values()),
            "architecture": {
                "api": "IsWow64Process2",
                "available": False,
                "attempted": False,
                "succeeded": False,
                "win32Error": None,
                "processMachine": None,
                "nativeMachine": None,
            },
            "policies": {},
        }
        architecture = result["architecture"]
        try:
            query = getattr(self.kernel, "IsWow64Process2", None)
            architecture["available"] = query is not None
            if query is not None:
                query.argtypes = [
                    c.c_void_p,
                    c.POINTER(c.c_uint16),
                    c.POINTER(c.c_uint16),
                ]
                query.restype = c.c_int
                process_machine, native_machine = c.c_uint16(), c.c_uint16()
                architecture["attempted"] = True
                ok = bool(
                    query(handle, c.byref(process_machine), c.byref(native_machine))
                )
                architecture["succeeded"] = ok
                architecture["win32Error"] = 0 if ok else c.get_last_error()
                if ok:
                    architecture["processMachine"] = f"0x{process_machine.value:04x}"
                    architecture["nativeMachine"] = f"0x{native_machine.value:04x}"
        except Exception as error:
            architecture["error"] = owner.detail(error)
        for name, policy in (
            ("dynamicCode", 2),
            ("win32k", 4),
            ("cfg", 7),
            ("signature", 8),
            ("imageLoad", 10),
            ("childProcess", 13),
        ):
            row = {
                "enum": policy,
                "bufferBytes": 4,
                "available": False,
                "attempted": False,
                "succeeded": False,
                "win32Error": None,
                "flags": None,
                "flagsHex": None,
            }
            result["policies"][name] = row
            try:
                query = getattr(self.kernel, "GetProcessMitigationPolicy", None)
                row["available"] = query is not None
                if query is None:
                    continue
                query.argtypes = [c.c_void_p, c.c_int, c.c_void_p, c.c_size_t]
                query.restype = c.c_int
                flags = c.c_uint32()
                row["attempted"] = True
                ok = bool(query(handle, policy, c.byref(flags), c.sizeof(flags)))
                row["succeeded"] = ok
                row["win32Error"] = 0 if ok else c.get_last_error()
                if ok:
                    row["flags"] = flags.value
                    row["flagsHex"] = f"0x{flags.value:08x}"
            except Exception as error:
                row["error"] = owner.detail(error)
        return result

    def debug_string(self, process, info):
        # Optional secondary evidence only. Never let an unreadable debug
        # string replace the actual exception or stop event continuation.
        declared = int(info.length) * (2 if info.unicode else 1)
        size = min(declared, 1024)
        row = {
            "unicode": bool(info.unicode),
            "declaredCharacters": int(info.length),
            "requestedBytes": size,
            "readAttempted": False,
            "readSucceeded": False,
            "readBytes": 0,
            "win32Error": None,
            "truncated": declared > size,
            "text": "",
        }
        if not info.address or not size:
            row["unavailable"] = "empty-or-null-buffer"
            return row
        storage = (c.c_ubyte * size)()
        copied = c.c_size_t()
        row["readAttempted"] = True
        try:
            row["readSucceeded"] = bool(
                self.kernel.ReadProcessMemory(
                    process["handle"], info.address, storage, size, c.byref(copied)
                )
            )
            row["win32Error"] = 0 if row["readSucceeded"] else c.get_last_error()
            row["readBytes"] = copied.value
            if copied.value > size:
                row["unavailable"] = "invalid-read-count"
                return row
            row["truncated"] |= copied.value < declared
            count = copied.value - (copied.value % 2 if info.unicode else 0)
            encoding = (
                "utf-16-le"
                if info.unicode
                else ("mbcs" if os.name == "nt" else "latin-1")
            )
            row["text"] = (
                bytes(storage[:count]).decode(encoding, errors="replace").rstrip("\0")
            )
        except Exception as error:
            row["error"] = owner.detail(error)
        return row

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
        # Budget exhaustion loses history, not the identity of the original
        # CREATE_PROCESS handles. Continue tracking/forwarding during cleanup.
        self.event_history_exceeded |= self.event_count > MAX_EVENTS
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
                    "parentPid": metadata.get("parentPid"),
                    "initialClientHandles": metadata.get("initialClientHandles"),
                    "chromeRole": metadata.get("chromeRole"),
                    "invalidHandleObserved": False,
                    "ownedChrome": (image["name"] or "").lower() == "chrome.exe"
                    and metadata.get("ownedJobMember") is True
                    and metadata.get("isAppContainer") is True,
                    "debugStrings": 0,
                }
                row.update(image=image, **metadata)
                startup = self.chrome_startup_metadata(info.process, image, metadata)
                if startup is not None:
                    row["startupPolicies"] = startup
                if metadata.get("chromeRole") == "crashpad-handler":
                    parent = self.processes.get(metadata.get("parentPid"), {}).get(
                        "handle"
                    )
                    row["startupHandles"] = self.observe_startup_handles(
                        info.process,
                        parent,
                        metadata.get("initialClientHandles"),
                        "create",
                    )
                    self.processes[event.pid]["createdHandleValues"] = [
                        int(value, 16)
                        for value in row["startupHandles"].get("selectedValues", [])
                    ]
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
                process = self.processes[event.pid]
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
                    if (
                        info.record.code == 0xC0000008
                        and process.get("chromeRole") == "crashpad-handler"
                        and not process["invalidHandleObserved"]
                    ):
                        process["invalidHandleObserved"] = True
                        parent = self.processes.get(process.get("parentPid"), {}).get(
                            "handle"
                        )
                        row["startupHandles"] = self.observe_startup_handles(
                            process["handle"],
                            parent,
                            process.get("initialClientHandles"),
                            "invalid-handle",
                            process.get("createdHandleValues", []),
                        )
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
            elif event.kind == 8:
                process = self.processes.get(event.pid)
                if (
                    process
                    and process["ownedChrome"]
                    and process["debugStrings"] < 8
                    and self.debug_string_count < 16
                ):
                    process["debugStrings"] += 1
                    self.debug_string_count += 1
                    row["debugString"] = self.debug_string(process, event.data.string)
            # Thread and debug-string events still must be continued. Their
            # handles are OS-owned; debug-string payload is not read.
            if (event.kind in (1, 3, 5, 6, 7, 9) or "debugString" in row) and len(
                self.events
            ) < MAX_EVENTS:
                self.events.append(row)
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

    def reconcile_exited_processes(self):
        # The normal five-second EXIT drain runs first. Some faulted Chrome
        # processes disappear from the Job without an observed EXIT event.
        # Only their original CREATE_PROCESS handle can independently prove
        # termination; job accounting or a reused PID cannot substitute for it.
        for pid in sorted(self.live_debug_pids):
            process = self.processes.get(pid, {})
            row = {
                "pid": pid,
                "createdSequence": process.get("createdSequence"),
                "exitEventObserved": False,
                "sameRetainedCreateProcessHandle": True,
                "waitResult": None,
                "waitError": None,
                "exitCode": None,
                "exitQueryError": None,
                "closureProved": False,
            }
            handle = process.get("handle")
            if handle:
                row["waitResult"] = self.kernel.WaitForSingleObject(handle, 0)
                if row["waitResult"] == 0xFFFFFFFF:
                    row["waitError"] = c.get_last_error()
                elif row["waitResult"] == 0:
                    code = c.c_uint32()
                    if self.kernel.GetExitCodeProcess(handle, c.byref(code)):
                        row["exitCode"] = code.value
                        row["closureProved"] = True
                        self.live_debug_pids.discard(pid)
                    else:
                        row["exitQueryError"] = c.get_last_error()
            self.reconciled_exits.append(row)
        # Debug-event handles stay OS-owned. Do not close them or reopen by PID.
        self.debug_complete = self.saw_process and not self.live_debug_pids


def validate(request):
    primary = request.get("classification") == "personal-MXC-browser-debug-request"
    owner.require(
        request.get("schemaVersion") == 1
        and (
            primary
            or request.get("classification") == "stock-MXC-browser-debug-request"
        ),
        "Unexpected debug request",
    )
    executor, policy = Path(request["executor"]), Path(request["policyFile"])
    if primary:
        proof_reference = request["nativeProof"]
        proof_data = Path(proof_reference["path"]).read_bytes()
        owner.require(
            len(proof_data) <= 4 * 1024 * 1024
            and len(proof_data) == proof_reference["bytes"]
            and owner.hashlib.sha256(proof_data).hexdigest()
            == proof_reference["sha256"],
            "Passed native proof changed",
        )
        proof = json.loads(proof_data)
        owner.require(
            proof.get("passed") is True
            and proof.get("normalCleanup") is True
            and proof.get("phase") == "two-container-isolation",
            "Native compatibility proof did not pass",
        )
        build = proof["inputs"]["mxcBuild"]
        owner.require(
            build["candidateRevision"] == proof["sourceRevision"]
            and len(build["files"]) == 1
            and build["files"][0]["file"] == "wxc-exec.exe",
            "Executor proof identity differs",
        )
        expected_executor = {key: build["files"][0][key] for key in ("bytes", "sha256")}
        owner.require(
            owner.identity(executor) == expected_executor
            and all(
                request["executorIdentity"].get(key) == value
                for key, value in expected_executor.items()
            ),
            "Proved executor bytes differ",
        )
    else:
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
    if primary:
        controller = PureWindowsPath(probe).parent
        owner.require(
            controller.name == "NemoClawPersonalNode-" + nonce[:12],
            "Primary debug controller is not fresh and nonce-bound",
        )
        native = PureWindowsPath(request["nativeRoot"])
        owner.require(
            str(native) in body["filesystem"]["readonlyPaths"]
            or native == PureWindowsPath(runtime) / "mxc-compat",
            "Current native component is not readonly",
        )
        compatibility = proof["inputs"]["compatibility"]
        owner.require(
            compatibility["sourceRevision"] == proof["sourceRevision"]
            and compatibility["status"] == "built",
            "Native DLL source identity differs",
        )
        expected_names = {
            "NemoClawMsysLauncher.exe",
            "NemoClawMsysCompat-arm64.dll",
            "NemoClawMsysCompat-x64.dll",
        }
        owner.require(
            {row["file"] for row in compatibility["files"]} == expected_names
            and len(compatibility["files"]) == 3,
            "Native component file set differs",
        )
        for row in compatibility["files"]:
            owner.require(
                owner.identity(str(native / row["file"]))
                == {key: row[key] for key in ("bytes", "sha256")},
                "Native component bytes differ",
            )
        node = str(controller / "node.exe")
        owner.require(
            owner.identity(node)["sha256"]
            == "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
            "Primary Node identity differs",
        )
        expected = [
            str(native / "NemoClawMsysLauncher.exe"),
            "--",
            node,
            "--experimental-strip-types",
            "--no-warnings",
            str(controller / "probe-personal-workload.mts"),
            runtime,
            str(PureWindowsPath(state) / "result.json"),
            nonce,
            str(controller / "personal-workload-input.json"),
        ]
    owner.require(
        body["process"]["commandLine"]
        == " ".join('"' + value + '"' for value in expected),
        "Debug request does not run its exact canonical workload",
    )
    owner.require(
        runtime in body["filesystem"]["readonlyPaths"]
        and str(PureWindowsPath(probe).parent) in body["filesystem"]["readonlyPaths"],
        "Debug inputs must retain their readonly paths",
    )
    environment = request["environment"]
    owner.require(
        environment.get("GITHUB_ACTIONS") == "true"
        and (
            environment.get("NEMOCLAW_MSYS_TOKEN_INSPECTION") == "repair-query"
            if primary
            else "NEMOCLAW_MSYS_TOKEN_INSPECTION" not in environment
        ),
        "Unexpected debug host environment",
    )
    return [str(executor), str(policy), "--log-file", request["logFile"]], state


def capture(request, native):
    command, state = validate(request)
    started = time.monotonic()
    # The full Personal executor emits both application and native owner
    # evidence. Match its existing 64 KiB + 256 KiB channel budgets in this
    # merged diagnostic pipe; stock browser-only capture stays at 64 KiB.
    primary = request.get("classification") == "personal-MXC-browser-debug-request"
    capture_limits = [
        owner.CAPTURE_BYTES,
        owner.CAPTURE_BYTES + (256 * 1024 if primary else 0),
    ]
    result = {
        "schemaVersion": 1,
        "classification": "personal-MXC-browser-debug-result"
        if request.get("classification") == "personal-MXC-browser-debug-request"
        else "stock-MXC-browser-debug-result",
        "diagnosticOnly": True,
        "canonicalQualification": False,
        "nonce": request["nonce"],
        "policySha256": request["policySha256"],
        "nativeProofSha256": request.get("nativeProof", {}).get("sha256"),
        "captureLimits": dict(zip(("stdout", "stderr"), capture_limits)),
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
        {"bytes": bytearray(), "eof": False, "error": None, "total": 0, "limit": limit}
        for limit in capture_limits
    ]
    readers = []
    stop = threading.Event()
    assigned = False
    stage = "create-job"

    def read(stream, item):
        try:
            while data := stream.read(8192):
                remaining = max(0, item["limit"] - len(item["bytes"]))
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
        stage = "create-debugged-executor"
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
            owner.require(
                not native.event_history_exceeded, "Debug event history bound exceeded"
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
            if (
                result["execution"]["childClosed"]
                and result["cleanup"]["activeProcesses"] == 0
                and not native.observation_errors
                and native.live_debug_pids
            ):
                native.reconcile_exited_processes()
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
        result["cleanup"]["errors"].extend(native.handle_cleanup_errors)
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
        x["total"] > x["limit"] for x in buffers
    )
    result["execution"]["elapsedMs"] = (time.monotonic() - started) * 1000
    result["events"] = native.events
    result["eventHistory"] = {
        "eventLimit": MAX_EVENTS,
        "eventsObserved": native.event_count,
        "rowsRetained": len(native.events),
        "exceeded": native.event_history_exceeded,
    }
    if native.event_history_exceeded and result["execution"]["error"] is None:
        # Overflow can first occur on an EXIT or during cleanup. It still
        # fails this diagnostic, while actual handle closure remains provable.
        result["execution"]["error"] = {
            **owner.detail(ValueError("Debug event history bound exceeded")),
            "stage": "debug-events",
        }
    result["lastForwardedException"] = native.last_fault
    result["firstForwardedException"] = native.first_fault
    result["firstUnhandledException"] = native.first_unhandled
    result["debugObservationErrors"] = native.observation_errors
    result["appContainerDebugEventsObserved"] = native.appcontainer_seen
    result["chromeDebugEventsObserved"] = native.chrome_seen
    result["remainingDebugProcesses"] = list(native.live_debug_pids)
    result["reconciledDebugProcessExits"] = native.reconciled_exits
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
