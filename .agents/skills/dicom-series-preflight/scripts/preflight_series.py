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

"""DICOM series preflight — header-only scan of a directory.

Scans readable DICOM instances (stop_before_pixels), inventories series,
checks orientation/spacing/consistency, and flags a standard-tag PHI subset.
Engineering verification only; not de-identification or clinical QA.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import pydicom
import typer

app = typer.Typer(add_completion=False)

PHI_TAGS_STANDARD = [
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientSex",
    "PatientAge",
    "PatientWeight",
    "PatientAddress",
    "PatientTelephoneNumbers",
    "InstitutionName",
    "InstitutionAddress",
    "InstitutionalDepartmentName",
    "ReferringPhysicianName",
    "PerformingPhysicianName",
    "OperatorsName",
    "OtherPatientIDs",
    "OtherPatientNames",
    "EthnicGroup",
    "Occupation",
    "PatientComments",
]

PHI_SCOPE_DISCLAIMER = (
    "Standard DICOM PS3.15 basic-profile tags only. "
    "Private tags (odd group) NOT checked. "
    "Burnt-in pixel text NOT detected. "
    "Use a proper de-identifier for clinical or regulatory work."
)

CANONICAL_CT_AXCODES = ["L", "P", "S"]
COMPRESSED_TRANSFER_SYNTAX_PREFIXES = (
    "1.2.840.10008.1.2.4",  # JPEG / JPEG-LS / JPEG 2000 / RLE family
)


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(value)
    except Exception:
        return repr(value)


def _public_path(path: Path) -> str:
    """Return repo-relative paths when possible so evidence packs are portable."""
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def _list_dicom_paths(dicom_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for p in sorted(dicom_dir.rglob("*")):
        if p.is_file() and p.suffix.lower() in (".dcm", ""):
            paths.append(p)
    return paths


def _read_header(path: Path) -> tuple[pydicom.Dataset | None, str | None]:
    try:
        return pydicom.dcmread(str(path), stop_before_pixels=True), None
    except Exception as e:
        return None, str(e)


def _phi_tags_found(ds: pydicom.Dataset) -> list[str]:
    found: list[str] = []
    for tag_name in PHI_TAGS_STANDARD:
        if hasattr(ds, tag_name):
            value_str = _safe_str(getattr(ds, tag_name, None))
            if value_str is not None and value_str.strip() != "":
                found.append(tag_name)
    return found


def _transfer_syntax_uid(ds: pydicom.Dataset) -> str | None:
    if hasattr(ds, "file_meta") and ds.file_meta is not None:
        if hasattr(ds.file_meta, "TransferSyntaxUID"):
            return str(ds.file_meta.TransferSyntaxUID)
    return None


def _is_compressed_transfer_syntax(uid: str | None) -> bool:
    if not uid:
        return False
    return any(uid.startswith(prefix) for prefix in COMPRESSED_TRANSFER_SYNTAX_PREFIXES)


def _iop_list(ds: pydicom.Dataset) -> list[float] | None:
    if not hasattr(ds, "ImageOrientationPatient"):
        return None
    try:
        return [float(v) for v in ds.ImageOrientationPatient]
    except (TypeError, ValueError):
        return None


def _axcodes_from_iop(iop: list[float]) -> list[str] | None:
    if len(iop) != int("6"):
        return None
    row_dir = np.array(iop[: int("3")], dtype=float)
    col_dir = np.array(iop[int("3") :], dtype=float)
    slice_dir = np.cross(row_dir, col_dir)
    affine_lps = np.eye(int("4"))
    affine_lps[: int("3"), 0] = row_dir
    affine_lps[: int("3"), 1] = col_dir
    affine_lps[: int("3"), 2] = slice_dir
    lps_to_ras = np.diag([float("-1.0"), float("-1.0"), float("1.0"), float("1.0")])
    affine_ras = lps_to_ras @ affine_lps
    return list(nib.aff2axcodes(affine_ras))


def _spacing_key(ds: pydicom.Dataset) -> tuple[str, ...] | None:
    if not hasattr(ds, "PixelSpacing"):
        return None
    try:
        return tuple(str(v) for v in ds.PixelSpacing)
    except Exception:
        return None


def preflight(dicom_dir: Path) -> dict[str, Any]:
    t0 = time.perf_counter()
    dicom_dir = dicom_dir.resolve()
    paths = _list_dicom_paths(dicom_dir)

    readable: list[tuple[Path, pydicom.Dataset]] = []
    corrupt: list[dict[str, str]] = []
    for path in paths:
        ds, err = _read_header(path)
        if ds is None:
            corrupt.append({"path": _public_path(path), "error": err or "unreadable"})
            continue
        readable.append((path, ds))

    series_uids: set[str] = set()
    modalities: set[str] = set()
    iops: set[tuple[float, ...]] = set()
    spacings: set[tuple[str, ...]] = set()
    shapes: set[tuple[int, ...]] = set()
    phi_tags_union: set[str] = set()
    compressed_count = 0
    multi_frame_count = 0
    missing_iop = 0
    missing_spacing = 0

    for _path, ds in readable:
        suid = _safe_str(getattr(ds, "SeriesInstanceUID", None))
        if suid:
            series_uids.add(suid)
        mod = _safe_str(getattr(ds, "Modality", None))
        if mod:
            modalities.add(mod)
        iop = _iop_list(ds)
        if iop is None:
            missing_iop += 1
        else:
            iops.add(tuple(iop))
        sp = _spacing_key(ds)
        if sp is None:
            missing_spacing += 1
        else:
            spacings.add(sp)
        rows = getattr(ds, "Rows", None)
        cols = getattr(ds, "Columns", None)
        if rows and cols:
            shapes.add((int(rows), int(cols)))
        phi_tags_union.update(_phi_tags_found(ds))
        ts_uid = _transfer_syntax_uid(ds)
        if _is_compressed_transfer_syntax(ts_uid):
            compressed_count += 1
        n_frames = getattr(ds, "NumberOfFrames", 1) or 1
        try:
            if int(n_frames) > 1:
                multi_frame_count += 1
        except (TypeError, ValueError):
            pass

    primary_iop = list(next(iter(iops))) if len(iops) == 1 else None
    axcodes = _axcodes_from_iop(primary_iop) if primary_iop else None
    orientation_ok = axcodes == CANONICAL_CT_AXCODES if axcodes else None

    findings: list[dict[str, str]] = []
    if not paths:
        findings.append(
            {
                "level": "fail",
                "code": "no_dicom_files",
                "message": "No DICOM files found under input directory",
            }
        )
    if corrupt:
        findings.append(
            {
                "level": "fail",
                "code": "corrupt_instances",
                "message": f"{len(corrupt)} instance(s) could not be read",
            }
        )
    if len(series_uids) > 1:
        findings.append(
            {
                "level": "fail",
                "code": "multiple_series",
                "message": f"Found {len(series_uids)} distinct SeriesInstanceUID values",
            }
        )
    if len(iops) > 1:
        findings.append(
            {
                "level": "fail",
                "code": "inconsistent_orientation",
                "message": "ImageOrientationPatient varies across instances",
            }
        )
    if orientation_ok is False:
        findings.append(
            {
                "level": "fail",
                "code": "unexpected_orientation",
                "message": f"Derived axcodes {axcodes} != canonical {CANONICAL_CT_AXCODES}",
            }
        )
    if len(spacings) > 1:
        findings.append(
            {
                "level": "warn",
                "code": "inconsistent_spacing",
                "message": "PixelSpacing varies across instances",
            }
        )
    if len(shapes) > 1:
        findings.append(
            {
                "level": "warn",
                "code": "inconsistent_shape",
                "message": "Rows/Columns vary across instances",
            }
        )
    if phi_tags_union:
        findings.append(
            {
                "level": "warn",
                "code": "phi_tags_present",
                "message": f"Standard PHI tags populated: {sorted(phi_tags_union)}",
            }
        )
    if compressed_count:
        findings.append(
            {
                "level": "warn",
                "code": "compressed_transfer_syntax",
                "message": f"{compressed_count} instance(s) use compressed transfer syntax",
            }
        )
    if multi_frame_count:
        findings.append(
            {
                "level": "warn",
                "code": "multi_frame_instances",
                "message": f"{multi_frame_count} multi-frame instance(s); not fully supported downstream",
            }
        )
    if missing_iop:
        findings.append(
            {
                "level": "warn",
                "code": "missing_orientation_tags",
                "message": f"{missing_iop} instance(s) lack ImageOrientationPatient",
            }
        )

    fail_levels = {f["level"] for f in findings if f["level"] == "fail"}
    warn_levels = {f["level"] for f in findings if f["level"] == "warn"}
    if fail_levels:
        verdict = "fail"
    elif warn_levels:
        verdict = "warn"
    else:
        verdict = "pass"

    sample = readable[0][1] if readable else None
    study = {}
    series = {}
    if sample is not None:
        study = {
            "StudyInstanceUID": _safe_str(getattr(sample, "StudyInstanceUID", None)),
            "StudyDate": _safe_str(getattr(sample, "StudyDate", None)),
            "StudyDescription": _safe_str(getattr(sample, "StudyDescription", None)),
        }
        series = {
            "SeriesInstanceUID": _safe_str(getattr(sample, "SeriesInstanceUID", None)),
            "SeriesDescription": _safe_str(getattr(sample, "SeriesDescription", None)),
            "Modality": _safe_str(getattr(sample, "Modality", None)),
            "BodyPartExamined": _safe_str(getattr(sample, "BodyPartExamined", None)),
        }

    elapsed = time.perf_counter() - t0
    return {
        "skill": "dicom_series_preflight",
        "input_dir": _public_path(dicom_dir),
        "inventory": {
            "n_files_seen": len(paths),
            "n_readable": len(readable),
            "n_corrupt": len(corrupt),
            "corrupt_samples": corrupt[: int("5")],
        },
        "series": {
            "n_series": len(series_uids),
            "series_instance_uids": sorted(series_uids),
            "single_series": len(series_uids) <= 1,
            "modalities": sorted(modalities),
        },
        "orientation": {
            "n_distinct_iop": len(iops),
            "primary_iop": primary_iop,
            "axcodes": axcodes,
            "expected_axcodes": CANONICAL_CT_AXCODES,
            "axcodes_match": orientation_ok,
        },
        "consistency": {
            "n_distinct_pixel_spacing": len(spacings),
            "n_distinct_shapes": len(shapes),
            "missing_iop_count": missing_iop,
            "missing_spacing_count": missing_spacing,
        },
        "phi": {
            "phi_present": len(phi_tags_union) > 0,
            "phi_tags_found": sorted(phi_tags_union),
            "phi_scope_disclaimer": PHI_SCOPE_DISCLAIMER,
        },
        "transfer_syntax": {
            "compressed_instance_count": compressed_count,
        },
        "study": study,
        "series_metadata": series,
        "findings": findings,
        "preflight": {
            "verdict": verdict,
            "acceptable": verdict in ("pass", "warn"),
            "n_fail": sum(1 for f in findings if f["level"] == "fail"),
            "n_warn": sum(1 for f in findings if f["level"] == "warn"),
        },
        "runtime": {"scan_seconds": round(elapsed, int("3"))},
        "intended_use_disclaimer": (
            "Engineering-time DICOM folder preflight only. Does not decode pixels, "
            "de-identify, or certify data for clinical or regulatory use."
        ),
    }


@app.command()
def main(
    dicom_dir: Path = typer.Argument(..., exists=True, file_okay=False),
) -> None:
    """Scan a DICOM directory and emit preflight JSON on stdout."""
    print(json.dumps(preflight(dicom_dir), indent=2, default=str))


if __name__ == "__main__":
    app()
