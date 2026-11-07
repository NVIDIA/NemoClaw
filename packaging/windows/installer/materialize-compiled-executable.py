# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""CI-only: copy a Cargo output into a fresh ordinary packaging input."""

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path


MAX_BYTES = 32 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_path(path, directory=False):
    for part in (path, *path.parents):
        value = part.lstat()
        require(
            not stat.S_ISLNK(value.st_mode)
            and not getattr(value, "st_file_attributes", 0) & 0x400,
            "Compiled inputs cannot traverse a link or reparse point.",
        )
    value = path.lstat()
    require(
        stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode),
        "Compiled inputs must be ordinary files with ordinary parents.",
    )
    return value


def stat_record(value):
    return {
        "device": value.st_dev,
        "fileId": value.st_ino,
        "links": value.st_nlink,
        "bytes": value.st_size,
        "modifiedNanoseconds": value.st_mtime_ns,
        "fileAttributes": getattr(value, "st_file_attributes", None),
    }


def file_identity(value):
    return value.st_dev, value.st_ino, value.st_nlink, value.st_size, value.st_mtime_ns


def fresh(path):
    inspect_path(path.parent, directory=True)
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise FileExistsError("The compiled packaging output must be fresh.")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def materialize(source, output, receipt):
    source, output, receipt = (
        Path(path).absolute() for path in (source, output, receipt)
    )
    # Never overwrite either an existing artifact or its provenance, even on failure.
    fresh(receipt)
    record = {
        "schemaVersion": 1,
        "classification": "ci-native-compiled-artifact",
        "status": "failed",
        "source": str(source),
        "output": str(output),
        "runtimeLaunchCopy": False,
    }
    primary = None
    try:
        before = inspect_path(source)
        record["sourceStatBefore"] = stat_record(before)
        require(
            0 < before.st_size <= MAX_BYTES,
            "Compiled executable exceeds its size bound.",
        )
        fresh(output)
        with source.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            require(
                stat.S_ISREG(opened.st_mode)
                and file_identity(opened) == file_identity(before),
                "Compiled source changed before opening.",
            )
            data = stream.read(MAX_BYTES + 1)
            require(
                len(data) == before.st_size,
                "Compiled source changed during its first read.",
            )
            record["sourceSha256Before"] = digest(data)
            # Exclusive creation writes new bytes; it never asks the filesystem to link.
            with output.open("xb") as destination:
                destination.write(data)
                destination.flush()
                os.fsync(destination.fileno())
                require(
                    os.fstat(destination.fileno()).st_nlink == 1,
                    "Compiled output is not single-link.",
                )
            stream.seek(0)
            after_data = stream.read(MAX_BYTES + 1)
            after_open = os.fstat(stream.fileno())
        after = inspect_path(source)
        copied = inspect_path(output)
        record["sourceStatAfter"] = stat_record(after)
        record["outputStat"] = stat_record(copied)
        record["sourceSha256After"] = digest(after_data)
        with output.open("rb") as stream:
            copied_open = os.fstat(stream.fileno())
            copied_data = stream.read(MAX_BYTES + 1)
            copied_after = os.fstat(stream.fileno())
        record["outputSha256"] = digest(copied_data)
        require(
            file_identity(before) == file_identity(after_open) == file_identity(after)
            and file_identity(copied)
            == file_identity(copied_open)
            == file_identity(copied_after)
            == file_identity(inspect_path(output))
            and record["sourceSha256Before"]
            == record["sourceSha256After"]
            == record["outputSha256"]
            and copied.st_size == before.st_size
            and copied.st_nlink == 1,
            "Compiled source or copied bytes changed during materialization.",
        )
        record["status"] = "materialized"
    except Exception as error:
        primary = error
        record["error"] = str(error)
    try:
        with receipt.open("x", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if primary is None:
            raise
    if primary is not None:
        raise primary
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "output", "receipt"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    result = materialize(args.source, args.output, args.receipt)
    print(
        json.dumps(
            {
                "status": result["status"],
                "sha256": result["outputSha256"],
                "bytes": result["outputStat"]["bytes"],
            }
        )
    )


if __name__ == "__main__":
    main()
