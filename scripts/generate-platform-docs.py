#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate platform and provider tables from ci/platform-matrix.json.

Reads the single-source-of-truth metadata and patches markdown tables
between sentinel comments in target files.

Sentinel pairs:
  <!-- platform-matrix:begin --> / <!-- platform-matrix:end -->
  <!-- provider-status:begin --> / <!-- provider-status:end -->

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

# Each entry: (sentinel_name, table_generator_key, list of target files)
TABLES = [
    (
        "platform-matrix",
        "platforms",
        [
            REPO_ROOT / "README.md",
            REPO_ROOT / "docs" / "get-started" / "quickstart.md",
        ],
    ),
    (
        "provider-status",
        "providers",
        [
            REPO_ROOT / "docs" / "inference" / "inference-options.md",
        ],
    ),
]


def _sentinel_re(name: str) -> re.Pattern:
    return re.compile(
        rf"(<!-- {re.escape(name)}:begin -->)\n.*?\n(<!-- {re.escape(name)}:end -->)",
        re.DOTALL,
    )


def load_matrix() -> dict:
    with open(MATRIX_PATH) as f:
        return json.load(f)


def generate_platform_table(platforms: list[dict]) -> str:
    """Build a markdown table from platform entries.

    Deferred entries are tracked in the metadata but excluded from
    user-facing tables — they have no validated setup path yet.
    """
    STATUS_LABELS = {
        "tested": "Tested",
        "caveated": "Tested with limitations",
        "experimental": "Experimental",
    }
    header = "| OS | Container runtime | Status | Notes |"
    separator = "|----|-------------------|--------|-------|"
    rows = []
    for p in platforms:
        if p["status"] == "deferred":
            continue
        runtimes = ", ".join(p["runtimes"])
        status = STATUS_LABELS.get(p["status"], p["status"].capitalize())
        rows.append(f"| {p['name']} | {runtimes} | {status} | {p['notes']} |")
    return "\n".join([header, separator, *rows])


def generate_provider_table(providers: list[dict]) -> str:
    """Build a markdown table from provider entries.

    Deferred entries are excluded from user-facing tables.
    """
    header = "| Provider | Status | Endpoint type | Notes |"
    separator = "|----------|--------|---------------|-------|"
    rows = []
    for p in providers:
        if p["status"] == "deferred":
            continue
        status = p["status"].capitalize()
        rows.append(f"| {p['name']} | {status} | {p['endpoint_type']} | {p['notes']} |")
    return "\n".join([header, separator, *rows])


TABLE_GENERATORS = {
    "platforms": generate_platform_table,
    "providers": generate_provider_table,
}


def patch_file(path: Path, sentinel_name: str, table: str, check_only: bool) -> bool:
    """Replace content between sentinels. Returns True if file was changed."""
    text = path.read_text()
    begin = f"<!-- {sentinel_name}:begin -->"
    end = f"<!-- {sentinel_name}:end -->"
    if begin not in text:
        return False

    if end not in text:
        raise ValueError(
            f"{path.relative_to(REPO_ROOT)} has '{begin}' but no matching '{end}'"
        )

    pattern = _sentinel_re(sentinel_name)
    replacement = f"<!-- {sentinel_name}:begin -->\n{table}\n<!-- {sentinel_name}:end -->"
    new_text = pattern.sub(replacement, text)

    if new_text == text:
        return False

    if check_only:
        print(f"  DIFF {path.relative_to(REPO_ROOT)} [{sentinel_name}]")
        return True

    path.write_text(new_text)
    print(f"  PATCH {path.relative_to(REPO_ROOT)} [{sentinel_name}]")
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

    print(f"{'Checking' if args.check else 'Patching'} tables from {MATRIX_PATH.name}:")
    diffs = []
    missing = []
    ok = []

    for sentinel_name, data_key, target_files in TABLES:
        generator = TABLE_GENERATORS[data_key]
        table = generator(matrix[data_key])
        for path in target_files:
            if not path.exists():
                print(f"  MISS {path.relative_to(REPO_ROOT)}", file=sys.stderr)
                missing.append(path)
                continue
            changed = patch_file(path, sentinel_name, table, check_only=args.check)
            if changed:
                diffs.append(path)
            else:
                ok.append(path)

    for path in ok:
        print(f"  OK   {path.relative_to(REPO_ROOT)}")

    if missing:
        print(f"\n{len(missing)} configured target file(s) missing.", file=sys.stderr)
        sys.exit(1)

    if args.check and diffs:
        print(f"\n{len(diffs)} file(s) out of sync. Run: python3 scripts/generate-platform-docs.py")
        sys.exit(1)

    if not args.check and diffs:
        print(f"\n{len(diffs)} file(s) patched.")
    elif not diffs:
        print("\nAll files in sync.")


if __name__ == "__main__":
    main()
