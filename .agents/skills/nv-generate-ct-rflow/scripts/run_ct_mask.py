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

"""NV-Generate-CTMR standalone CT mask-generation wrapper.

Generates raw MAISI-space CT masks from controllable anatomy-size conditions
using upstream mask diffusion. This wrapper is intentionally narrow: it is for
diagnosing and producing masks before image generation, not for paired CT image
synthesis.
"""

from __future__ import annotations

import json
import os
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import nibabel as nib
import numpy as np
import typer

_SCRIPT_DIR = Path(__file__).resolve().parent
_SKILLS_DIR = _SCRIPT_DIR.parent.parent
if str(_SKILLS_DIR) not in sys.path:
    sys.path.insert(0, str(_SKILLS_DIR))
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from wrapper_utils import emit, file_sha256_safe, git_commit  # noqa: E402

SKILL_NAME = "nv_generate_ct_rflow_ct_mask"
MODEL_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
MODEL_WEIGHTS_REPO = "https://huggingface.co/nvidia/NV-Generate-CT"
NETWORK_CONFIG = "configs/config_network_rflow.json"
INFER_CONFIG = "configs/config_infer.json"
ENV_CONFIG = "configs/environment_rflow-ct.json"
MODEL_FILES = (
    "models/mask_generation_autoencoder.pt",
    "models/mask_generation_diffusion_unet.pt",
)
NATIVE_OUTPUT_SIZE = [256, 256, 256]
NATIVE_SPACING = [1.5, 1.5, 1.5]
ANATOMY_SIZE_INDEX = {
    "gallbladder": 0,
    "liver": 1,
    "stomach": 2,
    "pancreas": 3,
    "colon": 4,
    "lung tumor": 5,
    "pancreatic tumor": 6,
    "hepatic tumor": 7,
    "colon cancer primaries": 8,
    "bone lesion": 9,
}
OVERRIDE_KEYS = (
    "num_output_samples",
    "controllable_anatomy_size",
    "output_size",
    "spacing",
    "mask_generation_num_inference_steps",
    "autoencoder_sliding_window_infer_size",
    "autoencoder_sliding_window_infer_overlap",
)

app = typer.Typer(add_completion=False)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _valid_upstream_root(path: Path) -> bool:
    return (path / NETWORK_CONFIG).is_file() and (path / "scripts/sample_mask.py").is_file()


def _candidate_upstream_roots(env_value: str) -> list[Path]:
    candidates: list[Path] = []
    if env_value:
        candidates.append(Path(env_value).expanduser())
    candidates.extend(
        [
            Path(__file__).resolve().parents[3] / ".workbench_data/upstreams/NV-Generate-CTMR",
            Path.home() / "NV-Generate-CTMR",
            Path.home() / "nv-generate-ctmr",
        ]
    )
    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            deduped.append(candidate)
    return deduped


def _resolve_upstream_root(env_value: str) -> tuple[Path | None, list[str]]:
    checked: list[str] = []
    for candidate in _candidate_upstream_roots(env_value):
        resolved = candidate.resolve()
        checked.append(str(resolved))
        if _valid_upstream_root(resolved):
            return resolved, checked
    return None, checked


def _load_request(request_arg: str) -> tuple[dict[str, Any], str | None]:
    if request_arg == "default":
        return {}, None
    request_path = Path(request_arg).expanduser().resolve()
    if not request_path.is_file():
        raise typer.BadParameter(f"mask request JSON not found: {request_arg}")
    raw = json.loads(request_path.read_text())
    request = {k: v for k, v in raw.items() if not k.startswith("_")}
    unknown = sorted(k for k in request if k not in OVERRIDE_KEYS)
    if unknown:
        raise typer.BadParameter(
            f"mask request contains unknown key(s): {unknown}. Allowed: {OVERRIDE_KEYS}"
        )
    return request, str(request_path)


def _load_label_dict(upstream_root: Path) -> dict[str, int]:
    raw = _load_json(upstream_root / "configs/label_dict.json")
    return {str(k): int(v) for k, v in raw.items()}


def _validate_request(request: dict[str, Any], label_dict: dict[str, int]) -> list[str]:
    errors: list[str] = []
    controllable = request.get("controllable_anatomy_size") or []
    if not isinstance(controllable, list) or not controllable:
        errors.append("controllable_anatomy_size must be a non-empty list")
    elif len(controllable) > 10:
        errors.append("controllable_anatomy_size supports at most 10 entries")
    else:
        names: list[str] = []
        tumor_names = {
            "lung tumor",
            "pancreatic tumor",
            "hepatic tumor",
            "colon cancer primaries",
            "bone lesion",
        }
        tumors_seen = 0
        for item in controllable:
            if not (isinstance(item, (list, tuple)) and len(item) == 2):
                errors.append(f"controllable entry must be [name, size], got {item!r}")
                continue
            name, size = str(item[0]), item[1]
            names.append(name)
            if name not in ANATOMY_SIZE_INDEX:
                errors.append(f"unsupported controllable anatomy {name!r}")
            if name not in label_dict:
                errors.append(f"controllable anatomy {name!r} not found in label_dict.json")
            if name in tumor_names:
                tumors_seen += 1
            if not isinstance(size, (int, float)) or not (-1 <= float(size) <= 1):
                errors.append(
                    f"controllable size for {name!r} must be in [0, 1] or -1, got {size!r}"
                )
        if len(names) != len(set(names)):
            errors.append("controllable_anatomy_size must not repeat anatomy names")
        if tumors_seen > 1:
            errors.append("only one controllable tumor is supported")

    output_size = request.get("output_size", NATIVE_OUTPUT_SIZE)
    spacing = request.get("spacing", NATIVE_SPACING)
    if output_size != NATIVE_OUTPUT_SIZE or spacing != NATIVE_SPACING:
        errors.append(
            "standalone mask generation is restricted to native 256x256x256 at 1.5 mm isotropic; "
            "use paired CT generation for resampled image/mask output"
        )
    steps = request.get("mask_generation_num_inference_steps", 1000)
    if steps != 1000:
        errors.append(
            "mask_generation_num_inference_steps should be 1000 for the DDPM mask generator"
        )
    return errors


def _expected_label_mapping(
    request: dict[str, Any], label_dict: dict[str, int]
) -> list[dict[str, Any]]:
    mapping: list[dict[str, Any]] = []
    for item in request.get("controllable_anatomy_size") or []:
        if isinstance(item, (list, tuple)) and item:
            name = str(item[0])
            if name in label_dict:
                mapping.append({"anatomy": name, "maisi_label_id": int(label_dict[name])})
    return mapping


def _anatomy_size_condition(request: dict[str, Any], conditions_path: Path) -> list[float]:
    controllable = request.get("controllable_anatomy_size") or []
    provided: list[float | None] = [None] * 10
    for name, size in controllable:
        provided[ANATOMY_SIZE_INDEX[str(name)]] = float(size)

    candidates = json.loads(conditions_path.read_text())
    best_condition = [float(v) for v in candidates[0]["organ_size"]]
    best_diff = float("inf")
    for candidate in candidates:
        condition = [float(v) for v in candidate["organ_size"]]
        diff = sum(
            abs(condition[i] - value) for i, value in enumerate(provided) if value is not None
        )
        if diff < best_diff:
            best_diff = diff
            best_condition = condition
    for i, value in enumerate(provided):
        if value is not None:
            best_condition[i] = value
    return best_condition


def _model_inventory(upstream_root: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    all_present = True
    for rel in MODEL_FILES:
        path = upstream_root / rel
        present = path.is_file()
        files.append(
            {
                "path": rel,
                "present": present,
                "bytes": path.stat().st_size if present else None,
                "sha256": file_sha256_safe(path) if present else "",
            }
        )
        all_present = all_present and present
    return {"all_present": all_present, "files": files}


def _detect_cuda() -> dict[str, Any]:
    info: dict[str, Any] = {"available": False, "device_name": None, "total_memory_gb": None}
    try:
        import torch  # noqa: PLC0415

        info["torch_version"] = torch.__version__
        info["available"] = bool(torch.cuda.is_available())
        if info["available"]:
            props = torch.cuda.get_device_properties(0)
            info["device_name"] = props.name
            info["total_memory_gb"] = round(props.total_memory / (1024**3), 1)
            info["cuda_version"] = torch.version.cuda
    except Exception as exc:
        info["import_error"] = repr(exc)
    return info


def _summarize_mask(mask_path: Path, expected_mapping: list[dict[str, Any]]) -> dict[str, Any]:
    record: dict[str, Any] = {"mask_path": str(mask_path), "mask_readable": False}
    try:
        img = nib.load(str(mask_path))
        arr = np.asarray(img.get_fdata()).astype(np.int64)
        labels = sorted(int(v) for v in np.unique(arr).tolist())
        expected = sorted({int(item["maisi_label_id"]) for item in expected_mapping})
        record.update(
            {
                "mask_readable": True,
                "mask_shape": [int(v) for v in arr.shape],
                "mask_spacing": [round(float(v), 6) for v in img.header.get_zooms()[:3]],
                "label_ids_present": labels,
                "foreground_label_ids_present": [v for v in labels if v != 0],
                "expected_maisi_label_ids": expected,
                "missing_expected_maisi_label_ids": sorted(set(expected) - set(labels)),
                "all_expected_maisi_labels_present": not (set(expected) - set(labels)),
            }
        )
    except Exception as exc:
        record["mask_error"] = repr(exc)
    return record


def _aggregate(samples: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(samples)
    union: set[int] = set()
    missing: set[int] = set()
    for sample in samples:
        union.update(int(v) for v in sample.get("label_ids_present", []))
        missing.update(int(v) for v in sample.get("missing_expected_maisi_label_ids", []))
    return {
        "num_samples": n,
        "all_masks_readable": bool(n) and all(s.get("mask_readable") for s in samples),
        "union_label_ids_present": sorted(union),
        "missing_expected_maisi_label_ids": sorted(missing),
        "all_expected_maisi_labels_present": not missing,
    }


def _prepare_args(
    upstream_root: Path, request: dict[str, Any], output_dir: Path
) -> SimpleNamespace:
    env = _load_json(upstream_root / ENV_CONFIG)
    network = _load_json(upstream_root / NETWORK_CONFIG)
    infer = _load_json(upstream_root / INFER_CONFIG)
    infer.update(request)
    infer["output_size"] = NATIVE_OUTPUT_SIZE
    infer["spacing"] = NATIVE_SPACING
    args = SimpleNamespace()
    for source in (env, network, infer):
        for key, value in source.items():
            setattr(args, key, value)
    for key in (
        "trained_mask_generation_autoencoder_path",
        "trained_mask_generation_diffusion_path",
        "all_anatomy_size_conditions_json",
        "label_dict_remap_json",
    ):
        value = getattr(args, key, None)
        if isinstance(value, str) and not Path(value).is_absolute():
            setattr(args, key, str(upstream_root / value))
    args.output_dir = str(output_dir)
    return args


def _run_mask_generation(
    upstream_root: Path, request: dict[str, Any], output_dir: Path, seed: int
) -> list[Path]:
    import torch  # noqa: PLC0415
    from monai.utils import set_determinism  # noqa: PLC0415

    sys.path.insert(0, str(upstream_root))
    from scripts.sample_mask import ldm_conditional_sample_one_mask  # noqa: PLC0415
    from scripts.utils import define_instance  # noqa: PLC0415

    set_determinism(seed=seed)
    args = _prepare_args(upstream_root, request, output_dir)
    condition = _anatomy_size_condition(
        request, upstream_root / args.all_anatomy_size_conditions_json
    )
    device = torch.device("cuda")

    mask_ae = define_instance(args, "mask_generation_autoencoder").to(device)
    checkpoint_ae = torch.load(args.trained_mask_generation_autoencoder_path, weights_only=True)
    mask_ae.load_state_dict(checkpoint_ae)

    mask_unet = define_instance(args, "mask_generation_diffusion").to(device)
    checkpoint_unet = torch.load(args.trained_mask_generation_diffusion_path, weights_only=False)
    mask_unet.load_state_dict(checkpoint_unet["unet_state_dict"])
    scale_factor = checkpoint_unet["scale_factor"]
    scheduler = define_instance(args, "mask_generation_noise_scheduler")

    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    samples = int(request.get("num_output_samples", 1))
    for index in range(samples):
        with redirect_stdout(sys.stderr):
            mask = ldm_conditional_sample_one_mask(
                mask_ae,
                mask_unet,
                scheduler,
                scale_factor,
                condition,
                device,
                args.mask_generation_latent_shape,
                label_dict_remap_json=args.label_dict_remap_json,
                num_inference_steps=int(request.get("mask_generation_num_inference_steps", 1000)),
                autoencoder_sliding_window_infer_size=request.get(
                    "autoencoder_sliding_window_infer_size", [96, 96, 96]
                ),
                autoencoder_sliding_window_infer_overlap=float(
                    request.get("autoencoder_sliding_window_infer_overlap", 0.6667)
                ),
            )
        arr = mask.squeeze().detach().cpu().numpy().astype(np.int16)
        affine = np.diag([*NATIVE_SPACING, 1.0])
        out_path = output_dir / f"mask_{index:04d}.nii.gz"
        nib.save(nib.Nifti1Image(arr, affine), str(out_path))
        paths.append(out_path)
    return paths


@app.command()
def main(
    request_json: str = typer.Argument(..., help='Path to mask request JSON, or "default".'),
    output_dir: Path | None = typer.Option(None, "--output-dir", "-o"),
    seed: int = typer.Option(0, "--random-seed", "-s"),
    preflight_only: bool = typer.Option(False, "--preflight-only"),
    yes: bool = typer.Option(False, "--yes", "-y"),
) -> None:
    upstream_root, checked_roots = _resolve_upstream_root(
        os.environ.get("NV_GENERATE_ROOT", "").strip()
    )
    if upstream_root is None:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "NV_GENERATE_ROOT layout invalid",
                "checked_roots": checked_roots,
            }
        )
        raise typer.Exit(2)
    output_dir = (output_dir or upstream_root / "output").expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    request, request_source = _load_request(request_json)
    label_dict = _load_label_dict(upstream_root)
    errors = _validate_request(request, label_dict)
    inventory = _model_inventory(upstream_root)
    if not inventory["all_present"]:
        errors.append(
            "missing mask-generation weights. Run `python -m scripts.download_model_data "
            "--version rflow-ct --root_dir ./` from $NV_GENERATE_ROOT."
        )
    condition_path = upstream_root / "datasets/all_anatomy_size_conditions.json"
    if not condition_path.is_file():
        errors.append(
            "missing datasets/all_anatomy_size_conditions.json; run the full CT download without --model_only"
        )
    cuda = _detect_cuda()
    if not cuda["available"]:
        errors.append("CUDA not available. CT mask generation needs an NVIDIA GPU.")
    expected_mapping = _expected_label_mapping(request, label_dict)

    if errors:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "preflight validation failed",
                "preflight_errors": errors,
                "input": {
                    "request_json": request_source,
                    "request": request,
                    "expected_label_mapping": expected_mapping,
                },
                "invocation": {"model_inventory": inventory},
                "cuda": cuda,
            }
        )
        raise typer.Exit(2)

    if preflight_only:
        emit(
            {
                "skill": SKILL_NAME,
                "preflight": "ok",
                "input": {
                    "request_json": request_source,
                    "request": request,
                    "expected_label_mapping": expected_mapping,
                    "anatomy_size_condition": _anatomy_size_condition(request, condition_path),
                },
                "model_inventory": inventory,
                "cuda": cuda,
            }
        )
        raise typer.Exit(0)

    if not yes:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "cost gate: mask generation is GPU-heavy; re-run with --yes",
            }
        )
        raise typer.Exit(2)

    t0 = time.monotonic()
    try:
        paths = _run_mask_generation(upstream_root, request, output_dir, seed)
        rc = 0
        generation_error = None
    except Exception as exc:
        paths = []
        rc = 1
        generation_error = repr(exc)
    elapsed = time.monotonic() - t0

    samples = [_summarize_mask(path, expected_mapping) for path in paths]
    aggregate = _aggregate(samples)
    failure_reasons: list[str] = []
    if rc != 0:
        failure_reasons.append(f"mask generation failed: {generation_error}")
    if not samples:
        failure_reasons.append("mask generation produced zero masks")
    if aggregate["missing_expected_maisi_label_ids"]:
        failure_reasons.append(
            f"generated mask is missing expected MAISI label id(s): {aggregate['missing_expected_maisi_label_ids']}"
        )

    payload: dict[str, Any] = {
        "skill": SKILL_NAME,
        "model": "NVIDIA-Medtech/NV-Generate-CTMR (mask diffusion)",
        "model_repo": MODEL_REPO,
        "model_weights_repo": MODEL_WEIGHTS_REPO,
        "license": "Wrapper Apache-2.0; CT weights use NVIDIA Open Model License.",
        "input": {
            "request_json": request_source,
            "request": request,
            "expected_label_mapping": expected_mapping,
            "random_seed": seed,
            "version": "rflow-ct",
        },
        "output": {"directory": str(output_dir), "samples": samples, **aggregate},
        "invocation": {
            "official_entrypoint": "scripts.sample_mask.ldm_conditional_sample_one_mask",
            "upstream_root": str(upstream_root),
            "upstream_commit": git_commit(upstream_root),
            "exit_code": rc,
            "subprocess_seconds": round(elapsed, 3),
            "model_inventory": inventory,
        },
        "runtime": {"subprocess_seconds": round(elapsed, 3), "device": "cuda"},
        "preflight": {"cuda": cuda},
        "intended_use_disclaimer": (
            "Engineering verification only. Output is synthetic and NOT clinically meaningful. "
            "This wrapper invokes upstream mask-diffusion library code and saves raw MAISI label masks."
        ),
    }
    if failure_reasons:
        payload["error"] = "; ".join(failure_reasons)
        payload["failure_reasons"] = failure_reasons
    emit(payload)
    if failure_reasons:
        raise typer.Exit(1)
    raise typer.Exit(0)


if __name__ == "__main__":
    app()
