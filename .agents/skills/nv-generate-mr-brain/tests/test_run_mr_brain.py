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
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_mr_brain.py"
spec = importlib.util.spec_from_file_location("run_mr_brain", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def _save_image(path: Path, data: np.ndarray, affine: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(data.astype(np.int16), affine), str(path))


def test_load_config_override_default_returns_empty() -> None:
    override, source = mod._load_config_override("default")
    assert override == {}
    assert source is None


def test_load_config_override_accepts_flat_and_nested_keys(tmp_path: Path) -> None:
    p = tmp_path / "cfg.json"
    p.write_text(
        json.dumps(
            {
                "_comment": "drop",
                "diffusion_unet_inference": {"dim": [128, 128, 128]},
                "modality": "mri_t2",
            }
        )
    )
    override, source = mod._load_config_override(str(p))
    assert override == {"dim": [128, 128, 128], "modality": "mri_t2"}
    assert source == str(p)


def test_load_config_override_rejects_unknown_key(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"nonsense": 1}))
    with pytest.raises(Exception):
        mod._load_config_override(str(p))


def test_modality_to_code_uses_readme_supported_mr_brain_modalities() -> None:
    mapping = {
        "mri_t1": 9,
        "mri_t2": 10,
        "mri_flair_skull_stripped": 31,
    }
    assert mod._modality_to_code("mri_t1", mapping) == 9
    assert mod._modality_to_code("mri_flair_skull_stripped", mapping) == 31
    with pytest.raises(Exception):
        mod._modality_to_code("ct", {"ct": 1})


def test_stage_config_writes_model_and_environment_overrides(tmp_path: Path) -> None:
    upstream = tmp_path / "upstream"
    (upstream / "configs").mkdir(parents=True)
    (upstream / mod.UPSTREAM_MODEL_CONFIG).write_text(
        json.dumps(
            {
                "diffusion_unet_inference": {
                    "dim": [256, 256, 256],
                    "spacing": [1, 1, 1],
                    "random_seed": 1,
                    "num_inference_steps": 30,
                    "modality": 9,
                    "cfg_guidance_scale": 10,
                    "top_region_index": [0, 1, 0, 0],
                    "bottom_region_index": [0, 0, 1, 0],
                }
            }
        )
    )
    (upstream / mod.UPSTREAM_ENV_CONFIG).write_text(
        json.dumps({"output_dir": "./output", "output_prefix": "unet_3d"})
    )

    rendered_model, rendered_env, model_path, env_path = mod._stage_config(
        upstream,
        tmp_path / "stage",
        {"dim": [128, 128, 128]},
        tmp_path / "out",
        10,
        "mri_t2",
        42,
    )

    inference = rendered_model["diffusion_unet_inference"]
    assert inference["dim"] == [128, 128, 128]
    assert inference["modality"] == 10
    assert inference["random_seed"] == 42
    assert rendered_env["output_dir"] == str(tmp_path / "out")
    assert rendered_env["output_prefix"] == "mr_brain_mri_t2"
    assert model_path.is_file()
    assert env_path.is_file()


def test_summarize_image_and_aggregate_pass(tmp_path: Path) -> None:
    affine = np.diag([float("1.0"), float("1.0"), float("1.5"), float("1.0")])
    data = np.arange(4 * 5 * 6, dtype=np.int16).reshape(4, 5, 6)
    image = tmp_path / "mr_brain_mri_t1_seed1234_size4x5x6_spacing1.00x1.00x1.50.nii.gz"
    _save_image(image, data, affine)

    rec = mod._summarize_image(image, [4, 5, 6], [float("1.0"), float("1.0"), float("1.5")])
    agg = mod._aggregate([rec])

    assert rec["image_readable"] is True
    assert rec["shape_match_requested"] is True
    assert rec["spacing_match_requested"] is True
    assert rec["image_nonconstant"] is True
    assert rec["image_nonnegative"] is True
    assert rec["all_finite"] is True
    assert agg["num_samples"] == 1
    assert agg["all_images_readable"] is True
    assert agg["all_images_nonconstant"] is True


def test_summarize_image_flags_shape_spacing_and_constant_image(tmp_path: Path) -> None:
    affine = np.diag([float("2.0"), float("2.0"), float("2.0"), float("1.0")])
    image = tmp_path / "constant.nii.gz"
    _save_image(image, np.zeros((4, 4, 4), dtype=np.int16), affine)

    rec = mod._summarize_image(image, [8, 8, 8], [float("1.0"), float("1.0"), float("1.0")])
    agg = mod._aggregate([rec])

    assert rec["shape_match_requested"] is False
    assert rec["spacing_match_requested"] is False
    assert rec["image_nonconstant"] is False
    assert agg["all_shapes_match_requested"] is False
    assert agg["all_spacing_match_requested"] is False
    assert agg["all_images_nonconstant"] is False


def test_build_command_matches_documented_entrypoint(tmp_path: Path) -> None:
    cmd = mod._build_command(tmp_path / "model.json", tmp_path / "env.json", num_gpus=1)
    assert cmd[1:3] == ["-m", "scripts.diff_model_infer"]
    assert cmd[cmd.index("-t") + 1] == "./configs/config_network_rflow.json"
    assert cmd[cmd.index("-e") + 1] == str(tmp_path / "env.json")
    assert cmd[cmd.index("-c") + 1] == str(tmp_path / "model.json")
    assert "-g" not in cmd
