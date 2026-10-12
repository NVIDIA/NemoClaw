// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Decode one bounded regular log from runtime cp without extracting host files. */
export const STOPPED_CONTAINER_STARTUP_LOG_READER = String.raw`
import io
import json
import sys
import tarfile

try:
    data = sys.stdin.buffer.read(65537)
    if len(data) > 65536 or len(data) % 512 or data[-1024:] != bytes(1024):
        raise ValueError("archive bound")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        members = archive.getmembers()
        if len(members) != 1:
            raise ValueError("entry count")
        member = members[0]
        if (member.name != "nemoclaw-start.log" or not member.isfile()
                or member.linkname or member.issparse() or member.size > 16384):
            raise ValueError("log identity or size")
        stream = archive.extractfile(member)
        if stream is None:
            raise ValueError("missing log")
        content = stream.read(16385)
        if len(content) != member.size:
            raise ValueError("incomplete log")
        text = content.decode("utf-8", errors="strict")
    print(json.dumps({"file": "/tmp/nemoclaw-start.log", "log": text, "truncated": False}))
except (OSError, ValueError, tarfile.TarError):
    print(json.dumps({"file": "/tmp/nemoclaw-start.log", "logOmitted": "unsafe-or-incomplete-archive"}))
    sys.exit(1)
`;
