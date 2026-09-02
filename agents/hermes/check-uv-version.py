#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify that ``uv --version`` reports the required semantic version."""

import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-uv-version.py '<uv --version output>' <expected-version>", file=sys.stderr)
        return 2

    output, expected_version = sys.argv[1:]
    fields = output.split()
    if len(fields) < 2 or fields[0] != "uv" or fields[1] != expected_version:
        print(
            f"uv version mismatch: expected {expected_version!r}, received {output!r}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
