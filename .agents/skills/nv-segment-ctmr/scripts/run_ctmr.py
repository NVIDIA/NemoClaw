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

"""NVIDIA-Medtech NV-Segment-CTMR skill wrapper.

Thin wrapper around the upstream MONAI bundle command documented by
NVIDIA-Medtech/NV-Segment-CTMR. The wrapper does not implement inference; it
launches `python -m monai.bundle run`, captures logs, and summarizes the
resulting NIfTI label map as JSON.

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

app = typer.Typer(add_completion=False)

SKILL_NAME = "nv_segment_ctmr"
MODEL_REPO = "https://github.com/NVIDIA-Medtech/NV-Segment-CTMR/tree/main/NV-Segment-CTMR"
SUPPORTED_MODALITIES = ("CT_BODY", "MRI_BODY", "MRI_BRAIN")
GEOMETRY_TOLERANCE = float("1e-4")
REPO_ROOT = Path(__file__).resolve().parents[int("3")]


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, indent=2))
    sys.stdout.flush()


def tail(s: str, n_chars: int = int("4000")) -> str:
    if len(s) <= n_chars:
        return s
    return "..." + s[-n_chars:]


def git_commit(root: Path) -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=int("10"),
            check=False,
        )
    except Exception:
        return ""
    if proc.returncode == 0:
        return proc.stdout.strip()
    return ""


def _strip_nifti_suffix(path: Path) -> str:
    name = path.name
    for suffix in (".nii.gz", ".nii"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return path.stem


def _is_nifti_path(path: Path) -> bool:
    return path.name.endswith(".nii.gz") or path.suffix == ".nii"


def _round_floats(values, ndigits: int = int("6")) -> list[float]:
    return [round(float(v), ndigits) for v in values]


def _spacing3(img: nib.spatialimages.SpatialImage) -> list[float]:
    zooms = list(img.header.get_zooms())
    while len(zooms) < int("3"):
        zooms.append(1.0)
    return _round_floats(zooms[: int("3")])


def _input_summary(img: nib.spatialimages.SpatialImage) -> dict[str, Any]:
    return {
        "shape": [int(v) for v in img.shape],
        "ndim": len(img.shape),
        "spacing": _spacing3(img),
    }


def _geometry_summary(
    input_img: nib.spatialimages.SpatialImage,
    output_img: nib.spatialimages.SpatialImage,
) -> dict[str, Any]:
    input_shape = [int(v) for v in input_img.shape]
    output_shape = [int(v) for v in output_img.shape]
    input_spacing = _spacing3(input_img)
    output_spacing = _spacing3(output_img)
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


def _coerce_label_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _walk_label_records(raw: Any) -> list[tuple[int, str]]:
    records: list[tuple[int, str]] = []
    if isinstance(raw, list):
        for item in raw:
            records.extend(_walk_label_records(item))
        return records
    if not isinstance(raw, dict):
        return records

    for key, value in raw.items():
        key_id = _coerce_label_id(key)
        if key_id is not None:
            if isinstance(value, str):
                records.append((key_id, value))
            elif isinstance(value, dict):
                name = (
                    value.get("name")
                    or value.get("label")
                    or value.get("organ")
                    or value.get("class")
                    or f"label_id_{key_id}"
                )
                records.append((key_id, str(name)))
                records.extend(_walk_label_records(value))
            else:
                records.append((key_id, f"label_id_{key_id}"))
            continue

        value_id = _coerce_label_id(value)
        if value_id is not None:
            records.append((value_id, str(key)))
            continue

        if isinstance(value, dict):
            id_value = None
            for id_key in ("id", "index", "label_id", "label_index", "value"):
                if id_key in value:
                    id_value = _coerce_label_id(value[id_key])
                    if id_value is not None:
                        break
            if id_value is not None:
                name = (
                    value.get("name")
                    or value.get("label")
                    or value.get("organ")
                    or value.get("class")
                    or key
                )
                records.append((id_value, str(name)))
            records.extend(_walk_label_records(value))
        elif isinstance(value, list):
            records.extend(_walk_label_records(value))
    return records


def _load_label_map(upstream_root: Path) -> tuple[dict[int, str], Path | None]:
    candidates = [
        upstream_root / "configs" / "label_dict.json",
        upstream_root / "configs" / "metadata.json",
        upstream_root / "label_dict.json",
        upstream_root / "metadata.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text())
        except Exception:
            continue
        if path.name == "metadata.json" and isinstance(raw, dict):
            channel_def = (
                raw.get("network_data_format", {})
                .get("outputs", {})
                .get("pred", {})
                .get("channel_def")
            )
            if channel_def:
                raw = channel_def
        label_by_id: dict[int, str] = {}
        for label_id, name in _walk_label_records(raw):
            if label_id >= 0 and label_id not in label_by_id:
                label_by_id[label_id] = name
        if label_by_id:
            return label_by_id, path
    return {}, None


def _parse_label_prompts(raw: str | None) -> list[int] | None:
    if raw is None or not raw.strip():
        return None
    values: list[int] = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        values.append(int(item))
    return values


def _build_command(
    input_path: Path,
    output_dir: Path,
    modality: str,
    label_prompts: list[int] | None,
) -> list[str]:
    input_dict: dict[str, Any] = {"image": str(input_path)}
    if label_prompts is not None:
        input_dict["label_prompt"] = label_prompts
    return [
        sys.executable,
        "-m",
        "monai.bundle",
        "run",
        "--config_file",
        "configs/inference.json",
        "--input_dict",
        repr(input_dict),
        "--output_dir",
        str(output_dir),
        "--modality",
        modality,
    ]


def _expected_output_candidates(output_dir: Path, input_path: Path) -> list[Path]:
    stem = _strip_nifti_suffix(input_path)
    folder = output_dir / stem
    suffixes = ("_trans.nii.gz", "_seg.nii.gz", ".nii.gz", ".nii")
    return [folder / f"{stem}{suffix}" for suffix in suffixes] + [
        output_dir / f"{stem}{suffix}" for suffix in suffixes
    ]


def _find_output_mask(output_dir: Path, input_path: Path, run_started: float) -> Path | None:
    for candidate in _expected_output_candidates(output_dir, input_path):
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate

    candidates: list[Path] = []
    if output_dir.is_dir():
        for path in output_dir.rglob("*"):
            if not path.is_file() or not _is_nifti_path(path):
                continue
            try:
                if path.resolve() == input_path.resolve():
                    continue
            except OSError:
                pass
            try:
                if path.stat().st_size > 0 and path.stat().st_mtime >= run_started - 1:
                    candidates.append(path)
            except OSError:
                continue
    if not candidates:
        return None
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def _empty_geometry(input_summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "input_shape": input_summary["shape"],
        "output_shape": [],
        "shape_match": False,
        "input_spacing": input_summary["spacing"],
        "output_spacing": [],
        "spacing_match": False,
        "affine_max_abs_diff": None,
        "affine_match": False,
    }


def _empty_output_summary(
    input_summary: dict[str, Any],
    label_prompts: list[int] | None,
    label_map: dict[int, str],
    label_map_source: Path | None,
) -> dict[str, Any]:
    return {
        "path": None,
        "shape": [],
        "label_prompts_requested": label_prompts,
        "label_ids_present": [],
        "unexpected_label_ids": [],
        "label_set_valid": False,
        "label_map_loaded": bool(label_map),
        "label_map_source": str(label_map_source) if label_map_source is not None else None,
        "class_counts": {},
        "voxel_volume_ml": None,
        "class_volumes_ml": {},
        "any_label_present": False,
        "geometry": _empty_geometry(input_summary),
    }


def _mask_summary(
    mask_path: Path,
    input_img: nib.spatialimages.SpatialImage,
    label_prompts: list[int] | None,
    label_map: dict[int, str],
    label_map_source: Path | None,
) -> dict[str, Any]:
    mask_img = nib.load(str(mask_path))
    arr = np.asarray(mask_img.get_fdata()).astype(np.int64)
    voxel_volume_ml = float(np.prod(_spacing3(mask_img))) / float("1000.0")
    unique, counts = np.unique(arr, return_counts=True)
    class_counts: dict[str, int] = {}
    class_volumes_ml: dict[str, float] = {}
    label_ids_present: list[int] = []
    unexpected: list[int] = []
    valid_ids = set(label_map)

    for value, count in zip(unique.tolist(), counts.tolist()):
        label_id = int(value)
        if label_id == 0:
            continue
        label_ids_present.append(label_id)
        if label_map:
            if label_id not in valid_ids:
                unexpected.append(label_id)
        elif label_id < 0:
            unexpected.append(label_id)
        name = label_map.get(label_id, f"label_id_{label_id}")
        class_counts[name] = int(count)
        class_volumes_ml[name] = round(int(count) * voxel_volume_ml, int("4"))

    return {
        "shape": [int(v) for v in arr.shape],
        "label_prompts_requested": label_prompts,
        "label_ids_present": sorted(label_ids_present),
        "unexpected_label_ids": sorted(unexpected),
        "label_set_valid": len(unexpected) == 0,
        "label_map_loaded": bool(label_map),
        "label_map_source": str(label_map_source) if label_map_source is not None else None,
        "class_counts": class_counts,
        "voxel_volume_ml": round(voxel_volume_ml, int("8")),
        "class_volumes_ml": class_volumes_ml,
        "any_label_present": len(class_counts) > 0,
        "geometry": _geometry_summary(input_img, mask_img),
    }


def _model_inventory(upstream_root: Path, label_map_source: Path | None) -> dict[str, Any]:
    model_pt = upstream_root / "models" / "model.pt"
    return {
        "model_pt_present": model_pt.is_file(),
        "model_pt_path": str(model_pt),
        "label_map_present": label_map_source is not None,
        "label_map_path": str(label_map_source) if label_map_source is not None else None,
    }


def _resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch  # noqa: PLC0415

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _error_payload(message: str, detail: str) -> dict[str, Any]:
    return {
        "skill": SKILL_NAME,
        "error": message,
        "detail": detail,
        "model_repo": MODEL_REPO,
    }


def _valid_upstream_root(path: Path) -> bool:
    return (path / "configs" / "inference.json").is_file()


def _candidate_upstream_roots(env_value: str) -> list[Path]:
    candidates: list[Path] = []
    if env_value:
        candidates.append(Path(env_value).expanduser())
    candidates.extend(
        [
            REPO_ROOT / ".workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR",
            Path.home() / "NV-Segment-CTMR/NV-Segment-CTMR",
            Path.home() / "NV-Segment-CTMR",
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


def _resolve_upstream_root(
    explicit_root: Path | None,
    env_value: str,
) -> tuple[Path | None, list[str]]:
    if explicit_root is not None:
        resolved = explicit_root.expanduser().resolve()
        return (resolved if _valid_upstream_root(resolved) else None), [str(resolved)]
    checked: list[str] = []
    for candidate in _candidate_upstream_roots(env_value):
        resolved = candidate.resolve()
        checked.append(str(resolved))
        if _valid_upstream_root(resolved):
            return resolved, checked
    return None, checked


@app.command()
def main(
    nifti_path: Path = typer.Argument(..., exists=True, dir_okay=False),
    output_dir: Path | None = typer.Option(
        None, "--output-dir", "-o", help="dir for produced masks"
    ),
    modality: str = typer.Option("CT_BODY", "--modality", help="CT_BODY | MRI_BODY | MRI_BRAIN"),
    label_prompts: str | None = typer.Option(
        None,
        "--label-prompts",
        help="Optional comma-separated upstream class IDs, e.g. '3,14'.",
    ),
    device: str = typer.Option("auto", "--device", help="Recorded device hint: auto | cuda | cpu"),
    upstream_root: Path | None = typer.Option(
        None,
        "--upstream-root",
        help="Path to NV-Segment-CTMR/NV-Segment-CTMR; defaults to $NV_SEGMENT_CTMR_ROOT.",
    ),
    timeout_seconds: float = typer.Option(float("3600.0"), "--timeout-seconds"),
    ground_truth: Path | None = typer.Option(
        None,
        "--ground-truth",
        exists=True,
        dir_okay=False,
        help=(
            "Optional reference label map. Recorded under input.ground_truth_path "
            "for downstream verifiers. The skill does not compute GT metrics."
        ),
    ),
) -> None:
    """Run NV-Segment-CTMR on a CT or MRI NIfTI volume."""
    if modality not in SUPPORTED_MODALITIES:
        raise typer.BadParameter(f"--modality must be one of {SUPPORTED_MODALITIES}")

    env_root = os.environ.get("NV_SEGMENT_CTMR_ROOT", "").strip()
    resolved_root, checked_roots = _resolve_upstream_root(upstream_root, env_root)
    if resolved_root is None and upstream_root is None and not env_root:
        emit(
            _error_payload(
                "NV_SEGMENT_CTMR_ROOT is unset",
                "Clone https://github.com/NVIDIA-Medtech/NV-Segment-CTMR and export "
                "NV_SEGMENT_CTMR_ROOT to the nested NV-Segment-CTMR directory, or place the clone at "
                ".workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR.",
            )
            | {"checked_roots": checked_roots}
        )
        raise typer.Exit(2)
    if resolved_root is None:
        emit(
            _error_payload(
                "NV_SEGMENT_CTMR_ROOT layout invalid",
                "configs/inference.json not found in any checked root",
            )
            | {"checked_roots": checked_roots}
        )
        raise typer.Exit(2)
    config_file = resolved_root / "configs" / "inference.json"

    nifti_path = nifti_path.expanduser().resolve()
    if output_dir is None:
        output_dir = nifti_path.parent / f"{_strip_nifti_suffix(nifti_path)}_nv_segment_ctmr_out"
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    parsed_label_prompts = _parse_label_prompts(label_prompts)
    label_map, label_map_source = _load_label_map(resolved_root)
    inventory = _model_inventory(resolved_root, label_map_source)
    resolved_device = _resolve_device(device)

    input_img = nib.load(str(nifti_path))
    input_summary = _input_summary(input_img)
    output_summary = _empty_output_summary(
        input_summary,
        parsed_label_prompts,
        label_map,
        label_map_source,
    )

    cmd = _build_command(nifti_path, output_dir, modality, parsed_label_prompts)
    run_env = os.environ.copy()
    run_env.setdefault("MONAI_DATA_DIRECTORY", str(output_dir / "_monai_data"))
    run_env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "max_split_size_mb:128,expandable_segments:True")

    run_started = time.time()
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(resolved_root),
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

    mask_path = _find_output_mask(output_dir, nifti_path, run_started)
    if mask_path is not None:
        output_summary = _mask_summary(
            mask_path,
            input_img,
            parsed_label_prompts,
            label_map,
            label_map_source,
        )
        output_summary["path"] = str(mask_path)

    payload: dict[str, Any] = {
        "skill": SKILL_NAME,
        "model": "NVIDIA-Medtech/NV-Segment-CTMR (VISTA3D CT/MRI)",
        "model_repo": MODEL_REPO,
        "license": "Wrapper Apache-2.0; upstream model and repository licenses apply.",
        "input": {
            "path": str(nifti_path),
            **input_summary,
            "modality": modality,
            "ground_truth_path": str(ground_truth) if ground_truth is not None else None,
        },
        "output": output_summary,
        "invocation": {
            "official_entrypoint": "python -m monai.bundle run",
            "upstream_root": str(resolved_root),
            "upstream_commit": git_commit(resolved_root),
            "config_file": str(config_file),
            "output_dir": str(output_dir),
            "modality": modality,
            "label_prompts": parsed_label_prompts,
            "command": cmd,
            "exit_code": rc,
            "model_inventory": inventory,
        },
        "runtime": {
            "subprocess_seconds": round(elapsed, int("3")),
            "device": resolved_device,
        },
        "logs": {
            "stdout_tail": tail(stdout),
            "stderr_tail": tail(stderr),
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Output is NOT clinically meaningful. "
            "This wrapper invokes the upstream MONAI bundle entry point from the "
            "NVIDIA-Medtech/NV-Segment-CTMR README; it does not modify inference, "
            "preprocessing, or postprocessing."
        ),
    }
    emit(payload)
    raise typer.Exit(0)


if __name__ == "__main__":
    app()
