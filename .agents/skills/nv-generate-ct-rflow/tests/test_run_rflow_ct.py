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

"""Unit tests for skills/nv-generate-ct-rflow/scripts/run_rflow_ct.py.

These do NOT exercise the upstream NV-Generate-CTMR subprocess (that needs a
GPU + ~5GB of weights). They cover the wrapper's deterministic surface:
config override loading, pair scanning + summarization, and aggregate
verdicts.
"""

import importlib.util
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_rflow_ct.py"
spec = importlib.util.spec_from_file_location("run_rflow_ct", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def _save_pair(
    out_dir: Path, stem: str, image: np.ndarray, mask: np.ndarray, affine: np.ndarray
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    nib.save(
        nib.Nifti1Image(image.astype(np.float32), affine), str(out_dir / f"{stem}_image.nii.gz")
    )
    nib.save(nib.Nifti1Image(mask.astype(np.int16), affine), str(out_dir / f"{stem}_label.nii.gz"))


def test_load_config_override_default_returns_empty():
    override, source = mod._load_config_override("default")
    assert override == {}
    assert source is None


def test_load_config_override_strips_comment_keys(tmp_path):
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps({"_comment": "drop me", "num_output_samples": 2}))
    override, source = mod._load_config_override(str(p))
    assert override == {"num_output_samples": 2}
    assert source == str(p)


def test_load_config_override_rejects_unknown_key(tmp_path):
    import typer

    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"num_output_samples": 1, "nonsense": 7}))
    with pytest.raises(typer.BadParameter):
        mod._load_config_override(str(p))


def test_stage_config_forces_caller_output_dir_when_upstream_cache_is_mutated(tmp_path):
    upstream = tmp_path / "upstream"
    configs = upstream / "configs"
    configs.mkdir(parents=True)
    stale_out = tmp_path / "stale_repeat"
    requested_out = tmp_path / "requested_repeat"
    (configs / "config_infer.json").write_text(
        json.dumps(
            {
                "num_output_samples": 1,
                "output_dir": str(stale_out),
                "spacing": [1.0, 1.0, 1.0],
            }
        )
    )
    (configs / "environment_rflow-ct.json").write_text(
        json.dumps({"output_dir": str(stale_out), "model_dir": "models"})
    )

    rendered_infer, rendered_env, infer_path, env_path = mod._stage_config(
        upstream,
        requested_out / "_staged_configs",
        {"spacing": [1.5, 1.5, 2.0]},
        requested_out,
        "rflow-ct",
    )

    assert rendered_infer["output_dir"] == str(requested_out)
    assert rendered_env["output_dir"] == str(requested_out)
    assert rendered_infer["spacing"] == [1.5, 1.5, 2.0]
    assert json.loads(infer_path.read_text())["output_dir"] == str(requested_out)
    assert json.loads(env_path.read_text())["output_dir"] == str(requested_out)


def test_validate_override_bounds_rejects_abdomen_head_sized_fov():
    errors = mod._validate_override_bounds(
        {
            "body_region": ["abdomen"],
            "anatomy_list": ["liver"],
            "output_size": [256, 256, 128],
            "spacing": [1.0, 1.0, 2.0],
        }
    )

    assert any("at least 384 mm" in e for e in errors)


def test_validate_override_bounds_infers_non_head_fov_from_anatomy_list():
    errors = mod._validate_override_bounds(
        {
            "body_region": [],
            "anatomy_list": ["liver"],
            "output_size": [256, 256, 128],
            "spacing": [1.0, 1.0, 2.0],
        }
    )

    assert any("non-head CT body regions/anatomies" in e for e in errors)


def test_validate_override_bounds_allows_head_256mm_fov():
    errors = mod._validate_override_bounds(
        {
            "body_region": ["head"],
            "anatomy_list": ["brain"],
            "output_size": [256, 256, 128],
            "spacing": [1.0, 1.0, 2.0],
        }
    )

    assert errors == []


def test_validate_override_bounds_rejects_ct_geometry_outside_upstream_contract():
    errors = mod._validate_override_bounds(
        {
            "output_size": [320, 384, 96],
            "spacing": [0.4, 0.6, 6.0],
        }
    )

    joined = " ".join(errors)
    assert "output_size[0] and output_size[1] must match" in joined
    assert "upstream-supported CT xy sizes" in joined
    assert "upstream-supported CT z sizes" in joined
    assert "spacing[0] and spacing[1] must match" in joined
    assert "upstream-supported CT xy range" in joined
    assert "upstream-supported CT z range" in joined


def test_summarize_pair_finds_label_and_matches_geometry(tmp_path):
    affine = np.diag([float("1.5"), float("1.5"), float("2.0"), float("1.0")])
    image = np.linspace(-1000, 500, num=4 * 4 * 4).reshape(4, 4, 4)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    mask[1:3, 1:3, 1:3] = 23
    _save_pair(tmp_path, "sample_20260519_120000_000000", image, mask, affine)

    image_path = tmp_path / "sample_20260519_120000_000000_image.nii.gz"
    rec = mod._summarize_pair(image_path)

    assert rec["image_readable"] is True
    assert rec["label_readable"] is True
    assert rec["image_shape"] == [4, 4, 4]
    assert rec["label_shape"] == [4, 4, 4]
    assert rec["shape_match"] is True
    assert rec["spacing_match"] is True
    assert rec["affine_match"] is True
    assert rec["image_hu_negative_present"] is True
    assert rec["image_hu_bone_present"] is True
    assert rec["image_nonconstant"] is True
    assert rec["label_ids_present"] == [23]
    assert rec["label_foreground_voxels"] == 8


def test_scan_outputs_accepts_prefix_image_label_names(tmp_path):
    affine = np.eye(4)
    image = np.linspace(-1000, 500, num=4 * 4 * 4).reshape(4, 4, 4)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    mask[0, 0, 0] = 1
    nib.save(nib.Nifti1Image(image.astype(np.float32), affine), str(tmp_path / "image_0000.nii.gz"))
    nib.save(nib.Nifti1Image(mask.astype(np.int16), affine), str(tmp_path / "label_0000.nii.gz"))

    image_paths = mod._scan_outputs(tmp_path)
    samples = [mod._summarize_pair(path) for path in image_paths]

    assert image_paths == [tmp_path / "image_0000.nii.gz"]
    assert samples[0]["label_path"] == str(tmp_path / "label_0000.nii.gz")
    assert samples[0]["shape_match"] is True


def test_summarize_pair_flags_constant_image(tmp_path):
    affine = np.eye(4)
    image = np.zeros((4, 4, 4), dtype=np.float32)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    _save_pair(tmp_path, "sample_const", image, mask, affine)
    rec = mod._summarize_pair(tmp_path / "sample_const_image.nii.gz")
    assert rec["image_nonconstant"] is False
    assert rec["image_hu_negative_present"] is False
    assert rec["image_hu_bone_present"] is False
    assert rec["label_foreground_voxels"] == 0


def test_summarize_pair_handles_missing_label(tmp_path):
    affine = np.eye(4)
    nib.save(
        nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.float32), affine),
        str(tmp_path / "sample_x_image.nii.gz"),
    )
    rec = mod._summarize_pair(tmp_path / "sample_x_image.nii.gz")
    assert rec["image_readable"] is True
    assert rec["label_readable"] is False
    assert rec["label_path"] is None


def test_aggregate_pass(tmp_path):
    affine = np.eye(4)
    img = np.array([-900.0, 300.0] * 32).reshape(4, 4, 4)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    mask[0, 0, 0] = 1
    _save_pair(tmp_path, "sample_a", img, mask, affine)
    _save_pair(tmp_path, "sample_b", img, mask, affine)
    samples = [mod._summarize_pair(p) for p in mod._scan_outputs(tmp_path)]
    agg = mod._aggregate(samples, None)
    assert agg["num_samples"] == 2
    assert agg["all_pairs_readable"] is True
    assert agg["all_geometry_consistent"] is True
    assert agg["any_foreground_present"] is True
    assert agg["all_images_nonconstant"] is True
    assert agg["all_images_hu_like"] is True
    assert agg["all_effective_anatomy_labels_present"] is True


def test_effective_label_mapping_preserves_maisi_id_for_controllable_request():
    rendered = {
        "anatomy_list": ["lung tumor", "heart"],
        "controllable_anatomy_size": [["lung tumor", 0.5]],
    }
    label_dict = {"lung tumor": 23, "heart": 2}

    assert mod._effective_anatomy_names(rendered) == ["lung tumor"]
    assert mod._expected_output_label_mapping(rendered, label_dict) == [
        {"anatomy": "lung tumor", "maisi_label_id": 23, "output_label_id": 1}
    ]


def test_aggregate_checks_saved_output_label_ordinals_not_raw_maisi_ids(tmp_path):
    affine = np.eye(4)
    img = np.array([-900.0, 300.0] * 32).reshape(4, 4, 4)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    mask[0, 0, 0] = 1
    _save_pair(tmp_path, "sample_lung_tumor", img, mask, affine)
    samples = [mod._summarize_pair(p) for p in mod._scan_outputs(tmp_path)]

    agg = mod._aggregate(
        samples,
        [{"anatomy": "lung tumor", "maisi_label_id": 23, "output_label_id": 1}],
    )

    assert agg["union_label_ids_present"] == [1]
    assert agg["expected_maisi_label_ids"] == [23]
    assert agg["expected_output_label_ids"] == [1]
    assert agg["missing_expected_output_label_ids"] == []
    assert agg["all_effective_anatomy_labels_present"] is True


def test_aggregate_reports_missing_expected_output_label(tmp_path):
    affine = np.eye(4)
    img = np.array([-900.0, 300.0] * 32).reshape(4, 4, 4)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    mask[0, 0, 0] = 1
    _save_pair(tmp_path, "sample_one_label", img, mask, affine)
    samples = [mod._summarize_pair(p) for p in mod._scan_outputs(tmp_path)]

    agg = mod._aggregate(
        samples,
        [
            {"anatomy": "lung tumor", "maisi_label_id": 23, "output_label_id": 1},
            {"anatomy": "heart", "maisi_label_id": 2, "output_label_id": 2},
        ],
    )

    assert agg["missing_expected_output_label_ids"] == [2]
    assert agg["all_effective_anatomy_labels_present"] is False
    assert mod._failure_reasons(0, samples, agg) == [
        "saved paired label map is missing expected output label id(s): [2]"
    ]


def test_curated_lung_tumor_fixture_uses_robust_size() -> None:
    fixture = (
        Path(__file__).resolve().parents[1] / "fixtures" / "chest_lung_tumor_controllable.json"
    )
    request = json.loads(fixture.read_text())

    assert request["controllable_anatomy_size"] == [["lung tumor", 0.5]]


def test_aggregate_flags_empty_foreground_and_constant_image(tmp_path):
    affine = np.eye(4)
    img = np.zeros((4, 4, 4), dtype=np.float32)
    mask = np.zeros((4, 4, 4), dtype=np.int16)
    _save_pair(tmp_path, "sample_z", img, mask, affine)
    samples = [mod._summarize_pair(p) for p in mod._scan_outputs(tmp_path)]
    agg = mod._aggregate(samples, None)
    assert agg["num_samples"] == 1
    assert agg["any_foreground_present"] is False
    assert agg["all_images_nonconstant"] is False
    assert agg["all_images_hu_like"] is False


def test_failure_reasons_report_upstream_failure_and_zero_samples():
    assert mod._failure_reasons(0, [{"image_readable": True}]) == []
    assert mod._failure_reasons(7, [{"image_readable": True}]) == [
        "upstream scripts.inference exited 7"
    ]
    assert mod._failure_reasons(0, []) == [
        "upstream scripts.inference produced zero image/label samples"
    ]
    assert mod._failure_reasons(7, []) == [
        "upstream scripts.inference exited 7",
        "upstream scripts.inference produced zero image/label samples",
    ]
