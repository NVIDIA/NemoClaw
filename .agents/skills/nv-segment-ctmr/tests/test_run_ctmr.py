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

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ctmr.py"
spec = importlib.util.spec_from_file_location("run_ctmr", SCRIPT)
run_ctmr = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(run_ctmr)


def _write_nifti(path: Path, data: np.ndarray, affine: np.ndarray) -> nib.Nifti1Image:
    img = nib.Nifti1Image(data, affine)
    nib.save(img, str(path))
    return img


def test_build_command_uses_documented_monai_bundle_entrypoint(tmp_path: Path) -> None:
    image = tmp_path / "scan.nii.gz"
    output_dir = tmp_path / "out"
    cmd = run_ctmr._build_command(image, output_dir, "MRI_BODY", [3, 14])

    assert cmd[1:4] == ["-m", "monai.bundle", "run"]
    assert cmd[cmd.index("--config_file") + 1] == "configs/inference.json"
    assert cmd[cmd.index("--output_dir") + 1] == str(output_dir)
    assert cmd[cmd.index("--modality") + 1] == "MRI_BODY"
    input_dict = cmd[cmd.index("--input_dict") + 1]
    assert "'image':" in input_dict
    assert "'label_prompt': [3, 14]" in input_dict


def test_find_output_mask_prefers_upstream_single_image_layout(tmp_path: Path) -> None:
    image = tmp_path / "s0289.nii.gz"
    output_dir = tmp_path / "out"
    expected_dir = output_dir / "s0289"
    expected_dir.mkdir(parents=True)
    expected = expected_dir / "s0289_trans.nii.gz"
    expected.write_bytes(b"placeholder")

    found = run_ctmr._find_output_mask(output_dir, image, run_started=0)

    assert found == expected


def test_mask_summary_accepts_known_labels_and_matching_geometry(tmp_path: Path) -> None:
    affine = np.diag([float("1.5"), float("1.5"), float("2.0"), float("1.0")])
    input_img = _write_nifti(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6)), affine)
    mask = np.zeros((4, 5, 6), dtype=np.int16)
    mask[1:3, 1:4, 2:4] = 3
    mask[3, 3, 3] = 14
    mask_path = tmp_path / "ct_trans.nii.gz"
    _write_nifti(mask_path, mask, affine)

    summary = run_ctmr._mask_summary(
        mask_path,
        input_img,
        [3, 14],
        {3: "spleen", 14: "left kidney"},
        tmp_path / "label_dict.json",
    )

    assert summary["label_ids_present"] == [3, 14]
    assert summary["unexpected_label_ids"] == []
    assert summary["label_set_valid"] is True
    assert summary["label_map_loaded"] is True
    assert summary["class_counts"] == {"spleen": 12, "left kidney": 1}
    assert summary["voxel_volume_ml"] == 0.0045
    assert summary["class_volumes_ml"] == {"spleen": 0.054, "left kidney": 0.0045}
    assert summary["geometry"]["shape_match"] is True
    assert summary["geometry"]["spacing_match"] is True
    assert summary["geometry"]["affine_match"] is True


def test_mask_summary_flags_labels_missing_from_loaded_label_map(tmp_path: Path) -> None:
    input_img = _write_nifti(tmp_path / "ct.nii.gz", np.zeros((4, 5, 6)), np.eye(4))
    mask = np.zeros((4, 5, 6), dtype=np.int16)
    mask[1, 1, 1] = 99
    mask_path = tmp_path / "ct_trans.nii.gz"
    _write_nifti(mask_path, mask, np.eye(4))

    summary = run_ctmr._mask_summary(mask_path, input_img, None, {3: "spleen"}, None)

    assert summary["label_ids_present"] == [99]
    assert summary["unexpected_label_ids"] == [99]
    assert summary["label_set_valid"] is False
