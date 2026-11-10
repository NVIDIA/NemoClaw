# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Download image sources with bounded retries for GitHub's HTTP 429 responses."""

import shutil
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen


def fetch(url, destination):
    """Download the archive; the Docker build verifies its checksum before extraction."""
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    # Image assembly owns this read-only GET. Retry only GitHub's observed 429:
    # three attempts, 15/30 s delays and a 60 s socket timeout per attempt.
    # Never retry an integrity failure or a partially transferred response.
    for attempt in range(3):
        print(f"source download attempt {attempt + 1}/3", file=sys.stderr)
        try:
            response = urlopen(url, timeout=60)
            break
        except HTTPError as error:
            error.close()
            if error.code != 429 or attempt == 2:
                raise
            print("source download HTTP 429; retrying", file=sys.stderr)
            time.sleep(15 * (attempt + 1))
    with response, open(destination, "wb") as output:
        shutil.copyfileobj(response, output)


if __name__ == "__main__":
    fetch(*sys.argv[1:])
