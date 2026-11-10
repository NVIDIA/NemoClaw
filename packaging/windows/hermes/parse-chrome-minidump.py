# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read bounded exception metadata from one owned dump; never execute its bytes.

Layouts: Microsoft minidumpapiset.h MINIDUMP_HEADER/DIRECTORY/EXCEPTION_STREAM,
MINIDUMP_MODULE (108 bytes), MINIDUMP_THREAD (48 bytes), and WinNT.h AMD64
CONTEXT (1232 bytes, ContextFlags at48, Rsp at152, Rip at248). No symbols or
unwinding are used. Stack words are only candidate addresses in loaded modules.
"""

import hashlib
import math
import os
from pathlib import Path, PureWindowsPath
import stat
import struct
import time

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_STREAMS = 64
MAX_MODULES = 256
MAX_THREADS = 256
MAX_STRING_BYTES = 8192
MAX_CONTEXT_BYTES = 65536
MAX_STACK_WORDS = 128
MAX_CANDIDATES = 16


def _check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("Minidump metadata deadline exceeded")


def _ordinary(value):
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_nlink != 1
        or getattr(value, "st_file_attributes", 0) & 0x400
        or not 32 <= value.st_size <= MAX_FILE_BYTES
    ):
        raise ValueError("Minidump must be one ordinary bounded file")


def _identity(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
        value.st_mode,
        value.st_nlink,
        getattr(value, "st_file_attributes", 0),
    )


def _read_once(path, deadline):
    _check_deadline(deadline)
    before = path.lstat()
    _ordinary(before)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NOINHERIT", 0) | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        _ordinary(opened)
        if _identity(before) != _identity(opened):
            raise ValueError("Minidump identity changed before reading")
        chunks, digest, count = [], hashlib.sha256(), 0
        while count <= opened.st_size:
            _check_deadline(deadline)
            chunk = os.read(descriptor, min(1024 * 1024, opened.st_size + 1 - count))
            if not chunk:
                break
            count += len(chunk)
            if count > opened.st_size:
                raise ValueError("Minidump grew while reading")
            digest.update(chunk)
            chunks.append(chunk)
        after = os.fstat(descriptor)
        _ordinary(after)
        _check_deadline(deadline)
        if count != opened.st_size or _identity(after) != _identity(opened):
            raise ValueError("Minidump changed while reading")
        final_path = path.lstat()
        _ordinary(final_path)
        if _identity(final_path) != _identity(opened):
            raise ValueError("Minidump path changed while reading")
        return b"".join(chunks), digest.hexdigest()
    finally:
        os.close(descriptor)


class _Dump:
    def __init__(self, data, deadline):
        self.data, self.deadline = data, deadline

    def check(self):
        _check_deadline(self.deadline)

    def span(self, offset, length):
        if offset < 0 or length < 0 or offset > len(self.data) - length:
            raise ValueError("Minidump RVA or size is outside the file")
        return memoryview(self.data)[offset : offset + length]

    def unpack(self, format, offset):
        return struct.unpack(format, self.span(offset, struct.calcsize(format)))

    def location(self, offset, cap=MAX_FILE_BYTES):
        size, rva = self.unpack("<II", offset)
        if size > cap:
            raise ValueError("Minidump referenced data exceeds its bound")
        if size:
            self.span(rva, size)
        return rva, size

    def name(self, offset):
        (length,) = self.unpack("<I", offset)
        if length == 0 or length > MAX_STRING_BYTES or length % 2:
            raise ValueError("Minidump module name length is invalid")
        text = bytes(self.span(offset + 4, length)).decode("utf-16-le", "strict")
        if "\x00" in text:
            raise ValueError("Minidump module name contains an embedded NUL")
        name = PureWindowsPath(text).name
        if not name or any(ord(value) < 32 for value in name):
            raise ValueError("Minidump module basename is invalid")
        return name[:128], len(name) > 128


def parse_minidump(path, *, deadline=None):
    """Return metadata only. Deadline is an optional absolute monotonic time.

    Checks surround bounded reads/loops; OS calls themselves are not claimed
    interruptible. The containing process deadline remains the final guard.
    """
    if deadline is not None and (
        not isinstance(deadline, (int, float)) or not math.isfinite(deadline)
    ):
        raise ValueError("Minidump deadline must be finite")
    path = Path(path)
    data, digest = _read_once(path, deadline)
    dump = _Dump(data, deadline)
    signature, version, count, directory, _, timestamp, _ = dump.unpack("<IIIIIIQ", 0)
    if signature != 0x504D444D or version & 0xFFFF != 0xA793 or count > MAX_STREAMS:
        raise ValueError("Minidump header signature/version/stream count is invalid")
    if directory < 32:
        raise ValueError("Minidump directory overlaps its header")
    dump.span(directory, count * 12)
    streams, occupied = {}, [(0, 32), (directory, directory + count * 12)]
    for index in range(count):
        dump.check()
        kind, size, rva = dump.unpack("<III", directory + index * 12)
        if kind in streams:
            raise ValueError("Minidump has duplicate stream types")
        dump.span(rva, size)
        if kind not in (3, 4, 6, 7, 15):
            continue  # Unconsumed/custom streams may repeat; never decode them.
        if size:
            if any(rva < end and begin < rva + size for begin, end in occupied):
                raise ValueError("Minidump stream directory ranges overlap")
            occupied.append((rva, rva + size))
        streams[kind] = (rva, size)

    result = {
        "schemaVersion": 1,
        "classification": "bounded-chrome-minidump",
        "file": {"name": path.name, "bytes": len(data), "sha256": digest},
        "headerTimeDateStamp": timestamp,
        "miscInfo": None,
        "systemInfo": None,
        "exception": None,
        "modules": [],
        "context": {"status": "no-exception-context", "bytes": 0},
        "stack": {
            "status": "no-amd64-context",
            "unwound": False,
            "scannedWords": 0,
            "candidates": [],
        },
    }
    if 15 in streams:
        rva, size = streams[15]
        if size < 8:
            raise ValueError("Minidump MiscInfo stream is truncated")
        declared, flags = dump.unpack("<II", rva)
        if declared < 8 or declared > size:
            raise ValueError("Minidump MiscInfo SizeOfInfo exceeds its stream")
        if flags & 1 and declared < 12 or flags & 2 and declared < 24:
            raise ValueError("Minidump MiscInfo flags require absent fields")
        result["miscInfo"] = {
            "sizeOfInfo": declared,
            "flags1": hex(flags),
            "processId": dump.unpack("<I", rva + 8)[0] if flags & 1 else None,
            "processCreateTime": dump.unpack("<I", rva + 12)[0] if flags & 2 else None,
        }
    if 7 in streams:
        rva, size = streams[7]
        if size < 56:
            raise ValueError("Minidump SystemInfo stream is truncated")
        (arch,) = dump.unpack("<H", rva)
        major, minor, build, platform = dump.unpack("<IIII", rva + 8)
        result["systemInfo"] = {
            "processorArchitecture": arch,
            "architecture": {0: "x86", 5: "arm", 9: "amd64", 12: "arm64"}.get(
                arch, "unsupported"
            ),
            "majorVersion": major,
            "minorVersion": minor,
            "buildNumber": build,
            "platformId": platform,
        }

    modules = []
    if 4 in streams:
        rva, size = streams[4]
        if size < 4:
            raise ValueError("Minidump ModuleList stream is truncated")
        (count,) = dump.unpack("<I", rva)
        if count > MAX_MODULES or 4 + count * 108 > size:
            raise ValueError("Minidump module count/table exceeds its bound")
        for index in range(count):
            dump.check()
            at = rva + 4 + index * 108
            base, length, _, _, name_rva = dump.unpack("<QIIII", at)
            if not length or base + length > 2**64:
                raise ValueError("Minidump module address range is invalid")
            name, truncated = dump.name(name_rva)
            dump.location(at + 76)
            dump.location(at + 84)
            modules.append((base, base + length, name))
            result["modules"].append(
                {
                    "name": name,
                    "base": hex(base),
                    "size": length,
                    "nameTruncated": truncated,
                }
            )
        modules.sort()
        if any(left[1] > right[0] for left, right in zip(modules, modules[1:])):
            raise ValueError("Minidump module address ranges overlap")

    def locate(address):
        for base, end, name in modules:
            if base <= address < end:
                return {"module": name, "base": hex(base), "rva": hex(address - base)}
        return None

    threads = {}
    if 3 in streams:
        rva, size = streams[3]
        if size < 4:
            raise ValueError("Minidump ThreadList stream is truncated")
        (count,) = dump.unpack("<I", rva)
        if count > MAX_THREADS or 4 + count * 48 > size:
            raise ValueError("Minidump thread count/table exceeds its bound")
        for index in range(count):
            dump.check()
            at = rva + 4 + index * 48
            (tid,) = dump.unpack("<I", at)
            (base,) = dump.unpack("<Q", at + 24)
            stack_rva, stack_size = dump.location(at + 32)
            dump.location(at + 40, MAX_CONTEXT_BYTES)
            if tid in threads or base + stack_size > 2**64:
                raise ValueError("Minidump thread identity/stack range is invalid")
            threads[tid] = (base, stack_rva, stack_size)

    if 6 not in streams:
        dump.check()
        return result
    rva, size = streams[6]
    if size < 168:
        raise ValueError("Minidump Exception stream is truncated")
    tid, _, code, flags = dump.unpack("<IIII", rva)
    (address,) = dump.unpack("<Q", rva + 24)
    (parameters,) = dump.unpack("<I", rva + 32)
    if parameters > 15:
        raise ValueError("Minidump exception parameter count exceeds its bound")
    context_rva, context_size = dump.location(rva + 160, MAX_CONTEXT_BYTES)
    result["exception"] = {
        "threadId": tid,
        "code": hex(code),
        "flags": hex(flags),
        "address": hex(address),
        "information": [
            hex(dump.unpack("<Q", rva + 40 + index * 8)[0])
            for index in range(parameters)
        ],
        "location": locate(address),
    }
    context = result["context"]
    context.update(status="unsupported-architecture", bytes=context_size)
    if (result["systemInfo"] or {}).get("processorArchitecture") != 9:
        dump.check()
        return result
    if context_size != 1232:
        context["status"] = "unsupported-amd64-context-size"
        dump.check()
        return result
    (context_flags,) = dump.unpack("<I", context_rva + 48)
    context["flags"] = hex(context_flags)
    # Require the AMD64 architecture tag and CONTROL|INTEGER groups. Never
    # reinterpret ARM64/WOW64 or an extension layout as this fixed CONTEXT.
    if context_flags & 0x00FF0000 != 0x00100000 or context_flags & 3 != 3:
        context["status"] = "unsupported-amd64-context-flags"
        dump.check()
        return result
    names = (
        "Rax",
        "Rcx",
        "Rdx",
        "Rbx",
        "Rsp",
        "Rbp",
        "Rsi",
        "Rdi",
        "R8",
        "R9",
        "R10",
        "R11",
        "R12",
        "R13",
        "R14",
        "R15",
        "Rip",
    )
    registers = dict(zip(names, dump.unpack("<17Q", context_rva + 120)))
    context.update(
        status="amd64", registers={key: hex(value) for key, value in registers.items()}
    )
    context["instructionLocation"] = locate(registers["Rip"])
    stack = result["stack"]
    if tid not in threads:
        stack["status"] = "exception-thread-stack-not-captured"
        dump.check()
        return result
    base, stack_rva, size = threads[tid]
    rsp = registers["Rsp"]
    if rsp % 8 or not base <= rsp < base + size:
        stack["status"] = "rsp-outside-captured-stack"
        dump.check()
        return result
    offset = rsp - base
    words = min(MAX_STACK_WORDS, (size - offset) // 8)
    stack["status"] = "module-address-candidates-not-unwound"
    for index in range(words):
        dump.check()
        (value,) = dump.unpack("<Q", stack_rva + offset + index * 8)
        stack["scannedWords"] += 1
        location = locate(value)
        if location:
            stack["candidates"].append(
                {"stackOffsetBytes": index * 8, "address": hex(value), **location}
            )
            if len(stack["candidates"]) == MAX_CANDIDATES:
                break
    dump.check()
    return result
