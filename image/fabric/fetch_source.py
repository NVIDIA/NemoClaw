# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Download a pinned source archive without accepting HTTP error bodies as source."""

import hashlib
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen


def open_source(url):
    # Image assembly owns this read-only GET. Retry only GitHub's observed 429:
    # three attempts, 15/30 s delays and a 60 s socket timeout per attempt.
    # Never retry an integrity failure or a partially transferred response.
    for attempt in range(3):
        print(f"source download attempt {attempt + 1}/3", file=sys.stderr)
        try:
            return urlopen(url, timeout=60)
        except HTTPError as error:
            error.close()
            if error.code != 429 or attempt == 2:
                raise
            print("source download HTTP 429; retrying", file=sys.stderr)
            time.sleep(15 * (attempt + 1))
    raise AssertionError("unreachable")


def fetch(url, checksum, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    try:
        with open_source(url) as response, partial.open("wb") as output:
            digest = hashlib.sha256()
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 128 * 1024 * 1024:
                    raise ValueError("source archive exceeds 128 MiB")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != checksum:
            raise ValueError(f"source archive SHA256 mismatch: {digest.hexdigest()}")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    fetch(*sys.argv[1:])
