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

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ct_image.py"
spec = importlib.util.spec_from_file_location("run_ct_image", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def test_load_config_override_accepts_nested_keys(tmp_path: Path) -> None:
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps({"diffusion_unet_inference": {"dim": [256, 256, 128]}}))
    override, source = mod._load_config_override(str(p))
    assert override == {"dim": [256, 256, 128]}
    assert source == str(p)


def test_validate_ct_inference_config_accepts_default_shape() -> None:
    errors = mod._validate_ct_inference_config(
        {
            "dim": [256, 256, 128],
            "spacing": [1.7, 1.7, 2.0],
            "top_region_index": [0, 1, 0, 0],
            "bottom_region_index": [0, 0, 1, 0],
            "num_inference_steps": 30,
            "modality": 1,
            "cfg_guidance_scale": 0,
        }
    )
    assert errors == []


def test_build_command_matches_upstream_entrypoint(tmp_path: Path) -> None:
    cmd = mod._build_command("rflow-ct", tmp_path / "model.json", tmp_path / "env.json", 1)
    assert cmd[1:3] == ["-m", "scripts.diff_model_infer"]
    assert cmd[cmd.index("-t") + 1] == "./configs/config_network_rflow.json"
    assert cmd[cmd.index("-e") + 1] == str(tmp_path / "env.json")
    assert cmd[cmd.index("-c") + 1] == str(tmp_path / "model.json")


def test_summarize_image_reports_ct_hu_like(tmp_path: Path) -> None:
    path = tmp_path / "ct.nii.gz"
    data = np.array([-900.0, 300.0] * 32, dtype=np.float32).reshape(4, 4, 4)
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))
    rec = mod._summarize_image(path, [4, 4, 4], [1.0, 1.0, 1.0])
    agg = mod._aggregate([rec])
    assert rec["image_hu_negative_present"] is True
    assert rec["image_hu_bone_present"] is True
    assert agg["all_images_hu_like"] is True


def test_validate_ct_inference_config_rejects_bad_xy() -> None:
    errors = mod._validate_ct_inference_config(
        {
            "dim": [256, 384, 128],
            "spacing": [1.0, 1.2, 2.0],
            "top_region_index": [0, 1, 0, 0],
            "bottom_region_index": [0, 0, 1, 0],
            "num_inference_steps": 30,
            "modality": 1,
            "cfg_guidance_scale": 0,
        }
    )
    assert any("dim[0] and dim[1]" in e for e in errors)
    assert any("spacing[0] and spacing[1]" in e for e in errors)
