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

"""Generate synthetic DICOM fixtures for dicom_series_preflight.

  clean_no_phi/  — canonical pass (LPS CT, no populated PHI tags)
  clean_axial/   — warn demo (same geometry, PHI tags populated)
  flipped_lr/    — fail demo (LR-flipped IOP)

Reuses the same volume geometry as dicom_series_to_volume fixtures.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
sys.path.insert(0, str(REPO / "skills" / "dicom-series-to-volume" / "fixtures"))

from generate_fixtures import write_series  # noqa: E402

if __name__ == "__main__":
    write_series(ROOT / "clean_axial", iop=[1, 0, 0, 0, 1, 0], series_label="clean_phi")
    write_series(ROOT / "flipped_lr", iop=[-1, 0, 0, 0, 1, 0], series_label="flipped_lr")
    write_series(ROOT / "clean_no_phi", iop=[1, 0, 0, 0, 1, 0], series_label="clean_no_phi")
    # Strip PHI tags from pass fixture
    import pydicom

    for p in (ROOT / "clean_no_phi").glob("*.dcm"):
        ds = pydicom.dcmread(str(p))
        for tag in (
            "PatientName",
            "PatientID",
            "PatientBirthDate",
            "PatientSex",
            "InstitutionName",
        ):
            if hasattr(ds, tag):
                delattr(ds, tag)
        ds.save_as(str(p), enforce_file_format=True)
    print("wrote clean_no_phi, clean_axial, flipped_lr under", ROOT)
