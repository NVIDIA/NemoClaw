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

"""NVIDIA-Medtech NV-Generate-CTMR (rflow-ct) skill.

Thin wrapper around the upstream `scripts.inference` entry point from
https://github.com/NVIDIA-Medtech/NV-Generate-CTMR. The wrapper does NOT
implement diffusion, sampling, autoencoder decoding, or mask synthesis --
it shells out to the upstream command exactly as the upstream README
documents, then reads the produced image/mask NIfTI pairs to emit a
structured summary.

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

_SCRIPT_DIR = Path(__file__).resolve().parent
_SKILLS_DIR = _SCRIPT_DIR.parent.parent
if str(_SKILLS_DIR) not in sys.path:
    sys.path.insert(0, str(_SKILLS_DIR))
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
from _anatomy import (  # noqa: E402
    load_label_dict,
    region_for_class,
    validate_anatomy_list,
    validate_body_region,
    validate_controllable_anatomy_size,
)
from wrapper_utils import (  # noqa: E402
    emit,
    file_sha256_safe,
    git_commit,
    tail,
)

SKILL_DIR = _SCRIPT_DIR.parent

# Upstream layout (verified against
# https://github.com/NVIDIA-Medtech/NV-Generate-CTMR README and configs).
# `network` is the model family ({"rflow", "ddpm"} -> different unet
# architectures); `version` is the published checkpoint tag (rflow-ct,
# ddpm-ct). The mapping is a strict prefix split.
NETWORK_FOR_VERSION = {"rflow-ct": "rflow", "ddpm-ct": "ddpm"}
UPSTREAM_NETWORK_CONFIG_FMT = "configs/config_network_{network}.json"
UPSTREAM_INFER_CONFIG = "configs/config_infer.json"
UPSTREAM_ENV_CONFIG_FMT = "configs/environment_{version}.json"
UPSTREAM_MODEL_FILES = (
    "models/autoencoder_v1.pt",
    "models/diff_unet_3d_{version}.pt",
    "models/controlnet_3d_{version}.pt",
    "models/mask_generation_autoencoder.pt",
    "models/mask_generation_diffusion_unet.pt",
)
SUPPORTED_VERSIONS = ("rflow-ct", "ddpm-ct")
CT_OUTPUT_XY_SIZES = (256, 384, 512)
CT_OUTPUT_Z_SIZES = (128, 256, 384, 512, 640, 768)
CT_SPACING_XY_RANGE = (0.5, 3.0)
CT_SPACING_Z_RANGE = (0.5, 5.0)
HEAD_MIN_FOV_XY_MM = 256.0
NON_HEAD_MIN_FOV_XY_MM = 384.0

# Override keys we accept in the user-supplied config_infer.json. Anything
# else in the override is rejected so a typo doesn't silently fall through
# to upstream defaults.
OVERRIDE_KEYS = (
    "num_output_samples",
    "body_region",
    "anatomy_list",
    "controllable_anatomy_size",
    "output_size",
    "spacing",
    "num_inference_steps",
    "mask_generation_num_inference_steps",
    "image_output_ext",
    "label_output_ext",
    "autoencoder_sliding_window_infer_size",
    "autoencoder_sliding_window_infer_overlap",
    "cfg_guidance_scale",
    "modality",
)

app = typer.Typer(add_completion=False)


def _load_config_override(fixture_arg: str) -> tuple[dict[str, Any], str | None]:
    """Read the user's config_infer override.

    The fixture sentinel "default" means "use upstream config_infer.json as-is".
    """
    if fixture_arg == "default":
        return {}, None
    fixture_path = Path(fixture_arg).expanduser().resolve()
    if not fixture_path.is_file():
        raise typer.BadParameter(f"config_infer override not found: {fixture_arg}")
    raw = json.loads(fixture_path.read_text())
    # Drop comment / metadata keys (leading underscore).
    cleaned = {k: v for k, v in raw.items() if not k.startswith("_")}
    unknown = sorted(k for k in cleaned if k not in OVERRIDE_KEYS)
    if unknown:
        raise typer.BadParameter(
            f"config_infer override contains unknown key(s): {unknown}. "
            f"Allowed: {sorted(OVERRIDE_KEYS)}"
        )
    return cleaned, str(fixture_path)


def _validate_override_bounds(rendered: dict[str, Any]) -> list[str]:
    """Type/value bounds on rendered config_infer fields. Catches typos and
    out-of-range values *before* the diffusion model loads. Returns a list
    of error messages (empty if valid).
    """
    errors: list[str] = []

    n_samples = rendered.get("num_output_samples")
    if n_samples is not None:
        if not isinstance(n_samples, int) or n_samples < 1:
            errors.append(f"num_output_samples must be int >= 1, got {n_samples!r}")

    output_size = rendered.get("output_size")
    if output_size is not None:
        if not (isinstance(output_size, (list, tuple)) and len(output_size) == int("3")):
            errors.append(f"output_size must be a 3-tuple, got {output_size!r}")
        else:
            if output_size[0] != output_size[1]:
                errors.append(
                    f"output_size[0] and output_size[1] must match for CT, got {output_size!r}"
                )
            for i, v in enumerate(output_size):
                if not isinstance(v, int):
                    errors.append(f"output_size[{i}] must be int, got {v!r}")
            if all(isinstance(v, int) for v in output_size):
                if output_size[0] not in CT_OUTPUT_XY_SIZES:
                    errors.append(
                        f"output_size[0]={output_size[0]} outside upstream-supported CT xy sizes "
                        f"{list(CT_OUTPUT_XY_SIZES)}"
                    )
                if output_size[2] not in CT_OUTPUT_Z_SIZES:
                    errors.append(
                        f"output_size[2]={output_size[2]} outside upstream-supported CT z sizes "
                        f"{list(CT_OUTPUT_Z_SIZES)}"
                    )

    spacing = rendered.get("spacing")
    if spacing is not None:
        if not (isinstance(spacing, (list, tuple)) and len(spacing) == int("3")):
            errors.append(f"spacing must be a 3-tuple, got {spacing!r}")
        else:
            for i, v in enumerate(spacing):
                if not isinstance(v, (int, float)) or v <= 0:
                    errors.append(f"spacing[{i}] must be a positive float, got {v!r}")
            if all(isinstance(v, (int, float)) and v > 0 for v in spacing):
                if spacing[0] != spacing[1]:
                    errors.append(f"spacing[0] and spacing[1] must match for CT, got {spacing!r}")
                if not (CT_SPACING_XY_RANGE[0] <= float(spacing[0]) <= CT_SPACING_XY_RANGE[1]):
                    errors.append(
                        f"spacing[0]={spacing[0]} outside upstream-supported CT xy range "
                        f"[{CT_SPACING_XY_RANGE[0]}, {CT_SPACING_XY_RANGE[1]}] mm"
                    )
                if not (CT_SPACING_Z_RANGE[0] <= float(spacing[2]) <= CT_SPACING_Z_RANGE[1]):
                    errors.append(
                        f"spacing[2]={spacing[2]} outside upstream-supported CT z range "
                        f"[{CT_SPACING_Z_RANGE[0]}, {CT_SPACING_Z_RANGE[1]}] mm"
                    )

    errors.extend(_validate_ct_fov(rendered))

    n_steps = rendered.get("num_inference_steps")
    if n_steps is not None:
        if not isinstance(n_steps, int) or n_steps < 1 or n_steps > int("2000"):
            errors.append(
                f"num_inference_steps must be int in [1, 2000] (rflow-ct uses 30; ddpm-ct uses 1000), got {n_steps!r}"
            )

    mg_steps = rendered.get("mask_generation_num_inference_steps")
    if mg_steps is not None:
        if not isinstance(mg_steps, int) or mg_steps < 1 or mg_steps > int("2000"):
            errors.append(
                f"mask_generation_num_inference_steps must be int in [1, 2000], got {mg_steps!r}"
            )

    cfg_g = rendered.get("cfg_guidance_scale")
    if cfg_g is not None and not isinstance(cfg_g, (int, float)):
        errors.append(f"cfg_guidance_scale must be numeric, got {cfg_g!r}")

    for ext_key in ("image_output_ext", "label_output_ext"):
        ext = rendered.get(ext_key)
        if ext is not None and ext not in (".nii", ".nii.gz"):
            errors.append(f"{ext_key} must be '.nii' or '.nii.gz', got {ext!r}")

    return errors


def _requested_regions(rendered: dict[str, Any]) -> set[str]:
    """Infer requested body regions from explicit body_region and anatomy names."""
    regions: set[str] = set()
    body_region = rendered.get("body_region")
    if isinstance(body_region, list):
        regions.update(entry for entry in body_region if isinstance(entry, str))

    for name in _effective_anatomy_names(rendered):
        region = region_for_class(name)
        if region:
            regions.add("body" if region == "general" else region)
    return regions


def _validate_ct_fov(rendered: dict[str, Any]) -> list[str]:
    """Enforce the upstream CT FOV guidance before launching GPU inference."""
    output_size = rendered.get("output_size")
    spacing = rendered.get("spacing")
    if not (
        isinstance(output_size, (list, tuple))
        and len(output_size) == 3
        and isinstance(spacing, (list, tuple))
        and len(spacing) == 3
        and isinstance(output_size[0], int)
        and isinstance(spacing[0], (int, float))
        and float(spacing[0]) > 0
    ):
        return []

    fov_xy = float(output_size[0]) * float(spacing[0])
    regions = _requested_regions(rendered)
    min_fov = HEAD_MIN_FOV_XY_MM
    reason = "head-only or unspecified CT requests"
    if any(region != "head" for region in regions):
        min_fov = NON_HEAD_MIN_FOV_XY_MM
        reason = "non-head CT body regions/anatomies"
    if fov_xy < min_fov:
        return [
            f"CT xy field of view is {fov_xy:g} mm; must be at least {min_fov:g} mm for {reason}"
        ]
    return []


def _stage_config(
    upstream_root: Path,
    stage_dir: Path,
    override: dict[str, Any],
    output_dir: Path,
    version: str,
) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    """Render staged infer + environment configs for the upstream subprocess.

    Writes to `stage_dir` (typically `<output_dir>/_staged_configs/`) so the
    user's upstream clone is never mutated. Returns the rendered configs and
    the absolute paths to feed into `-i` and `-e`.
    """
    stage_dir.mkdir(parents=True, exist_ok=True)
    base_infer = json.loads((upstream_root / UPSTREAM_INFER_CONFIG).read_text())
    rendered_infer = dict(base_infer)
    rendered_infer.update(override)
    # Upstream commands in the README-only study arm may mutate the shared
    # upstream config cache. The wrapper must always honor the caller's output
    # directory rather than inheriting a stale output_dir from that cache.
    rendered_infer["output_dir"] = str(output_dir)
    staged_infer_path = stage_dir / "config_infer.json"
    staged_infer_path.write_text(json.dumps(rendered_infer, indent=2))

    env_template_path = upstream_root / UPSTREAM_ENV_CONFIG_FMT.format(version=version)
    base_env = json.loads(env_template_path.read_text())
    rendered_env = dict(base_env)
    rendered_env["output_dir"] = str(output_dir)
    staged_env_path = stage_dir / f"environment_{version}.json"
    staged_env_path.write_text(json.dumps(rendered_env, indent=2))

    return rendered_infer, rendered_env, staged_infer_path, staged_env_path


# Empirical VRAM brackets for output_size, taken from upstream's
# `configs/config_infer_<vram>g_<dims>.json` naming. Used by the cost
# preview to refuse runs that won't fit. Values are GB; a 0.85 safety
# factor is applied at compare time so a 24 GB card doesn't get pushed
# to OOM on a "24 GB" config.
_VRAM_BRACKETS: tuple[tuple[tuple[int, int, int], int], ...] = (
    ((int("256"), int("256"), int("128")), int("16")),
    ((int("256"), int("256"), int("256")), int("24")),
    ((int("512"), int("512"), int("128")), int("24")),
    ((int("512"), int("512"), int("512")), int("32")),
    ((int("512"), int("512"), int("768")), int("80")),
)

# Walltime calibration on RTX 6000 Ada at num_inference_steps=30 (rflow-ct).
# Source: measurement from this case study's tier-5 runs (~90s for 256^3).
# Extrapolation is linear in voxel-steps, capped at the empirical brackets.
_WALLTIME_REF_VOXELS: int = int("256") * int("256") * int("256")
_WALLTIME_REF_STEPS: int = int("30")
_WALLTIME_REF_SECONDS: float = float("90.0")


def _estimate_cost(rendered: dict[str, Any], version: str) -> dict[str, Any]:
    """Predict wall-time, peak VRAM, and disk for a rendered config.

    The estimates are calibrated for rflow-ct on RTX 6000 Ada and are
    coarse; they exist to gate "this won't fit" cases, not to schedule
    cluster jobs.
    """
    out_size = rendered.get("output_size") or [int("256"), int("256"), int("256")]
    n_steps = int(rendered.get("num_inference_steps") or int("30"))
    n_samples = int(rendered.get("num_output_samples") or 1)

    voxels = int(out_size[0]) * int(out_size[1]) * int(out_size[2])
    seconds_per_sample = (
        _WALLTIME_REF_SECONDS * (voxels / _WALLTIME_REF_VOXELS) * (n_steps / _WALLTIME_REF_STEPS)
    )
    # ddpm-ct uses ~1000 steps with a heavier per-step cost; default
    # callers pass num_inference_steps=1000, so the linear model already
    # accounts for it. We don't add an extra multiplier here.

    # Pick the smallest VRAM bracket whose dims dominate the request.
    vram_gb_estimate: float | None = None
    for dims, gb in _VRAM_BRACKETS:
        if all(int(out_size[i]) <= dims[i] for i in range(int("3"))):
            vram_gb_estimate = float(gb)
            break
    # Anything bigger than the largest bracket: extrapolate by voxel ratio.
    if vram_gb_estimate is None:
        largest_dims, largest_gb = _VRAM_BRACKETS[-1]
        ratio = voxels / (largest_dims[0] * largest_dims[1] * largest_dims[2])
        vram_gb_estimate = float(largest_gb) * ratio

    # Disk: compressed NIfTI typically ~int16 per voxel for image, ~uint8
    # for label, gzip ~3-5x. Use 0.6 bytes/voxel as a conservative aggregate.
    disk_mb_per_sample = (voxels * float("0.6")) / (int("1024") * int("1024"))

    return {
        "version": version,
        "voxels_per_sample": voxels,
        "num_samples": n_samples,
        "num_inference_steps": n_steps,
        "estimated_wall_seconds": round(seconds_per_sample * n_samples, 1),
        "estimated_wall_seconds_per_sample": round(seconds_per_sample, 1),
        "estimated_peak_vram_gb": round(vram_gb_estimate, 1),
        "estimated_disk_mb": round(disk_mb_per_sample * n_samples * 2, 1),  # image + label
    }


def _detect_cuda() -> dict[str, Any]:
    """Return CUDA availability info without importing torch eagerly if it
    can be avoided. We still ultimately need torch to know GPU memory,
    so we accept the import cost when called."""
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


def _preflight(
    upstream_root: Path,
    rendered_infer: dict[str, Any],
    version: str,
) -> tuple[list[str], list[str], dict[str, Any]]:
    """Run all pre-execution validation. Returns (errors, warnings, context).
    Errors are hard fails; warnings let the run proceed.
    """
    errors: list[str] = []
    warnings: list[str] = []

    # 1. body_region values
    errors.extend(validate_body_region(rendered_infer.get("body_region")))

    # 2. anatomy_list values
    try:
        label_dict = load_label_dict(upstream_root)
        errors.extend(validate_anatomy_list(rendered_infer.get("anatomy_list"), label_dict))
    except Exception as e:
        errors.append(f"could not load label_dict for anatomy validation: {e}")
        label_dict = {}

    # 3. controllable_anatomy_size
    errors.extend(
        validate_controllable_anatomy_size(rendered_infer.get("controllable_anatomy_size"))
    )

    # 4. numeric bounds
    errors.extend(_validate_override_bounds(rendered_infer))

    # 5. dataset presence (paired generation needs the mask candidates)
    if not (rendered_infer.get("controllable_anatomy_size") or []):
        masks_dir = upstream_root / "datasets" / "all_masks_flexible_size_and_spacing_4000"
        masks_json = (
            upstream_root / "datasets" / "candidate_masks_flexible_size_and_spacing_4000.json"
        )
        if not masks_dir.is_dir() or not masks_json.is_file():
            errors.append(
                "mask-candidate dataset missing under "
                f"{upstream_root}/datasets/. Run `python -m scripts.download_model_data "
                f"--version {version} --root_dir ./` (no --model_only) from $NV_GENERATE_ROOT."
            )

    # 6. CUDA + estimated cost vs available VRAM
    cuda = _detect_cuda()
    cost = _estimate_cost(rendered_infer, version)
    if not cuda["available"]:
        errors.append(
            "CUDA not available. rflow-ct synthesis needs an NVIDIA GPU; "
            "there is no CPU fallback in the upstream code path."
        )
    elif cuda["total_memory_gb"] is not None:
        # Apply a 0.85 safety factor: leave headroom for activations / fragmentation.
        usable = cuda["total_memory_gb"] * float("0.85")
        if cost["estimated_peak_vram_gb"] > usable:
            warnings.append(
                f"estimated peak VRAM {cost['estimated_peak_vram_gb']} GB exceeds "
                f"85% of detected GPU memory ({cuda['total_memory_gb']} GB on "
                f"{cuda['device_name']}). Risk of OOM mid-run; consider smaller output_size."
            )

    context = {"cuda": cuda, "estimated_cost": cost}
    return errors, warnings, context


def _model_inventory(upstream_root: Path, version: str) -> dict[str, Any]:
    """Resolve checkpoint paths + sha256 for evidence."""
    files: list[dict[str, Any]] = []
    all_present = True
    for tmpl in UPSTREAM_MODEL_FILES:
        rel = tmpl.format(version=version)
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


def _nifti_suffix(path: Path) -> str:
    if path.name.endswith(".nii.gz"):
        return ".nii.gz"
    if path.name.endswith(".nii"):
        return ".nii"
    return path.suffix


def _nifti_stem(path: Path) -> str:
    if path.name.endswith(".nii.gz"):
        return path.name[: -len(".nii.gz")]
    if path.name.endswith(".nii"):
        return path.name[: -len(".nii")]
    return path.stem


def _paired_label_path(image_path: Path) -> Path:
    stem = _nifti_stem(image_path)
    suffix = _nifti_suffix(image_path)
    if stem.endswith("_image"):
        return image_path.with_name(f"{stem[:-len('_image')]}_label{suffix}")
    if stem.startswith("image_"):
        return image_path.with_name(f"label_{stem[len('image_'):]}{suffix}")
    if stem == "image":
        return image_path.with_name(f"label{suffix}")
    return Path(
        str(image_path)
        .replace("_image.nii.gz", "_label.nii.gz")
        .replace("_image.nii", "_label.nii")
    )


def _scan_outputs(output_dir: Path) -> list[Path]:
    """Find image/label pair image files produced by supported upstream names."""
    if not output_dir.is_dir():
        return []
    candidates = list(output_dir.rglob("sample_*_image.nii*")) + list(
        output_dir.rglob("image*.nii*")
    )
    image_paths = [path for path in candidates if _paired_label_path(path).exists()]
    return sorted(dict.fromkeys(image_paths))


def _round(values: Any, ndigits: int = int("6")) -> Any:
    if isinstance(values, (list, tuple)):
        return [round(float(v), ndigits) for v in values]
    return round(float(values), ndigits)


def _summarize_pair(image_path: Path) -> dict[str, Any]:
    """Read an image / paired label pair and return geometry + content summary."""
    label_path = _paired_label_path(image_path)
    record: dict[str, Any] = {
        "image_path": str(image_path),
        "label_path": str(label_path) if label_path.exists() else None,
        "image_bytes": image_path.stat().st_size if image_path.exists() else None,
        "label_bytes": label_path.stat().st_size if label_path.exists() else None,
        "image_sha256": file_sha256_safe(image_path) if image_path.exists() else "",
        "label_sha256": file_sha256_safe(label_path) if label_path.exists() else "",
        "image_readable": False,
        "label_readable": False,
    }
    try:
        img = nib.load(str(image_path))
        arr = np.asarray(img.get_fdata(), dtype=np.float32)
        record["image_readable"] = True
        record["image_shape"] = [int(v) for v in arr.shape]
        record["image_spacing"] = _round(img.header.get_zooms()[: int("3")])
        finite = arr[np.isfinite(arr)]
        if finite.size:
            record["image_hu_min"] = _round(float(finite.min()), int("3"))
            record["image_hu_max"] = _round(float(finite.max()), int("3"))
            record["image_hu_mean"] = _round(float(finite.mean()), int("3"))
            record["image_hu_negative_present"] = bool((finite < -int("500")).any())
            record["image_hu_bone_present"] = bool((finite > int("200")).any())
            record["image_nonconstant"] = bool(finite.max() - finite.min() > 1.0)
        record["image_affine"] = [list(map(float, row)) for row in img.affine.tolist()]
    except Exception as e:
        record["image_error"] = repr(e)

    if not label_path.exists():
        return record

    try:
        mask = nib.load(str(label_path))
        marr = np.asarray(mask.get_fdata()).astype(np.int64)
        record["label_readable"] = True
        record["label_shape"] = [int(v) for v in marr.shape]
        record["label_spacing"] = _round(mask.header.get_zooms()[: int("3")])
        unique, counts = np.unique(marr, return_counts=True)
        label_ids = [int(v) for v in unique.tolist() if int(v) != 0]
        record["label_ids_present"] = sorted(label_ids)
        record["label_id_count"] = len(label_ids)
        record["label_foreground_voxels"] = int(
            sum(int(c) for v, c in zip(unique, counts) if int(v) != 0)
        )
        record["label_background_voxels"] = int(
            sum(int(c) for v, c in zip(unique, counts) if int(v) == 0)
        )
        if record["image_readable"]:
            record["shape_match"] = record["image_shape"] == record["label_shape"]
            record["spacing_match"] = record["image_spacing"] == record["label_spacing"]
            affine_diff = float(np.max(np.abs(img.affine - mask.affine)))
            record["affine_max_abs_diff"] = round(affine_diff, int("8"))
            record["affine_match"] = affine_diff <= float("1e-4")
    except Exception as e:
        record["label_error"] = repr(e)

    return record


def _effective_anatomy_names(rendered: dict[str, Any]) -> list[str]:
    """Return the anatomy names the saved paired label map can represent.

    Upstream `LDMSampler` intentionally overwrites `anatomy_list` with
    `controllable_anatomy_size` names when controllable generation is used.
    It then saves a filtered label map whose values are local 1..N ordinals,
    not raw MAISI label IDs. Evidence must preserve that mapping explicitly.
    """
    controllable = rendered.get("controllable_anatomy_size") or []
    if controllable:
        names = [str(item[0]) for item in controllable if isinstance(item, (list, tuple)) and item]
    else:
        names = [str(item) for item in (rendered.get("anatomy_list") or [])]

    deduped: list[str] = []
    seen: set[str] = set()
    for name in names:
        if name not in seen:
            seen.add(name)
            deduped.append(name)
    return deduped


def _expected_output_label_mapping(
    rendered: dict[str, Any],
    label_dict: dict[str, int],
) -> list[dict[str, Any]]:
    """Map saved output-label ordinals back to MAISI label IDs."""
    mapping: list[dict[str, Any]] = []
    for idx, name in enumerate(_effective_anatomy_names(rendered), start=1):
        if name not in label_dict:
            continue
        mapping.append(
            {
                "anatomy": name,
                "maisi_label_id": int(label_dict[name]),
                "output_label_id": idx,
            }
        )
    return mapping


def _aggregate(
    samples: list[dict[str, Any]],
    output_label_mapping: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Aggregate per-sample records into top-level output summary."""
    n = len(samples)
    all_readable = bool(n) and all(
        s.get("image_readable") and s.get("label_readable") for s in samples
    )
    all_geometry = bool(n) and all(
        s.get("shape_match") and s.get("spacing_match") and s.get("affine_match") for s in samples
    )
    any_foreground = any(s.get("label_foreground_voxels", 0) > 0 for s in samples)
    all_nonconstant = bool(n) and all(s.get("image_nonconstant") for s in samples)
    all_hu_like = bool(n) and all(
        s.get("image_hu_negative_present") and s.get("image_hu_bone_present") for s in samples
    )
    union_label_ids: set[int] = set()
    for s in samples:
        for v in s.get("label_ids_present", []):
            union_label_ids.add(int(v))
    output_label_mapping = output_label_mapping or []
    expected_output_ids = {int(item["output_label_id"]) for item in output_label_mapping}
    missing_output_ids = sorted(expected_output_ids - union_label_ids)
    return {
        "num_samples": n,
        "all_pairs_readable": all_readable,
        "all_geometry_consistent": all_geometry,
        "any_foreground_present": any_foreground,
        "all_images_nonconstant": all_nonconstant,
        "all_images_hu_like": all_hu_like,
        "union_label_ids_present": sorted(union_label_ids),
        "output_label_mapping": output_label_mapping,
        "expected_output_label_ids": sorted(expected_output_ids),
        "expected_maisi_label_ids": sorted(
            {int(item["maisi_label_id"]) for item in output_label_mapping}
        ),
        "missing_expected_output_label_ids": missing_output_ids,
        "all_effective_anatomy_labels_present": not missing_output_ids,
    }


def _failure_reasons(
    upstream_exit_code: int,
    samples: list[dict[str, Any]],
    aggregate: dict[str, Any] | None = None,
) -> list[str]:
    reasons: list[str] = []
    if upstream_exit_code != 0:
        reasons.append(f"upstream scripts.inference exited {upstream_exit_code}")
    if not samples:
        reasons.append("upstream scripts.inference produced zero image/label samples")
    missing = (aggregate or {}).get("missing_expected_output_label_ids") or []
    if samples and missing:
        reasons.append(f"saved paired label map is missing expected output label id(s): {missing}")
    return reasons


@app.command()
def main(
    config_infer: str = typer.Argument(
        ...,
        help='Path to a config_infer override JSON, or the literal "default" '
        "to use upstream config_infer.json verbatim.",
    ),
    output_dir: Path = typer.Option(
        None, "--output-dir", "-o", help="Absolute directory for generated samples."
    ),
    seed: int = typer.Option(0, "--random-seed", "-s"),
    version: str = typer.Option("rflow-ct", "--version", help="rflow-ct or ddpm-ct"),
    timeout_seconds: float = typer.Option(float("3600.0"), "--timeout-seconds"),
    preflight_only: bool = typer.Option(
        False,
        "--preflight-only",
        help="Run all preflight checks (config validation, dataset presence, "
        "CUDA, VRAM/walltime estimate) and exit without launching inference.",
    ),
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        help="Skip the cost-preview confirmation gate (runs estimated to "
        "exceed 5 min wall-time or 30 GB VRAM normally require explicit confirmation).",
    ),
    no_summary_card: bool = typer.Option(
        False,
        "--no-summary-card",
        help="Skip rendering summary.html (mid-slice triptych + label overlay) after the run.",
    ),
) -> None:
    """Generate paired synthetic CT / mask volumes via NV-Generate-CTMR."""
    if version not in SUPPORTED_VERSIONS:
        raise typer.BadParameter(f"--version must be one of {SUPPORTED_VERSIONS}")

    upstream_root_env = os.environ.get("NV_GENERATE_ROOT", "").strip()
    if not upstream_root_env:
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "error": "NV_GENERATE_ROOT is unset",
                "detail": "Clone https://github.com/NVIDIA-Medtech/NV-Generate-CTMR and "
                "export NV_GENERATE_ROOT to its path.",
            }
        )
        raise typer.Exit(2)
    upstream_root = Path(upstream_root_env).expanduser().resolve()
    network = NETWORK_FOR_VERSION[version]
    network_config = UPSTREAM_NETWORK_CONFIG_FMT.format(network=network)
    if not (upstream_root / network_config).is_file():
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "error": "NV_GENERATE_ROOT layout invalid",
                "detail": f"{upstream_root}/{network_config} not found",
            }
        )
        raise typer.Exit(2)

    if output_dir is None:
        output_dir = upstream_root / "output"
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    override, override_source = _load_config_override(config_infer)
    stage_dir = output_dir / "_staged_configs"
    rendered_infer, rendered_env, staged_infer_path, staged_env_path = _stage_config(
        upstream_root, stage_dir, override, output_dir, version
    )

    # --- Preflight (#1) + cost preview (#6) -----------------------------
    errors, warnings, context = _preflight(upstream_root, rendered_infer, version)
    cost = context["estimated_cost"]
    cuda = context["cuda"]

    # Print a compact preview to stderr so it doesn't pollute the wrapper's
    # stdout JSON envelope. Users see this every run.
    print(
        f"[nv_generate_ct_rflow] preflight: "
        f"output_size={rendered_infer.get('output_size')} "
        f"steps={rendered_infer.get('num_inference_steps')} "
        f"samples={rendered_infer.get('num_output_samples')}",
        file=sys.stderr,
    )
    print(
        f"[nv_generate_ct_rflow] cost estimate: "
        f"~{cost['estimated_wall_seconds']}s wall, "
        f"~{cost['estimated_peak_vram_gb']} GB VRAM peak, "
        f"~{cost['estimated_disk_mb']} MB disk. "
        f"GPU: {cuda.get('device_name','?')} ({cuda.get('total_memory_gb','?')} GB)",
        file=sys.stderr,
    )
    for w in warnings:
        print(f"[nv_generate_ct_rflow] warning: {w}", file=sys.stderr)
    if errors:
        for e in errors:
            print(f"[nv_generate_ct_rflow] error: {e}", file=sys.stderr)
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "error": "preflight validation failed",
                "preflight_errors": errors,
                "preflight_warnings": warnings,
                "estimated_cost": cost,
                "cuda": cuda,
            }
        )
        raise typer.Exit(2)

    if preflight_only:
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "preflight": "ok",
                "preflight_warnings": warnings,
                "estimated_cost": cost,
                "cuda": cuda,
                "rendered_infer_config": rendered_infer,
            }
        )
        raise typer.Exit(0)

    # Cost gate: require --yes if the run is going to be slow or VRAM-hungry.
    HEAVY_WALL = float("300.0")  # 5 minutes
    HEAVY_VRAM = float("30.0")  # GB
    if not yes and (
        cost["estimated_wall_seconds"] > HEAVY_WALL or cost["estimated_peak_vram_gb"] > HEAVY_VRAM
    ):
        print(
            f"[nv_generate_ct_rflow] estimated run exceeds the default cost gate "
            f"(>{HEAVY_WALL:.0f}s or >{HEAVY_VRAM:.0f} GB VRAM). "
            f"Re-run with --yes to proceed, or shrink output_size / num_inference_steps / num_output_samples.",
            file=sys.stderr,
        )
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "error": "cost gate: run would be expensive; re-run with --yes to proceed",
                "estimated_cost": cost,
                "cuda": cuda,
            }
        )
        raise typer.Exit(2)

    model_inventory = _model_inventory(upstream_root, version)
    if not model_inventory["all_present"]:
        emit(
            {
                "skill": "nv_generate_ct_rflow",
                "error": "missing model weights",
                "detail": "Run `python -m scripts.download_model_data --version "
                f"{version} --root_dir ./` from $NV_GENERATE_ROOT first "
                "(without --model_only; paired generation needs the mask candidates).",
                "model_inventory": model_inventory,
            }
        )
        raise typer.Exit(2)

    cmd: list[str] = [
        sys.executable,
        "-m",
        "scripts.inference",
        "-t",
        network_config,
        "-i",
        str(staged_infer_path),
        "-e",
        str(staged_env_path),
        "--random-seed",
        str(seed),
        "--version",
        version,
    ]
    run_env = os.environ.copy()
    # Upstream README sets these; preserve user overrides.
    run_env.setdefault("MONAI_DATA_DIRECTORY", str(upstream_root / "temp_work_dir"))
    run_env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "max_split_size_mb:128,expandable_segments:True")

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

    image_paths = _scan_outputs(output_dir)
    samples = [_summarize_pair(p) for p in image_paths]
    requested_anatomy = rendered_infer.get("anatomy_list") or []
    try:
        label_dict = load_label_dict(upstream_root)
    except Exception:
        label_dict = {}
    output_label_mapping = _expected_output_label_mapping(rendered_infer, label_dict)
    aggregate = _aggregate(samples, output_label_mapping)
    failure_reasons = _failure_reasons(rc, samples, aggregate)

    payload: dict[str, Any] = {
        "skill": "nv_generate_ct_rflow",
        "model": "NVIDIA-Medtech/NV-Generate-CTMR (rflow-ct)",
        "model_repo": "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR",
        "model_weights_repo": "https://huggingface.co/nvidia/NV-Generate-CT",
        "license": "NVIDIA Open Model License (commercial-friendly)",
        "input": {
            "config_infer_override_path": override_source,
            "config_infer_override": override,
            "anatomy_list_requested": requested_anatomy,
            "effective_anatomy_for_output": _effective_anatomy_names(rendered_infer),
            "paired_output_label_semantics": (
                "Saved paired labels are local 1..N output ids after upstream "
                "filter_mask_with_organs; use output.output_label_mapping to "
                "map them back to MAISI label ids such as lung tumor=23."
            ),
            "body_region_requested": rendered_infer.get("body_region"),
            "num_output_samples_requested": rendered_infer.get("num_output_samples"),
            "output_size_requested": rendered_infer.get("output_size"),
            "spacing_requested": rendered_infer.get("spacing"),
            "random_seed": seed,
            "version": version,
        },
        "output": {
            "directory": str(output_dir),
            "samples": samples,
            **aggregate,
        },
        "invocation": {
            "upstream_root": str(upstream_root),
            "upstream_commit": git_commit(upstream_root),
            "command": cmd,
            "exit_code": rc,
            "subprocess_seconds": round(elapsed, int("3")),
            "model_inventory": model_inventory,
            "rendered_infer_config": rendered_infer,
            "rendered_env_output_dir": rendered_env.get("output_dir"),
        },
        "runtime": {
            "subprocess_seconds": round(elapsed, int("3")),
            "device": "cuda",
        },
        "logs": {
            "stdout_tail": tail(stdout),
            "stderr_tail": tail(stderr),
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Output is NOT clinically meaningful "
            "and is NOT suitable as training data for production deployment. "
            "This wrapper invokes the upstream scripts.inference entry point from "
            "the NV-Generate-CTMR README; it does not modify diffusion, sampling, "
            "or autoencoder decoding."
        ),
    }
    if failure_reasons:
        payload["error"] = "; ".join(failure_reasons)
        payload["failure_reasons"] = failure_reasons
    # Render summary.html (mid-slice triptych + label overlay + run table).
    # Failures here are non-fatal: the JSON envelope is the load-bearing
    # output. We record the card path in the payload so consumers can find it.
    if not no_summary_card:
        try:
            from _summary_card import render_card  # noqa: PLC0415

            card_path = render_card(output_dir, payload)
            if card_path is not None:
                payload["output"]["summary_html"] = str(card_path)
        except Exception as e:  # pragma: no cover
            payload["output"]["summary_html_error"] = repr(e)

    payload["preflight"] = {
        "warnings": warnings,
        "estimated_cost": cost,
        "cuda": cuda,
    }
    emit(payload)
    if failure_reasons:
        if rc not in (0, None):
            raise typer.Exit(rc if 0 < rc < 256 else 1)
        raise typer.Exit(1)
    raise typer.Exit(0)


if __name__ == "__main__":
    app()
