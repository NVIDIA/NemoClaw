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

"""Anatomy / region taxonomy for the nv_generate_ct_rflow skill.

Mirrors what `scripts/sample.py` in NVIDIA-Medtech/NV-Generate-CTMR
enforces at inference time, surfaced here so the wrapper can validate
user input *before* loading the diffusion model (which takes ~30s on a
warm GPU). All sources cited inline; nothing here is reverse-engineered.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# Authoritative source: $NV_GENERATE_ROOT/scripts/sample.py:
#     available_body_region = ["head", "chest", "thorax", "abdomen", "pelvis", "lower"]
SUPPORTED_BODY_REGIONS: tuple[str, ...] = (
    "head",
    "chest",
    "thorax",
    "abdomen",
    "pelvis",
    "lower",
)

# Authoritative source: $NV_GENERATE_ROOT/scripts/sample.py
#     available_controllable_organ = ["liver", "gallbladder", "stomach", "pancreas", "colon"]
CONTROLLABLE_ORGANS: tuple[str, ...] = (
    "liver",
    "gallbladder",
    "stomach",
    "pancreas",
    "colon",
)

# Authoritative source: $NV_GENERATE_ROOT/scripts/sample.py
#     available_controllable_tumor = ["hepatic tumor", "bone lesion", "lung tumor",
#                                     "colon cancer primaries", "pancreatic tumor"]
CONTROLLABLE_TUMORS: tuple[str, ...] = (
    "hepatic tumor",
    "bone lesion",
    "lung tumor",
    "colon cancer primaries",
    "pancreatic tumor",
)

# Region groupings used only for display in list_anatomies.py. The model
# does not enforce these; a user can pair any anatomy_list with any
# body_region. Membership is curated by anatomical convention; some
# classes (e.g. aorta, vena cava) span regions and appear once where
# their bulk lives.
_REGION_GROUPS: dict[str, tuple[str, ...]] = {
    "head": (
        "brain",
        "skull",
        "spinal cord",
        "thyroid gland",
        "trachea",
        "vertebrae C1",
        "vertebrae C2",
        "vertebrae C3",
        "vertebrae C4",
        "vertebrae C5",
        "vertebrae C6",
        "vertebrae C7",
    ),
    "chest": (
        "left lung upper lobe",
        "left lung lower lobe",
        "right lung upper lobe",
        "right lung middle lobe",
        "right lung lower lobe",
        "lung tumor",
        "heart",
        "left atrial appendage",
        "pulmonary vein",
        "esophagus",
        "airway",
        "sternum",
        "costal cartilages",
        "left clavicula",
        "right clavicula",
        "left scapula",
        "right scapula",
        "left humerus",
        "right humerus",
        "left rib 1",
        "left rib 2",
        "left rib 3",
        "left rib 4",
        "left rib 5",
        "left rib 6",
        "left rib 7",
        "left rib 8",
        "left rib 9",
        "left rib 10",
        "left rib 11",
        "left rib 12",
        "right rib 1",
        "right rib 2",
        "right rib 3",
        "right rib 4",
        "right rib 5",
        "right rib 6",
        "right rib 7",
        "right rib 8",
        "right rib 9",
        "right rib 10",
        "right rib 11",
        "right rib 12",
        "vertebrae T1",
        "vertebrae T2",
        "vertebrae T3",
        "vertebrae T4",
        "vertebrae T5",
        "vertebrae T6",
        "vertebrae T7",
        "vertebrae T8",
        "vertebrae T9",
        "vertebrae T10",
        "vertebrae T11",
        "vertebrae T12",
        "aorta",
        "inferior vena cava",
        "superior vena cava",
        "brachiocephalic trunk",
        "left brachiocephalic vein",
        "right brachiocephalic vein",
        "left common carotid artery",
        "right common carotid artery",
        "left subclavian artery",
        "right subclavian artery",
    ),
    "abdomen": (
        "liver",
        "spleen",
        "pancreas",
        "right kidney",
        "left kidney",
        "right adrenal gland",
        "left adrenal gland",
        "gallbladder",
        "stomach",
        "duodenum",
        "small bowel",
        "colon",
        "hepatic vessel",
        "hepatic tumor",
        "pancreatic tumor",
        "colon cancer primaries",
        "portal vein and splenic vein",
        "right kidney cyst",
        "left kidney cyst",
        "bone lesion",
        "vertebrae L1",
        "vertebrae L2",
        "vertebrae L3",
        "vertebrae L4",
        "vertebrae L5",
    ),
    "pelvis": (
        "bladder",
        "prostate",
        "sacrum",
        "vertebrae S1",
        "left hip",
        "right hip",
        "left iliac artery",
        "right iliac artery",
        "left iliac vena",
        "right iliac vena",
        "left iliopsoas",
        "right iliopsoas",
        "left autochthon",
        "right autochthon",
    ),
    "lower": (
        "left femur",
        "right femur",
        "left gluteus maximus",
        "right gluteus maximus",
        "left gluteus medius",
        "right gluteus medius",
        "left gluteus minimus",
        "right gluteus minimus",
    ),
    "general": ("body",),
}


def resolve_nv_generate_root() -> Path:
    raw = os.environ.get("NV_GENERATE_ROOT", "").strip()
    if not raw:
        raise RuntimeError(
            "NV_GENERATE_ROOT is unset. Clone "
            "https://github.com/NVIDIA-Medtech/NV-Generate-CTMR and export "
            "NV_GENERATE_ROOT=<clone-path>."
        )
    p = Path(raw).expanduser().resolve()
    if not p.is_dir():
        raise RuntimeError(f"NV_GENERATE_ROOT does not exist: {p}")
    return p


def load_label_dict(upstream_root: Path | None = None) -> dict[str, int]:
    """Read the upstream's label_dict.json. Drops the `dummy*` placeholder
    entries (they're holes in the VISTA3D index space, not real classes).
    """
    root = upstream_root or resolve_nv_generate_root()
    path = root / "configs" / "label_dict.json"
    if not path.is_file():
        raise FileNotFoundError(
            f"{path} not found. Re-clone NV-Generate-CTMR or check $NV_GENERATE_ROOT."
        )
    raw = json.loads(path.read_text())
    return {name: idx for name, idx in raw.items() if not name.startswith("dummy")}


def region_for_class(class_name: str) -> str | None:
    """Return the region grouping for a class name, or None if it has no
    canonical region. Display-only; the upstream model does not enforce.
    """
    for region, members in _REGION_GROUPS.items():
        if class_name in members:
            return region
    return None


def classes_by_region(label_dict: dict[str, int]) -> dict[str, list[tuple[str, int]]]:
    """Group `label_dict` entries by region. Classes with no canonical
    region land under "other"."""
    out: dict[str, list[tuple[str, int]]] = {r: [] for r in _REGION_GROUPS}
    out["other"] = []
    for name, idx in label_dict.items():
        region = region_for_class(name)
        out[region or "other"].append((name, idx))
    for r in out:
        out[r].sort(key=lambda x: x[1])
    return out


def validate_anatomy_list(
    anatomy_list: list[str] | None,
    label_dict: dict[str, int],
) -> list[str]:
    """Return a list of error messages (empty if valid)."""
    errors: list[str] = []
    if anatomy_list is None:
        return errors
    if not isinstance(anatomy_list, list):
        return [f"anatomy_list must be a list of strings, got {type(anatomy_list).__name__}"]
    valid_names = set(label_dict.keys())
    for entry in anatomy_list:
        if not isinstance(entry, str):
            errors.append(f"anatomy_list entry must be a string, got {entry!r}")
            continue
        if entry not in valid_names:
            close = _suggest_close(entry, valid_names)
            hint = f" (did you mean {close!r}?)" if close else ""
            errors.append(f"anatomy_list entry not in upstream label_dict: {entry!r}{hint}")
    return errors


def validate_body_region(body_region: list[str] | None) -> list[str]:
    errors: list[str] = []
    if body_region is None:
        return errors
    if not isinstance(body_region, list):
        return [f"body_region must be a list of strings, got {type(body_region).__name__}"]
    for entry in body_region:
        if entry not in SUPPORTED_BODY_REGIONS:
            errors.append(
                f"body_region entry {entry!r} not in supported set "
                f"{list(SUPPORTED_BODY_REGIONS)}"
            )
    return errors


def validate_controllable_anatomy_size(
    controllable_anatomy_size: list[Any] | None,
) -> list[str]:
    errors: list[str] = []
    if controllable_anatomy_size is None or controllable_anatomy_size == []:
        return errors
    if not isinstance(controllable_anatomy_size, list):
        return ["controllable_anatomy_size must be a list of [name, size] pairs"]
    if len(controllable_anatomy_size) > int("10"):
        errors.append(
            f"controllable_anatomy_size length must be <= 10, got {len(controllable_anatomy_size)}"
        )
    valid = set(CONTROLLABLE_ORGANS) | set(CONTROLLABLE_TUMORS)
    tumors_seen: list[str] = []
    names_seen: list[str] = []
    for i, pair in enumerate(controllable_anatomy_size):
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
            errors.append(
                f"controllable_anatomy_size[{i}] must be a [name, size] pair, got {pair!r}"
            )
            continue
        name, size = pair
        if name not in valid:
            errors.append(
                f"controllable_anatomy_size[{i}] name {name!r} not in "
                f"controllable organs {list(CONTROLLABLE_ORGANS)} or "
                f"tumors {list(CONTROLLABLE_TUMORS)}"
            )
        if name in CONTROLLABLE_TUMORS:
            tumors_seen.append(name)
        names_seen.append(name)
        if not isinstance(size, (int, float)):
            errors.append(f"controllable_anatomy_size[{i}] size must be numeric, got {size!r}")
        elif size != -1 and not (0.0 <= size <= 1.0):
            errors.append(
                f"controllable_anatomy_size[{i}] size must be in [0, 1] or -1, got {size}"
            )
    if len(tumors_seen) > 1:
        errors.append(f"controllable_anatomy_size may include at most one tumor; got {tumors_seen}")
    if len(names_seen) != len(set(names_seen)):
        errors.append(f"controllable_anatomy_size must not repeat anatomy names; got {names_seen}")
    return errors


def _suggest_close(needle: str, haystack: set[str], max_distance: int = int("4")) -> str | None:
    """Tiny Levenshtein-ish suggestion for typos. No external deps."""
    needle_l = needle.lower()
    best: tuple[int, str] | None = None
    for candidate in haystack:
        d = _edit_distance(needle_l, candidate.lower(), cap=max_distance + 1)
        if d <= max_distance and (best is None or d < best[0]):
            best = (d, candidate)
    return best[1] if best else None


def _edit_distance(a: str, b: str, cap: int) -> int:
    if abs(len(a) - len(b)) >= cap:
        return cap
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        row_min = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            )
            row_min = min(row_min, cur[j])
        if row_min >= cap:
            return cap
        prev = cur
    return prev[-1]
