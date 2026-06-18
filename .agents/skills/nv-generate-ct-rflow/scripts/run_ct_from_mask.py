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

"""NV-Generate-CTMR image-from-mask wrapper.

Runs upstream `python -m scripts.infer_image_from_mask` after validating that
the input mask is an integer MAISI-style NIfTI label map with body envelope
evidence. The wrapper stages configs under the caller's output directory.
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

SKILL_NAME = "nv_generate_ct_rflow_ct_from_mask"
MODEL_REPO = "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR"
MODEL_WEIGHTS_REPO = "https://huggingface.co/nvidia/NV-Generate-CT"
NETWORK_CONFIG = "configs/config_network_rflow.json"
INFER_CONFIG = "configs/config_infer.json"
ENV_CONFIG = "configs/environment_rflow-ct.json"
MODEL_FILES = (
    "models/autoencoder_v1.pt",
    "models/diff_unet_3d_rflow-ct.pt",
    "models/controlnet_3d_rflow-ct.pt",
)
OVERRIDE_KEYS = (
    "num_inference_steps",
    "autoencoder_sliding_window_infer_size",
    "autoencoder_sliding_window_infer_overlap",
    "cfg_guidance_scale",
    "modality",
)
MAISI_VALID_LABELS = set(range(0, 133)) | {200}

app = typer.Typer(add_completion=False)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _valid_upstream_root(path: Path) -> bool:
    return (path / NETWORK_CONFIG).is_file() and (
        path / "scripts/infer_image_from_mask.py"
    ).is_file()


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


def _load_request(request_arg: str) -> tuple[dict[str, Any], Path | None]:
    if request_arg == "default":
        raise typer.BadParameter("ct-from-mask requires a JSON request containing mask_path")
    request_path = Path(request_arg).expanduser().resolve()
    if not request_path.is_file():
        raise typer.BadParameter(f"request JSON not found: {request_arg}")
    request = json.loads(request_path.read_text())
    if "mask_path" not in request:
        raise typer.BadParameter("request JSON must contain mask_path")
    unknown = sorted(
        k for k in request if not k.startswith("_") and k not in ("mask_path", *OVERRIDE_KEYS)
    )
    if unknown:
        raise typer.BadParameter(
            f"request contains unknown key(s): {unknown}. Allowed: mask_path plus {OVERRIDE_KEYS}"
        )
    return {k: v for k, v in request.items() if not k.startswith("_")}, request_path


def _resolve_mask_path(mask_value: str, request_path: Path | None) -> Path:
    path = Path(mask_value).expanduser()
    if not path.is_absolute() and request_path is not None:
        path = request_path.parent / path
    return path.resolve()


def _round(values: Any, ndigits: int = 6) -> Any:
    if isinstance(values, (list, tuple, np.ndarray)):
        return [round(float(v), ndigits) for v in values]
    return round(float(values), ndigits)


def _summarize_mask(mask_path: Path) -> dict[str, Any]:
    record: dict[str, Any] = {
        "mask_path": str(mask_path),
        "mask_exists": mask_path.is_file(),
        "mask_readable": False,
    }
    if not mask_path.is_file():
        return record
    try:
        img = nib.load(str(mask_path))
        data = np.asarray(img.get_fdata())
        rounded = np.rint(data)
        integer_like = bool(np.allclose(data, rounded))
        labels = sorted(int(v) for v in np.unique(rounded).tolist())
        unknown = [v for v in labels if v not in MAISI_VALID_LABELS]
        record.update(
            {
                "mask_readable": True,
                "mask_shape": [int(v) for v in data.shape],
                "mask_spacing": _round(img.header.get_zooms()[:3]),
                "label_ids_present": labels,
                "foreground_label_ids_present": [v for v in labels if v != 0],
                "label_id_count": len([v for v in labels if v != 0]),
                "integer_like": integer_like,
                "unknown_label_ids": unknown,
                "all_labels_in_maisi_vocab": not unknown,
                "body_label_200_present": 200 in labels,
            }
        )
    except Exception as exc:
        record["mask_error"] = repr(exc)
    return record


def _validate_mask_summary(summary: dict[str, Any], allow_missing_body_label: bool) -> list[str]:
    errors: list[str] = []
    if not summary.get("mask_exists"):
        errors.append(f"mask file not found: {summary.get('mask_path')}")
        return errors
    if not summary.get("mask_readable"):
        errors.append(f"mask is not a readable NIfTI: {summary.get('mask_path')}")
        return errors
    if not summary.get("integer_like"):
        errors.append("mask voxels must be integer-like label ids")
    if not summary.get("all_labels_in_maisi_vocab"):
        errors.append(
            f"mask has labels outside MAISI vocabulary: {summary.get('unknown_label_ids')}"
        )
    if not summary.get("body_label_200_present") and not allow_missing_body_label:
        errors.append(
            "mask is missing label 200 body envelope; add it before CT image-from-mask inference"
        )
    if summary.get("label_id_count", 0) < 1:
        errors.append("mask has no foreground labels")
    return errors


def _stage_configs(
    upstream_root: Path,
    stage_dir: Path,
    request: dict[str, Any],
    output_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any], Path, Path]:
    stage_dir.mkdir(parents=True, exist_ok=True)
    infer = _load_json(upstream_root / INFER_CONFIG)
    override = {k: v for k, v in request.items() if k in OVERRIDE_KEYS}
    infer.update(override)
    infer["modality"] = 1
    infer_path = stage_dir / "config_infer_from_mask.json"
    infer_path.write_text(json.dumps(infer, indent=2))

    env = _load_json(upstream_root / ENV_CONFIG)
    env["output_dir"] = str(output_dir)
    env_path = stage_dir / "environment_rflow-ct_from_mask.json"
    env_path.write_text(json.dumps(env, indent=2))
    return infer, env, infer_path, env_path


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


def _build_command(
    mask_path: Path, staged_infer_path: Path, staged_env_path: Path, seed: int
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "scripts.infer_image_from_mask",
        "--mask",
        str(mask_path),
        "-t",
        f"./{NETWORK_CONFIG}",
        "-e",
        str(staged_env_path),
        "-i",
        str(staged_infer_path),
        "--random-seed",
        str(seed),
    ]


def _scan_outputs(output_dir: Path, run_started: float) -> list[Path]:
    if not output_dir.is_dir():
        return []
    paths: list[Path] = []
    for path in output_dir.rglob("*_image.nii*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > 0 and path.stat().st_mtime >= run_started - 1:
                paths.append(path)
        except OSError:
            continue
    return sorted(paths)


def _summarize_image(path: Path) -> dict[str, Any]:
    record: dict[str, Any] = {"image_path": str(path), "image_readable": False}
    try:
        img = nib.load(str(path))
        data = np.asarray(img.get_fdata(), dtype=np.float32)
        finite = data[np.isfinite(data)]
        record["image_readable"] = True
        record["image_shape"] = [int(v) for v in data.shape]
        record["image_spacing"] = _round(img.header.get_zooms()[:3])
        record["all_finite"] = bool(finite.size == data.size)
        if finite.size:
            record["image_hu_min"] = _round(float(finite.min()), 3)
            record["image_hu_max"] = _round(float(finite.max()), 3)
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
        "all_images_finite": bool(n) and all(s.get("all_finite") for s in samples),
        "all_images_nonconstant": bool(n) and all(s.get("image_nonconstant") for s in samples),
        "all_images_hu_like": bool(n)
        and all(
            s.get("image_hu_negative_present") and s.get("image_hu_bone_present") for s in samples
        ),
    }


@app.command()
def main(
    request_json: str = typer.Argument(
        ..., help="JSON containing mask_path and optional inference overrides."
    ),
    output_dir: Path | None = typer.Option(None, "--output-dir", "-o"),
    seed: int = typer.Option(0, "--random-seed", "-s"),
    timeout_seconds: float = typer.Option(3600.0, "--timeout-seconds"),
    preflight_only: bool = typer.Option(False, "--preflight-only"),
    allow_missing_body_label: bool = typer.Option(False, "--allow-missing-body-label"),
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

    request, request_path = _load_request(request_json)
    mask_path = _resolve_mask_path(str(request["mask_path"]), request_path)
    mask_summary = _summarize_mask(mask_path)
    errors = _validate_mask_summary(mask_summary, allow_missing_body_label)
    rendered_infer, rendered_env, infer_path, env_path = _stage_configs(
        upstream_root,
        output_dir / "_staged_configs",
        request,
        output_dir,
    )
    inventory = _model_inventory(upstream_root)
    if not inventory["all_present"]:
        errors.append(
            "missing CT image/controlnet weights. Run `python -m scripts.download_model_data "
            "--version rflow-ct --root_dir ./ --model_only` from $NV_GENERATE_ROOT."
        )
    cuda = _detect_cuda()
    if not cuda["available"]:
        errors.append("CUDA not available. CT image-from-mask inference needs an NVIDIA GPU.")

    if errors:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "preflight validation failed",
                "preflight_errors": errors,
                "input": {"request_json": str(request_path), "mask": mask_summary},
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
                "input": {"request_json": str(request_path), "mask": mask_summary},
                "model_inventory": inventory,
                "rendered_infer_config": rendered_infer,
                "rendered_env_config": rendered_env,
                "cuda": cuda,
            }
        )
        raise typer.Exit(0)

    if not yes and int(rendered_infer.get("num_inference_steps", 30)) > 60:
        emit(
            {
                "skill": SKILL_NAME,
                "error": "cost gate: high step count; re-run with --yes to proceed",
            }
        )
        raise typer.Exit(2)

    cmd = _build_command(mask_path, infer_path, env_path, seed)
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

    samples = [_summarize_image(p) for p in _scan_outputs(output_dir, run_started)]
    aggregate = _aggregate(samples)
    failure_reasons: list[str] = []
    if rc != 0:
        failure_reasons.append(f"upstream scripts.infer_image_from_mask exited {rc}")
    if not samples:
        failure_reasons.append("upstream scripts.infer_image_from_mask produced zero images")

    payload: dict[str, Any] = {
        "skill": SKILL_NAME,
        "model": "NVIDIA-Medtech/NV-Generate-CTMR (rflow-ct image-from-mask)",
        "model_repo": MODEL_REPO,
        "model_weights_repo": MODEL_WEIGHTS_REPO,
        "license": "Wrapper Apache-2.0; CT weights use NVIDIA Open Model License.",
        "input": {
            "request_json": str(request_path),
            "request": request,
            "mask": mask_summary,
            "random_seed": seed,
            "version": "rflow-ct",
        },
        "output": {"directory": str(output_dir), "samples": samples, **aggregate},
        "invocation": {
            "official_entrypoint": "python -m scripts.infer_image_from_mask",
            "upstream_root": str(upstream_root),
            "upstream_commit": git_commit(upstream_root),
            "command": cmd,
            "exit_code": rc,
            "subprocess_seconds": round(elapsed, 3),
            "model_inventory": inventory,
            "rendered_infer_config": rendered_infer,
            "rendered_env_output_dir": rendered_env.get("output_dir"),
        },
        "runtime": {"subprocess_seconds": round(elapsed, 3), "device": "cuda"},
        "logs": {"stdout_tail": tail(stdout), "stderr_tail": tail(stderr)},
        "preflight": {"cuda": cuda},
        "intended_use_disclaimer": (
            "Engineering verification only. Output is synthetic and NOT clinically meaningful. "
            "This wrapper invokes upstream scripts.infer_image_from_mask."
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
