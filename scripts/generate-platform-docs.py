#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate platform matrix tables from ci/platform-matrix.json.

Reads the single-source-of-truth metadata and patches markdown tables
between sentinel comments in target files.

Usage:
    python3 scripts/generate-platform-docs.py                  # patch files in place
    python3 scripts/generate-platform-docs.py --check          # exit 1 if out of sync
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MATRIX_PATH = REPO_ROOT / "ci" / "platform-matrix.json"

# Files containing <!-- platform-matrix:begin --> / <!-- platform-matrix:end --> sentinels
TARGET_FILES = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs" / "get-started" / "quickstart.md",
]

SENTINEL_RE = re.compile(
    r"(<!-- platform-matrix:begin -->)\n.*?\n(<!-- platform-matrix:end -->)",
    re.DOTALL,
)


def load_matrix() -> dict:
    with open(MATRIX_PATH) as f:
        return json.load(f)


def generate_platform_table(platforms: list[dict]) -> str:
    """Build a markdown table from platform entries."""
    header = "| Platform | Tested runtimes | Status | Notes |"
    separator = "|----------|-----------------|--------|-------|"
    rows = []
    for p in platforms:
        runtimes = ", ".join(p["runtimes"])
        status = p["status"].capitalize()
        rows.append(f"| {p['name']} | {runtimes} | {status} | {p['notes']} |")
    return "\n".join([header, separator, *rows])


def patch_file(path: Path, table: str, check_only: bool) -> bool:
    """Replace content between sentinels. Returns True if file was changed."""
    text = path.read_text()
    if "<!-- platform-matrix:begin -->" not in text:
        print(f"  SKIP {path.relative_to(REPO_ROOT)} (no sentinels)")
        return False

    replacement = f"<!-- platform-matrix:begin -->\n{table}\n<!-- platform-matrix:end -->"
    new_text = SENTINEL_RE.sub(replacement, text)

    if new_text == text:
        print(f"  OK   {path.relative_to(REPO_ROOT)}")
        return False

    if check_only:
        print(f"  DIFF {path.relative_to(REPO_ROOT)} (out of sync with ci/platform-matrix.json)")
        return True

    path.write_text(new_text)
    print(f"  PATCH {path.relative_to(REPO_ROOT)}")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check mode: exit 1 if any file is out of sync (no writes)",
    )
    args = parser.parse_args()

    if not MATRIX_PATH.exists():
        print(f"Error: {MATRIX_PATH} not found", file=sys.stderr)
        sys.exit(1)

    matrix = load_matrix()
    table = generate_platform_table(matrix["platforms"])

    print(f"{'Checking' if args.check else 'Patching'} platform tables from {MATRIX_PATH.name}:")
    diffs = []
    for path in TARGET_FILES:
        if not path.exists():
            print(f"  MISS {path.relative_to(REPO_ROOT)} (file not found)")
            continue
        changed = patch_file(path, table, check_only=args.check)
        if changed:
            diffs.append(path)

    if args.check and diffs:
        print(f"\n{len(diffs)} file(s) out of sync. Run: python3 scripts/generate-platform-docs.py")
        sys.exit(1)

    if not args.check and diffs:
        print(f"\n{len(diffs)} file(s) patched.")


if __name__ == "__main__":
    main()
