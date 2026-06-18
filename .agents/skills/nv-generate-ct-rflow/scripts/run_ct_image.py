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

"""NV-Generate-CTMR CT image-only wrapper.

Runs the upstream `scripts.diff_model_infer` entry point for CT image-only
generation. The wrapper stages config overrides under the caller's output
directory and emits auditable JSON. It does not implement diffusion sampling.
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

_SCRIPT_DIR = Path(__file__).resolve().parent
_SKILLS_DIR = _SCRIPT_DIR.parent.parent
if str(_SKILLS_DIR) not in sys.path:
    sys.path.insert(0, str(_SKILLS_DIR))
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from wrapper_utils import emit, file_sha256_safe, git_commit, tail  # noqa: E402

SKILL_NAME = "nv_generate_ct_rflow_ct_image"
MODEL_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
MODEL_WEIGHTS_REPO = "https://huggingface.co/nvidia/NV-Generate-CT"

VERSION_CONFIGS = {
    "rflow-ct": {
        "network": "configs/config_network_rflow.json",
        "model": "configs/config_maisi_diff_model_rflow-ct.json",
        "env": "configs/environment_maisi_diff_model_rflow-ct.json",
        "weights": ("models/autoencoder_v1.pt", "models/diff_unet_3d_rflow-ct.pt"),
    },
    "ddpm-ct": {
        "network": "configs/config_network_ddpm.json",
        "model": "configs/config_maisi_diff_model_ddpm-ct.json",
        "env": "configs/environment_maisi_diff_model_ddpm-ct.json",
        "weights": ("models/autoencoder_v1.pt", "models/diff_unet_3d_ddpm-ct.pt"),
    },
}
OVERRIDE_KEYS = (
    "dim",
    "spacing",
    "top_region_index",
    "bottom_region_index",
    "random_seed",
    "num_inference_steps",
    "cfg_guidance_scale",
    "output_prefix",
)

app = typer.Typer(add_completion=False)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _valid_upstream_root(path: Path) -> bool:
    return (path / "configs/config_network_rflow.json").is_file()


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


def _load_config_override(fixture_arg: str) -> tuple[dict[str, Any], str | None]:
    if fixture_arg == "default":
        return {}, None
    fixture_path = Path(fixture_arg).expanduser().resolve()
    if not fixture_path.is_file():
        raise typer.BadParameter(f"CT image override not found: {fixture_arg}")
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
            f"CT image override contains unknown key(s): {unknown}. Allowed: {sorted(OVERRIDE_KEYS)}"
        )
    return cleaned, str(fixture_path)


def _validate_ct_inference_config(rendered_inference: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    dim = rendered_inference.get("dim")
    if not (isinstance(dim, (list, tuple)) and len(dim) == 3):
        errors.append(f"dim must be a 3-tuple, got {dim!r}")
    else:
        if dim[0] != dim[1]:
            errors.append(f"dim[0] and dim[1] must match for CT, got {dim!r}")
        if dim[0] not in (256, 384, 512) or dim[2] not in (128, 256, 384, 512, 640, 768):
            errors.append(
                "CT dim must use xy in {256,384,512} and z in "
                f"{{128,256,384,512,640,768}}, got {dim!r}"
            )
        for i, value in enumerate(dim):
            if not isinstance(value, int):
                errors.append(f"dim[{i}] must be int, got {value!r}")

    spacing = rendered_inference.get("spacing")
    if not (isinstance(spacing, (list, tuple)) and len(spacing) == 3):
        errors.append(f"spacing must be a 3-tuple, got {spacing!r}")
    else:
        if spacing[0] != spacing[1]:
            errors.append(f"spacing[0] and spacing[1] must match for CT, got {spacing!r}")
        if not (0.5 <= float(spacing[0]) <= 3.0) or not (0.5 <= float(spacing[2]) <= 5.0):
            errors.append(f"CT spacing out of range, got {spacing!r}")
        if dim and isinstance(dim, (list, tuple)) and len(dim) == 3:
            if float(dim[0]) * float(spacing[0]) < 256.0:
                errors.append("CT xy field of view must be at least 256 mm")

    for key in ("top_region_index", "bottom_region_index"):
        value = rendered_inference.get(key)
        if not (isinstance(value, (list, tuple)) and len(value) == 4):
            errors.append(f"{key} must be a 4-tuple, got {value!r}")
        elif not all(isinstance(v, (int, float)) for v in value):
            errors.append(f"{key} values must be numeric, got {value!r}")

    n_steps = rendered_inference.get("num_inference_steps")
    if not isinstance(n_steps, int) or n_steps < 1 or n_steps > 2000:
        errors.append(f"num_inference_steps must be int in [1, 2000], got {n_steps!r}")

    cfg = rendered_inference.get("cfg_guidance_scale")
    if not isinstance(cfg, (int, float)):
        errors.append(f"cfg_guidance_scale must be numeric, got {cfg!r}")

    modality = rendered_inference.get("modality")
    if modality != 1:
        errors.append(f"CT image-only wrapper forces modality 1; rendered got {modality!r}")
    return errors


def _stage_config(
    upstream_root: Path,
    stage_dir: Path,
    override: dict[str, Any],
    output_dir: Path,
    version: str,
    seed: int,
) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    stage_dir.mkdir(parents=True, exist_ok=True)
    cfg = VERSION_CONFIGS[version]
    base_model = _load_json(upstream_root / cfg["model"])
    rendered_model = dict(base_model)
    inference = dict(rendered_model.get("diffusion_unet_inference") or {})
    output_prefix = str(override.pop("output_prefix", f"ct_image_{version.replace('-', '_')}"))
    inference.update(override)
    inference["modality"] = 1
    inference["random_seed"] = seed
    rendered_model["diffusion_unet_inference"] = inference
    staged_model_path = stage_dir / Path(str(cfg["model"])).name
    staged_model_path.write_text(json.dumps(rendered_model, indent=2))

    base_env = _load_json(upstream_root / cfg["env"])
    rendered_env = dict(base_env)
    rendered_env["output_dir"] = str(output_dir)
    rendered_env["output_prefix"] = output_prefix
    staged_env_path = stage_dir / Path(str(cfg["env"])).name
    staged_env_path.write_text(json.dumps(rendered_env, indent=2))
    return rendered_model, rendered_env, staged_model_path, staged_env_path


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


def _estimate_cost(rendered_inference: dict[str, Any], version: str) -> dict[str, Any]:
    dim = rendered_inference.get("dim") or [256, 256, 128]
    steps = int(
        rendered_inference.get("num_inference_steps") or (1000 if version == "ddpm-ct" else 30)
    )
    voxels = int(dim[0]) * int(dim[1]) * int(dim[2])
    ref_voxels = 256 * 256 * 128
    ref_steps = 30
    seconds = 60.0 * (voxels / ref_voxels) * (steps / ref_steps)
    vram = 16.0 if voxels <= ref_voxels else 32.0
    return {
        "version": version,
        "voxels_per_sample": voxels,
        "num_inference_steps": steps,
        "estimated_wall_seconds": round(seconds, 1),
        "estimated_peak_vram_gb": round(vram, 1),
        "estimated_disk_mb": round((voxels * 2.0) / (1024 * 1024), 1),
    }


def _model_inventory(upstream_root: Path, version: str) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    all_present = True
    for rel in VERSION_CONFIGS[version]["weights"]:
        path = upstream_root / str(rel)
        present = path.is_file()
        files.append(
            {
                "path": str(rel),
                "present": present,
                "bytes": path.stat().st_size if present else None,
                "sha256": file_sha256_safe(path) if present else "",
            }
        )
        all_present = all_present and present
    return {"all_present": all_present, "files": files}


def _build_command(
    version: str, staged_model_path: Path, staged_env_path: Path, num_gpus: int
) -> list[str]:
    cmd = [
        sys.executable,
        "-m",
        "scripts.diff_model_infer",
        "-t",
        f"./{VERSION_CONFIGS[version]['network']}",
        "-e",
        str(staged_env_path),
        "-c",
        str(staged_model_path),
    ]
    if num_gpus != 1:
        cmd.extend(["-g", str(num_gpus)])
    return cmd


def _round(values: Any, ndigits: int = 6) -> Any:
    if isinstance(values, (list, tuple, np.ndarray)):
        return [round(float(v), ndigits) for v in values]
    return round(float(values), ndigits)


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
    image_path: Path, requested_dim: list[int], requested_spacing: list[float]
) -> dict[str, Any]:
    record: dict[str, Any] = {"image_path": str(image_path), "image_readable": False}
    try:
        img = nib.load(str(image_path))
        arr = np.asarray(img.get_fdata(), dtype=np.float32)
        finite = arr[np.isfinite(arr)]
        record["image_readable"] = True
        record["image_shape"] = [int(v) for v in arr.shape]
        record["requested_shape"] = [int(v) for v in requested_dim]
        record["shape_match_requested"] = record["image_shape"] == record["requested_shape"]
        record["image_spacing"] = _round(img.header.get_zooms()[:3])
        record["requested_spacing"] = _round(requested_spacing)
        record["spacing_match_requested"] = record["image_spacing"] == record["requested_spacing"]
        record["all_finite"] = bool(finite.size == arr.size)
        if finite.size:
            record["image_hu_min"] = _round(float(finite.min()), 3)
            record["image_hu_max"] = _round(float(finite.max()), 3)
            record["image_hu_mean"] = _round(float(finite.mean()), 3)
            record["image_nonconstant"] = bool(finite.max() - finite.min() > 1.0)
            record["image_hu_negative_present"] = bool((finite < -500).any())
            record["image_hu_bone_present"] = bool((finite > 200).any())
    except Exception as exc:
        record["image_error"] = repr(exc)
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
        "all_images_hu_like": bool(n)
        and all(
            s.get("image_hu_negative_present") and s.get("image_hu_bone_present") for s in samples
        ),
    }


@app.command()
def main(
    model_config: str = typer.Argument(..., help='Path to CT image override JSON, or "default".'),
    output_dir: Path | None = typer.Option(None, "--output-dir", "-o"),
    version: str = typer.Option("rflow-ct", "--version", help="rflow-ct or ddpm-ct"),
    seed: int = typer.Option(0, "--random-seed", "-s"),
    num_gpus: int = typer.Option(1, "--num-gpus", min=1),
    timeout_seconds: float = typer.Option(3600.0, "--timeout-seconds"),
    preflight_only: bool = typer.Option(False, "--preflight-only"),
    yes: bool = typer.Option(False, "--yes", "-y"),
) -> None:
    if version not in VERSION_CONFIGS:
        raise typer.BadParameter(f"--version must be one of {sorted(VERSION_CONFIGS)}")

    upstream_root, checked_roots = _resolve_upstream_root(
        os.environ.get("NV_GENERATE_ROOT", "").strip()
    )
    if upstream_root is None:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "NV_GENERATE_ROOT layout invalid",
                "detail": "Could not find NV-Generate-CTMR checkout.",
                "checked_roots": checked_roots,
            }
        )
        raise typer.Exit(2)

    output_dir = (output_dir or upstream_root / "output").expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    override, override_source = _load_config_override(model_config)
    rendered_model, rendered_env, staged_model_path, staged_env_path = _stage_config(
        upstream_root,
        output_dir / "_staged_configs",
        dict(override),
        output_dir,
        version,
        seed,
    )
    inference = rendered_model["diffusion_unet_inference"]
    errors = _validate_ct_inference_config(inference)
    inventory = _model_inventory(upstream_root, version)
    if not inventory["all_present"]:
        errors.append(
            "missing CT image model weights. Run `python -m scripts.download_model_data "
            f"--version {version} --root_dir ./ --model_only` from $NV_GENERATE_ROOT."
        )
    cuda = _detect_cuda()
    if not cuda["available"]:
        errors.append("CUDA not available. CT image synthesis needs an NVIDIA GPU.")
    cost = _estimate_cost(inference, version)

    if errors:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "preflight validation failed",
                "preflight_errors": errors,
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
                "estimated_cost": cost,
                "cuda": cuda,
                "model_inventory": inventory,
                "rendered_model_config": rendered_model,
                "rendered_env_config": rendered_env,
            }
        )
        raise typer.Exit(0)

    if not yes and (
        cost["estimated_wall_seconds"] > 300.0 or cost["estimated_peak_vram_gb"] > 30.0
    ):
        emit(
            {
                "skill": SKILL_NAME,
                "error": "cost gate: re-run with --yes to proceed",
                "estimated_cost": cost,
            }
        )
        raise typer.Exit(2)

    cmd = _build_command(version, staged_model_path, staged_env_path, num_gpus)
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
    except subprocess.TimeoutExpired as exc:
        rc = 124
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr_raw = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        stderr = stderr_raw + f"\n[TIMEOUT after {timeout_seconds}s]"
    elapsed = time.monotonic() - t0

    requested_dim = [int(v) for v in inference["dim"]]
    requested_spacing = [float(v) for v in inference["spacing"]]
    samples = [
        _summarize_image(p, requested_dim, requested_spacing)
        for p in _scan_outputs(output_dir, run_started)
    ]
    aggregate = _aggregate(samples)
    failure_reasons: list[str] = []
    if rc != 0:
        failure_reasons.append(f"upstream scripts.diff_model_infer exited {rc}")
    if not samples:
        failure_reasons.append("upstream scripts.diff_model_infer produced zero CT images")

    payload: dict[str, Any] = {
        "skill": SKILL_NAME,
        "model": f"NVIDIA-Medtech/NV-Generate-CTMR ({version} image-only)",
        "model_repo": MODEL_REPO,
        "model_weights_repo": MODEL_WEIGHTS_REPO,
        "license": "Wrapper Apache-2.0; CT weights use NVIDIA Open Model License.",
        "input": {
            "model_config_override_path": override_source,
            "model_config_override": override,
            "dim_requested": requested_dim,
            "spacing_requested": requested_spacing,
            "num_inference_steps_requested": inference.get("num_inference_steps"),
            "cfg_guidance_scale_requested": inference.get("cfg_guidance_scale"),
            "random_seed": seed,
            "version": version,
        },
        "output": {"directory": str(output_dir), "samples": samples, **aggregate},
        "invocation": {
            "official_entrypoint": "python -m scripts.diff_model_infer",
            "upstream_root": str(upstream_root),
            "upstream_commit": git_commit(upstream_root),
            "command": cmd,
            "exit_code": rc,
            "subprocess_seconds": round(elapsed, 3),
            "model_inventory": inventory,
            "rendered_model_config": rendered_model,
            "rendered_env_output_dir": rendered_env.get("output_dir"),
            "rendered_env_output_prefix": rendered_env.get("output_prefix"),
        },
        "runtime": {"subprocess_seconds": round(elapsed, 3), "device": "cuda"},
        "logs": {"stdout_tail": tail(stdout), "stderr_tail": tail(stderr)},
        "preflight": {"estimated_cost": cost, "cuda": cuda},
        "intended_use_disclaimer": (
            "Engineering verification only. Output is synthetic and NOT clinically meaningful. "
            "This wrapper invokes upstream scripts.diff_model_infer and does not modify diffusion sampling."
        ),
    }
    if failure_reasons:
        payload["error"] = "; ".join(failure_reasons)
        payload["failure_reasons"] = failure_reasons
    emit(payload)
    if failure_reasons:
        raise typer.Exit(rc if 0 < rc < 256 else 1)
    raise typer.Exit(0)


if __name__ == "__main__":
    app()
