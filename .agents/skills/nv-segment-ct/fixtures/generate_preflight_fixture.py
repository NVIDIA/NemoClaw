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

"""Generate a tiny synthetic CT NIfTI for repository preflight checks.

The real NV-Segment-CT example fixture (`spleen_03.nii.gz`) is intentionally
not committed because it is a medical imaging artifact. This script writes a
small, synthetic, non-clinical volume that is sufficient for input-boundary
preflight checks without downloading data or model weights.
"""

from __future__ import annotations

from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "preflight_synthetic_ct.nii.gz"


def main() -> int:
    if OUT.is_file():
        return 0

    data = np.full((16, 16, 16), -1000.0, dtype=np.float32)
    yy, xx, zz = np.meshgrid(
        np.arange(16),
        np.arange(16),
        np.arange(16),
        indexing="ij",
    )
    body = (xx - 8) ** 2 + (yy - 8) ** 2 + (zz - 8) ** 2 < 6**2
    data[body] = 40.0
    blob = (xx - 10) ** 2 + (yy - 9) ** 2 + (zz - 8) ** 2 < 3**2
    data[blob] = 70.0

    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    img = nib.Nifti1Image(data, affine)
    nib.save(img, str(OUT))
    print(f"wrote {OUT.relative_to(ROOT.parents[2])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
