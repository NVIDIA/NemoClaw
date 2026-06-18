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

"""NVIDIA-Medtech NV-Segment-CT (VISTA3D) skill.

Thin wrapper around the official `HuggingFacePipelineHelper` from
nvidia/NV-Segment-CT (https://huggingface.co/nvidia/NV-Segment-CT).
The wrapper does NOT implement inference -- it invokes the pipeline
exactly as the HF model card recommends, then reads the produced
NIfTI mask to emit a structured summary.

Engineering verification only. Output is NOT clinically meaningful.
"""

import contextlib
import json
import os
import sys
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import typer


@contextlib.contextmanager
def _stdout_to_stderr():
    """Send anything the wrapped pipeline prints to its own stdout to stderr,
    so the eval_engine sees only the JSON we explicitly print at the end."""
    fd = sys.stdout.fileno()
    saved = os.dup(fd)
    try:
        os.dup2(sys.stderr.fileno(), fd)
        yield
    finally:
        os.dup2(saved, fd)
        os.close(saved)


SKILL_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SKILL_DIR.parent.parent
BUNDLE = SKILL_DIR / "bundle"

# The HF repo (downloaded into bundle/) defines `hugging_face_pipeline`,
# `vista3d_model`, `vista3d_pipeline`, `vista3d_config`, and `scripts/`.
# We add bundle/ to sys.path so the official imports resolve. We do not
# modify any of those files.
sys.path.insert(0, str(BUNDLE))

app = typer.Typer(add_completion=False)
DEFAULT_LABEL_DICT = BUNDLE / "label_dict.json"
GEOMETRY_TOLERANCE = float("1e-4")


def _public_path(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        resolved = path.resolve()
    except (OSError, ValueError):
        return str(path)
    try:
        return str(resolved.relative_to(REPO_ROOT))
    except ValueError:
        return str(resolved)


def _resolve_device(requested: str) -> str:
    if requested == "auto":
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    return requested


def _find_output_mask(output_dir: Path, input_path: Path) -> Path | None:
    """The HF pipeline writes <output_dir>/<basename>/<basename>_seg.nii.gz."""
    name = input_path.name
    for suffix in (".nii.gz", ".nii"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    candidate = output_dir / name / f"{name}_seg.nii.gz"
    if candidate.exists():
        return candidate
    matches = list((output_dir / name).glob("*_seg.nii.gz")) if (output_dir / name).is_dir() else []
    return matches[0] if matches else None


def _round_floats(values, ndigits: int = int("6")) -> list[float]:
    return [round(float(v), ndigits) for v in values]


def _input_summary(img: nib.spatialimages.SpatialImage) -> dict:
    zooms = img.header.get_zooms()[: len(img.shape)]
    return {
        "shape": [int(v) for v in img.shape],
        "ndim": len(img.shape),
        "spacing": _round_floats(zooms[: int("3")]),
    }


def _geometry_summary(
    input_img: nib.spatialimages.SpatialImage,
    output_img: nib.spatialimages.SpatialImage,
) -> dict:
    input_shape = [int(v) for v in input_img.shape]
    output_shape = [int(v) for v in output_img.shape]
    input_spacing = _round_floats(input_img.header.get_zooms()[: int("3")])
    output_spacing = _round_floats(output_img.header.get_zooms()[: int("3")])
    affine_max_abs_diff = float(np.max(np.abs(input_img.affine - output_img.affine)))
    return {
        "input_shape": input_shape,
        "output_shape": output_shape,
        "shape_match": input_shape == output_shape,
        "input_spacing": input_spacing,
        "output_spacing": output_spacing,
        "spacing_match": input_spacing == output_spacing,
        "affine_max_abs_diff": round(affine_max_abs_diff, int("8")),
        "affine_match": affine_max_abs_diff <= GEOMETRY_TOLERANCE,
    }


def _mask_summary(
    mask_path: Path,
    input_img: nib.spatialimages.SpatialImage,
    requested_label_ids: list[int],
    inv_label_dict: dict[int, str],
) -> dict:
    mask_img = nib.load(str(mask_path))
    arr = np.asarray(mask_img.get_fdata()).astype(np.int64)
    spacing = mask_img.header.get_zooms()[: int("3")]
    voxel_volume_ml = float(np.prod(spacing)) / float("1000.0")
    unique, counts = np.unique(arr, return_counts=True)
    class_counts: dict[str, int] = {}
    class_volumes_ml: dict[str, float] = {}
    label_ids_present: list[int] = []
    requested = set(requested_label_ids)
    unexpected: list[int] = []
    for v, c in zip(unique.tolist(), counts.tolist()):
        label_id = int(v)
        if label_id == 0:
            continue
        label_ids_present.append(label_id)
        if label_id not in requested:
            unexpected.append(label_id)
        name = inv_label_dict.get(label_id, f"label_id_{label_id}")
        class_counts[name] = int(c)
        class_volumes_ml[name] = round(int(c) * voxel_volume_ml, int("4"))

    return {
        "shape": [int(v) for v in arr.shape],
        "label_prompts_requested": requested_label_ids,
        "label_ids_present": sorted(label_ids_present),
        "unexpected_label_ids": sorted(unexpected),
        "label_set_valid": len(unexpected) == 0,
        "class_counts": class_counts,
        "voxel_volume_ml": round(voxel_volume_ml, int("8")),
        "class_volumes_ml": class_volumes_ml,
        "any_label_present": len(class_counts) > 0,
        "geometry": _geometry_summary(input_img, mask_img),
    }


@app.command()
def main(
    nifti_path: Path = typer.Argument(..., exists=True, dir_okay=False),
    output_dir: Path = typer.Option(None, "--output-dir", "-o", help="dir for produced masks"),
    label_prompts: str = typer.Option(
        "1,3,5,14",
        "--label-prompts",
        help="Comma-sep VISTA3D label IDs (1=liver, 3=spleen, 5=right kidney, 14=left kidney)",
    ),
    device: str = typer.Option("auto", "--device", help="auto | cuda | cpu"),
    ground_truth: Path = typer.Option(
        None,
        "--ground-truth",
        exists=True,
        dir_okay=False,
        help=(
            "Optional reference label map. Recorded under input.ground_truth_path "
            "for downstream verifiers (e.g. ct_segmentation_quality_v1). The skill "
            "does not compute any GT comparison metrics."
        ),
    ),
) -> None:
    """Run NV-Segment-CT (VISTA3D) on a CT NIfTI volume."""
    if output_dir is None:
        stem = nifti_path.name
        for suffix in (".nii.gz", ".nii"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        output_dir = nifti_path.parent / f"{stem}_vista3d_out"
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    label_ids = [int(x) for x in label_prompts.split(",")]
    label_dict = json.loads(DEFAULT_LABEL_DICT.read_text()) if DEFAULT_LABEL_DICT.exists() else {}
    inv_label_dict = {int(v): k for k, v in label_dict.items() if isinstance(v, int)}

    resolved_device = _resolve_device(device)

    try:
        from hugging_face_pipeline import HuggingFacePipelineHelper  # noqa: PLC0415
    except ModuleNotFoundError as e:
        result = {
            "skill": "nv_segment_ct",
            "error": "NV-Segment-CT bundle is missing or incomplete",
            "detail": str(e),
            "install_command": (
                "huggingface-cli download nvidia/NV-Segment-CT "
                "--local-dir skills/nv-segment-ct/bundle/"
            ),
        }
        print(json.dumps(result, indent=2))
        raise typer.Exit(2)

    import torch

    with _stdout_to_stderr():
        t0 = time.perf_counter()
        helper = HuggingFacePipelineHelper("vista3d")
        pipeline = helper.init_pipeline(
            str(BUNDLE / "vista3d_pretrained_model"),
            device=torch.device(resolved_device),
        )
        t_load = time.perf_counter() - t0

        inputs = [{"image": str(nifti_path), "label_prompt": label_ids}]
        t0 = time.perf_counter()
        pipeline(inputs, output_dir=str(output_dir))
        t_inf = time.perf_counter() - t0

    input_img = nib.load(str(nifti_path))
    input_summary = _input_summary(input_img)
    mask_path = _find_output_mask(output_dir, nifti_path)
    output_summary = {
        "path": None,
        "shape": [],
        "label_prompts_requested": label_ids,
        "label_ids_present": [],
        "unexpected_label_ids": [],
        "label_set_valid": False,
        "class_counts": {},
        "voxel_volume_ml": None,
        "class_volumes_ml": {},
        "any_label_present": False,
        "geometry": {
            "input_shape": input_summary["shape"],
            "output_shape": [],
            "shape_match": False,
            "input_spacing": input_summary["spacing"],
            "output_spacing": [],
            "spacing_match": False,
            "affine_max_abs_diff": None,
            "affine_match": False,
        },
    }
    if mask_path is not None and mask_path.exists():
        output_summary = _mask_summary(mask_path, input_img, label_ids, inv_label_dict)
        output_summary["path"] = _public_path(mask_path)

    result = {
        "skill": "nv_segment_ct",
        "model": "NVIDIA-Medtech/NV-Segment-CT (VISTA3D)",
        "model_repo": "https://huggingface.co/nvidia/NV-Segment-CT",
        "license": "NVIDIA Open Model License (commercial-friendly)",
        "input": {
            "path": _public_path(nifti_path),
            **input_summary,
            "ground_truth_path": _public_path(ground_truth),
        },
        "output": output_summary,
        "invocation": {
            "official_helper": "hugging_face_pipeline.HuggingFacePipelineHelper",
            "pipeline_name": "vista3d",
            "weights_dir": _public_path(BUNDLE / "vista3d_pretrained_model"),
        },
        "runtime": {
            "model_load_seconds": round(t_load, int("3")),
            "inference_seconds": round(t_inf, int("3")),
            "device": resolved_device,
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Output is NOT clinically meaningful. "
            "This wrapper invokes the official HuggingFace pipeline from the "
            "nvidia/NV-Segment-CT model card; it does not modify inference."
        ),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    app()
