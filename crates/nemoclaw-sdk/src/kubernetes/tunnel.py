# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Keep the command-scoped port forward within the SDK parent's custody."""

import subprocess
import sys

import parent_watch


def main():
    parent_watch.start()
    # Only the Rust caller builds these argv values. The child never consumes
    # the parent's custody pipe, and its stderr never enters SDK diagnostics.
    return subprocess.call(sys.argv[1:], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    raise SystemExit(main())
