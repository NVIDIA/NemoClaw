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

import argparse
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_vae_finetune.py"
spec = importlib.util.spec_from_file_location("run_vae_finetune", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def _write_datalist(root: Path, *, include_validation: bool = True) -> Path:
    train_image = root / "imagesTr" / "case001.nii.gz"
    train_image.parent.mkdir(parents=True)
    train_image.write_text("placeholder\n")
    payload = {"training": [{"image": "imagesTr/case001.nii.gz", "modality": "mri_t1"}]}
    if include_validation:
        val_image = root / "imagesVal" / "case001.nii.gz"
        val_image.parent.mkdir(parents=True)
        val_image.write_text("placeholder\n")
        payload["testing"] = [{"image": "imagesVal/case001.nii.gz", "class": "mri"}]
    datalist = root / "datalist.json"
    datalist.write_text(json.dumps(payload))
    return datalist


def _args(tmp_path: Path, datalist: Path) -> argparse.Namespace:
    return argparse.Namespace(
        output_dir=tmp_path / "out",
        data_base_dir=tmp_path,
        datalist=datalist,
        modality="mri",
        epochs=2,
        batch_size=1,
        val_batch_size=1,
        lr=1e-4,
        cache_rate=0.0,
        patch_size=[32, 32, 32],
        val_patch_size=None,
        val_sliding_window_patch_size=[32, 32, 32],
        autoencoder_num_splits=1,
        num_gpus=1,
        perceptual_weight=0.3,
        kl_weight=1e-7,
        adv_weight=0.1,
        recon_loss="l1",
        val_interval=1,
        spacing_type="original",
        spacing=None,
        select_channel=0,
        cache_num_workers=0,
        loader_num_workers=0,
        random_seed=123,
        trained_autoencoder_path=None,
        download_model_data=False,
        train_from_scratch=False,
        random_aug=True,
        no_amp=True,
        preflight=True,
    )


def _fake_upstream(root: Path) -> Path:
    configs = root / "configs"
    scripts = root / "scripts"
    configs.mkdir(parents=True)
    scripts.mkdir()
    for script in ("download_model_data.py", "transforms.py", "utils.py"):
        (scripts / script).write_text("")
    (configs / "config_network_rflow.json").write_text(
        json.dumps({"spatial_dims": 3, "autoencoder_def": {"num_splits": 4}})
    )
    (configs / "environment_maisi_vae_train.json").write_text(
        json.dumps(
            {
                "model_dir": "./models",
                "tfevent_path": "./outputs/tfevent",
                "trained_autoencoder_path": "models/autoencoder_v1.pt",
                "finetune": True,
            }
        )
    )
    (configs / "config_maisi_vae_train.json").write_text(
        json.dumps({"data_option": {}, "autoencoder_train": {}})
    )
    return root


def test_validate_datalist_requires_training_and_validation_cases(tmp_path: Path) -> None:
    datalist = _write_datalist(tmp_path)

    summary = mod._validate_datalist(tmp_path, datalist, "mri_t1")

    assert summary["training_cases"] == 1
    assert summary["validation_cases"] == 1
    assert summary["modalities"] == ["mri"]
    assert summary["default_modality"] == "mri"


def test_validate_datalist_rejects_missing_validation_split(tmp_path: Path) -> None:
    datalist = _write_datalist(tmp_path, include_validation=False)

    with pytest.raises(ValueError, match="validation"):
        mod._validate_datalist(tmp_path, datalist, "mri")


def test_stage_configs_writes_absolute_paths_and_training_options(tmp_path: Path) -> None:
    datalist = _write_datalist(tmp_path)
    args = _args(tmp_path, datalist)
    upstream = _fake_upstream(tmp_path / "upstream")

    staged = mod._stage_configs(args, upstream)

    staged_datalist = json.loads(Path(staged["datalist"]).read_text())
    assert Path(staged_datalist["training"][0]["image"]).is_absolute()
    assert staged_datalist["training"][0]["class"] == "mri"
    env_config = json.loads(Path(staged["env_config"]).read_text())
    assert env_config["model_dir"].endswith("artifacts/models")
    assert env_config["trained_autoencoder_path"].endswith("upstream/models/autoencoder_v1.pt")
    train_config = json.loads(Path(staged["model_config"]).read_text())
    assert train_config["autoencoder_train"]["n_epochs"] == 2
    model_def = json.loads(Path(staged["model_def"]).read_text())
    assert model_def["autoencoder_def"]["num_splits"] == 1


def test_preflight_payload_reports_skill_entrypoint(tmp_path: Path) -> None:
    datalist = _write_datalist(tmp_path)
    args = _args(tmp_path, datalist)
    args.output_dir.mkdir()
    dataset = mod._validate_datalist(tmp_path, datalist, "mri")

    payload = mod._payload(args, dataset, None, ["/missing"], 0, 0.1)

    assert payload["skill"] == "nv_generate_vae_finetune"
    assert payload["runtime"]["preflight_only"] is True
    assert payload["invocation"]["official_entrypoint"] == mod.UPSTREAM_ENTRYPOINT
    assert payload["invocation"]["exit_code"] == 0
