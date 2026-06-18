#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Fetch the spleen_03 fixture from the Decathlon MSD09 dataset.

The committed Medical AI Skills tree does not ship `spleen_03.nii.gz` (it is a
public Decathlon dataset case, ~11 MB, gitignored per Medical AI Skills'
"no medical artifacts in git" policy). This script downloads the
canonical source and stages the case-3 image into the skill's
fixtures/ dir so the wrapper's example invocation works from a fresh
git clone.

Source: <http://medicaldecathlon.com/> / MONAI's AWS mirror at
`https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar`
(~1.5 GB). Cached under Medical AI Skills' `.workbench_data/` so re-runs
are no-ops.

Usage:
    python skills/nv-segment-ct/fixtures/fetch_spleen_fixture.py

Idempotent: skips the download if the fixture is already present, and
skips the extraction if Task09_Spleen.tar already lives in
.workbench_data/datasets/.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DATASETS_DIR = REPO_ROOT / ".workbench_data" / "datasets"
TASK09_TAR = DATASETS_DIR / "Task09_Spleen.tar"
TASK09_EXTRACT = DATASETS_DIR / "Task09_Spleen"
TASK09_URL = "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar"
# MSD09 image basenames are spleen_<N>.nii.gz (1-indexed, no zero pad).
# We expose case 3 as `spleen_03.nii.gz` to match the wrapper's example.
SOURCE_CASE = "imagesTr/spleen_3.nii.gz"
FIXTURE_DEST = REPO_ROOT / "skills" / "nv-segment-ct" / "fixtures" / "spleen_03.nii.gz"


def _human(n: int) -> str:
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} TB"


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".partial")
    sys.stderr.write(f"[fetch] downloading {url}\n[fetch]   -> {dest} (~1.5 GB)\n")
    with urllib.request.urlopen(url) as r:
        total = int(r.headers.get("Content-Length", "0"))
        with tmp.open("wb") as f:
            n = 0
            last_report = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
                if n - last_report > (50 << 20):  # every 50 MB
                    sys.stderr.write(f"[fetch]   {_human(n)}/{_human(total) if total else '?'}\n")
                    last_report = n
    tmp.rename(dest)
    sys.stderr.write(
        f"[fetch] saved {_human(dest.stat().st_size)} to {dest.relative_to(REPO_ROOT)}\n"
    )


def _extract_case(tar_path: Path, dest_dir: Path, member_name: str) -> Path:
    """Extract a single member from the MSD09 tar and return its path."""
    with tarfile.open(tar_path, "r") as tf:
        target = f"Task09_Spleen/{member_name}"
        member = tf.getmember(target)
        # tarfile's extract overwrites; safe because we know the path.
        sys.stderr.write(f"[fetch] extracting {member.name} ({_human(member.size)})\n")
        tf.extract(member, path=dest_dir)
    extracted = dest_dir / target
    if not extracted.is_file():
        raise FileNotFoundError(f"extraction reported success but {extracted} missing")
    return extracted


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--keep-tar",
        action="store_true",
        help="Keep the 1.5 GB Task09_Spleen.tar after extraction (default: keep)",
    )
    ap.parse_args(argv)

    if FIXTURE_DEST.is_file():
        sys.stderr.write(
            f"[fetch] fixture already present: {FIXTURE_DEST.relative_to(REPO_ROOT)}\n"
        )
        return 0

    if not TASK09_TAR.is_file():
        _download(TASK09_URL, TASK09_TAR)
    else:
        sys.stderr.write(f"[fetch] tar already cached: {TASK09_TAR.relative_to(REPO_ROOT)}\n")

    if not (TASK09_EXTRACT / SOURCE_CASE).is_file():
        _extract_case(TASK09_TAR, DATASETS_DIR, SOURCE_CASE)
    else:
        sys.stderr.write(
            f"[fetch] case already extracted: {(TASK09_EXTRACT / SOURCE_CASE).relative_to(REPO_ROOT)}\n"
        )

    src = TASK09_EXTRACT / SOURCE_CASE
    FIXTURE_DEST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, FIXTURE_DEST)
    sys.stderr.write(
        f"[fetch] staged fixture: {FIXTURE_DEST.relative_to(REPO_ROOT)} "
        f"({_human(FIXTURE_DEST.stat().st_size)})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
