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

import importlib.util
from pathlib import Path

import nibabel as nib
import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_vista3d.py"
spec = importlib.util.spec_from_file_location("run_vista3d", SCRIPT)
run_vista3d = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(run_vista3d)


def _write_nifti(path: Path, data: np.ndarray, affine: np.ndarray) -> nib.Nifti1Image:
    img = nib.Nifti1Image(data, affine)
    nib.save(img, str(path))
    return img


def test_mask_summary_accepts_requested_labels_and_matching_geometry(tmp_path: Path) -> None:
    affine = np.diag([float("1.5"), float("1.5"), float("2.0"), float("1.0")])
    input_img = _write_nifti(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6)), affine)
    mask = np.zeros((4, 5, 6), dtype=np.int16)
    mask[1:3, 1:4, 2:4] = 1
    mask[3, 3, 3] = 3
    mask_path = tmp_path / "ct_seg.nii.gz"
    _write_nifti(mask_path, mask, affine)

    summary = run_vista3d._mask_summary(
        mask_path,
        input_img,
        [1, 3],
        {1: "liver", 3: "spleen"},
    )

    assert summary["label_ids_present"] == [1, 3]
    assert summary["unexpected_label_ids"] == []
    assert summary["label_set_valid"] is True
    assert summary["class_counts"] == {"liver": 12, "spleen": 1}
    assert summary["voxel_volume_ml"] == 0.0045
    assert summary["class_volumes_ml"] == {"liver": 0.054, "spleen": 0.0045}
    assert summary["geometry"]["shape_match"] is True
    assert summary["geometry"]["spacing_match"] is True
    assert summary["geometry"]["affine_match"] is True


def test_mask_summary_flags_unrequested_labels_and_geometry_mismatch(tmp_path: Path) -> None:
    input_img = _write_nifti(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6)), np.eye(4))
    shifted_affine = np.eye(4)
    shifted_affine[0, 3] = 10.0
    mask = np.zeros((4, 5, 6), dtype=np.int16)
    mask[1, 1, 1] = 99
    mask_path = tmp_path / "ct_seg.nii.gz"
    _write_nifti(mask_path, mask, shifted_affine)

    summary = run_vista3d._mask_summary(mask_path, input_img, [1, 3], {})

    assert summary["label_ids_present"] == [99]
    assert summary["unexpected_label_ids"] == [99]
    assert summary["label_set_valid"] is False
    assert summary["geometry"]["shape_match"] is True
    assert summary["geometry"]["spacing_match"] is True
    assert summary["geometry"]["affine_match"] is False
