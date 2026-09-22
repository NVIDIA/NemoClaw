# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import errno
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

VERSION = 1
MAX_INPUT_BYTES = 32768
MAX_PATTERNS = 16
MAX_PATTERN_BYTES = 4096
MAX_PATHS = 16
MAX_FILE_BYTES = 1048576
MAX_FILE_CATEGORY_BYTES = 2097152
MAX_PROCESS_ITEMS = 512
MAX_PROCESS_ITEM_BYTES = 262144
MAX_PROCESS_CATEGORY_BYTES = 4194304
MAX_SCAN_WINDOWS = 8000000
CATEGORIES = ("credentialFiles", "configFiles", "processEnvironment", "processArguments")


def empty_category(error):
    return {
        "status": "error",
        "itemsScanned": 0,
        "bytesScanned": 0,
        "matches": [],
        "errors": [error],
    }


def emit_input_error(error):
    print(
        json.dumps(
            {
                "version": VERSION,
                "status": "error",
                "categories": {name: empty_category(error) for name in CATEGORIES},
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    raise SystemExit(2)


def read_input():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        emit_input_error("input-limit-exceeded")
    try:
        value = json.loads(raw)
    except Exception:
        emit_input_error("invalid-input")
    if not isinstance(value, dict) or set(value) != {
        "version",
        "patterns",
        "credentialFiles",
        "configFiles",
        "procRoot",
    }:
        emit_input_error("invalid-input")
    if value.get("version") != VERSION:
        emit_input_error("invalid-input")
    patterns = value.get("patterns")
    if not isinstance(patterns, list) or not patterns or len(patterns) > MAX_PATTERNS:
        emit_input_error("invalid-patterns")
    names = set()
    for pattern in patterns:
        if not isinstance(pattern, dict) or set(pattern) != {
            "name",
            "byteLength",
            "sha256",
            "byteSum",
        }:
            emit_input_error("invalid-patterns")
        name = pattern.get("name")
        width = pattern.get("byteLength")
        expected = pattern.get("sha256")
        byte_sum = pattern.get("byteSum")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9 -]{0,63}", name):
            emit_input_error("invalid-patterns")
        if name in names or not isinstance(width, int) or isinstance(width, bool):
            emit_input_error("invalid-patterns")
        if width < 8 or width > MAX_PATTERN_BYTES:
            emit_input_error("invalid-patterns")
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            emit_input_error("invalid-patterns")
        if not isinstance(byte_sum, int) or isinstance(byte_sum, bool):
            emit_input_error("invalid-patterns")
        if byte_sum < 0 or byte_sum > 255 * width:
            emit_input_error("invalid-patterns")
        names.add(name)
    for field in ("credentialFiles", "configFiles"):
        paths = value.get(field)
        if not isinstance(paths, list) or not paths or len(paths) > MAX_PATHS:
            emit_input_error("invalid-paths")
        if any(
            not isinstance(path, str) or not path.startswith("/") or "\n" in path
            for path in paths
        ):
            emit_input_error("invalid-paths")
    proc_root = value.get("procRoot")
    if not isinstance(proc_root, str) or not proc_root.startswith("/") or "\n" in proc_root:
        emit_input_error("invalid-paths")
    return value, patterns


class ScanWorkLimitExceeded(Exception):
    pass


def matches(data, patterns, scan_budget):
    work = sum(max(0, len(data) - pattern["byteLength"] + 1) for pattern in patterns)
    if work > scan_budget["remaining"]:
        raise ScanWorkLimitExceeded
    scan_budget["remaining"] -= work
    found = set()
    for pattern in patterns:
        width = pattern["byteLength"]
        expected = pattern["sha256"]
        if width > len(data):
            continue
        expected_sum = pattern["byteSum"]
        window_sum = sum(data[:width])
        for offset in range(len(data) - width + 1):
            if (
                window_sum == expected_sum
                and hashlib.sha256(data[offset : offset + width]).hexdigest() == expected
            ):
                found.add(pattern["name"])
                break
            next_offset = offset + width
            if next_offset < len(data):
                window_sum += data[next_offset] - data[offset]
    return sorted(found)


def category_result(items, total_bytes, found, errors):
    unique_matches = sorted(set(found))
    unique_errors = sorted(set(errors))
    status = "error" if unique_errors else ("leak" if unique_matches else "clean")
    return {
        "status": status,
        "itemsScanned": items,
        "bytesScanned": total_bytes,
        "matches": unique_matches,
        "errors": unique_errors,
    }


def scan_files(paths, patterns, scan_budget):
    found = []
    errors = []
    items = 0
    total_bytes = 0
    for raw_path in paths:
        descriptor = None
        try:
            descriptor = os.open(raw_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                errors.append("unsafe-file-boundary")
                continue
            handle = os.fdopen(descriptor, "rb")
            descriptor = None
            with handle:
                data = handle.read(MAX_FILE_BYTES + 1)
        except FileNotFoundError:
            errors.append("required-file-missing")
            continue
        except OSError as error:
            errors.append(
                "unsafe-file-boundary"
                if error.errno == errno.ELOOP
                else "file-read-failed"
            )
            continue
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if len(data) > MAX_FILE_BYTES:
            errors.append("file-item-limit-exceeded")
            continue
        if total_bytes + len(data) > MAX_FILE_CATEGORY_BYTES:
            errors.append("file-category-limit-exceeded")
            continue
        items += 1
        total_bytes += len(data)
        try:
            found.extend(matches(data, patterns, scan_budget))
        except ScanWorkLimitExceeded:
            errors.append("scan-work-limit-exceeded")
    if items == 0:
        errors.append("required-file-boundary-empty")
    return category_result(items, total_bytes, found, errors)


def scan_processes(proc_root, member, patterns, scan_budget):
    found = []
    errors = []
    items = 0
    total_bytes = 0
    root = pathlib.Path(proc_root)
    try:
        processes = sorted(
            (path for path in root.iterdir() if path.name.isdigit()),
            key=lambda path: int(path.name),
        )
    except Exception:
        return category_result(0, 0, [], ["process-root-read-failed"])
    if len(processes) > MAX_PROCESS_ITEMS:
        errors.append("process-count-limit-exceeded")
        processes = processes[:MAX_PROCESS_ITEMS]
    for process in processes:
        path = process / member
        try:
            with path.open("rb") as handle:
                data = handle.read(MAX_PROCESS_ITEM_BYTES + 1)
        # Sandbox visibility is the retained contract. Kernel ptrace policy and
        # native-agent ownership intentionally keep some /proc entries outside it.
        # The category still fails closed below when no entry is readable.
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        except Exception:
            continue
        if len(data) > MAX_PROCESS_ITEM_BYTES:
            errors.append("process-item-limit-exceeded")
            continue
        if total_bytes + len(data) > MAX_PROCESS_CATEGORY_BYTES:
            errors.append("process-category-limit-exceeded")
            continue
        items += 1
        total_bytes += len(data)
        try:
            found.extend(matches(data, patterns, scan_budget))
        except ScanWorkLimitExceeded:
            errors.append("scan-work-limit-exceeded")
    if items == 0:
        errors.append("required-process-boundary-empty")
    return category_result(items, total_bytes, found, errors)


payload, patterns = read_input()
scan_budget = {"remaining": MAX_SCAN_WINDOWS}
categories = {
    "credentialFiles": scan_files(payload["credentialFiles"], patterns, scan_budget),
    "configFiles": scan_files(payload["configFiles"], patterns, scan_budget),
    "processEnvironment": scan_processes(
        payload["procRoot"],
        "environ",
        patterns,
        scan_budget,
    ),
    "processArguments": scan_processes(
        payload["procRoot"],
        "cmdline",
        patterns,
        scan_budget,
    ),
}
statuses = {category["status"] for category in categories.values()}
status = "error" if "error" in statuses else ("leak" if "leak" in statuses else "clean")
print(
    json.dumps(
        {
            "version": VERSION,
            "status": status,
            "categories": categories,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
raise SystemExit(0 if status == "clean" else (3 if status == "leak" else 2))
