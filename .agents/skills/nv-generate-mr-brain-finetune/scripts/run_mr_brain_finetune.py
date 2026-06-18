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

"""Thin wrapper for NV-Generate-CTMR MR-brain diffusion-UNet finetuning.

The wrapper mirrors the upstream ``train_diff_unet_tutorial.ipynb`` flow without
reimplementing it:

1. stage the three config JSONs, rewriting only the run-specific paths and
   ``n_epochs`` (notebook cell 15);
2. ``python -m scripts.diff_model_create_training_data`` -> ``*_emb.nii.gz``
   (notebook cell 17);
3. write a ``<emb>.nii.gz.json`` sidecar per embedding (notebook cell 19) -- the
   one piece of glue that lives in the notebook, not in upstream ``scripts/``,
   and that ``diff_model_train`` requires;
4. ``python -m scripts.diff_model_train`` (notebook cell 21), optionally followed
   by ``python -m scripts.diff_model_infer``.

All hyperparameters (lr, batch_size, cache_rate, inference settings, ...) live in
the model-config JSON and are edited there or supplied via ``--model-config``;
the wrapper does not surface them as flags. It does not execute the notebook.

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

SKILL_NAME = "nv_generate_mr_brain_finetune"
UPSTREAM_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
UPSTREAM_ENTRYPOINT = (
    "python -m scripts.diff_model_create_training_data; " "python -m scripts.diff_model_train"
)
VERSION = "rflow-mr-brain"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_UPSTREAM = REPO_ROOT / ".workbench_data" / "upstreams" / "NV-Generate-CTMR"
REQUIRED_UPSTREAM_FILES = (
    "scripts/download_model_data.py",
    "scripts/diff_model_create_training_data.py",
    "scripts/diff_model_train.py",
    "scripts/diff_model_infer.py",
    "configs/config_network_rflow.json",
    "configs/environment_maisi_diff_model_rflow-mr-brain.json",
    "configs/config_maisi_diff_model_rflow-mr-brain.json",
    "configs/modality_mapping.json",
)
SUPPORTED_MODALITIES = (
    "mri",
    "mri_t1",
    "mri_t2",
    "mri_flair",
    "mri_swi",
    "mri_t1_skull_stripped",
    "mri_t2_skull_stripped",
    "mri_flair_skull_stripped",
    "mri_swi_skull_stripped",
)


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


def _parse_region(value: str) -> list[int]:
    parts = [int(v.strip()) for v in value.split(",")]
    if len(parts) != 4 or any(v not in (0, 1) for v in parts):
        raise argparse.ArgumentTypeError("expected four comma-separated 0/1 values")
    return parts


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


def _validate_datalist(data_base_dir: Path, datalist: Path, modality: str) -> dict[str, Any]:
    if modality not in SUPPORTED_MODALITIES:
        raise ValueError(f"unsupported modality {modality!r}")
    raw = _load_json(datalist)
    if not isinstance(raw, dict):
        raise ValueError("datalist must be a JSON object")
    training = raw.get("training")
    testing = raw.get("testing", [])
    if not isinstance(training, list) or not training:
        raise ValueError("datalist.training must be a non-empty list")
    if not isinstance(testing, list):
        raise ValueError("datalist.testing must be a list when provided")

    missing: list[str] = []
    modality_values: set[str] = set()
    for split_name, entries in (("training", training), ("testing", testing)):
        for i, item in enumerate(entries):
            if not isinstance(item, dict) or "image" not in item:
                raise ValueError(f"{split_name}[{i}] must contain image")
            item_modality = str(item.get("modality", modality))
            if item_modality not in SUPPORTED_MODALITIES:
                raise ValueError(f"unsupported modality {item_modality!r} in {split_name}[{i}]")
            image_path = _resolve_data_path(data_base_dir, str(item["image"]))
            if not image_path.is_file():
                missing.append(str(image_path))
            modality_values.add(item_modality)
    if missing:
        raise FileNotFoundError(f"missing datalist image(s): {missing[:5]}")

    return {
        "data_base_dir": str(data_base_dir),
        "datalist": str(datalist),
        "training_cases": len(training),
        "testing_cases": len(testing),
        "modalities": sorted(modality_values),
        "default_modality": modality,
    }


def _stage_datalist(
    data_base_dir: Path,
    input_path: Path,
    output_path: Path,
    default_modality: str,
) -> tuple[Path, dict[str, Any]]:
    raw = _load_json(input_path)
    staged: dict[str, Any] = {"training": [], "testing": []}
    for split in ("training", "testing"):
        for item in raw.get(split, []):
            next_item = dict(item)
            next_item.setdefault("modality", default_modality)
            _resolve_data_path(data_base_dir, str(next_item["image"]))
            staged[split].append(next_item)
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


def _config_sources(args: argparse.Namespace, upstream_root: Path) -> tuple[Path, Path, Path]:
    """Resolve the three config JSONs: caller-supplied overrides or upstream defaults."""
    model_def = (
        Path(args.model_def).expanduser()
        if args.model_def
        else upstream_root / "configs" / "config_network_rflow.json"
    )
    env_config = (
        Path(args.env_config).expanduser()
        if args.env_config
        else upstream_root / "configs" / f"environment_maisi_diff_model_{VERSION}.json"
    )
    model_config = (
        Path(args.model_config).expanduser()
        if args.model_config
        else upstream_root / "configs" / f"config_maisi_diff_model_{VERSION}.json"
    )
    return model_def, env_config, model_config


def _modality_mapping(upstream_root: Path) -> dict[str, int]:
    path = upstream_root / "configs" / "modality_mapping.json"
    return {str(k): int(v) for k, v in _load_json(path).items()}


def _resolve_from_upstream(upstream_root: Path, value: str | None) -> str | None:
    if value in (None, ""):
        return value
    path = Path(str(value)).expanduser()
    if path.is_absolute():
        return str(path)
    return str((upstream_root / path).resolve())


def _stage_configs(args: argparse.Namespace, upstream_root: Path) -> dict[str, Any]:
    """Stage configs the way the notebook does: rewrite run paths + n_epochs only.

    Every other hyperparameter is left exactly as it appears in the (upstream or
    caller-supplied) model-config JSON.
    """
    model_def_src, env_src, model_src = _config_sources(args, upstream_root)
    for path in (model_def_src, env_src, model_src):
        if not path.is_file():
            raise FileNotFoundError(path)

    work_dir = args.output_dir.resolve() / "workflow"
    artifacts_dir = args.output_dir.resolve() / "artifacts"
    config_dir = work_dir / "configs"
    embedding_dir = work_dir / "embeddings"
    model_dir = artifacts_dir / "models"
    inference_dir = artifacts_dir / "inference"
    staged_datalist_path, staged_datalist = _stage_datalist(
        args.data_base_dir.resolve(),
        args.datalist.resolve(),
        work_dir / "dataset.json",
        args.modality,
    )

    model_def = copy.deepcopy(_load_json(model_def_src))
    env_config = copy.deepcopy(_load_json(env_src))
    model_config = copy.deepcopy(_load_json(model_src))

    # Run-specific path rewrites (notebook cell 15).
    env_config["data_base_dir"] = str(args.data_base_dir.resolve())
    env_config["embedding_base_dir"] = str(embedding_dir)
    env_config["json_data_list"] = str(staged_datalist_path)
    env_config["model_dir"] = str(model_dir)
    env_config["output_dir"] = str(inference_dir)
    env_config["modality_mapping_path"] = str(
        (upstream_root / "configs" / "modality_mapping.json").resolve()
    )
    env_config["trained_autoencoder_path"] = (
        str(args.trained_autoencoder_path.resolve())
        if args.trained_autoencoder_path
        else _resolve_from_upstream(upstream_root, env_config.get("trained_autoencoder_path"))
    )
    if args.existing_ckpt_filepath:
        env_config["existing_ckpt_filepath"] = str(args.existing_ckpt_filepath.resolve())
    elif args.train_from_scratch:
        env_config["existing_ckpt_filepath"] = None
    else:
        env_config["existing_ckpt_filepath"] = _resolve_from_upstream(
            upstream_root,
            env_config.get("existing_ckpt_filepath"),
        )
    if args.model_filename:
        env_config["model_filename"] = args.model_filename

    # The only training field the notebook overrides; everything else stays as in
    # the config JSON so users tune by editing it (or passing --model-config).
    model_config.setdefault("diffusion_unet_train", {})["n_epochs"] = args.epochs

    # Keep optional inference conditioning consistent with the chosen modality.
    modality_code = _modality_mapping(upstream_root).get(args.modality)
    if modality_code is None:
        raise ValueError(f"modality {args.modality!r} not found in configs/modality_mapping.json")
    model_config.setdefault("diffusion_unet_inference", {})["modality"] = modality_code

    artifacts_dir.mkdir(parents=True, exist_ok=True)
    return {
        "env_config": _write_json(config_dir / "environment_maisi_diff_model.json", env_config),
        "model_config": _write_json(config_dir / "config_maisi_diff_model.json", model_config),
        "model_def": _write_json(config_dir / "config_maisi.json", model_def),
        "embedding_dir": embedding_dir,
        "artifacts_dir": artifacts_dir,
        "model_dir": model_dir,
        "inference_dir": inference_dir,
        "datalist": staged_datalist,
        "include_body_region": bool(model_def.get("include_body_region", False)),
        "modality_code": modality_code,
    }


def _module_command(module: str, module_args: list[str], num_gpus: int) -> list[str]:
    if num_gpus > 1:
        return [
            sys.executable,
            "-m",
            "torch.distributed.run",
            "--nproc_per_node",
            str(num_gpus),
            "--nnodes",
            "1",
            "--master_addr",
            "localhost",
            "--master_port",
            "1234",
            "-m",
            module,
            *module_args,
        ]
    return [sys.executable, "-m", module, *module_args]


def _build_command_plan(
    args: argparse.Namespace,
    upstream_root: Path,
    staged: dict[str, Any] | None = None,
) -> list[list[str]]:
    env_config = str(staged["env_config"]) if staged else "<staged-env-config>"
    model_config = str(staged["model_config"]) if staged else "<staged-model-config>"
    model_def = str(staged["model_def"]) if staged else "<staged-model-def>"
    plan: list[list[str]] = []
    if args.download_model_data:
        plan.append(
            [
                sys.executable,
                "-m",
                "scripts.download_model_data",
                "--version",
                VERSION,
                "--root_dir",
                str(upstream_root),
                "--model_only",
            ]
        )
    if not args.skip_create_training_data:
        plan.append(
            _module_command(
                "scripts.diff_model_create_training_data",
                ["-e", env_config, "-c", model_config, "-t", model_def, "-g", str(args.num_gpus)],
                args.num_gpus,
            )
        )
    if not args.skip_train:
        train_args = [
            "-e",
            env_config,
            "-c",
            model_config,
            "-t",
            model_def,
            "-g",
            str(args.num_gpus),
        ]
        if args.no_amp:
            train_args.append("--no_amp")
        plan.append(_module_command("scripts.diff_model_train", train_args, args.num_gpus))
    if args.run_inference:
        plan.append(
            _module_command(
                "scripts.diff_model_infer",
                ["-e", env_config, "-c", model_config, "-t", model_def, "-g", str(args.num_gpus)],
                args.num_gpus,
            )
        )
    return plan


def _create_embedding_sidecars(
    embedding_base_dir: Path,
    modality: str,
    include_body_region: bool,
    top_region_index: list[int],
    bottom_region_index: list[int],
) -> list[Path]:
    """Reproduce notebook cell 19: a <emb>.nii.gz.json sidecar per embedding.

    ``diff_model_train`` reads spacing/modality (and region indices when the model
    uses body-region conditioning) from these files; upstream ``scripts/`` does not
    write them, so this glue stays in the skill.
    """
    import nibabel as nib

    sidecars: list[Path] = []
    for emb in sorted(embedding_base_dir.rglob("*_emb.nii.gz")):
        img = nib.load(str(emb))
        data: dict[str, Any] = {
            "dim": [int(v) for v in img.shape[:3]],
            "spacing": [float(v) for v in img.header.get_zooms()[:3]],
            "modality": modality,
        }
        if include_body_region:
            data["top_region_index"] = top_region_index
            data["bottom_region_index"] = bottom_region_index
        sidecars.append(_write_json(Path(str(emb) + ".json"), data))
    return sidecars


def _run_command(
    command: list[str], upstream_root: Path, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(upstream_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _write_workflow_summary(
    args: argparse.Namespace,
    staged: dict[str, Any],
    sidecars: list[Path],
    inference_outputs: list[Path],
) -> Path:
    env_config = _load_json(staged["env_config"])
    model_filename = env_config.get("model_filename")
    checkpoint = staged["model_dir"] / model_filename if model_filename else None
    summary = {
        "generate_version": VERSION,
        "modality": args.modality,
        "modality_code": staged["modality_code"],
        "training_cases": len(staged["datalist"].get("training", [])),
        "testing_cases": len(staged["datalist"].get("testing", [])),
        "embedding_sidecars": [str(p) for p in sidecars],
        "checkpoint": str(checkpoint) if checkpoint else None,
        "inference_outputs": [str(p) for p in inference_outputs],
        "staged_configs": {
            "env_config": str(staged["env_config"]),
            "model_config": str(staged["model_config"]),
            "model_def": str(staged["model_def"]),
        },
    }
    return _write_json(staged["artifacts_dir"] / "workflow_summary.json", summary)


def _run_workflow(
    args: argparse.Namespace,
    upstream_root: Path,
    staged: dict[str, Any],
    env: dict[str, str],
) -> tuple[int, str, str, list[list[str]]]:
    command_plan = _build_command_plan(args, upstream_root, staged)
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    sidecars: list[Path] = []

    command_index = 0
    if args.download_model_data:
        proc = _run_command(command_plan[command_index], upstream_root, env)
        stdout_parts.append(proc.stdout)
        stderr_parts.append(proc.stderr)
        command_index += 1
        if proc.returncode != 0:
            return proc.returncode, "\n".join(stdout_parts), "\n".join(stderr_parts), command_plan

    if not args.skip_create_training_data:
        proc = _run_command(command_plan[command_index], upstream_root, env)
        stdout_parts.append(proc.stdout)
        stderr_parts.append(proc.stderr)
        command_index += 1
        if proc.returncode != 0:
            return proc.returncode, "\n".join(stdout_parts), "\n".join(stderr_parts), command_plan

    sidecars = _create_embedding_sidecars(
        staged["embedding_dir"],
        args.modality,
        staged["include_body_region"],
        args.top_region_index,
        args.bottom_region_index,
    )

    if not args.skip_train:
        proc = _run_command(command_plan[command_index], upstream_root, env)
        stdout_parts.append(proc.stdout)
        stderr_parts.append(proc.stderr)
        command_index += 1
        if proc.returncode != 0:
            return proc.returncode, "\n".join(stdout_parts), "\n".join(stderr_parts), command_plan

    inference_outputs: list[Path] = []
    if args.run_inference:
        proc = _run_command(command_plan[command_index], upstream_root, env)
        stdout_parts.append(proc.stdout)
        stderr_parts.append(proc.stderr)
        if proc.returncode != 0:
            return proc.returncode, "\n".join(stdout_parts), "\n".join(stderr_parts), command_plan
        inference_outputs = sorted(staged["inference_dir"].glob("*.nii.gz"))

    _write_workflow_summary(args, staged, sidecars, inference_outputs)
    return 0, "\n".join(stdout_parts), "\n".join(stderr_parts), command_plan


def _summarize_output(output_dir: Path) -> dict[str, Any]:
    artifacts_dir = output_dir / "artifacts"
    summary_path = artifacts_dir / "workflow_summary.json"
    summary = _load_json(summary_path) if summary_path.is_file() else {}
    checkpoint = Path(summary.get("checkpoint") or "")
    inference_outputs = [Path(p) for p in summary.get("inference_outputs", [])]
    return {
        "directory": str(output_dir),
        "artifacts_dir": str(artifacts_dir),
        "workflow_summary": str(summary_path) if summary_path.is_file() else None,
        "checkpoint": str(checkpoint) if str(checkpoint) else None,
        "checkpoint_present": checkpoint.is_file() if str(checkpoint) else False,
        "checkpoint_bytes": checkpoint.stat().st_size if checkpoint.is_file() else None,
        "embedding_sidecars": summary.get("embedding_sidecars", []),
        "num_embedding_sidecars": len(summary.get("embedding_sidecars", [])),
        "inference_outputs": [str(p) for p in inference_outputs],
        "num_inference_outputs": len(inference_outputs),
        "all_inference_outputs_present": all(p.is_file() for p in inference_outputs),
    }


def _empty_output(output_dir: Path) -> dict[str, Any]:
    return {
        "directory": str(output_dir),
        "artifacts_dir": str(output_dir / "artifacts"),
        "workflow_summary": None,
        "checkpoint": None,
        "checkpoint_present": False,
        "checkpoint_bytes": None,
        "embedding_sidecars": [],
        "num_embedding_sidecars": 0,
        "inference_outputs": [],
        "num_inference_outputs": 0,
        "all_inference_outputs_present": False,
    }


def _payload(
    args: argparse.Namespace,
    dataset: dict[str, Any],
    upstream_root: Path | None,
    checked_roots: list[str],
    command_plan: list[list[str]],
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
        "model": VERSION,
        "model_repo": UPSTREAM_REPO,
        "license": "Apache-2.0",
        "input": {
            **dataset,
            "epochs": args.epochs,
            "num_gpus": args.num_gpus,
            "amp": not args.no_amp,
            "modality": args.modality,
            "run_inference": bool(args.run_inference),
            "train_from_scratch": bool(args.train_from_scratch),
        },
        "output": output,
        "invocation": {
            "official_entrypoint": UPSTREAM_ENTRYPOINT,
            "upstream_root": str(upstream_root) if upstream_root else None,
            "upstream_commit": _git_commit(upstream_root) if upstream_root else "",
            "checked_upstream_roots": checked_roots,
            "command": command_plan[0] if command_plan else [],
            "command_plan": command_plan,
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
            "Engineering wrapper for synthetic MR-brain diffusion model finetuning; "
            "not for clinical interpretation, regulatory use, or production training data approval."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datalist", type=Path)
    parser.add_argument("--data-base-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--upstream-root")
    # Config sources: edit these JSONs (or the upstream defaults) to tune training.
    parser.add_argument(
        "--env-config", help="Override environment JSON (default: upstream MR-brain env config)"
    )
    parser.add_argument(
        "--model-config",
        help="Override model-config JSON holding training/inference hyperparameters",
    )
    parser.add_argument("--model-def", help="Override network-definition JSON")
    parser.add_argument("--modality", default="mri_t1", choices=SUPPORTED_MODALITIES)
    parser.add_argument(
        "--epochs",
        type=int,
        default=2,
        help="Overrides diffusion_unet_train.n_epochs in the model config",
    )
    parser.add_argument("--num-gpus", type=int, default=1)
    parser.add_argument("--no-amp", action="store_true")
    parser.add_argument("--top-region-index", type=_parse_region, default=[0, 1, 0, 0])
    parser.add_argument("--bottom-region-index", type=_parse_region, default=[0, 0, 1, 0])
    parser.add_argument("--existing-ckpt-filepath", type=Path)
    parser.add_argument("--trained-autoencoder-path", type=Path)
    parser.add_argument("--model-filename", default="")
    parser.add_argument("--download-model-data", action="store_true")
    parser.add_argument("--train-from-scratch", action="store_true")
    parser.add_argument("--skip-create-training-data", action="store_true")
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--run-inference", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    dataset = _validate_datalist(
        args.data_base_dir.resolve(), args.datalist.resolve(), args.modality
    )
    upstream_root, checked = _resolve_upstream_root(args.upstream_root)
    start = time.time()
    command_plan = _build_command_plan(args, upstream_root or DEFAULT_UPSTREAM)

    if upstream_root is None and args.preflight:
        payload = _payload(args, dataset, None, checked, command_plan, 0, time.time() - start)
        payload["logs"]["stderr_tail"] = (
            "Preflight did not find an NV-Generate-CTMR checkout containing the existing "
            "diffusion training scripts. A real training run requires NV_GENERATE_ROOT to "
            "point at a current NVIDIA-Medtech/NV-Generate-CTMR checkout."
        )
        _emit(payload)
        return

    if upstream_root is None:
        payload = _payload(args, dataset, None, checked, command_plan, 2, time.time() - start)
        payload["logs"]["stderr_tail"] = (
            "NV-Generate-CTMR checkout with diffusion training scripts was not found. "
            "Set NV_GENERATE_ROOT or pass --upstream-root."
        )
        _emit(payload)
        raise SystemExit(2)

    try:
        staged = _stage_configs(args, upstream_root)
        command_plan = _build_command_plan(args, upstream_root, staged)
    except Exception as exc:
        payload = _payload(
            args,
            dataset,
            upstream_root,
            checked,
            command_plan,
            2,
            time.time() - start,
            stderr=str(exc),
        )
        _emit(payload)
        raise SystemExit(2)

    if args.preflight:
        payload = _payload(
            args, dataset, upstream_root, checked, command_plan, 0, time.time() - start
        )
        payload["logs"][
            "stderr_tail"
        ] = "Preflight staged configs and validated existing upstream script entrypoints."
        _emit(payload)
        return

    env = os.environ.copy()
    cache_dir = args.output_dir / "cache"
    env.setdefault("MPLCONFIGDIR", str(cache_dir / "matplotlib"))
    env.setdefault("XDG_CACHE_HOME", str(cache_dir / "xdg"))
    env.setdefault("CUDA_CACHE_PATH", str(cache_dir / "cuda"))
    exit_code, stdout, stderr, command_plan = _run_workflow(args, upstream_root, staged, env)
    payload = _payload(
        args,
        dataset,
        upstream_root,
        checked,
        command_plan,
        exit_code,
        time.time() - start,
        stdout,
        stderr,
    )
    _emit(payload)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
