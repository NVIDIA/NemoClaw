# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Apply and verify the exact installer OpenShell source derivative."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def load_lock(directory=None):
    directory = directory or Path(__file__).resolve().parent.parent
    lock = json.loads((directory / "openshell-native-transport.lock.json").read_text("utf-8"))
    if (
        not isinstance(lock, dict)
        or set(lock) != {"schemaVersion", "baseRevision", "patchedTree", "patchSha256"}
        or type(lock["schemaVersion"]) is not int
        or lock["schemaVersion"] != 1
        or any(
            not isinstance(lock[field], str)
            or re.fullmatch(r"[0-9a-f]{" + str(length) + "}", lock[field]) is None
            for field, length in (("baseRevision", 40), ("patchedTree", 40), ("patchSha256", 64))
        )
    ):
        raise ValueError("The locked OpenShell source identity is invalid.")
    patch = directory / "openshell-native-transport.patch"
    if patch.is_symlink() or not patch.is_file():
        raise ValueError("The locked OpenShell source patch is not an ordinary file.")
    with patch.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != lock["patchSha256"]:
        raise ValueError("The OpenShell source patch differs from its lock.")
    return lock


def git(checkout, *arguments):
    result = subprocess.run(
        ["git", "-C", str(checkout), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError("The OpenShell source check failed: " + arguments[0])
    return result.stdout.strip()


def verify(checkout, lock):
    if git(checkout, "rev-parse", "HEAD") != lock["baseRevision"]:
        raise ValueError("The OpenShell base revision differs from its lock.")
    git(checkout, "diff", "--quiet", "--no-ext-diff")
    if git(checkout, "ls-files", "--others", "--exclude-standard"):
        raise ValueError("The OpenShell source contains untracked files.")
    if git(checkout, "write-tree") != lock["patchedTree"]:
        raise ValueError("The OpenShell source tree differs from its lock.")
    return lock


def apply(checkout, directory=None):
    directory = directory or Path(__file__).resolve().parent.parent
    lock = load_lock(directory)
    if git(checkout, "rev-parse", "HEAD") != lock["baseRevision"]:
        raise ValueError("The OpenShell base revision differs from its lock.")
    if git(checkout, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("The OpenShell checkout is not clean before patching.")
    patch = str((directory / "openshell-native-transport.patch").resolve())
    git(checkout, "apply", "--check", "--index", patch)
    git(checkout, "apply", "--index", patch)
    return verify(checkout, lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("apply", "verify"))
    parser.add_argument("checkout", type=Path)
    args = parser.parse_args()
    lock = apply(args.checkout) if args.phase == "apply" else verify(args.checkout, load_lock())
    print(json.dumps(lock))


if __name__ == "__main__":
    main()
