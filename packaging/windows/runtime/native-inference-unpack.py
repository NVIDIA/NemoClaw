# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Extract already SHA-256-verified native archives into a new private directory."""

import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
import zipfile


def extract(archives, destination):
    target = Path(destination)
    target.mkdir(exist_ok=False)
    seen = set()
    total = 0
    written = []
    for archive in archives:
        with zipfile.ZipFile(archive) as source:
            entries = source.infolist()
            if len(entries) > 256:
                raise ValueError("The native archive contains too many entries")
            for entry in entries:
                name = PurePosixPath(entry.filename)
                mode = entry.external_attr >> 16
                if (entry.flag_bits & 1 or name.is_absolute() or ".." in name.parts
                        or "\\" in entry.filename or ":" in entry.filename
                        or "\x00" in entry.filename or stat.S_ISLNK(mode)):
                    raise ValueError("The native archive contains an unsafe entry")
                if entry.is_dir():
                    continue
                # Release archives may have one containing folder. Only their
                # native binaries/libraries and license text are materialized.
                if len(name.parts) > 2 or not name.name or name.name.endswith((".", " ")):
                    raise ValueError("The native archive has an unexpected layout")
                suffix = Path(name.name).suffix.lower()
                if suffix not in {".dll", ".exe", ".txt", ".md"} and name.name.casefold() not in {"license", "copying", "copyright"}:
                    raise ValueError("The native archive contains an unexpected file type")
                key = name.name.casefold()
                if key in seen:
                    raise ValueError("The native archives contain a duplicate destination")
                seen.add(key)
                total += entry.file_size
                if entry.file_size > 1024**3 or total > 2 * 1024**3:
                    raise ValueError("The native archives exceed their extraction limit")
                output = target / name.name
                copied = 0
                with source.open(entry) as stream, output.open("xb") as sink:
                    while chunk := stream.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > entry.file_size:
                            raise ValueError("The native archive exceeded its declared size")
                        sink.write(chunk)
                if copied != entry.file_size:
                    raise ValueError("The native archive entry is truncated")
                if suffix in {".dll", ".exe"}:
                    with output.open("rb") as executable:
                        if executable.read(2) != b"MZ":
                            raise ValueError("The native executable lacks a PE header")
                        executable.seek(0x3C)
                        pe_offset = struct.unpack("<I", executable.read(4))[0]
                        if pe_offset > entry.file_size - 6:
                            raise ValueError("The native executable has an invalid PE offset")
                        executable.seek(pe_offset)
                        if executable.read(4) != b"PE\0\0" or struct.unpack("<H", executable.read(2))[0] != 0xAA64:
                            raise ValueError("The native executable is not Windows ARM64")
                written.append(name.name)
    required = {"llama-server.exe", "ggml-cuda.dll", "llama.dll"}
    if not required.issubset(seen) or not any(name.startswith("cudart64_") for name in seen):
        raise ValueError("The native CUDA runtime is incomplete")
    return {"schemaVersion": 1, "files": written, "expandedBytes": total, "architecture": "arm64"}


if __name__ == "__main__":
    if len(sys.argv) != 4 or os.name != "nt":
        raise SystemExit("Native Windows and two pinned runtime archives are required")
    print(json.dumps(extract(sys.argv[1:3], sys.argv[3]), separators=(",", ":")))
