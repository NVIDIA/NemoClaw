#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Check with the pinned whitespace fixers without writing repository files."""

import contextlib
import importlib
import io
import pathlib
import shutil
import sys
import tempfile


def check_files(fixer, filenames, args=()):
    """Run the original fixer against disposable copies, preserving its semantics."""
    with tempfile.TemporaryDirectory(prefix="nemoclaw-format-check-") as temporary:
        copies = []
        for index, filename in enumerate(filenames):
            target = pathlib.Path(temporary) / f"{index}-{pathlib.Path(filename).name}"
            shutil.copyfile(filename, target)
            copies.append(str(target))
        with contextlib.redirect_stdout(io.StringIO()):
            status = fixer([*args, *copies])
        changed = [
            filename
            for filename, copy in zip(filenames, copies)
            if pathlib.Path(filename).read_bytes() != pathlib.Path(copy).read_bytes()
        ]
        for filename in changed:
            print(f"Formatting required: {filename}")
        return status or int(bool(changed))


if __name__ == "__main__":
    modes = {
        "trailing-whitespace": ("trailing_whitespace_fixer", []),
        "end-of-file-fixer": ("end_of_file_fixer", []),
        "mixed-line-ending": ("mixed_line_ending", ["--fix=lf"]),
    }
    module, arguments = modes[sys.argv[1]]
    main = importlib.import_module(f"pre_commit_hooks.{module}").main
    sys.exit(check_files(main, sys.argv[2:], arguments))
