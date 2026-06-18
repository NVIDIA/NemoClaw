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

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ct_from_mask.py"
spec = importlib.util.spec_from_file_location("run_ct_from_mask", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def test_summarize_mask_accepts_maisi_body_label(tmp_path: Path) -> None:
    path = tmp_path / "mask.nii.gz"
    data = np.zeros((4, 4, 4), dtype=np.int16)
    data[0, 0, 0] = 23
    data[1, 1, 1] = 200
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))
    summary = mod._summarize_mask(path)
    assert summary["mask_readable"] is True
    assert summary["body_label_200_present"] is True
    assert summary["all_labels_in_maisi_vocab"] is True
    assert mod._validate_mask_summary(summary, allow_missing_body_label=False) == []


def test_validate_mask_summary_rejects_missing_body_label(tmp_path: Path) -> None:
    path = tmp_path / "mask.nii.gz"
    data = np.zeros((4, 4, 4), dtype=np.int16)
    data[0, 0, 0] = 23
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))
    summary = mod._summarize_mask(path)
    errors = mod._validate_mask_summary(summary, allow_missing_body_label=False)
    assert any("label 200 body envelope" in e for e in errors)


def test_load_request_resolves_mask_path(tmp_path: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"mask_path": "mask.nii.gz", "num_inference_steps": 30}))
    loaded, request_path = mod._load_request(str(request))
    assert loaded["mask_path"] == "mask.nii.gz"
    assert mod._resolve_mask_path(loaded["mask_path"], request_path) == tmp_path / "mask.nii.gz"


def test_build_command_uses_official_entrypoint(tmp_path: Path) -> None:
    cmd = mod._build_command(
        tmp_path / "mask.nii.gz", tmp_path / "infer.json", tmp_path / "env.json", 7
    )
    assert cmd[1:3] == ["-m", "scripts.infer_image_from_mask"]
    assert "--mask" in cmd
    assert cmd[cmd.index("--random-seed") + 1] == "7"
