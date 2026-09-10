# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read shipped pyc headers with the exact target interpreter, after timing runs.

No bytecode is unmarshalled or executed. Header/source agreement is not a claim
that an import used the cache; correlate actual .py/.pyc opens in the ETW replay.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys


def ordinary_path(file: Path, root: Path) -> os.stat_result | None:
    """Reject links before reading any source, including an unvisited sibling."""
    if not file.is_relative_to(root):
        raise ValueError("Bytecode source escaped the audited root")
    current = root
    info = current.lstat()
    for part in ("", *file.relative_to(root).parts):
        if part:
            current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("Bytecode audit does not follow reparse/symbolic links")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Bytecode/source must be an ordinary file")
    return info


def inspect_bytecode(file: Path, root: Path) -> dict[str, object]:
    ordinary_path(file, root)
    with file.open("rb") as stream:
        header = stream.read(16)
    record: dict[str, object] = {
        "path": str(file.relative_to(root)),
        "headerHex": header.hex(),
        "magic": header[:4].hex(),
        "interpreterMagicMatches": header[:4] == importlib.util.MAGIC_NUMBER,
        "usedByImport": None,
    }
    if len(header) != 16:
        return {**record, "mode": "invalid-short-header", "sourceMatches": False}
    flags = struct.unpack_from("<I", header, 4)[0]
    if flags & ~3:
        return {**record, "flags": flags, "mode": "invalid-flags", "sourceMatches": False}
    try:
        source = Path(importlib.util.source_from_cache(str(file)))
    except ValueError:
        source = file.with_suffix(".py")
    if not source.is_relative_to(root):
        raise ValueError("Bytecode source escaped the audited root")
    info = ordinary_path(source, root)
    record.update(flags=flags, source=str(source.relative_to(root)), sourceExists=info is not None)
    if flags & 1:
        expected_hash = header[8:16].hex()
        record.update(mode="checked-hash" if flags & 2 else "unchecked-hash", storedSourceHash=expected_hash)
        if info is not None and record["interpreterMagicMatches"]:
            if info.st_size > 32 * 1024 * 1024:
                raise ValueError("Bytecode source exceeds the audit bound")
            actual = importlib.util.source_hash(source.read_bytes()).hex()
            record.update(actualSourceHash=actual, sourceMatches=actual == expected_hash)
        else:
            record["sourceMatches"] = None
    else:
        timestamp, size = struct.unpack_from("<II", header, 8)
        record.update(mode="timestamp", storedSourceMtime=timestamp, storedSourceSize=size)
        if info is not None:
            actual_time = int(info.st_mtime) & 0xFFFFFFFF
            actual_size = info.st_size & 0xFFFFFFFF
            record.update(actualSourceMtime=actual_time, actualSourceSize=actual_size,
                          sourceMatches=timestamp == actual_time and size == actual_size)
        else:
            record["sourceMatches"] = None
    return record


def audit(root: Path) -> dict[str, object]:
    root = Path(os.path.abspath(root))
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        raise ValueError("The audit root must be an ordinary directory")
    records = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            value = Path(directory) / name
            info = value.lstat()
            if value.is_symlink() or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
                raise ValueError("Bytecode inventory does not follow reparse/symbolic links")
        for name in files:
            if name.endswith(".pyc"):
                records.append(inspect_bytecode(Path(directory) / name, root))
                if len(records) > 100000:
                    raise ValueError("Bytecode inventory exceeds its bound")
    return {
        "schemaVersion": 1, "classification": "shipped-python-bytecode-header-audit",
        "interpreter": sys.executable, "pythonVersion": sys.version,
        "interpreterMagic": importlib.util.MAGIC_NUMBER.hex(),
        "root": str(root), "files": records, "count": len(records),
        "sourceMatches": sum(row.get("sourceMatches") is True for row in records),
        "sourceMismatches": sum(row.get("sourceMatches") is False for row in records),
        "actualCacheUse": "unknown until actual read events are inspected",
        "dontWriteBytecodeDoesNotDisableReads": True,
        "timingSample": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Use the exact installed Windows interpreter for the actual artifact audit")
    result = audit(args.root)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(result, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
