# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""One read-only lookup per exact owned desktop after its executor has closed."""

import argparse
import ctypes
import ctypes.wintypes as w
import hashlib
import json
import os
from pathlib import Path
import re


def require(value, message):
    if not value:
        raise ValueError(message)


def validate_request(value):
    require(
        value.get("schemaVersion") == 1
        and value.get("classification") == "post-executor-desktop-absence-request",
        "Unexpected request",
    )
    require(value.get("executorClosed") is True, "Executor closure is required")
    binding = value["binding"]
    require(
        type(binding.get("executorPid")) is int and 0 < binding["executorPid"] < 2**32,
        "Invalid executor identity",
    )
    require(
        re.fullmatch(r"[a-f0-9]{64}", binding.get("requestSha256", "")),
        "Invalid executed request hash",
    )
    require(
        re.fullmatch(r"nm-[a-f0-9]{12}-(?:start|d)", binding.get("containerId", "")),
        "Invalid container identity",
    )
    require(
        type(value.get("hostSession")) is int and 0 <= value["hostSession"] < 2**32,
        "Invalid host session",
    )
    require(
        value.get("stationName", "").casefold() == "winsta0",
        "Expected the same current station",
    )
    require(
        re.fullmatch(r"S-1-5-(?:[0-9]+-)*[0-9]+", value.get("hostUserSid", "")),
        "Missing host account",
    )
    sid = value.get("appContainerSid", "")
    require(
        len(sid) <= 184 and re.fullmatch(r"S-1-15-2-(?:[0-9]+-)*[0-9]+", sid),
        "Invalid AppSID",
    )
    require(
        type(value.get("afterDropTick")) is int and 0 <= value["afterDropTick"] < 2**53,
        "Invalid Drop clock",
    )
    names = value.get("names", [])
    require(
        isinstance(names, list)
        and 0 < len(names) <= 2
        and len(set(names)) == len(names),
        "Invalid owned name set",
    )
    require(
        all(
            name
            in {
                f"NemoClawHermesDesktop-{sid}-default",
                f"NemoClawHermesDesktop-{sid}-low",
            }
            for name in names
        ),
        "Unowned desktop name",
    )
    return value


class WindowsLookup:
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        declarations = [
            (self.kernel, "GetCurrentProcess", [], w.HANDLE),
            (self.kernel, "GetCurrentProcessId", [], w.DWORD),
            (self.kernel, "GetTickCount64", [], ctypes.c_ulonglong),
            (
                self.kernel,
                "ProcessIdToSessionId",
                [w.DWORD, ctypes.POINTER(w.DWORD)],
                w.BOOL,
            ),
            (self.kernel, "CloseHandle", [w.HANDLE], w.BOOL),
            (self.kernel, "LocalFree", [ctypes.c_void_p], ctypes.c_void_p),
            (self.user, "GetProcessWindowStation", [], w.HANDLE),
            (
                self.user,
                "GetUserObjectInformationW",
                [
                    w.HANDLE,
                    ctypes.c_int,
                    ctypes.c_void_p,
                    w.DWORD,
                    ctypes.POINTER(w.DWORD),
                ],
                w.BOOL,
            ),
            (
                self.user,
                "OpenDesktopW",
                [w.LPCWSTR, w.DWORD, w.BOOL, w.DWORD],
                w.HANDLE,
            ),
            (self.user, "CloseDesktop", [w.HANDLE], w.BOOL),
            (
                self.advapi,
                "OpenProcessToken",
                [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)],
                w.BOOL,
            ),
            (
                self.advapi,
                "GetTokenInformation",
                [
                    w.HANDLE,
                    ctypes.c_int,
                    ctypes.c_void_p,
                    w.DWORD,
                    ctypes.POINTER(w.DWORD),
                ],
                w.BOOL,
            ),
            (
                self.advapi,
                "ConvertSidToStringSidW",
                [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                w.BOOL,
            ),
        ]
        for library, name, args, result in declarations:
            function = getattr(library, name)
            function.argtypes, function.restype = args, result

    def context(self):
        result = {
            "pid": self.kernel.GetCurrentProcessId(),
            "tokenHandleClosed": False,
            "sidBufferFreed": False,
        }
        self.context_result = result
        session = w.DWORD()
        if not self.kernel.ProcessIdToSessionId(result["pid"], ctypes.byref(session)):
            raise ctypes.WinError(ctypes.get_last_error())
        result["hostSession"] = session.value
        station = (
            self.user.GetProcessWindowStation()
        )  # Borrowed, never selected or closed.
        name, needed = ctypes.create_unicode_buffer(256), w.DWORD()
        if not station or not self.user.GetUserObjectInformationW(
            station, 2, name, ctypes.sizeof(name), ctypes.byref(needed)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        result["stationName"] = name.value
        token, sid_text = w.HANDLE(), ctypes.c_void_p()
        if not self.advapi.OpenProcessToken(
            self.kernel.GetCurrentProcess(), 8, ctypes.byref(token)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            size = w.DWORD()
            self.advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            require(0 < size.value <= 4096, "Token user read exceeded bound")
            buffer = ctypes.create_string_buffer(size.value)
            if not self.advapi.GetTokenInformation(
                token, 1, buffer, size, ctypes.byref(size)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            sid = ctypes.c_void_p.from_buffer(buffer).value
            if not sid or not self.advapi.ConvertSidToStringSidW(
                sid, ctypes.byref(sid_text)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            result["hostUserSid"] = ctypes.wstring_at(sid_text.value)
        finally:
            if sid_text.value:
                result["sidBufferFreed"] = self.kernel.LocalFree(sid_text) is None
            result["tokenHandleClosed"] = bool(self.kernel.CloseHandle(token))
        require(
            result["tokenHandleClosed"] and result["sidBufferFreed"],
            "Context query handles did not close",
        )
        return result

    def tick(self):
        return self.kernel.GetTickCount64()

    def observe(self, name):
        started = self.tick()
        ctypes.set_last_error(0)
        handle = self.user.OpenDesktopW(name, 0, False, 0x20000)
        error = ctypes.get_last_error() if not handle else 0
        closed, close_error = True, 0
        if handle:
            closed = bool(self.user.CloseDesktop(handle))
            close_error = ctypes.get_last_error() if not closed else 0
        return {
            "name": name,
            "startedTick": started,
            "completedTick": self.tick(),
            "requestedAccess": 0x20000,
            "openFlags": 0,
            "inheritRequested": False,
            "present": bool(handle),
            "openError": error,
            "absent": not handle and error in (2, 3),
            "lookupHandleClosed": closed,
            "closeError": close_error,
        }


def observe(request, api):
    validate_request(request)
    started = api.tick()
    require(started >= request["afterDropTick"], "Observation precedes Drop")
    context = api.context()
    require(
        context["hostSession"] == request["hostSession"]
        and context["stationName"].casefold() == "winsta0"
        and context["hostUserSid"] == request["hostUserSid"],
        "Observer host context differs from the owner",
    )
    rows = [api.observe(name) for name in request["names"]]
    return {
        "schemaVersion": 1,
        "classification": "post-executor-desktop-absence",
        "binding": request["binding"],
        "appContainerSid": request["appContainerSid"],
        "startedTick": started,
        "completedTick": api.tick(),
        "clock": "GetTickCount64",
        "context": context,
        "contextMatched": True,
        "rows": rows,
        "passed": all(
            row["absent"] and row["lookupHandleClosed"] and row["closeError"] == 0
            for row in rows
        ),
        "attemptsPerName": 1,
        "selectionAttempted": False,
        "mutationAttempted": False,
        "enumerationAttempted": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(
        os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
        "Disposable Windows CI only",
    )
    require(
        args.request.is_file()
        and not args.request.is_symlink()
        and args.request.stat().st_size <= 16384,
        "Invalid bounded request",
    )
    require(
        args.output.parent.resolve() == args.request.parent.resolve()
        and not args.output.exists(),
        "Receipt must be fresh beside the request",
    )
    raw = args.request.read_bytes()
    result = {
        "schemaVersion": 1,
        "classification": "post-executor-desktop-absence",
        "passed": False,
        "error": None,
    }
    api = None
    try:
        api = WindowsLookup()
        result.update(observe(json.loads(raw), api))
    except Exception as error:
        result["context"] = getattr(api, "context_result", None)
        result["error"] = {
            "type": type(error).__name__,
            "message": str(error),
            "winerror": getattr(error, "winerror", None),
        }
    result["requestSha256"] = hashlib.sha256(raw).hexdigest()
    with args.output.open("x", encoding="utf-8") as out:
        json.dump(result, out, indent=2)
        out.write("\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
