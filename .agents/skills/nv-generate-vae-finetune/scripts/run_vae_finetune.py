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

"""Wrapper for NV-Generate-CTMR VAE finetuning.

The upstream repository documents VAE training in ``train_vae_tutorial.ipynb``
and provides reusable configs/transforms/utilities, but no dedicated
``scripts.train_vae`` entrypoint. This wrapper stages the same config and
datalist contract into deterministic files, then runs the VAE training loop
against existing upstream helper APIs. It does not execute the notebook.

Engineering verification only. Outputs are not clinically meaningful.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SKILL_NAME = "nv_generate_vae_finetune"
MODEL_NAME = "maisi-vae"
UPSTREAM_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
UPSTREAM_ENTRYPOINT = "python skills/nv-generate-vae-finetune/scripts/run_vae_finetune.py"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_UPSTREAM = REPO_ROOT / ".workbench_data" / "upstreams" / "NV-Generate-CTMR"
REQUIRED_UPSTREAM_FILES = (
    "scripts/download_model_data.py",
    "scripts/transforms.py",
    "scripts/utils.py",
    "configs/config_network_rflow.json",
    "configs/environment_maisi_vae_train.json",
    "configs/config_maisi_vae_train.json",
)
SUPPORTED_MODALITIES = ("ct", "mri")


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, indent=2))
    sys.stdout.flush()


def _tail(text: str, n_chars: int = 4000) -> str:
    return text if len(text) <= n_chars else "..." + text[-n_chars:]


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def _write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return path


def _parse_triplet(value: str, cast: type = int) -> list[Any]:
    parts = [cast(v.strip()) for v in value.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("expected three comma-separated values")
    return parts


def _normalize_modality(value: str) -> str:
    lower = value.lower()
    if lower == "ct":
        return "ct"
    if lower == "mri" or lower.startswith("mri_"):
        return "mri"
    raise ValueError(f"unsupported modality {value!r}; expected ct or mri")


def _resolve_upstream_root(explicit: str | None = None) -> tuple[Path | None, list[str]]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_root = os.environ.get("NV_GENERATE_ROOT")
    if env_root:
        candidates.append(Path(env_root).expanduser())
    candidates.extend([DEFAULT_UPSTREAM, Path.home() / "NV-Generate-CTMR"])

    checked: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        checked.append(key)
        if all((resolved / rel).is_file() for rel in REQUIRED_UPSTREAM_FILES):
            return resolved, checked
    return None, checked


def _resolve_data_path(data_base_dir: Path, image: str) -> Path:
    image_path = Path(image)
    if image_path.is_absolute():
        raise ValueError("datalist image paths must be relative to --data-base-dir")
    return data_base_dir / image_path


def _split_entries(raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    training = raw.get("training")
    validation = raw.get("validation", raw.get("testing", raw.get("val", [])))
    if not isinstance(training, list) or not training:
        raise ValueError("datalist.training must be a non-empty list")
    if not isinstance(validation, list) or not validation:
        raise ValueError("datalist must include non-empty validation[] or testing[] entries")
    return training, validation


def _validate_datalist(
    data_base_dir: Path, datalist: Path, default_modality: str
) -> dict[str, Any]:
    default_class = _normalize_modality(default_modality)
    raw = _load_json(datalist)
    if not isinstance(raw, dict):
        raise ValueError("datalist must be a JSON object")
    training, validation = _split_entries(raw)

    missing: list[str] = []
    classes: set[str] = set()
    for split_name, entries in (("training", training), ("validation", validation)):
        for i, item in enumerate(entries):
            if not isinstance(item, dict) or "image" not in item:
                raise ValueError(f"{split_name}[{i}] must contain image")
            modality = _normalize_modality(
                str(item.get("class", item.get("modality", default_class)))
            )
            image_path = _resolve_data_path(data_base_dir, str(item["image"]))
            if not image_path.is_file():
                missing.append(str(image_path))
            classes.add(modality)
    if missing:
        raise FileNotFoundError(f"missing datalist image(s): {missing[:5]}")

    return {
        "data_base_dir": str(data_base_dir),
        "datalist": str(datalist),
        "training_cases": len(training),
        "validation_cases": len(validation),
        "modalities": sorted(classes),
        "default_modality": default_class,
    }


def _stage_entries(
    data_base_dir: Path,
    entries: list[dict[str, Any]],
    default_modality: str,
) -> list[dict[str, Any]]:
    staged: list[dict[str, Any]] = []
    for item in entries:
        next_item = dict(item)
        next_item["image"] = str(
            _resolve_data_path(data_base_dir, str(next_item["image"])).resolve()
        )
        next_item["class"] = _normalize_modality(
            str(next_item.get("class", next_item.get("modality", default_modality)))
        )
        next_item.pop("modality", None)
        staged.append(next_item)
    return staged


def _stage_datalist(
    data_base_dir: Path,
    input_path: Path,
    output_path: Path,
    default_modality: str,
) -> tuple[Path, dict[str, Any]]:
    raw = _load_json(input_path)
    training, validation = _split_entries(raw)
    staged = {
        "training": _stage_entries(data_base_dir, training, default_modality),
        "validation": _stage_entries(data_base_dir, validation, default_modality),
    }
    return _write_json(output_path, staged), staged


def _git_commit(root: Path) -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _resolve_from_upstream(upstream_root: Path, value: str | None) -> str | None:
    if value in (None, ""):
        return value
    path = Path(str(value)).expanduser()
    if path.is_absolute():
        return str(path)
    return str((upstream_root / path).resolve())


def _stage_configs(args: argparse.Namespace, upstream_root: Path) -> dict[str, Any]:
    model_def_src = upstream_root / "configs" / "config_network_rflow.json"
    env_src = upstream_root / "configs" / "environment_maisi_vae_train.json"
    train_src = upstream_root / "configs" / "config_maisi_vae_train.json"
    for path in (model_def_src, env_src, train_src):
        if not path.is_file():
            raise FileNotFoundError(path)

    work_dir = args.output_dir.resolve() / "workflow"
    artifacts_dir = args.output_dir.resolve() / "artifacts"
    config_dir = work_dir / "configs"
    model_dir = artifacts_dir / "models"
    tfevent_path = artifacts_dir / "tfevent"
    staged_datalist_path, staged_datalist = _stage_datalist(
        args.data_base_dir.resolve(),
        args.datalist.resolve(),
        work_dir / "dataset.json",
        args.modality,
    )

    model_def = copy.deepcopy(_load_json(model_def_src))
    env_config = copy.deepcopy(_load_json(env_src))
    train_config = copy.deepcopy(_load_json(train_src))

    env_config["model_dir"] = str(model_dir)
    env_config["tfevent_path"] = str(tfevent_path)
    env_config["finetune"] = not args.train_from_scratch
    env_config["trained_autoencoder_path"] = (
        str(args.trained_autoencoder_path.resolve())
        if args.trained_autoencoder_path
        else _resolve_from_upstream(upstream_root, env_config.get("trained_autoencoder_path"))
    )

    data_option = train_config.setdefault("data_option", {})
    data_option["random_aug"] = args.random_aug
    data_option["spacing_type"] = args.spacing_type
    data_option["spacing"] = args.spacing
    data_option["select_channel"] = args.select_channel

    auto_train = train_config.setdefault("autoencoder_train", {})
    auto_train["batch_size"] = args.batch_size
    auto_train["patch_size"] = args.patch_size
    auto_train["val_batch_size"] = args.val_batch_size
    auto_train["val_patch_size"] = args.val_patch_size
    auto_train["val_sliding_window_patch_size"] = args.val_sliding_window_patch_size
    auto_train["lr"] = args.lr
    auto_train["perceptual_weight"] = args.perceptual_weight
    auto_train["kl_weight"] = args.kl_weight
    auto_train["adv_weight"] = args.adv_weight
    auto_train["recon_loss"] = args.recon_loss
    auto_train["val_interval"] = args.val_interval
    auto_train["cache"] = args.cache_rate
    auto_train["amp"] = not args.no_amp
    auto_train["n_epochs"] = args.epochs

    if "autoencoder_def" in model_def and args.autoencoder_num_splits is not None:
        model_def["autoencoder_def"]["num_splits"] = args.autoencoder_num_splits

    artifacts_dir.mkdir(parents=True, exist_ok=True)
    return {
        "env_config": _write_json(config_dir / "environment_maisi_vae_train.json", env_config),
        "model_config": _write_json(config_dir / "config_maisi_vae_train.json", train_config),
        "model_def": _write_json(config_dir / "config_network_rflow.json", model_def),
        "datalist": _write_json(config_dir / "datalist_staged.json", staged_datalist),
        "staged_datalist": staged_datalist,
        "artifacts_dir": artifacts_dir,
        "model_dir": model_dir,
        "tfevent_path": tfevent_path,
    }


def _namespace_from_staged(staged: dict[str, Any]) -> argparse.Namespace:
    ns = argparse.Namespace()
    for path_key in ("env_config", "model_def"):
        for key, value in _load_json(staged[path_key]).items():
            setattr(ns, key, value)
    train_config = _load_json(staged["model_config"])
    for section in ("data_option", "autoencoder_train"):
        for key, value in train_config.get(section, {}).items():
            setattr(ns, key, value)
    return ns


def _warmup_rule(epoch: int) -> float:
    if epoch < 10:
        return 0.01
    if epoch < 20:
        return 0.1
    return 1.0


def _loss_weighted_sum(args: argparse.Namespace, losses: dict[str, float]) -> float:
    return (
        losses["recons_loss"]
        + args.kl_weight * losses["kl_loss"]
        + args.perceptual_weight * losses["p_loss"]
    )


def _run_training(
    args: argparse.Namespace, upstream_root: Path, staged: dict[str, Any]
) -> dict[str, Any]:
    if args.num_gpus != 1:
        raise ValueError("VAE finetuning runner currently supports exactly one CUDA GPU")
    sys.path.insert(0, str(upstream_root))

    import torch
    from monai.data import CacheDataset, DataLoader
    from monai.inferers.inferer import SimpleInferer, SlidingWindowInferer
    from monai.losses.adversarial_loss import PatchAdversarialLoss
    from monai.losses.perceptual import PerceptualLoss
    from monai.networks.nets import PatchDiscriminator
    from monai.utils import set_determinism
    from scripts.download_model_data import download_model_data
    from scripts.transforms import VAE_Transform
    from scripts.utils import KL_loss, define_instance, dynamic_infer
    from torch.amp import GradScaler, autocast
    from torch.nn import L1Loss, MSELoss
    from torch.optim import lr_scheduler
    from torch.utils.tensorboard import SummaryWriter

    if args.download_model_data:
        previous_cwd = os.getcwd()
        try:
            os.chdir(upstream_root)
            download_model_data("rflow-ct", str(upstream_root), model_only=True)
        finally:
            os.chdir(previous_cwd)

    set_determinism(seed=args.random_seed)
    cfg = _namespace_from_staged(staged)
    device = torch.device("cuda")

    train_transform = VAE_Transform(
        is_train=True,
        random_aug=cfg.random_aug,
        k=4,
        patch_size=cfg.patch_size,
        val_patch_size=cfg.val_patch_size,
        output_dtype=torch.float16,
        spacing_type=cfg.spacing_type,
        spacing=cfg.spacing,
        image_keys=["image"],
        label_keys=[],
        additional_keys=[],
        select_channel=cfg.select_channel,
    )
    val_transform = VAE_Transform(
        is_train=False,
        random_aug=False,
        k=4,
        val_patch_size=cfg.val_patch_size,
        output_dtype=torch.float16,
        image_keys=["image"],
        label_keys=[],
        additional_keys=[],
        select_channel=cfg.select_channel,
    )
    staged_datalist = staged["staged_datalist"]
    dataset_train = CacheDataset(
        data=staged_datalist["training"],
        transform=train_transform,
        cache_rate=cfg.cache,
        num_workers=args.cache_num_workers,
    )
    dataloader_train = DataLoader(
        dataset_train,
        batch_size=cfg.batch_size,
        num_workers=args.loader_num_workers,
        shuffle=True,
        drop_last=True,
    )
    dataset_val = CacheDataset(
        data=staged_datalist["validation"],
        transform=val_transform,
        cache_rate=cfg.cache,
        num_workers=args.cache_num_workers,
    )
    dataloader_val = DataLoader(
        dataset_val,
        batch_size=cfg.val_batch_size,
        num_workers=args.loader_num_workers,
        shuffle=False,
    )
    if len(dataloader_train) == 0:
        raise ValueError("training dataloader is empty; add cases or reduce batch size")
    if len(dataloader_val) == 0:
        raise ValueError("validation dataloader is empty; add validation/testing cases")

    Path(cfg.model_dir).mkdir(parents=True, exist_ok=True)
    tensorboard_path = Path(cfg.tfevent_path) / "autoencoder"
    tensorboard_path.mkdir(parents=True, exist_ok=True)
    writer = SummaryWriter(str(tensorboard_path))
    trained_g_path = Path(cfg.model_dir) / "autoencoder.pt"
    trained_d_path = Path(cfg.model_dir) / "discriminator.pt"

    autoencoder = define_instance(cfg, "autoencoder_def").to(device)
    discriminator = PatchDiscriminator(
        spatial_dims=cfg.spatial_dims,
        num_layers_d=3,
        channels=32,
        in_channels=1,
        out_channels=1,
        norm="INSTANCE",
    ).to(device)

    if cfg.finetune:
        checkpoint_autoencoder = torch.load(cfg.trained_autoencoder_path, map_location=device)
        if "unet_state_dict" in checkpoint_autoencoder:
            checkpoint_autoencoder = checkpoint_autoencoder["unet_state_dict"]
        autoencoder.load_state_dict(checkpoint_autoencoder)

    intensity_loss = MSELoss() if cfg.recon_loss == "l2" else L1Loss(reduction="mean")
    adv_loss = PatchAdversarialLoss(criterion="least_squares")
    loss_perceptual = (
        PerceptualLoss(spatial_dims=3, network_type="squeeze", is_fake_3d=True, fake_3d_ratio=0.2)
        .eval()
        .to(device)
    )
    optimizer_g = torch.optim.Adam(
        params=autoencoder.parameters(), lr=cfg.lr, eps=1e-6 if cfg.amp else 1e-8
    )
    optimizer_d = torch.optim.Adam(
        params=discriminator.parameters(), lr=cfg.lr, eps=1e-6 if cfg.amp else 1e-8
    )
    scheduler_g = lr_scheduler.LambdaLR(optimizer_g, lr_lambda=_warmup_rule)
    scheduler_d = lr_scheduler.LambdaLR(optimizer_d, lr_lambda=_warmup_rule)
    scaler_g = GradScaler("cuda", init_scale=2.0**8, growth_factor=1.5) if cfg.amp else None
    scaler_d = GradScaler("cuda", init_scale=2.0**8, growth_factor=1.5) if cfg.amp else None
    val_inferer = (
        SlidingWindowInferer(
            roi_size=cfg.val_sliding_window_patch_size,
            sw_batch_size=1,
            progress=False,
            overlap=0.0,
            device=torch.device("cpu"),
            sw_device=device,
        )
        if cfg.val_sliding_window_patch_size
        else SimpleInferer()
    )

    history: list[dict[str, Any]] = []
    best_val_loss = float("inf")
    best_paths: list[str] = []
    total_step = 0
    for epoch in range(cfg.n_epochs):
        autoencoder.train()
        discriminator.train()
        train_losses = {"recons_loss": 0.0, "kl_loss": 0.0, "p_loss": 0.0}
        adv_total = 0.0

        for batch in dataloader_train:
            images = batch["image"].to(device).contiguous()
            optimizer_g.zero_grad(set_to_none=True)
            optimizer_d.zero_grad(set_to_none=True)
            with autocast("cuda", enabled=cfg.amp):
                reconstruction, z_mu, z_sigma = autoencoder(images)
                losses = {
                    "recons_loss": intensity_loss(reconstruction, images),
                    "kl_loss": KL_loss(z_mu, z_sigma),
                    "p_loss": loss_perceptual(reconstruction.float(), images.float()),
                }
                logits_fake = discriminator(reconstruction.contiguous().float())[-1]
                generator_loss = adv_loss(logits_fake, target_is_real=True, for_discriminator=False)
                loss_g = (
                    losses["recons_loss"]
                    + cfg.kl_weight * losses["kl_loss"]
                    + cfg.perceptual_weight * losses["p_loss"]
                    + cfg.adv_weight * generator_loss
                )
                if cfg.amp and scaler_g is not None:
                    scaler_g.scale(loss_g).backward()
                    scaler_g.unscale_(optimizer_g)
                    scaler_g.step(optimizer_g)
                    scaler_g.update()
                else:
                    loss_g.backward()
                    optimizer_g.step()

                logits_fake = discriminator(reconstruction.contiguous().detach())[-1]
                loss_d_fake = adv_loss(logits_fake, target_is_real=False, for_discriminator=True)
                logits_real = discriminator(images.contiguous().detach())[-1]
                loss_d_real = adv_loss(logits_real, target_is_real=True, for_discriminator=True)
                loss_d = (loss_d_fake + loss_d_real) * 0.5
                if cfg.amp and scaler_d is not None:
                    scaler_d.scale(loss_d).backward()
                    scaler_d.step(optimizer_d)
                    scaler_d.update()
                else:
                    loss_d.backward()
                    optimizer_d.step()

            total_step += 1
            for loss_name, loss_value in losses.items():
                value = float(loss_value.item())
                writer.add_scalar(f"train_{loss_name}_iter", value, total_step)
                train_losses[loss_name] += value
            adv_total += float(generator_loss.item())
            writer.add_scalar("train_adv_loss_iter", float(generator_loss.item()), total_step)
            writer.add_scalar("train_fake_loss_iter", float(loss_d_fake.item()), total_step)
            writer.add_scalar("train_real_loss_iter", float(loss_d_real.item()), total_step)

        scheduler_g.step()
        scheduler_d.step()
        for key in train_losses:
            train_losses[key] /= len(dataloader_train)
            writer.add_scalar(f"train_{key}_epoch", train_losses[key], epoch)
        train_weighted = _loss_weighted_sum(cfg, train_losses)
        torch.save(autoencoder.state_dict(), trained_g_path)
        torch.save(discriminator.state_dict(), trained_d_path)

        epoch_record: dict[str, Any] = {
            "epoch": epoch,
            "train_losses": train_losses,
            "train_weighted_loss": train_weighted,
            "train_adv_loss": adv_total / len(dataloader_train),
        }

        if epoch % cfg.val_interval == 0:
            autoencoder.eval()
            val_losses = {"recons_loss": 0.0, "kl_loss": 0.0, "p_loss": 0.0}
            last_z_mu = None
            for batch in dataloader_val:
                with torch.no_grad(), autocast("cuda", enabled=cfg.amp):
                    images = batch["image"].to(device).contiguous()
                    reconstruction, z_mu, z_sigma = dynamic_infer(val_inferer, autoencoder, images)
                    reconstruction = reconstruction.to(device)
                    target = images
                    val_losses["recons_loss"] += float(
                        intensity_loss(reconstruction, target).item()
                    )
                    val_losses["kl_loss"] += float(KL_loss(z_mu, z_sigma).item())
                    val_losses["p_loss"] += float(loss_perceptual(reconstruction, target).item())
                    last_z_mu = z_mu
            for key in val_losses:
                val_losses[key] /= len(dataloader_val)
                writer.add_scalar(key, val_losses[key], epoch)
            val_loss = _loss_weighted_sum(cfg, val_losses)
            epoch_record["val_losses"] = val_losses
            epoch_record["val_weighted_loss"] = val_loss
            if last_z_mu is not None:
                writer.add_scalar(
                    "val_one_sample_scale_factor", float(1.0 / last_z_mu.flatten().std()), epoch
                )
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_path = Path(str(trained_g_path)[:-3] + f"_epoch{epoch}.pt")
                torch.save(autoencoder.state_dict(), best_path)
                best_paths.append(str(best_path))
                epoch_record["best_autoencoder_checkpoint"] = str(best_path)
        history.append(epoch_record)

    writer.close()
    return {
        "autoencoder_checkpoint": str(trained_g_path),
        "discriminator_checkpoint": str(trained_d_path),
        "best_autoencoder_checkpoints": best_paths,
        "history": history,
        "tensorboard_dir": str(tensorboard_path),
    }


def _write_workflow_summary(staged: dict[str, Any], result: dict[str, Any]) -> Path:
    summary = {
        "model": MODEL_NAME,
        "training_cases": len(staged["staged_datalist"].get("training", [])),
        "validation_cases": len(staged["staged_datalist"].get("validation", [])),
        "staged_configs": {
            "env_config": str(staged["env_config"]),
            "model_config": str(staged["model_config"]),
            "model_def": str(staged["model_def"]),
            "datalist": str(staged["datalist"]),
        },
        **result,
    }
    return _write_json(staged["artifacts_dir"] / "workflow_summary.json", summary)


def _build_command(args: argparse.Namespace) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        str(args.datalist.resolve()),
        "--data-base-dir",
        str(args.data_base_dir.resolve()),
        "--output-dir",
        str(args.output_dir.resolve()),
        "--modality",
        args.modality,
        "--epochs",
        str(args.epochs),
        "--batch-size",
        str(args.batch_size),
        "--lr",
        str(args.lr),
        "--cache-rate",
        str(args.cache_rate),
        "--patch-size",
        ",".join(str(v) for v in args.patch_size),
        "--num-gpus",
        str(args.num_gpus),
    ]
    if args.download_model_data:
        command.append("--download-model-data")
    if args.train_from_scratch:
        command.append("--train-from-scratch")
    if args.no_amp:
        command.append("--no-amp")
    if args.preflight:
        command.append("--preflight")
    return command


def _summarize_output(output_dir: Path) -> dict[str, Any]:
    artifacts_dir = output_dir / "artifacts"
    summary_path = artifacts_dir / "workflow_summary.json"
    summary = _load_json(summary_path) if summary_path.is_file() else {}
    autoencoder = Path(summary.get("autoencoder_checkpoint") or "")
    discriminator = Path(summary.get("discriminator_checkpoint") or "")
    best_paths = [Path(p) for p in summary.get("best_autoencoder_checkpoints", [])]
    return {
        "directory": str(output_dir),
        "artifacts_dir": str(artifacts_dir),
        "workflow_summary": str(summary_path) if summary_path.is_file() else None,
        "autoencoder_checkpoint": str(autoencoder) if str(autoencoder) else None,
        "autoencoder_checkpoint_present": autoencoder.is_file() if str(autoencoder) else False,
        "discriminator_checkpoint": str(discriminator) if str(discriminator) else None,
        "discriminator_checkpoint_present": (
            discriminator.is_file() if str(discriminator) else False
        ),
        "best_autoencoder_checkpoints": [str(p) for p in best_paths],
        "num_best_autoencoder_checkpoints": len(best_paths),
        "loss_history": summary.get("history", []),
        "tensorboard_dir": summary.get("tensorboard_dir"),
    }


def _empty_output(output_dir: Path) -> dict[str, Any]:
    return {
        "directory": str(output_dir),
        "artifacts_dir": str(output_dir / "artifacts"),
        "workflow_summary": None,
        "autoencoder_checkpoint": None,
        "autoencoder_checkpoint_present": False,
        "discriminator_checkpoint": None,
        "discriminator_checkpoint_present": False,
        "best_autoencoder_checkpoints": [],
        "num_best_autoencoder_checkpoints": 0,
        "loss_history": [],
        "tensorboard_dir": None,
    }


def _payload(
    args: argparse.Namespace,
    dataset: dict[str, Any],
    upstream_root: Path | None,
    checked_roots: list[str],
    exit_code: int,
    elapsed: float,
    stdout: str = "",
    stderr: str = "",
) -> dict[str, Any]:
    output = (
        _summarize_output(args.output_dir)
        if exit_code == 0 and not args.preflight
        else _empty_output(args.output_dir)
    )
    return {
        "skill": SKILL_NAME,
        "model": MODEL_NAME,
        "model_repo": UPSTREAM_REPO,
        "license": "Apache-2.0",
        "input": {
            **dataset,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "cache_rate": args.cache_rate,
            "patch_size": args.patch_size,
            "val_patch_size": args.val_patch_size,
            "num_gpus": args.num_gpus,
            "finetune": not args.train_from_scratch,
            "random_seed": args.random_seed,
        },
        "output": output,
        "invocation": {
            "official_entrypoint": UPSTREAM_ENTRYPOINT,
            "upstream_root": str(upstream_root) if upstream_root else None,
            "upstream_commit": _git_commit(upstream_root) if upstream_root else "",
            "checked_upstream_roots": checked_roots,
            "command": _build_command(args),
            "exit_code": exit_code,
            "subprocess_seconds": elapsed,
        },
        "runtime": {
            "subprocess_seconds": elapsed,
            "device": "cuda" if args.num_gpus > 0 else "cpu",
            "preflight_only": bool(args.preflight),
        },
        "logs": {"stdout_tail": _tail(stdout), "stderr_tail": _tail(stderr)},
        "intended_use_disclaimer": (
            "Engineering wrapper for synthetic-imaging VAE finetuning; not for clinical "
            "interpretation, regulatory use, or production training data approval."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datalist", type=Path)
    parser.add_argument("--data-base-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--upstream-root")
    parser.add_argument(
        "--modality",
        default="mri",
        help="Default modality/class for entries missing class/modality: ct or mri",
    )
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--val-batch-size", type=int, default=1)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--cache-rate", type=float, default=0.0)
    parser.add_argument("--patch-size", type=lambda s: _parse_triplet(s, int), default=[64, 64, 64])
    parser.add_argument("--val-patch-size", type=lambda s: _parse_triplet(s, int))
    parser.add_argument(
        "--val-sliding-window-patch-size",
        type=lambda s: _parse_triplet(s, int),
        default=[96, 96, 64],
    )
    parser.add_argument("--autoencoder-num-splits", type=int, default=1)
    parser.add_argument("--num-gpus", type=int, default=1)
    parser.add_argument("--perceptual-weight", type=float, default=0.3)
    parser.add_argument("--kl-weight", type=float, default=1e-7)
    parser.add_argument("--adv-weight", type=float, default=0.1)
    parser.add_argument("--recon-loss", choices=("l1", "l2"), default="l1")
    parser.add_argument("--val-interval", type=int, default=1)
    parser.add_argument(
        "--spacing-type", choices=("original", "fixed", "rand_zoom"), default="original"
    )
    parser.add_argument("--spacing", type=lambda s: _parse_triplet(s, float))
    parser.add_argument("--select-channel", type=int, default=0)
    parser.add_argument("--cache-num-workers", type=int, default=0)
    parser.add_argument("--loader-num-workers", type=int, default=0)
    parser.add_argument("--random-seed", type=int, default=0)
    parser.add_argument("--trained-autoencoder-path", type=Path)
    parser.add_argument("--download-model-data", action="store_true")
    parser.add_argument("--train-from-scratch", action="store_true")
    parser.add_argument("--no-random-aug", dest="random_aug", action="store_false")
    parser.set_defaults(random_aug=True)
    parser.add_argument("--no-amp", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.modality = _normalize_modality(args.modality)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    dataset = _validate_datalist(
        args.data_base_dir.resolve(), args.datalist.resolve(), args.modality
    )
    upstream_root, checked = _resolve_upstream_root(args.upstream_root)
    start = time.time()

    if upstream_root is None and args.preflight:
        payload = _payload(args, dataset, None, checked, 0, time.time() - start)
        payload["logs"]["stderr_tail"] = (
            "Preflight did not find an NV-Generate-CTMR checkout containing VAE configs/helpers. "
            "A real training run requires NV_GENERATE_ROOT to point at a current checkout."
        )
        _emit(payload)
        return

    if upstream_root is None:
        payload = _payload(args, dataset, None, checked, 2, time.time() - start)
        payload["logs"]["stderr_tail"] = (
            "NV-Generate-CTMR checkout with VAE configs/helpers was not found. "
            "Set NV_GENERATE_ROOT or pass --upstream-root."
        )
        _emit(payload)
        raise SystemExit(2)

    try:
        staged = _stage_configs(args, upstream_root)
    except Exception as exc:
        payload = _payload(
            args, dataset, upstream_root, checked, 2, time.time() - start, stderr=str(exc)
        )
        _emit(payload)
        raise SystemExit(2)

    if args.preflight:
        payload = _payload(args, dataset, upstream_root, checked, 0, time.time() - start)
        payload["logs"][
            "stderr_tail"
        ] = "Preflight staged VAE configs and validated datalist paths."
        _emit(payload)
        return

    stdout = ""
    try:
        result = _run_training(args, upstream_root, staged)
        _write_workflow_summary(staged, result)
        exit_code = 0
        stderr = ""
    except Exception as exc:
        exit_code = 2
        stderr = f"{type(exc).__name__}: {exc}"
    payload = _payload(
        args, dataset, upstream_root, checked, exit_code, time.time() - start, stdout, stderr
    )
    _emit(payload)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
