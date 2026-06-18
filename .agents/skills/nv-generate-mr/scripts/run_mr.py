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

"""NVIDIA-Medtech NV-Generate-CTMR rflow-mr skill.

Thin wrapper around the upstream `scripts.diff_model_infer` entry point from
https://github.com/NVIDIA-Medtech/NV-Generate-CTMR. The wrapper does NOT
implement diffusion sampling or autoencoder decoding. It stages config
overrides, shells out to the upstream command, and summarizes generated MR
NIfTI outputs.

Engineering verification only. Output is NOT clinically meaningful.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import typer

SKILL_NAME = "nv_generate_mr"
MODEL_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
MODEL_WEIGHTS_REPO = "https://huggingface.co/nvidia/NV-Generate-MR"
VERSION = "rflow-mr"
REPO_ROOT = Path(__file__).resolve().parents[int("3")]

UPSTREAM_NETWORK_CONFIG = "configs/config_network_rflow.json"
UPSTREAM_MODEL_CONFIG = "configs/config_maisi_diff_model_rflow-mr.json"
UPSTREAM_ENV_CONFIG = "configs/environment_maisi_diff_model_rflow-mr.json"
UPSTREAM_MODALITY_MAPPING = "configs/modality_mapping.json"
UPSTREAM_MODEL_FILES = (
    "models/autoencoder_v2.pt",
    "models/diff_unet_3d_rflow-mr.pt",
)

SUPPORTED_MODALITIES = ("mri", "mri_t1", "mri_t2", "mri_flair")
OVERRIDE_KEYS = (
    "dim",
    "spacing",
    "top_region_index",
    "bottom_region_index",
    "random_seed",
    "num_inference_steps",
    "modality",
    "cfg_guidance_scale",
    "output_prefix",
)
MAX_VOXELS = int("512") * int("512") * int("128")

app = typer.Typer(add_completion=False)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, indent=2))
    sys.stdout.flush()


def tail(s: str, n_chars: int = int("4000")) -> str:
    if len(s) <= n_chars:
        return s
    return "..." + s[-n_chars:]


def sha256_file(path: Path, chunk: int = 1 << int("20")) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def file_sha256_safe(path: Path) -> str:
    if not path.is_file():
        return ""
    try:
        return sha256_file(path)
    except Exception:
        return ""


def git_commit(root: Path) -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            check=False,
            capture_output=True,
            text=True,
            timeout=int("10"),
        )
    except Exception:
        return ""
    if proc.returncode == 0:
        return proc.stdout.strip()
    return ""


def _round(values: Any, ndigits: int = int("6")) -> Any:
    if isinstance(values, (list, tuple, np.ndarray)):
        return [round(float(v), ndigits) for v in values]
    return round(float(values), ndigits)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _valid_upstream_root(path: Path) -> bool:
    return (path / UPSTREAM_NETWORK_CONFIG).is_file()


def _candidate_upstream_roots(env_value: str) -> list[Path]:
    candidates: list[Path] = []
    if env_value:
        candidates.append(Path(env_value).expanduser())
    candidates.extend(
        [
            REPO_ROOT / ".workbench_data/upstreams/NV-Generate-CTMR",
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


def _load_modality_mapping(upstream_root: Path) -> dict[str, int]:
    mapping = _load_json(upstream_root / UPSTREAM_MODALITY_MAPPING)
    return {str(k): int(v) for k, v in mapping.items()}


def _modality_to_code(modality: str, mapping: dict[str, int]) -> int:
    if modality not in SUPPORTED_MODALITIES:
        raise typer.BadParameter(
            f"--modality must be one of {list(SUPPORTED_MODALITIES)}, got {modality!r}"
        )
    if modality not in mapping:
        raise typer.BadParameter(f"modality {modality!r} not found in upstream modality mapping")
    return int(mapping[modality])


def _load_config_override(fixture_arg: str) -> tuple[dict[str, Any], str | None]:
    if fixture_arg == "default":
        return {}, None
    fixture_path = Path(fixture_arg).expanduser().resolve()
    if not fixture_path.is_file():
        raise typer.BadParameter(f"model config override not found: {fixture_arg}")
    raw = json.loads(fixture_path.read_text())
    cleaned = {k: v for k, v in raw.items() if not k.startswith("_")}
    if "diffusion_unet_inference" in cleaned:
        nested = cleaned.pop("diffusion_unet_inference")
        if not isinstance(nested, dict):
            raise typer.BadParameter("diffusion_unet_inference must be a JSON object")
        cleaned.update(nested)
    unknown = sorted(k for k in cleaned if k not in OVERRIDE_KEYS)
    if unknown:
        raise typer.BadParameter(
            f"MR override contains unknown key(s): {unknown}. Allowed: {sorted(OVERRIDE_KEYS)}"
        )
    return cleaned, str(fixture_path)


def _validate_inference_config(rendered_inference: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    dim = rendered_inference.get("dim")
    if not (isinstance(dim, (list, tuple)) and len(dim) == int("3")):
        errors.append(f"dim must be a 3-tuple, got {dim!r}")
    else:
        voxels = 1
        for i, v in enumerate(dim):
            if not isinstance(v, int):
                errors.append(f"dim[{i}] must be int, got {v!r}")
            elif v < int("64") or v > int("512"):
                errors.append(f"dim[{i}]={v} outside rflow-mr range [64, 512]")
            elif v % int("32") != 0:
                errors.append(f"dim[{i}]={v} must be a multiple of 32")
            if isinstance(v, int):
                voxels *= int(v)
        if voxels > MAX_VOXELS:
            errors.append(
                f"dim product {voxels} exceeds rflow-mr max volume {MAX_VOXELS} "
                "(512x512x128 per upstream README)"
            )

    spacing = rendered_inference.get("spacing")
    if not (isinstance(spacing, (list, tuple)) and len(spacing) == int("3")):
        errors.append(f"spacing must be a 3-tuple, got {spacing!r}")
    else:
        for i, v in enumerate(spacing):
            if not isinstance(v, (int, float)) or v <= 0:
                errors.append(f"spacing[{i}] must be a positive float, got {v!r}")

    for key in ("top_region_index", "bottom_region_index"):
        value = rendered_inference.get(key)
        if not (isinstance(value, (list, tuple)) and len(value) == int("4")):
            errors.append(f"{key} must be a 4-tuple, got {value!r}")
        elif not all(isinstance(v, (int, float)) for v in value):
            errors.append(f"{key} values must be numeric, got {value!r}")

    n_steps = rendered_inference.get("num_inference_steps")
    if not isinstance(n_steps, int) or n_steps < 1 or n_steps > int("2000"):
        errors.append(f"num_inference_steps must be int in [1, 2000], got {n_steps!r}")

    seed = rendered_inference.get("random_seed")
    if not isinstance(seed, int):
        errors.append(f"random_seed must be int, got {seed!r}")

    cfg = rendered_inference.get("cfg_guidance_scale")
    if not isinstance(cfg, (int, float)):
        errors.append(f"cfg_guidance_scale must be numeric, got {cfg!r}")

    modality = rendered_inference.get("modality")
    if not isinstance(modality, int) or modality < 0:
        errors.append(f"modality must be a non-negative int code, got {modality!r}")

    return errors


def _stage_config(
    upstream_root: Path,
    stage_dir: Path,
    override: dict[str, Any],
    output_dir: Path,
    modality_code: int,
    modality_name: str,
    seed: int,
) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    stage_dir.mkdir(parents=True, exist_ok=True)

    base_model = _load_json(upstream_root / UPSTREAM_MODEL_CONFIG)
    rendered_model = dict(base_model)
    inference = dict(rendered_model.get("diffusion_unet_inference") or {})
    inference.update(override)
    inference["modality"] = modality_code
    inference["random_seed"] = seed
    rendered_model["diffusion_unet_inference"] = inference
    staged_model_path = stage_dir / "config_maisi_diff_model_rflow-mr.json"
    staged_model_path.write_text(json.dumps(rendered_model, indent=2))

    base_env = _load_json(upstream_root / UPSTREAM_ENV_CONFIG)
    rendered_env = dict(base_env)
    rendered_env["output_dir"] = str(output_dir)
    if "output_prefix" in override:
        rendered_env["output_prefix"] = str(override["output_prefix"])
    else:
        rendered_env["output_prefix"] = f"mr_{modality_name}"
    staged_env_path = stage_dir / "environment_maisi_diff_model_rflow-mr.json"
    staged_env_path.write_text(json.dumps(rendered_env, indent=2))

    return rendered_model, rendered_env, staged_model_path, staged_env_path


def _estimate_cost(rendered_inference: dict[str, Any]) -> dict[str, Any]:
    dim = rendered_inference.get("dim") or [int("128"), int("256"), int("256")]
    n_steps = int(rendered_inference.get("num_inference_steps") or int("30"))
    voxels = int(dim[0]) * int(dim[1]) * int(dim[2])
    ref_voxels = int("128") * int("256") * int("256")
    ref_steps = int("30")
    ref_seconds = float("60.0")
    seconds = ref_seconds * (voxels / ref_voxels) * (n_steps / ref_steps)
    vram = float("16.0") if voxels <= ref_voxels else float("32.0")
    disk_mb = (voxels * 2.0) / (int("1024") * int("1024"))
    return {
        "version": VERSION,
        "voxels_per_sample": voxels,
        "num_inference_steps": n_steps,
        "estimated_wall_seconds": round(seconds, 1),
        "estimated_peak_vram_gb": round(vram, 1),
        "estimated_disk_mb": round(disk_mb, 1),
    }


def _detect_cuda() -> dict[str, Any]:
    info: dict[str, Any] = {"available": False, "device_name": None, "total_memory_gb": None}
    try:
        import torch  # noqa: PLC0415

        info["torch_version"] = torch.__version__
        info["available"] = bool(torch.cuda.is_available())
        if info["available"]:
            props = torch.cuda.get_device_properties(0)
            info["device_name"] = props.name
            info["total_memory_gb"] = round(props.total_memory / (int("1024") ** int("3")), 1)
            info["cuda_version"] = torch.version.cuda
    except Exception as e:
        info["import_error"] = repr(e)
    return info


def _preflight(rendered_inference: dict[str, Any]) -> tuple[list[str], list[str], dict[str, Any]]:
    errors = _validate_inference_config(rendered_inference)
    warnings: list[str] = []
    cuda = _detect_cuda()
    cost = _estimate_cost(rendered_inference)
    if not cuda["available"]:
        errors.append(
            "CUDA not available. rflow-mr synthesis needs an NVIDIA GPU; "
            "there is no CPU fallback in the upstream code path."
        )
    elif cuda["total_memory_gb"] is not None:
        usable = cuda["total_memory_gb"] * float("0.85")
        if cost["estimated_peak_vram_gb"] > usable:
            warnings.append(
                f"estimated peak VRAM {cost['estimated_peak_vram_gb']} GB exceeds "
                f"85% of detected GPU memory ({cuda['total_memory_gb']} GB on "
                f"{cuda['device_name']}). Risk of OOM; reduce dim or use a larger GPU."
            )
    return errors, warnings, {"cuda": cuda, "estimated_cost": cost}


def _model_inventory(upstream_root: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    all_present = True
    for rel in UPSTREAM_MODEL_FILES:
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


def _build_command(staged_model_path: Path, staged_env_path: Path, num_gpus: int) -> list[str]:
    cmd = [
        sys.executable,
        "-m",
        "scripts.diff_model_infer",
        "-t",
        f"./{UPSTREAM_NETWORK_CONFIG}",
        "-e",
        str(staged_env_path),
        "-c",
        str(staged_model_path),
    ]
    if num_gpus != 1:
        cmd.extend(["-g", str(num_gpus)])
    return cmd


def _scan_outputs(output_dir: Path, run_started: float) -> list[Path]:
    if not output_dir.is_dir():
        return []
    paths: list[Path] = []
    for path in output_dir.rglob("*.nii*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > 0 and path.stat().st_mtime >= run_started - 1:
                paths.append(path)
        except OSError:
            continue
    return sorted(paths)


def _summarize_image(
    image_path: Path,
    requested_dim: list[int],
    requested_spacing: list[float],
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "image_path": str(image_path),
        "image_bytes": image_path.stat().st_size if image_path.exists() else None,
        "image_sha256": file_sha256_safe(image_path) if image_path.exists() else "",
        "image_readable": False,
    }
    try:
        img = nib.load(str(image_path))
        arr = np.asarray(img.get_fdata(), dtype=np.float32)
        finite = arr[np.isfinite(arr)]
        record["image_readable"] = True
        record["image_shape"] = [int(v) for v in arr.shape]
        record["requested_shape"] = [int(v) for v in requested_dim]
        record["shape_match_requested"] = record["image_shape"] == record["requested_shape"]
        record["image_spacing"] = _round(img.header.get_zooms()[: int("3")])
        record["requested_spacing"] = _round(requested_spacing)
        record["spacing_match_requested"] = record["image_spacing"] == record["requested_spacing"]
        record["image_affine"] = [list(map(float, row)) for row in img.affine.tolist()]
        record["finite_fraction"] = (
            round(float(finite.size) / float(arr.size), int("6")) if arr.size else 0.0
        )
        record["all_finite"] = bool(finite.size == arr.size)
        if finite.size:
            record["intensity_min"] = _round(float(finite.min()), int("3"))
            record["intensity_max"] = _round(float(finite.max()), int("3"))
            record["intensity_mean"] = _round(float(finite.mean()), int("3"))
            record["intensity_std"] = _round(float(finite.std()), int("3"))
            record["image_nonconstant"] = bool(finite.max() - finite.min() > 1.0)
            record["image_nonnegative"] = bool(finite.min() >= 0)
        else:
            record["image_nonconstant"] = False
            record["image_nonnegative"] = False
    except Exception as e:
        record["image_error"] = repr(e)
    return record


def _aggregate(samples: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(samples)
    return {
        "num_samples": n,
        "all_images_readable": bool(n) and all(s.get("image_readable") for s in samples),
        "all_shapes_match_requested": bool(n)
        and all(s.get("shape_match_requested") for s in samples),
        "all_spacing_match_requested": bool(n)
        and all(s.get("spacing_match_requested") for s in samples),
        "all_images_finite": bool(n) and all(s.get("all_finite") for s in samples),
        "all_images_nonconstant": bool(n) and all(s.get("image_nonconstant") for s in samples),
        "all_images_nonnegative": bool(n) and all(s.get("image_nonnegative") for s in samples),
    }


@app.command()
def main(
    model_config: str = typer.Argument(
        ...,
        help='Path to a model-config override JSON, or "default" for upstream defaults.',
    ),
    output_dir: Path | None = typer.Option(
        None, "--output-dir", "-o", help="Absolute directory for generated NIfTI volumes."
    ),
    modality: str | None = typer.Option(None, "--modality", help="MR modality name."),
    seed: int = typer.Option(0, "--random-seed", "-s"),
    num_gpus: int = typer.Option(1, "--num-gpus", min=1),
    timeout_seconds: float = typer.Option(float("3600.0"), "--timeout-seconds"),
    preflight_only: bool = typer.Option(
        False,
        "--preflight-only",
        help="Validate config, CUDA, cost estimate, and model inventory without inference.",
    ),
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        help="Skip the cost-preview confirmation gate for large runs.",
    ),
) -> None:
    """Generate synthetic 3D MRI volumes via NV-Generate-CTMR rflow-mr."""
    upstream_root_env = os.environ.get("NV_GENERATE_ROOT", "").strip()
    upstream_root, checked_roots = _resolve_upstream_root(upstream_root_env)
    if upstream_root is None and not upstream_root_env:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "NV_GENERATE_ROOT is unset",
                "detail": "Clone https://github.com/NVIDIA-Medtech/NV-Generate-CTMR and export "
                "NV_GENERATE_ROOT to its path, or place the clone at "
                ".workbench_data/upstreams/NV-Generate-CTMR.",
                "checked_roots": checked_roots,
            }
        )
        raise typer.Exit(2)
    if upstream_root is None:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "NV_GENERATE_ROOT layout invalid",
                "detail": f"{UPSTREAM_NETWORK_CONFIG} not found in any checked root",
                "checked_roots": checked_roots,
            }
        )
        raise typer.Exit(2)

    if output_dir is None:
        output_dir = upstream_root / "output"
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    mapping = _load_modality_mapping(upstream_root)
    override, override_source = _load_config_override(model_config)
    override_modality = str(override.pop("modality")) if "modality" in override else None
    modality_name = modality or override_modality or "mri_t1"
    modality_code = _modality_to_code(modality_name, mapping)

    stage_dir = output_dir / "_staged_configs"
    rendered_model, rendered_env, staged_model_path, staged_env_path = _stage_config(
        upstream_root,
        stage_dir,
        override,
        output_dir,
        modality_code,
        modality_name,
        seed,
    )
    rendered_inference = rendered_model["diffusion_unet_inference"]

    errors, warnings, context = _preflight(rendered_inference)
    inventory = _model_inventory(upstream_root)
    if not inventory["all_present"]:
        errors.append(
            "missing rflow-mr model weights. Run `python -m scripts.download_model_data "
            "--version rflow-mr --root_dir ./ --model_only` from $NV_GENERATE_ROOT."
        )

    cost = context["estimated_cost"]
    cuda = context["cuda"]
    print(
        f"[nv_generate_mr] preflight: dim={rendered_inference.get('dim')} "
        f"spacing={rendered_inference.get('spacing')} modality={modality_name}({modality_code}) "
        f"steps={rendered_inference.get('num_inference_steps')}",
        file=sys.stderr,
    )
    print(
        f"[nv_generate_mr] cost estimate: ~{cost['estimated_wall_seconds']}s wall, "
        f"~{cost['estimated_peak_vram_gb']} GB VRAM peak, ~{cost['estimated_disk_mb']} MB disk. "
        f"GPU: {cuda.get('device_name','?')} ({cuda.get('total_memory_gb','?')} GB)",
        file=sys.stderr,
    )
    for warning in warnings:
        print(f"[nv_generate_mr] warning: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"[nv_generate_mr] error: {error}", file=sys.stderr)
        emit(
            {
                "skill": SKILL_NAME,
                "error": "preflight validation failed",
                "preflight_errors": errors,
                "preflight_warnings": warnings,
                "estimated_cost": cost,
                "cuda": cuda,
                "invocation": {"model_inventory": inventory},
            }
        )
        raise typer.Exit(2)

    if preflight_only:
        emit(
            {
                "skill": SKILL_NAME,
                "preflight": "ok",
                "preflight_warnings": warnings,
                "estimated_cost": cost,
                "cuda": cuda,
                "model_inventory": inventory,
                "rendered_model_config": rendered_model,
                "rendered_env_config": rendered_env,
            }
        )
        raise typer.Exit(0)

    if not yes and (
        cost["estimated_wall_seconds"] > float("300.0")
        or cost["estimated_peak_vram_gb"] > float("30.0")
    ):
        emit(
            {
                "skill": SKILL_NAME,
                "error": "cost gate: run would be expensive; re-run with --yes to proceed",
                "estimated_cost": cost,
                "cuda": cuda,
            }
        )
        raise typer.Exit(2)

    cmd = _build_command(staged_model_path, staged_env_path, num_gpus)
    run_env = os.environ.copy()
    run_env.setdefault("MONAI_DATA_DIRECTORY", str(upstream_root / "temp_work_dir"))
    run_env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "max_split_size_mb:128,expandable_segments:True")

    run_started = time.time()
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(upstream_root),
            env=run_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        rc = proc.returncode
        stdout = proc.stdout
        stderr = proc.stderr
    except subprocess.TimeoutExpired as e:
        rc = int("124")
        stdout = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr_raw = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        stderr = stderr_raw + f"\n[TIMEOUT after {timeout_seconds}s]"
    elapsed = time.monotonic() - t0

    requested_dim = [int(v) for v in rendered_inference["dim"]]
    requested_spacing = [float(v) for v in rendered_inference["spacing"]]
    output_paths = _scan_outputs(output_dir, run_started)
    samples = [_summarize_image(p, requested_dim, requested_spacing) for p in output_paths]
    aggregate = _aggregate(samples)

    payload: dict[str, Any] = {
        "skill": SKILL_NAME,
        "model": "NVIDIA-Medtech/NV-Generate-CTMR (rflow-mr)",
        "model_repo": MODEL_REPO,
        "model_weights_repo": MODEL_WEIGHTS_REPO,
        "license": "Wrapper Apache-2.0; NV-Generate-MR weights use NVIDIA Non-Commercial License.",
        "input": {
            "model_config_override_path": override_source,
            "model_config_override": override,
            "modality_name": modality_name,
            "modality_code": modality_code,
            "dim_requested": requested_dim,
            "spacing_requested": requested_spacing,
            "num_inference_steps_requested": rendered_inference.get("num_inference_steps"),
            "cfg_guidance_scale_requested": rendered_inference.get("cfg_guidance_scale"),
            "random_seed": seed,
            "version": VERSION,
        },
        "output": {
            "directory": str(output_dir),
            "samples": samples,
            **aggregate,
        },
        "invocation": {
            "official_entrypoint": "python -m scripts.diff_model_infer",
            "upstream_root": str(upstream_root),
            "upstream_commit": git_commit(upstream_root),
            "command": cmd,
            "exit_code": rc,
            "subprocess_seconds": round(elapsed, int("3")),
            "model_inventory": inventory,
            "rendered_model_config": rendered_model,
            "rendered_env_output_dir": rendered_env.get("output_dir"),
            "rendered_env_output_prefix": rendered_env.get("output_prefix"),
        },
        "runtime": {
            "subprocess_seconds": round(elapsed, int("3")),
            "device": "cuda",
        },
        "logs": {
            "stdout_tail": tail(stdout),
            "stderr_tail": tail(stderr),
        },
        "preflight": {
            "warnings": warnings,
            "estimated_cost": cost,
            "cuda": cuda,
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Output is synthetic and NOT clinically meaningful. "
            "This wrapper invokes the upstream scripts.diff_model_infer entry point from the "
            "NV-Generate-CTMR README; it does not modify diffusion sampling or autoencoder decoding."
        ),
    }
    emit(payload)
    raise typer.Exit(0)


if __name__ == "__main__":
    app()
