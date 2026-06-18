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

"""nv_segment_ct_finetune - auto-configuring VISTA3D continual finetune.

Three presets:
  --smoke   1 iter on bundled spleen_micro fixture (synthetic plumbing).
  --sanity  Real-recipe verification on MSD06 Lung Tumor - mirrors the
            published DFW tutorial config: label mapping [[1, 23]], 5 epochs,
            lr=5e-5, patch [128,128,128], resample 1.5 mm isotropic,
            drop_label_prob=0.0, drop_point_prob=1.0 (automatic segmentation).
            Runs original-spacing evaluate.json before and after finetuning.
            Expected DFW reference scores are pretrained Dice 0.6697,
            finetuned Dice 0.6836, and training-best Dice 0.6905.
  default   user dataset under --dataset-dir, lr=5e-5, 50 epochs.

The wrapper auto-detects GPU + RAM, picks patch_size and cache_rate, writes
`configs/auto_override.json`, and runs `python -m monai.bundle run` (or
`torchrun --nproc_per_node=N -m monai.bundle run` for multi-GPU) exactly as
NV-Segment-CT's upstream `finetune.md` documents.

Engineering verification only. Output is NOT clinically meaningful.
"""

from __future__ import annotations

import inspect
import json
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import venv
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Optional

import nibabel as nib
import numpy as np
import scipy.ndimage as ndi
import typer

SKILL_DIR = Path(__file__).resolve().parent.parent
BUNDLE_DIR = SKILL_DIR / "bundle"
LABEL_DICT = BUNDLE_DIR / "label_dict.json"
LABEL_DICT_URL = (
    "https://raw.githubusercontent.com/NVIDIA-Medtech/NV-Segment-CTMR/main/"
    "NV-Segment-CT/configs/label_dict.json"
)
SMOKE_FIXTURE = SKILL_DIR / "fixtures" / "spleen_micro"
# Resolve Medical AI Skills cache root from the script's own location: repo_root/.workbench_data.
# Callers can still override with --dataset-dir when their cache lives elsewhere.
_REPO_ROOT = SKILL_DIR.parent.parent
SANITY_DATASET = _REPO_ROOT / ".workbench_data" / "datasets" / "Task06_Lung"
SANITY_ANATOMY = "lung tumor"  # MSD06 label 1 (cancer) -> vista3d global index 23
VERSION = "0.4.1"
SUPPORTED_MONAI_MAJOR_MINOR = {(1, 4)}
SANITY_REFERENCE_THRESHOLDS = {
    "formal_pretrained_val_dice_min": 0.65,
    "formal_finetuned_val_dice_min": 0.67,
    "formal_improvement_min": 0.005,
    "training_start_val_dice_min": 0.65,
    "training_best_val_dice_min": 0.68,
    "training_improvement_min": 0.005,
}

# Patch ladder keyed on free GPU MiB; calibrated on RTX 6000 Ada (see SKILL.md).
PATCH_LADDER = [
    (int("8_000"), [int("64"), int("64"), int("64")]),
    (int("16_000"), [int("96"), int("96"), int("96")]),
    (int("32_000"), [int("128"), int("128"), int("128")]),
    (int("48_000"), [int("160"), int("160"), int("160")]),
    (int("10") ** int("9"), [int("192"), int("192"), int("128")]),
]
NIFTI_SUFFIXES = (".nii.gz", ".nii")

# Domain knowledge for input-side anatomy checks (adult ranges; informative
# only - the wrapper records, doesn't hard-fail). Volumes in mL.
ANATOMY_VOLUME_ML = {
    "spleen": (int("50"), int("500")),
    "liver": (int("1000"), int("2500")),
    "pancreas": (int("50"), int("200")),
    "stomach": (int("200"), int("1500")),
    "gallbladder": (int("5"), int("80")),
    "right kidney": (int("100"), int("300")),
    "left kidney": (int("100"), int("300")),
    # Lung tumor (MSD06 cancer label) ranges widely from sub-mL nodules
    # to bulky disease; we set a generous adult-thoracic ceiling and a
    # floor that still flags empty-mask bugs.
    "lung tumor": (float("0.05"), int("500")),
}
ANATOMY_EXPECTED_COMPONENTS = {  # solitary organs; user can override
    "spleen": 1,
    "liver": 1,
    "pancreas": 1,
    "stomach": 1,
    "gallbladder": 1,
    "right kidney": 1,
    "left kidney": 1,
    # Tumors are multifocal in general - leave component count unconstrained.
}

app = typer.Typer(add_completion=False)


def _monai_major_minor(monai_version: str) -> tuple[int, int] | None:
    parts = monai_version.split("+", 1)[0].split(".", 2)
    if len(parts) < 2 or not all(p.isdigit() for p in parts[:2]):
        return None
    return int(parts[0]), int(parts[1])


def require_compatible_runtime() -> None:
    """Fail before launching MONAI when the version is outside the tested range."""
    try:
        monai_version = package_version("monai")
    except PackageNotFoundError as exc:
        raise typer.BadParameter(
            "monai is not installed; install `monai==1.4.0` in the active "
            "environment before running this skill."
        ) from exc

    major_minor = _monai_major_minor(monai_version)
    if major_minor not in SUPPORTED_MONAI_MAJOR_MINOR:
        raise typer.BadParameter(
            f"monai==1.4.0 is required for this bundle; found monai " f"{monai_version}."
        )


def _monai_is_compatible() -> bool:
    try:
        monai_version = package_version("monai")
    except PackageNotFoundError:
        return False
    return _monai_major_minor(monai_version) in SUPPORTED_MONAI_MAJOR_MINOR


def maybe_reexec_compatible_runtime() -> None:
    """Use a temporary compatible venv when the caller's MONAI is outside this range.

    Re-exec keeps the user-facing command simple while preserving the active
    environment's CUDA/Torch via --system-site-packages. The DFW reference
    run used MONAI 1.4.0 on Python 3.10; Python 3.12 environments usually
    should still use MONAI 1.4.0 for this upstream trainer.
    """
    if _monai_is_compatible():
        return
    if os.environ.get("NVSEG_FINETUNE_AUTO_VENV") == "0":
        return
    if os.environ.get("NVSEG_FINETUNE_IN_AUTO_VENV") == "1":
        return

    venv_dir = Path(os.environ.get("NVSEG_FINETUNE_AUTO_VENV_DIR", "/tmp/nvseg-m14"))
    python_bin = venv_dir / "bin" / "python"
    if not python_bin.exists():
        venv.EnvBuilder(system_site_packages=True, with_pip=True).create(venv_dir)

    subprocess.check_call(
        [
            str(python_bin),
            "-m",
            "pip",
            "install",
            "monai==1.4.0",
            "numpy<2",
        ],
        stdout=sys.stderr,
        stderr=sys.stderr,
    )
    env = os.environ.copy()
    env["NVSEG_FINETUNE_IN_AUTO_VENV"] = "1"
    sys.stderr.write(f"[nv_segment_ct_finetune] re-exec with {python_bin}\n")
    os.execvpe(str(python_bin), [str(python_bin), *sys.argv], env)


def require_bundle_files() -> None:
    """Fail with setup instructions before MONAI emits a deep config error."""
    bundle_notes = prepare_bundle_files()
    required = [
        BUNDLE_DIR / "configs" / "train.json",
        BUNDLE_DIR / "configs" / "train_continual.json",
        BUNDLE_DIR / "configs" / "metadata.json",
        LABEL_DICT,
        BUNDLE_DIR / "models" / "model.pt",
    ]
    missing = [p for p in required if not p.exists()]
    if not missing:
        if bundle_notes:
            sys.stderr.write(
                "[nv_segment_ct_finetune] prepared bundle files: " + "; ".join(bundle_notes) + "\n"
            )
        return

    rel_missing = [
        str(p.relative_to(SKILL_DIR)) if p.is_relative_to(SKILL_DIR) else str(p) for p in missing
    ]
    raise typer.BadParameter(
        "bundle setup is incomplete; missing: "
        + ", ".join(rel_missing)
        + "\nFrom skills/nv-segment-ct-finetune, run:\n"
        + "  hf download nvidia/NV-Segment-CT --local-dir bundle/\n"
        + '  python -c "import urllib.request; '
        + f"urllib.request.urlretrieve('{LABEL_DICT_URL}', "
        + "'bundle/label_dict.json')\"\n"
        + "  python - <<'PY'\n"
        + "from pathlib import Path\n"
        + "import shutil\n"
        + "for src, dst in [(Path('bundle/metadata.json'), Path('bundle/configs/metadata.json')), (Path('bundle/vista3d_pretrained_model/model.pt'), Path('bundle/models/model.pt'))]:\n"
        + "    dst.parent.mkdir(parents=True, exist_ok=True)\n"
        + "    if dst.is_symlink() or not dst.exists():\n"
        + "        dst.unlink(missing_ok=True)\n"
        + "        shutil.copy2(src, dst)\n"
        + "PY\n"
    )


def _unlink_broken_symlink(path: Path) -> bool:
    if path.is_symlink() and not path.exists():
        path.unlink()
        return True
    return False


def _copy_if_missing_or_broken(src: Path, dst: Path) -> bool:
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_symlink() and not dst.exists():
        dst.unlink()
    if dst.exists():
        return False
    shutil.copy2(src, dst)
    return True


def _upstream_config_dirs() -> list[Path]:
    """Local upstream checkouts that can seed missing bundle configs."""
    dirs: list[Path] = []
    env_root = os.environ.get("NV_SEGMENT_CT_ROOT", "").strip()
    if env_root:
        dirs.append(Path(env_root) / "configs")
    ctmr_root = os.environ.get("NV_SEGMENT_CTMR_ROOT", "").strip()
    if ctmr_root:
        root = Path(ctmr_root)
        dirs.extend([root / "configs", root.parent / "NV-Segment-CT" / "configs"])
    dirs.extend(
        [
            _REPO_ROOT
            / ".workbench_data"
            / "upstreams"
            / "NV-Segment-CTMR"
            / "NV-Segment-CT"
            / "configs",
            _REPO_ROOT
            / ".workbench_data"
            / "upstreams"
            / "NV-Segment-CTMR"
            / "NV-Segment-CTMR"
            / "configs",
        ]
    )
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in dirs:
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(resolved)
    return unique


def _copy_upstream_config(name: str, *, overwrite_if_different: bool = False) -> bool:
    dst = BUNDLE_DIR / "configs" / name
    for config_dir in _upstream_config_dirs():
        src = config_dir / name
        if not src.exists():
            continue
        if dst.is_symlink() and not dst.exists():
            dst.unlink()
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            return True
        if overwrite_if_different and src.read_bytes() != dst.read_bytes():
            shutil.copy2(src, dst)
            return True
        if dst.exists():
            return False
    return False


def _download_label_dict(dst: Path) -> bool:
    if dst.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(LABEL_DICT_URL, timeout=30) as response:
            payload = response.read()
    except (OSError, urllib.error.URLError):
        return False
    data = json.loads(payload.decode("utf-8"))
    if not isinstance(data, dict) or "lung tumor" not in data:
        return False
    dst.write_text(json.dumps(data, indent=2) + "\n")
    return True


def _fixture_preset(fixture: Path) -> str | None:
    name = fixture.name
    if name == "spleen_micro" or name.startswith("spleen_micro"):
        return "smoke"
    if name in {"Task06", "Task06_Lung"} or name.startswith("Task06_"):
        return "sanity"
    return None


def _resolve_sanity_dataset(fixture: Optional[Path], dataset_dir: Optional[Path]) -> Path:
    if dataset_dir is not None:
        return dataset_dir.resolve()
    if fixture is not None and fixture.is_dir():
        return fixture.resolve()
    return SANITY_DATASET


def prepare_bundle_files() -> list[str]:
    """Make the local downloaded bundle usable in fresh agent commands.

    `hf download --local-dir` can leave old local symlinks untouched when a
    previous checkout used a different skill path. Repairing those files here
    keeps the user-facing command idempotent without requiring shell cleanup.
    """
    notes: list[str] = []
    for rel in (
        "label_dict.json",
        "configs/metadata.json",
        "models/model.pt",
    ):
        if _unlink_broken_symlink(BUNDLE_DIR / rel):
            notes.append(f"removed dangling {rel}")

    sibling_label_dict = SKILL_DIR.parent / "nv-segment-ct" / "bundle" / "label_dict.json"
    if _copy_if_missing_or_broken(sibling_label_dict, LABEL_DICT):
        notes.append("copied label_dict.json from nv-segment-ct cache")
    if _download_label_dict(LABEL_DICT):
        notes.append("downloaded label_dict.json from NVIDIA-Medtech/NV-Segment-CTMR")

    for config_name in (
        "train.json",
        "train_continual.json",
        "multi_gpu_train.json",
        "evaluate.json",
    ):
        if _copy_upstream_config(config_name, overwrite_if_different=True):
            notes.append(f"restored configs/{config_name} from local upstream cache")

    needed_sources = [
        BUNDLE_DIR / "configs" / "train.json",
        BUNDLE_DIR / "configs" / "train_continual.json",
        BUNDLE_DIR / "metadata.json",
        BUNDLE_DIR / "vista3d_pretrained_model" / "model.pt",
    ]
    if not all(p.exists() for p in needed_sources):
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            return notes
        snapshot_download(
            repo_id="nvidia/NV-Segment-CT",
            local_dir=str(BUNDLE_DIR),
            local_dir_use_symlinks=False,
        )
        notes.append("downloaded nvidia/NV-Segment-CT bundle")

        for config_name in (
            "train.json",
            "train_continual.json",
            "multi_gpu_train.json",
            "evaluate.json",
        ):
            if _copy_upstream_config(config_name, overwrite_if_different=True):
                notes.append(f"restored configs/{config_name} from local upstream cache")

    if _copy_if_missing_or_broken(
        BUNDLE_DIR / "metadata.json",
        BUNDLE_DIR / "configs" / "metadata.json",
    ):
        notes.append("staged configs/metadata.json")
    if _copy_if_missing_or_broken(
        BUNDLE_DIR / "vista3d_pretrained_model" / "model.pt",
        BUNDLE_DIR / "models" / "model.pt",
    ):
        notes.append("staged models/model.pt")
    return notes


def _mean_dice_accepts_num_classes() -> bool:
    try:
        from monai.handlers import MeanDice
    except Exception:
        return True
    return "num_classes" in inspect.signature(MeanDice).parameters


def metric_compat_config_stack() -> list[str]:
    """Return metric-compat config files only when the runtime needs them."""
    if _mean_dice_accepts_num_classes():
        return []
    return [
        write_config(
            "mean_dice_no_num_classes.json",
            {
                "validate#key_metric#val_mean_dice": {
                    "_target_": "MeanDice",
                    "include_background": False,
                    "output_transform": "$monai.handlers.from_engine(['pred', 'label'])",
                }
            },
        )
    ]


def write_config(name: str, payload: dict) -> str:
    """Write a bundle config under configs/ and return its MONAI stack path."""
    cfg = BUNDLE_DIR / "configs" / name
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps(payload, indent=2))
    return f"configs/{name}"


# --- environment + plan -----------------------------------------------------


def detect_env() -> dict:
    try:
        rows = (
            subprocess.check_output(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total,memory.free",
                    "--format=csv,noheader,nounits",
                ],
                text=True,
                stderr=subprocess.DEVNULL,
            )
            .strip()
            .splitlines()
        )
        n = len(rows)
        name, total, free = (x.strip() for x in rows[0].split(","))
        gpu_name, total_mb, free_mb = name, int(total), int(free)
    except (FileNotFoundError, subprocess.CalledProcessError, IndexError):
        n, gpu_name, total_mb, free_mb = 0, "cpu", 0, 0
    try:
        with open("/proc/meminfo") as f:
            ram_mb = int(next(line for line in f if line.startswith("MemTotal")).split()[1]) // int(
                "1024"
            )
    except (OSError, StopIteration):
        ram_mb = 0
    packages: dict[str, str | None] = {}
    for package in ("monai", "torch", "nibabel", "scipy", "typer", "PyYAML"):
        try:
            packages[package] = package_version(package)
        except PackageNotFoundError:
            packages[package] = None
    try:
        import torch  # type: ignore

        torch_cuda = torch.version.cuda
        torch_cuda_available = bool(torch.cuda.is_available())
    except Exception:
        torch_cuda = None
        torch_cuda_available = False
    return {
        "gpu_count": n,
        "gpu_name": gpu_name,
        "gpu_total_mb": total_mb,
        "gpu_free_mb": free_mb,
        "host_ram_mb": ram_mb,
        "cuda_available": n > 0,
        "python": sys.version.split()[0],
        "packages": packages,
        "torch_cuda": torch_cuda,
        "torch_cuda_available": torch_cuda_available,
    }


def pick_patch(free_mb: int) -> list[int]:
    for ceiling, patch in PATCH_LADDER:
        if free_mb < ceiling:
            return patch
    return PATCH_LADDER[-1][1]


def pick_cache_rate(n_train: int, ram_mb: int) -> float:
    if n_train <= 0 or ram_mb <= 0:
        return float("0.1")
    return round(max(0.0, min(1.0, ram_mb * float("0.25") / (n_train * int("50")))), 2)


def pick_nproc(gpu_count: int) -> int:
    override = os.environ.get("NPROC_PER_NODE")
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            pass
    return max(1, gpu_count)


# --- dataset inspection -----------------------------------------------------


def _strip_nifti(name: str) -> str:
    for s in NIFTI_SUFFIXES:
        if name.endswith(s):
            return name[: -len(s)]
    return name


def _list_nifti(d: Path) -> list[Path]:
    out: list[Path] = []
    if d.is_dir():
        for s in NIFTI_SUFFIXES:
            out.extend(p for p in d.glob(f"*{s}") if not p.name.startswith("."))
    return sorted({p.resolve(): None for p in out})


def _resolve_dataset_path(dataset_dir: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else dataset_dir / path


def _audit_volume(img_path: Path, lab_path: Path, user_idx: int, anatomy: Optional[str]) -> dict:
    """Read one image+label pair fully and compute domain-side facts:
    orientation, HU range, spacing, foreground volume in mL, connected-
    component count, plus anatomy-specific bounds checks when known.
    Used on the sampled subset only (cheap per pair, ~1s)."""
    img = nib.load(str(img_path))
    lab = nib.load(str(lab_path))
    img_arr = np.asarray(img.dataobj)
    lab_arr = np.asarray(lab.dataobj).astype(int)
    spacing = tuple(float(z) for z in img.header.get_zooms()[: int("3")])
    vox_mm3 = abs(spacing[0] * spacing[1] * spacing[2])
    fg = lab_arr == user_idx
    fg_vox = int(fg.sum())
    fg_ml = round(fg_vox * vox_mm3 / float("1000.0"), 1)
    n_components = 0
    if fg_vox > 0:
        _, n_components = ndi.label(fg)
    img_min, img_max = float(img_arr.min()), float(img_arr.max())
    out = {
        "case": img_path.name,
        "orientation_code": "".join(nib.orientations.aff2axcodes(img.affine)),
        "spacing_mm": [round(s, int("4")) for s in spacing],
        "voxel_volume_mm3": round(vox_mm3, int("4")),
        "image_dtype": str(img_arr.dtype),
        "image_hu_min": img_min,
        "image_hu_max": img_max,
        "image_hu_looks_like_ct": img_min < -int("500") and img_max > 0,
        "label_dtype": str(lab_arr.dtype),
        "fg_voxels": fg_vox,
        "fg_volume_ml": fg_ml,
        "fg_components": int(n_components),
    }
    if anatomy:
        key = anatomy.strip().lower()
        if key in ANATOMY_VOLUME_ML:
            lo, hi = ANATOMY_VOLUME_ML[key]
            out["anatomy_volume_in_range"] = lo <= fg_ml <= hi
            out["anatomy_volume_expected_ml"] = [lo, hi]
        if key in ANATOMY_EXPECTED_COMPONENTS:
            out["anatomy_components_match"] = n_components == ANATOMY_EXPECTED_COMPONENTS[key]
            out["anatomy_components_expected"] = ANATOMY_EXPECTED_COMPONENTS[key]
    return out


def inspect_and_build_datalist(
    dataset_dir: Path,
    output_dir: Path,
    user_label_idx: int,
    anatomy: Optional[str] = None,
) -> tuple[Path, dict]:
    """Pair imagesTr/* with labelsTr/*, verify every pair, write 5-fold datalist."""
    images = _list_nifti(dataset_dir / "imagesTr")
    if not images:
        raise typer.BadParameter(
            f"expected NIfTI under {dataset_dir}/imagesTr + labelsTr (MSD layout)"
        )
    pairs, bad = [], []
    shapes, spacings, max_drift = set(), [], 0.0
    for img_p in images:
        stem = _strip_nifti(img_p.name)
        lab_p = next(
            (
                dataset_dir / "labelsTr" / f"{stem}{s}"
                for s in NIFTI_SUFFIXES
                if (dataset_dir / "labelsTr" / f"{stem}{s}").exists()
            ),
            None,
        )
        if lab_p is None:
            bad.append({"image": img_p.name, "reason": "no matching label"})
            continue
        try:
            img, lab = nib.load(str(img_p)), nib.load(str(lab_p))
        except Exception as e:
            bad.append({"image": img_p.name, "reason": f"nib.load: {e}"})
            continue
        if tuple(img.shape) != tuple(lab.shape):
            bad.append(
                {
                    "image": img_p.name,
                    "reason": f"shape {tuple(img.shape)} vs {tuple(lab.shape)}",
                }
            )
            continue
        drift = float(np.max(np.abs(np.asarray(img.affine) - np.asarray(lab.affine))))
        if drift > float("1e-3"):
            bad.append({"image": img_p.name, "reason": f"affine drift {drift:.4g}"})
            continue
        max_drift = max(max_drift, drift)
        shapes.add(tuple(img.shape))
        spacings.append(tuple(float(z) for z in img.header.get_zooms()[: int("3")]))
        pairs.append(
            {
                "image": str(img_p.relative_to(dataset_dir)),
                "label": str(lab_p.relative_to(dataset_dir)),
            }
        )
    if not pairs:
        raise typer.BadParameter(f"no valid pairs; first bad: {bad[:3]}")

    # Per-volume domain audit on a sample (orientation, HU range, foreground
    # volume, components, anatomy bounds). Cheap: ~1s per case.
    sampled = []
    seen_labels: set[int] = set()
    for p in pairs[: min(int("5"), len(pairs))]:
        img_p, lab_p = dataset_dir / p["image"], dataset_dir / p["label"]
        seen_labels.update(int(v) for v in np.unique(np.asarray(nib.load(str(lab_p)).dataobj)))
        sampled.append(_audit_volume(img_p, lab_p, user_label_idx, anatomy))
    orient_codes = sorted({s["orientation_code"] for s in sampled})

    split_pairs = list(pairs)
    random.Random(0).shuffle(split_pairs)
    for i, item in enumerate(split_pairs):
        item["fold"] = i % int("5")
    path = output_dir / "auto_datalist.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"training": split_pairs, "testing": []}, indent=2))

    audit = {
        "dataset_dir": str(dataset_dir),
        "datalist_source": "auto",
        "datalist_path": str(path),
        "n_pairs": len(split_pairs),
        "n_folds": int("5"),
        "fold_assignment": "random_seed_0_round_robin",
        "shape_consistent": len(shapes) == 1,
        "spacing_range": (
            (
                [round(min(c), int("4")) for c in zip(*spacings)],
                [round(max(c), int("4")) for c in zip(*spacings)],
            )
            if spacings
            else None
        ),
        "affine_max_drift_max": round(max_drift, int("6")),
        "label_uniques_sampled": sorted(seen_labels),
        "user_label_idx": user_label_idx,
        "user_label_idx_present_in_sample": user_label_idx in seen_labels,
        "bad_pairs": bad,
        # Aggregated domain checks over the sample.
        "n_sampled_for_domain_checks": len(sampled),
        "orientation_codes_seen": orient_codes,
        "orientation_consistent": len(orient_codes) == 1,
        "image_dtypes_seen": sorted({s["image_dtype"] for s in sampled}),
        "label_dtypes_seen": sorted({s["label_dtype"] for s in sampled}),
        "image_hu_range_seen": (
            [
                min(s["image_hu_min"] for s in sampled),
                max(s["image_hu_max"] for s in sampled),
            ]
            if sampled
            else None
        ),
        "image_looks_like_ct": all(s["image_hu_looks_like_ct"] for s in sampled),
        "fg_volumes_ml_seen": [s["fg_volume_ml"] for s in sampled],
        "fg_components_seen": [s["fg_components"] for s in sampled],
        "anatomy": anatomy,
        "anatomy_volume_all_in_range": (
            all(s.get("anatomy_volume_in_range") for s in sampled)
            if anatomy and any("anatomy_volume_in_range" in s for s in sampled)
            else None
        ),
        "anatomy_components_all_match": (
            all(s.get("anatomy_components_match") for s in sampled)
            if anatomy and any("anatomy_components_match" in s for s in sampled)
            else None
        ),
        "per_sample": sampled,
    }
    return path, audit


def audit_existing_datalist(
    dataset_dir: Path,
    datalist: Path,
    user_label_idx: int,
    anatomy: Optional[str] = None,
) -> dict:
    """Audit a caller-provided datalist without rewriting its split."""
    data = json.loads(datalist.read_text())
    entries = list(data.get("training", []))
    bad: list[dict] = []
    shapes, spacings, max_drift = set(), [], 0.0
    sampled = []
    seen_labels: set[int] = set()

    for idx, item in enumerate(entries):
        img_raw, lab_raw = item.get("image"), item.get("label")
        if not isinstance(img_raw, str) or not isinstance(lab_raw, str):
            bad.append({"index": idx, "reason": "missing image or label path"})
            continue
        img_p = _resolve_dataset_path(dataset_dir, img_raw)
        lab_p = _resolve_dataset_path(dataset_dir, lab_raw)
        if not img_p.exists() or not lab_p.exists():
            bad.append(
                {
                    "index": idx,
                    "image": img_raw,
                    "label": lab_raw,
                    "reason": "image or label file missing",
                }
            )
            continue
        try:
            img, lab = nib.load(str(img_p)), nib.load(str(lab_p))
        except Exception as e:
            bad.append({"index": idx, "image": img_raw, "reason": f"nib.load: {e}"})
            continue
        if tuple(img.shape) != tuple(lab.shape):
            bad.append(
                {
                    "index": idx,
                    "image": img_raw,
                    "reason": f"shape {tuple(img.shape)} vs {tuple(lab.shape)}",
                }
            )
            continue
        drift = float(np.max(np.abs(np.asarray(img.affine) - np.asarray(lab.affine))))
        if drift > float("1e-3"):
            bad.append({"index": idx, "image": img_raw, "reason": f"affine drift {drift:.4g}"})
            continue
        max_drift = max(max_drift, drift)
        shapes.add(tuple(img.shape))
        spacings.append(tuple(float(z) for z in img.header.get_zooms()[: int("3")]))
        if len(sampled) < int("5"):
            seen_labels.update(int(v) for v in np.unique(np.asarray(nib.load(str(lab_p)).dataobj)))
            sampled.append(_audit_volume(img_p, lab_p, user_label_idx, anatomy))

    orient_codes = sorted({s["orientation_code"] for s in sampled})
    return {
        "dataset_dir": str(dataset_dir),
        "datalist_source": "caller_provided",
        "datalist_path": str(datalist),
        "n_pairs": len(entries),
        "shape_consistent": len(shapes) <= 1,
        "spacing_range": (
            (
                [round(min(c), int("4")) for c in zip(*spacings)],
                [round(max(c), int("4")) for c in zip(*spacings)],
            )
            if spacings
            else None
        ),
        "affine_max_drift_max": round(max_drift, int("6")),
        "label_uniques_sampled": sorted(seen_labels),
        "user_label_idx": user_label_idx,
        "user_label_idx_present_in_sample": user_label_idx in seen_labels,
        "bad_pairs": bad,
        "n_sampled_for_domain_checks": len(sampled),
        "orientation_codes_seen": orient_codes,
        "orientation_consistent": len(orient_codes) <= 1,
        "image_dtypes_seen": sorted({s["image_dtype"] for s in sampled}),
        "label_dtypes_seen": sorted({s["label_dtype"] for s in sampled}),
        "image_hu_range_seen": (
            [
                min(s["image_hu_min"] for s in sampled),
                max(s["image_hu_max"] for s in sampled),
            ]
            if sampled
            else None
        ),
        "image_looks_like_ct": (
            all(s["image_hu_looks_like_ct"] for s in sampled) if sampled else False
        ),
        "fg_volumes_ml_seen": [s["fg_volume_ml"] for s in sampled],
        "fg_components_seen": [s["fg_components"] for s in sampled],
        "anatomy": anatomy,
        "anatomy_volume_all_in_range": (
            all(s.get("anatomy_volume_in_range") for s in sampled)
            if anatomy and any("anatomy_volume_in_range" in s for s in sampled)
            else None
        ),
        "anatomy_components_all_match": (
            all(s.get("anatomy_components_match") for s in sampled)
            if anatomy and any("anatomy_components_match" in s for s in sampled)
            else None
        ),
        "per_sample": sampled,
    }


def ensure_smoke_dataset(
    dataset_dir: Path, datalist: Path, output_dir: Path
) -> tuple[Path, Path, bool]:
    """Materialize synthetic smoke NIfTIs when the fixture ships only a datalist."""
    data = json.loads(datalist.read_text())
    entries = list(data.get("training", []))
    missing = []
    for item in entries:
        image = item.get("image")
        label = item.get("label")
        if not isinstance(image, str) or not isinstance(label, str):
            continue
        if not _resolve_dataset_path(dataset_dir, image).exists():
            missing.append(image)
        if not _resolve_dataset_path(dataset_dir, label).exists():
            missing.append(label)

    if not missing:
        return dataset_dir, datalist, False

    work_dir = output_dir / "smoke_dataset"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    (work_dir / "imagesTr").mkdir(parents=True, exist_ok=True)
    (work_dir / "labelsTr").mkdir(parents=True, exist_ok=True)

    shape = (int("64"), int("64"), int("64"))
    grid = np.indices(shape)
    center = np.array(shape, dtype=float) / float("2")
    radius = float("12")
    affine = np.diag([float("1"), float("1"), float("1"), float("1")])

    for idx, item in enumerate(entries):
        image = item.get("image")
        label = item.get("label")
        if not isinstance(image, str) or not isinstance(label, str):
            continue
        shift = np.array([idx % 2, (idx // 2) % 2, idx % 3], dtype=float) * float("2")
        dist = np.sqrt(
            ((grid - (center[:, None, None, None] + shift[:, None, None, None])) ** 2).sum(axis=0)
        )
        label_arr = (dist <= radius).astype(np.uint8)
        image_arr = np.full(shape, -900.0, dtype=np.float32)
        image_arr[label_arr > 0] = 80.0 + float(idx)
        image_arr += np.random.default_rng(idx).normal(0.0, 5.0, size=shape).astype(np.float32)

        image_path = work_dir / image
        label_path = work_dir / label
        image_path.parent.mkdir(parents=True, exist_ok=True)
        label_path.parent.mkdir(parents=True, exist_ok=True)
        nib.save(nib.Nifti1Image(image_arr, affine), str(image_path))
        nib.save(nib.Nifti1Image(label_arr, affine), str(label_path))

    staged_datalist = work_dir / "datalist.json"
    staged_datalist.write_text(json.dumps(data, indent=2))
    return work_dir, staged_datalist, True


def resolve_mapping(
    target_anatomy: Optional[str], user_idx: int, literal: Optional[str]
) -> tuple[dict, dict]:
    if literal:
        m = json.loads(literal)
        return {"default": m}, {"source": "literal", "value": m}
    if not target_anatomy:
        raise typer.BadParameter("pass --target-anatomy or --label-mapping")
    if not LABEL_DICT.exists():
        raise typer.BadParameter(
            f"label_dict.json missing at {LABEL_DICT}; "
            f"run `hf download nvidia/NV-Segment-CT` first"
        )
    d = {
        str(k).strip().lower(): int(v)
        for k, v in json.loads(LABEL_DICT.read_text()).items()
        if isinstance(v, int)
    }
    key = target_anatomy.strip().lower()
    if key not in d:
        raise typer.BadParameter(
            f"{target_anatomy!r} not in label_dict.json; "
            f"closest: {[k for k in d if key in k][:10]}"
        )
    return (
        {"default": [[user_idx, d[key]]]},
        {
            "source": "anatomy_lookup",
            "anatomy": target_anatomy,
            "user_idx": user_idx,
            "vista3d_idx": d[key],
        },
    )


# --- bundle run + log parse -------------------------------------------------


def build_override(
    dataset_dir: Path,
    datalist: Path,
    mapping: dict,
    patch: list[int],
    cache_rate: float,
    epochs: int,
    lr: float,
    ckpt_dir: Path,
    train_output_dir: Path,
    auto_seg: bool = False,
) -> dict:
    """Compose the JSON override layered on top of train.json + train_continual.json.

    `auto_seg=True` mirrors the published MSD06 lung-tumor tutorial:
    `drop_label_prob=0.0, drop_point_prob=1.0` forces automatic segmentation
    (no point prompts during training), and `resample_to_spacing` is pinned
    to the tutorial's 1.5 mm isotropic. Default leaves both prompt
    probabilities at the bundle's mixed-prompt training values.
    """
    override = {
        "dataset_dir": str(dataset_dir),
        "data_list_file_path": str(datalist),
        "image_key": "image",
        "label_key": "label",
        "finetune": True,
        "finetune_model_path": str(BUNDLE_DIR / "models" / "model.pt"),
        "ckpt_dir": str(ckpt_dir),
        "output_dir": str(train_output_dir),
        "patch_size": patch,
        "patch_size_valid": patch,
        "label_mappings": mapping,
        "epochs": epochs,
        "val_interval": 1,
        "val_at_start": True,
        "learning_rate": lr,
        "lr_schedule#activate": False,
        "train_dataset_cache_rate": cache_rate,
        "val_dataset_cache_rate": cache_rate,
    }
    if auto_seg:
        override.update(
            {
                "drop_label_prob": 0.0,
                "drop_point_prob": 1.0,
                "resample_to_spacing": tuple(float(x) for x in ("1.5", "1.5", "1.5")),
            }
        )
    return override


def _config_arg(stack: list[str]) -> str:
    cfg_arg = "[" + ",".join(f"'{s}'" for s in stack) + "]"
    return cfg_arg


def _peak_gpu_mb(gpu_csv: Path) -> int:
    peak = 0
    if not gpu_csv.exists():
        return peak
    for line in gpu_csv.read_text().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if not parts:
            continue
        try:
            peak = max(peak, int(parts[-1]))
        except ValueError:
            pass
    return peak


def run_monai_bundle(
    stack: list[str],
    log_path: Path,
    *,
    multi_gpu: bool = False,
    nproc: int = 1,
    extra_args: Optional[list[str]] = None,
    force_single_gpu: bool = False,
) -> tuple[int, int, list[str]]:
    cfg_arg = _config_arg(stack)
    if multi_gpu:
        cmd = [
            "torchrun",
            "--nnodes=1",
            f"--nproc_per_node={nproc}",
            "-m",
            "monai.bundle",
            "run",
            "--config_file",
            cfg_arg,
            "--bundle_root",
            str(BUNDLE_DIR),
        ]
    else:
        cmd = [
            sys.executable,
            "-m",
            "monai.bundle",
            "run",
            "--config_file",
            cfg_arg,
            "--bundle_root",
            str(BUNDLE_DIR),
        ]
    if extra_args:
        cmd.extend(extra_args)

    log_path.parent.mkdir(parents=True, exist_ok=True)
    gpu_csv = log_path.with_suffix(".gpu.csv")
    smi = None
    smi_out = None
    if subprocess.run(["which", "nvidia-smi"], capture_output=True).returncode == 0:
        smi_cmd = [
            "nvidia-smi",
            "--query-gpu=timestamp,index,memory.used",
            "--format=csv,noheader,nounits",
            "-l",
            "1",
        ]
        if force_single_gpu:
            smi_cmd[1:1] = ["-i", "0"]
        smi_out = open(gpu_csv, "w")
        smi = subprocess.Popen(smi_cmd, stdout=smi_out, stderr=subprocess.DEVNULL)
    try:
        env = os.environ.copy()
        if force_single_gpu and "CUDA_VISIBLE_DEVICES" not in env:
            env["CUDA_VISIBLE_DEVICES"] = "0"
        with open(log_path, "w") as f:
            rc = subprocess.call(cmd, cwd=BUNDLE_DIR, stdout=f, stderr=subprocess.STDOUT, env=env)
    finally:
        if smi is not None:
            smi.terminate()
            try:
                smi.wait(timeout=int("3"))
            except subprocess.TimeoutExpired:
                smi.kill()
        if smi_out is not None:
            smi_out.close()
    return rc, _peak_gpu_mb(gpu_csv), cmd


_LOSS = re.compile(r"train_loss:\s*([0-9.eE+-]+)")
_DICE = re.compile(r"val_mean_dice:\s*([0-9.eE+-]+)")
_OOM = re.compile(r"CUDA out of memory|OutOfMemoryError")


def parse_log(log_path: Path) -> dict:
    text = log_path.read_text() if log_path.exists() else ""
    losses = [float(m.group(1)) for m in _LOSS.finditer(text)]
    dices = [float(m.group(1)) for m in _DICE.finditer(text)]
    best = max(dices) if dices else None
    return {
        "train_loss_first": losses[0] if losses else None,
        "train_loss_last": losses[-1] if losses else None,
        "train_loss_finite": (
            all(loss == loss and abs(loss) != float("inf") for loss in losses) if losses else False
        ),
        "val_dice_per_epoch": dices,
        "baseline_val_dice": dices[0] if dices else None,
        "best_val_dice": best,
        "best_epoch_index": dices.index(best) if best is not None else None,
        "oom": bool(_OOM.search(text)),
        "log_tail": text.splitlines()[-int("25") :],
    }


def read_val_mean_dice(metrics_dir: Path) -> float | None:
    metrics_csv = metrics_dir / "metrics.csv"
    if not metrics_csv.exists():
        return None
    for line in metrics_csv.read_text().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[0] == "val_mean_dice":
            try:
                return float(parts[1])
            except ValueError:
                return None
    return None


def _extract_state_dict(obj: object) -> dict | None:
    if not isinstance(obj, dict):
        return None
    values = list(obj.values())
    if values and all(hasattr(v, "shape") for v in values):
        return obj
    for key in ("state_dict", "model", "network"):
        child = obj.get(key)
        if isinstance(child, dict):
            return child
    return None


def compare_checkpoint_weights(reference: Path, candidate: Path) -> dict:
    """Compare checkpoint tensors, not file bytes.

    MONAI/Ignite can reserialize identical weights into a different file, so
    sha256 alone is insufficient for detecting the epoch-0 checkpoint trap.
    """
    out = {
        "reference": str(reference),
        "candidate": str(candidate),
        "compared": False,
        "weights_identical": None,
    }
    if not reference.exists() or not candidate.exists():
        out["error"] = "reference or candidate checkpoint missing"
        return out
    try:
        import torch  # type: ignore

        ref_obj = torch.load(reference, map_location="cpu", weights_only=False)
        cand_obj = torch.load(candidate, map_location="cpu", weights_only=False)
        ref_state = _extract_state_dict(ref_obj)
        cand_state = _extract_state_dict(cand_obj)
        if ref_state is None or cand_state is None:
            out["error"] = "could not extract tensor state dict"
            return out
        ref_keys = set(ref_state)
        cand_keys = set(cand_state)
        shared_keys = sorted(ref_keys & cand_keys)
        differing_tensors = 0
        shape_or_dtype_mismatches = 0
        tensor_count = 0
        max_abs_diff = 0.0
        total_abs_diff = 0.0
        examples: list[dict] = []
        for key in shared_keys:
            ref_value = ref_state[key]
            cand_value = cand_state[key]
            if not (torch.is_tensor(ref_value) and torch.is_tensor(cand_value)):
                continue
            tensor_count += 1
            if ref_value.shape != cand_value.shape or ref_value.dtype != cand_value.dtype:
                shape_or_dtype_mismatches += 1
                if len(examples) < 5:
                    examples.append(
                        {
                            "key": key,
                            "reference_shape": list(ref_value.shape),
                            "candidate_shape": list(cand_value.shape),
                            "reference_dtype": str(ref_value.dtype),
                            "candidate_dtype": str(cand_value.dtype),
                        }
                    )
                continue
            if torch.equal(ref_value, cand_value):
                continue
            differing_tensors += 1
            diff = (ref_value.float() - cand_value.float()).abs()
            tensor_max = float(diff.max().item()) if diff.numel() else 0.0
            tensor_sum = float(diff.sum().item()) if diff.numel() else 0.0
            max_abs_diff = max(max_abs_diff, tensor_max)
            total_abs_diff += tensor_sum
            if len(examples) < 5:
                examples.append(
                    {
                        "key": key,
                        "shape": list(ref_value.shape),
                        "max_abs_diff": tensor_max,
                        "sum_abs_diff": tensor_sum,
                    }
                )
        missing = sorted(ref_keys - cand_keys)
        extra = sorted(cand_keys - ref_keys)
        weights_identical = (
            not missing and not extra and shape_or_dtype_mismatches == 0 and differing_tensors == 0
        )
        out.update(
            {
                "compared": True,
                "same_keys": not missing and not extra,
                "missing_keys_count": len(missing),
                "extra_keys_count": len(extra),
                "tensor_count": tensor_count,
                "differing_tensors": differing_tensors,
                "shape_or_dtype_mismatches": shape_or_dtype_mismatches,
                "max_abs_diff": max_abs_diff,
                "total_abs_diff": total_abs_diff,
                "weights_identical": weights_identical,
                "examples": examples,
            }
        )
    except Exception as exc:
        out["error"] = str(exc)
    return out


def sanity_reference_checks(
    *,
    formal_pretrained: float | None,
    formal_finetuned: float | None,
    formal_improvement: float | None,
    training_start: float | None,
    training_best: float | None,
    training_improvement: float | None,
    best_checkpoint_changed: bool | None,
    overall_rc: int,
) -> dict:
    thresholds = SANITY_REFERENCE_THRESHOLDS
    checks = {
        "return_code_ok": overall_rc == 0,
        "formal_pretrained_val_dice_ok": (
            formal_pretrained is not None
            and formal_pretrained >= thresholds["formal_pretrained_val_dice_min"]
        ),
        "formal_finetuned_val_dice_ok": (
            formal_finetuned is not None
            and formal_finetuned >= thresholds["formal_finetuned_val_dice_min"]
        ),
        "formal_improvement_ok": (
            formal_improvement is not None
            and formal_improvement >= thresholds["formal_improvement_min"]
        ),
        "training_start_val_dice_ok": (
            training_start is not None
            and training_start >= thresholds["training_start_val_dice_min"]
        ),
        "training_best_val_dice_ok": (
            training_best is not None and training_best >= thresholds["training_best_val_dice_min"]
        ),
        "training_improvement_ok": (
            training_improvement is not None
            and training_improvement >= thresholds["training_improvement_min"]
        ),
        "best_checkpoint_changed_ok": best_checkpoint_changed is True,
    }
    failed = [name for name, ok in checks.items() if not ok]
    return {
        "thresholds": thresholds,
        "checks": checks,
        "failed_checks": failed,
        "passed": not failed,
    }


# --- CLI --------------------------------------------------------------------


@app.command()
def main(
    fixture: Optional[Path] = typer.Argument(
        None,
        help=(
            "Optional positional fixture path. The eval_engine harness calls "
            "the script as `python run_finetune.py <fixture>`; this argument "
            "lets the wrapper auto-pick the preset from the fixture's "
            "basename: `spleen_micro` -> --smoke, `Task06_Lung` -> --sanity, "
            "any other directory -> treated as --dataset-dir. Explicit flags "
            "(--smoke / --sanity / --dataset-dir) still win when given."
        ),
    ),
    dataset_dir: Optional[Path] = typer.Option(
        None, "--dataset-dir", help="Root containing imagesTr/ and labelsTr/."
    ),
    datalist: Optional[Path] = typer.Option(
        None,
        "--datalist",
        help="MONAI-bundle datalist JSON. Optional; auto-built when omitted.",
    ),
    target_anatomy: Optional[str] = typer.Option(
        None,
        "--target-anatomy",
        help="Anatomy name resolved against bundle/label_dict.json.",
    ),
    user_label_idx: int = typer.Option(
        1,
        "--user-label-idx",
        help="Label index that --target-anatomy occupies in the user's datalist.",
    ),
    label_mapping: Optional[str] = typer.Option(
        None,
        "--label-mapping",
        help="Literal `[[user_idx, vista3d_idx], ...]`. Overrides --target-anatomy.",
    ),
    epochs: Optional[int] = typer.Option(
        None,
        "--epochs",
        help="Override preset epochs (finetune=50, sanity=5, smoke=2).",
    ),
    patch_size: Optional[str] = typer.Option(
        None, "--patch-size", help="JSON list. Overrides auto-derived patch size."
    ),
    cache_rate: Optional[float] = typer.Option(None, "--cache-rate"),
    learning_rate: Optional[float] = typer.Option(
        None,
        "--learning-rate",
        help="Default and --sanity: 5e-5 (matches the MSD06 lung-tumor tutorial).",
    ),
    output_dir: Path = typer.Option(
        Path("runs") / time.strftime("finetune_%Y%m%d_%H%M%S"), "--output-dir"
    ),
    smoke: bool = typer.Option(
        False,
        "--smoke",
        help="1 iter on bundled spleen_micro fixture (plumbing oracle).",
    ),
    sanity: bool = typer.Option(
        False,
        "--sanity",
        help="Tutorial-recipe verification on cached MSD06 Lung Tumor.",
    ),
    auto_seg: bool = typer.Option(
        False,
        "--auto-seg",
        help="Use automatic class-prompt training: drop_label_prob=0.0, drop_point_prob=1.0.",
    ),
    skip_formal_eval: bool = typer.Option(
        False,
        "--skip-formal-eval",
        help="Skip evaluate.json before/after scoring. Smoke always skips it.",
    ),
) -> None:
    """Auto-configure and run the VISTA3D continual-learning finetune.

    \b
    Presets:
      --smoke   synthetic plumbing, 4 cases x 1 iter.
      --sanity  Real-recipe verification on MSD06 Lung Tumor - mirrors the
                published DFW tutorial: label mapping [[1, 23]], 5 epochs,
                lr=5e-5, patch [128,128,128], resample 1.5 mm isotropic,
                drop_label_prob=0.0, drop_point_prob=1.0, single GPU, and
                original-spacing evaluate.json scores before/after finetune.
      default   user dataset under --dataset-dir, lr=5e-5, 50 epochs.

    The skill is built for "user brings their own dataset" (MSD layout:
    `imagesTr/` + `labelsTr/` with matching basenames). MSD06 lung tumor is
    the canonical sanity dataset.
    """
    t0 = time.perf_counter()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    timings: dict[str, float] = {}
    t_phase = time.perf_counter()

    maybe_reexec_compatible_runtime()
    require_compatible_runtime()
    require_bundle_files()

    # Fixture-driven preset detection. Only consulted when no explicit
    # mode flag was passed, so callers retain full control. eval_engine's
    # default args template is [python, script, fixture], which hits this
    # path; humans tend to call the script with --smoke / --sanity directly.
    if fixture is not None and not smoke and not sanity and dataset_dir is None:
        fixture = fixture.resolve()
        preset = _fixture_preset(fixture)
        if preset == "smoke":
            smoke = True
        elif preset == "sanity":
            sanity = True
        elif fixture.is_dir():
            dataset_dir = fixture

    # Preset selection - fill in dataset + defaults.
    smoke_generated_dataset = False
    if smoke:
        if fixture is not None and fixture.is_dir():
            dataset_dir = fixture.resolve()
        else:
            dataset_dir = SMOKE_FIXTURE
        datalist = dataset_dir / "datalist.json"
        dataset_dir, datalist, smoke_generated_dataset = ensure_smoke_dataset(
            dataset_dir, datalist, output_dir
        )
        target_anatomy = target_anatomy or "spleen"
    elif sanity:
        dataset_dir = _resolve_sanity_dataset(fixture, dataset_dir)
        if not dataset_dir.is_dir():
            raise typer.BadParameter(
                f"--sanity needs an MSD06 Lung Tumor dataset directory; tried {dataset_dir}\n"
                f"Pass the DFW/MSD Task06 path positionally, pass --dataset-dir, "
                f"or populate {SANITY_DATASET}."
            )
        target_anatomy = target_anatomy or SANITY_ANATOMY
        if epochs is None:
            epochs = int("5")
        if learning_rate is None:
            learning_rate = float("5e-5")
        if patch_size is None:
            patch_size = "[128,128,128]"
        if cache_rate is None:
            cache_rate = 1.0
        auto_seg = True
    if dataset_dir is None:
        raise typer.BadParameter("--dataset-dir required (or use --sanity / --smoke).")
    if not dataset_dir.is_dir():
        raise typer.BadParameter(f"dataset_dir does not exist: {dataset_dir}")
    if learning_rate is None:
        learning_rate = float("5e-5")

    env = detect_env()
    mapping, mapping_src = resolve_mapping(target_anatomy, user_label_idx, label_mapping)
    timings["env_detect"] = time.perf_counter() - t_phase
    t_phase = time.perf_counter()

    # Build or load the datalist. --sanity uses the same MSD-layout
    # auto-build as user datasets (the tutorial's seed-0 5-fold split is
    # what inspect_and_build_datalist already produces for MSD06 Lung Tumor).
    if datalist is None:
        datalist, dataset_audit = inspect_and_build_datalist(
            dataset_dir,
            output_dir,
            user_label_idx=user_label_idx,
            anatomy=target_anatomy,
        )
    else:
        if not datalist.is_file():
            raise typer.BadParameter(f"datalist not found: {datalist}")
        if smoke:
            dataset_audit = {
                "dataset_dir": str(dataset_dir),
                "datalist_source": "caller_provided",
                "datalist_path": str(datalist),
                "smoke_generated_dataset": smoke_generated_dataset,
            }
        else:
            dataset_audit = audit_existing_datalist(
                dataset_dir,
                datalist,
                user_label_idx=user_label_idx,
                anatomy=target_anatomy,
            )

    timings["dataset_audit"] = time.perf_counter() - t_phase
    t_phase = time.perf_counter()

    n_train = len(json.loads(datalist.read_text()).get("training", []))
    dataset_audit.setdefault("n_pairs", n_train)
    plan_patch = json.loads(patch_size) if patch_size else pick_patch(env["gpu_free_mb"])
    plan_cache = (
        cache_rate if cache_rate is not None else pick_cache_rate(n_train, env["host_ram_mb"])
    )
    plan_epochs = (
        epochs if epochs is not None else (2 if smoke else int("5") if sanity else int("50"))
    )
    formal_eval = bool(not smoke and not skip_formal_eval)
    force_single_gpu = bool(smoke or sanity)
    nproc = 1 if force_single_gpu else pick_nproc(env["gpu_count"])
    multi_gpu = (not force_single_gpu) and nproc >= 2 and env["cuda_available"]
    ckpt_dir = output_dir / "checkpoints"
    train_output_dir = output_dir / "val_during_train"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    train_output_dir.mkdir(parents=True, exist_ok=True)

    plan = {
        "patch_size": plan_patch,
        "train_dataset_cache_rate": plan_cache,
        "epochs": plan_epochs,
        "learning_rate": learning_rate,
        "nproc_per_node": nproc,
        "multi_gpu": multi_gpu,
        "formal_eval": formal_eval,
        "auto_seg": auto_seg,
        "force_single_gpu": force_single_gpu,
        "preset": "smoke" if smoke else "sanity" if sanity else "finetune",
        "rationale": [
            f"patch_size={plan_patch} (chose for free GPU={env['gpu_free_mb']} MiB)",
            f"cache_rate={plan_cache} (RAM={env['host_ram_mb']} MiB, n_train={n_train})",
            f"epochs={plan_epochs}",
            f"learning_rate={learning_rate}",
            f"nproc_per_node={nproc}",
            ("automatic class-prompt training" if auto_seg else "bundle prompt-mix training"),
            (
                "single-gpu DFW Task06 recipe"
                if sanity
                else "single-gpu smoke preset" if smoke else "host GPU policy"
            ),
        ],
    }

    override = build_override(
        dataset_dir,
        datalist,
        mapping,
        plan_patch,
        plan_cache,
        plan_epochs,
        learning_rate,
        ckpt_dir,
        train_output_dir,
        auto_seg=auto_seg,
    )
    override_file = (
        write_config("train_continual_task06_lung.json", override)
        if sanity
        else write_config("auto_override.json", override)
    )
    no_logging_file = write_config(
        "dfw_no_logging.json",
        {"use_mlflow": False, "use_tensorboard": False},
    )
    metric_compat_files = metric_compat_config_stack()

    train_stack = ["configs/train.json", "configs/train_continual.json"]
    if multi_gpu:
        train_stack.append("configs/multi_gpu_train.json")
    train_stack.extend([override_file, no_logging_file, *metric_compat_files])
    eval_stack = [
        "configs/train.json",
        "configs/train_continual.json",
        "configs/evaluate.json",
        override_file,
        no_logging_file,
        *metric_compat_files,
    ]

    timings["plan"] = time.perf_counter() - t_phase
    t_phase = time.perf_counter()

    pretrained = BUNDLE_DIR / "models" / "model.pt"
    formal_pretrained = None
    formal_finetuned = None
    formal_pre_rc = None
    formal_post_rc = None
    formal_pre_cmd: list[str] | None = None
    formal_post_cmd: list[str] | None = None
    phase_peaks: dict[str, int] = {}

    if formal_eval:
        pre_eval_dir = output_dir / "eval_pretrained"
        pre_eval_dir.mkdir(parents=True, exist_ok=True)
        pre_log = output_dir / "eval_pretrained.log"
        formal_pre_rc, pre_peak, formal_pre_cmd = run_monai_bundle(
            eval_stack,
            pre_log,
            force_single_gpu=True,
            extra_args=[
                "--ckpt_path",
                str(pretrained),
                "--output_dir",
                str(pre_eval_dir),
            ],
        )
        phase_peaks["eval_pretrained"] = pre_peak
        timings["eval_pretrained"] = time.perf_counter() - t_phase
        formal_pretrained = read_val_mean_dice(pre_eval_dir)
        t_phase = time.perf_counter()

    log_path = output_dir / "finetune.log"
    rc, train_peak, cmd = run_monai_bundle(
        train_stack,
        log_path,
        multi_gpu=multi_gpu,
        nproc=nproc,
        force_single_gpu=force_single_gpu,
    )
    phase_peaks["finetune"] = train_peak
    metrics = parse_log(log_path)
    timings["bundle_run"] = time.perf_counter() - t_phase

    finetune_ckpt = ckpt_dir / "model_finetune.pt"

    if formal_eval and rc == 0 and finetune_ckpt.exists():
        t_phase = time.perf_counter()
        post_eval_dir = output_dir / "eval_finetuned"
        post_eval_dir.mkdir(parents=True, exist_ok=True)
        post_log = output_dir / "eval_finetuned.log"
        formal_post_rc, post_peak, formal_post_cmd = run_monai_bundle(
            eval_stack,
            post_log,
            force_single_gpu=True,
            extra_args=[
                "--ckpt_path",
                str(finetune_ckpt),
                "--output_dir",
                str(post_eval_dir),
            ],
        )
        phase_peaks["eval_finetuned"] = post_peak
        timings["eval_finetuned"] = time.perf_counter() - t_phase
        formal_finetuned = read_val_mean_dice(post_eval_dir)

    checkpoint_comparisons = {
        "best": (
            compare_checkpoint_weights(pretrained, finetune_ckpt)
            if finetune_ckpt.exists()
            else None
        ),
    }
    best_checkpoint_changed = (
        checkpoint_comparisons["best"] is not None
        and checkpoint_comparisons["best"].get("weights_identical") is False
    )

    # Regression gate.
    baseline, best = metrics["baseline_val_dice"], metrics["best_val_dice"]
    formal_improvement = (
        round(formal_finetuned - formal_pretrained, int("4"))
        if formal_finetuned is not None and formal_pretrained is not None
        else None
    )
    formal_regressed = (
        formal_finetuned < formal_pretrained - float("1e-3")
        if formal_finetuned is not None and formal_pretrained is not None
        else None
    )
    formal_improved = (
        formal_finetuned > formal_pretrained + float("1e-3")
        if formal_finetuned is not None and formal_pretrained is not None
        else None
    )
    if baseline is None or best is None:
        regressed = improved = improvement = recommended = None
    else:
        improvement = round(best - baseline, int("4"))
        regressed = best < baseline - float("1e-3")
        improved = best > baseline + float("1e-3")
        recommended = (
            str(finetune_ckpt)
            if (improved and best_checkpoint_changed and finetune_ckpt.exists())
            else str(pretrained)
        )
    if formal_pretrained is not None:
        candidates: list[tuple[float, Path]] = []
        if (
            formal_finetuned is not None
            and formal_finetuned > formal_pretrained + float("1e-3")
            and best_checkpoint_changed
            and finetune_ckpt.exists()
        ):
            candidates.append((formal_finetuned, finetune_ckpt))
        recommended = str(max(candidates)[1]) if candidates else str(pretrained)

    peak_mb = max(phase_peaks.values()) if phase_peaks else 0
    phase_return_codes = {
        "eval_pretrained": formal_pre_rc,
        "finetune": rc,
        "eval_finetuned": formal_post_rc,
    }
    overall_rc = max((v for v in phase_return_codes.values() if v is not None), default=0)
    if sanity and formal_eval:
        sanity_checks = sanity_reference_checks(
            formal_pretrained=formal_pretrained,
            formal_finetuned=formal_finetuned,
            formal_improvement=formal_improvement,
            training_start=baseline,
            training_best=best,
            training_improvement=improvement,
            best_checkpoint_changed=best_checkpoint_changed,
            overall_rc=overall_rc,
        )
        sanity_ok = bool(sanity_checks["passed"])
    else:
        sanity_checks = None
        sanity_ok = (
            bool(baseline is not None and baseline >= float("0.5") and regressed is False)
            if sanity
            else None
        )

    result = {
        "skill": "nv_segment_ct_finetune",
        "model": "NVIDIA-Medtech/NV-Segment-CT (VISTA3D)",
        "model_repo": "https://huggingface.co/nvidia/NV-Segment-CT",
        "version": VERSION,
        "input": {
            "dataset_dir": str(dataset_dir),
            "datalist": str(datalist),
            "n_train_cases": n_train,
            "label_mappings": mapping,
            "label_mapping_resolution": mapping_src,
            "dataset_audit": dataset_audit,
            "smoke": smoke,
            "sanity": sanity,
            "auto_seg": auto_seg,
            "formal_eval": formal_eval,
        },
        "environment": env,
        "plan": plan,
        "invocation": {
            "command": " ".join(shlex.quote(c) for c in cmd),
            "commands": {
                "eval_pretrained": (
                    " ".join(shlex.quote(c) for c in formal_pre_cmd) if formal_pre_cmd else None
                ),
                "finetune": " ".join(shlex.quote(c) for c in cmd),
                "eval_finetuned": (
                    " ".join(shlex.quote(c) for c in formal_post_cmd) if formal_post_cmd else None
                ),
            },
            "command_prefix": (" ".join(cmd[: cmd.index("run") + 1]) if "run" in cmd else cmd[0]),
            "config_stack": train_stack,
            "eval_config_stack": eval_stack if formal_eval else None,
            "phase_return_codes": phase_return_codes,
            "multi_gpu": multi_gpu,
            "cwd": str(BUNDLE_DIR),
            "override_file": override_file,
            "no_logging_file": no_logging_file,
        },
        "output": {
            "finetuned_ckpt": str(finetune_ckpt) if finetune_ckpt.exists() else None,
            "finetuned_ckpt_exists": finetune_ckpt.exists(),
            "pretrained_ckpt": str(pretrained),
            "recommended_ckpt": recommended,
            "checkpoint_comparisons_to_pretrained": checkpoint_comparisons,
            "finetuned_ckpt_matches_pretrained_weights": (
                checkpoint_comparisons["best"].get("weights_identical")
                if checkpoint_comparisons["best"] is not None
                else None
            ),
            "baseline_val_dice": baseline,
            "best_val_dice": best,
            "best_epoch_index": metrics["best_epoch_index"],
            "improvement_over_baseline": improvement,
            "regressed": regressed,
            "improved": improved,
            "training_start_val_dice": baseline,
            "training_best_val_dice": best,
            "training_best_epoch_index": metrics["best_epoch_index"],
            "formal_eval_enabled": formal_eval,
            "formal_pretrained_val_dice": formal_pretrained,
            "formal_finetuned_val_dice": formal_finetuned,
            "formal_improvement_over_pretrained": formal_improvement,
            "formal_regressed": formal_regressed,
            "formal_improved": formal_improved,
            "val_dice_per_epoch": metrics["val_dice_per_epoch"],
            "train_loss_first": metrics["train_loss_first"],
            "train_loss_last": metrics["train_loss_last"],
            "train_loss_finite": metrics["train_loss_finite"],
            "oom": metrics["oom"],
            "sanity_reference_checks": sanity_checks,
            "sanity_recovery_demonstrated": sanity_ok,
        },
        "runtime": {
            "wall_seconds": round(time.perf_counter() - t0, int("3")),
            "peak_gpu_mb": peak_mb,
            "phase_peak_gpu_mb": phase_peaks,
            "return_code": overall_rc,
            "log_path": str(log_path),
            "log_tail": metrics["log_tail"],
        },
        "cost": {
            "steps": [
                {
                    "step": "env_detect",
                    "label": "Step 2: detect GPU + RAM",
                    "seconds": round(timings.get("env_detect", 0.0), int("3")),
                },
                {
                    "step": "dataset_audit",
                    "label": "Step 0: audit inputs + build datalist",
                    "seconds": round(timings.get("dataset_audit", 0.0), int("3")),
                },
                {
                    "step": "plan",
                    "label": "Step 2: compose plan + override",
                    "seconds": round(timings.get("plan", 0.0), int("3")),
                },
                {
                    "step": "eval_pretrained",
                    "label": "Step 4a: evaluate pretrained checkpoint",
                    "seconds": round(timings.get("eval_pretrained", 0.0), int("3")),
                    "peak_gpu_mb": phase_peaks.get("eval_pretrained", 0),
                },
                {
                    "step": "bundle_run",
                    "label": "Step 5: monai.bundle run + log parse",
                    "seconds": round(timings.get("bundle_run", 0.0), int("3")),
                    "peak_gpu_mb": phase_peaks.get("finetune", 0),
                },
                {
                    "step": "eval_finetuned",
                    "label": "Step 6: evaluate fine-tuned checkpoint",
                    "seconds": round(timings.get("eval_finetuned", 0.0), int("3")),
                    "peak_gpu_mb": phase_peaks.get("eval_finetuned", 0),
                },
            ],
            "total_seconds": round(sum(timings.values()), int("3")),
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Output is NOT clinically meaningful. "
            "This wrapper invokes the upstream `monai.bundle run` finetune entry "
            "described in NV-Segment-CT's finetune.md; it does not modify training."
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "output.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))

    if overall_rc != 0 or metrics["oom"]:
        sys.exit(2)
    if sanity and not result["output"]["sanity_recovery_demonstrated"]:
        print(
            f"\n[SANITY FAIL] training_start={baseline} training_best={best} "
            f"formal_pretrained={formal_pretrained} "
            f"formal_finetuned={formal_finetuned} "
            f"best_checkpoint_changed={best_checkpoint_changed}. Need Task06 "
            f"formal eval recovery and a best checkpoint whose tensors differ "
            f"from the pretrained checkpoint.",
            file=sys.stderr,
        )
        sys.exit(2)


if __name__ == "__main__":
    app()
