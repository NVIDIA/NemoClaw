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
import json
from pathlib import Path

import nibabel as nib
import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ct_mask.py"
spec = importlib.util.spec_from_file_location("run_ct_mask", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def test_expected_label_mapping_maps_lung_tumor_to_23() -> None:
    request = {"controllable_anatomy_size": [["lung tumor", 0.5]]}
    assert mod._expected_label_mapping(request, {"lung tumor": 23}) == [
        {"anatomy": "lung tumor", "maisi_label_id": 23}
    ]


def test_validate_request_requires_native_geometry() -> None:
    request = {
        "controllable_anatomy_size": [["lung tumor", 0.5]],
        "output_size": [256, 256, 256],
        "spacing": [1.5, 1.5, 2.0],
        "mask_generation_num_inference_steps": 1000,
    }
    errors = mod._validate_request(request, {"lung tumor": 23})
    assert any("native 256x256x256" in e for e in errors)


def test_summarize_mask_reports_missing_expected_label(tmp_path: Path) -> None:
    path = tmp_path / "mask.nii.gz"
    data = np.zeros((4, 4, 4), dtype=np.int16)
    data[0, 0, 0] = 1
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))
    summary = mod._summarize_mask(path, [{"anatomy": "lung tumor", "maisi_label_id": 23}])
    aggregate = mod._aggregate([summary])
    assert summary["missing_expected_maisi_label_ids"] == [23]
    assert aggregate["all_expected_maisi_labels_present"] is False


def test_anatomy_size_condition_overwrites_requested_slot(tmp_path: Path) -> None:
    conditions = tmp_path / "conditions.json"
    conditions.write_text(json.dumps([{"organ_size": [0.1] * 10}, {"organ_size": [0.9] * 10}]))
    request = {"controllable_anatomy_size": [["lung tumor", 0.5]]}
    condition = mod._anatomy_size_condition(request, conditions)
    assert condition[mod.ANATOMY_SIZE_INDEX["lung tumor"]] == 0.5
    assert len(condition) == 10


def test_curated_lung_tumor_mask_fixture_uses_robust_size() -> None:
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "ct_mask_lung_tumor.json"
    request = json.loads(fixture.read_text())

    assert request["controllable_anatomy_size"] == [["lung tumor", 0.5]]
