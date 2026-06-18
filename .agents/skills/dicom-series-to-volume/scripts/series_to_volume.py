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

"""DICOM-series-to-volume skill.

Reads a single-series DICOM directory, sorts by ImagePositionPatient z,
applies RescaleSlope / RescaleIntercept, builds a NIfTI affine from
ImageOrientationPatient + PixelSpacing + slice spacing, writes .nii.gz
plus a JSON summary that includes the resulting axcodes.

Engineering verification only. Not a vetted clinical converter.
"""

import json
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
import typer

app = typer.Typer(add_completion=False)


def _public_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def _read_series(dicom_dir: Path) -> list[pydicom.Dataset]:
    datasets = []
    for p in sorted(dicom_dir.rglob("*")):
        if not p.is_file():
            continue
        try:
            ds = pydicom.dcmread(str(p))
        except Exception:
            continue
        if not hasattr(ds, "PixelData"):
            continue
        datasets.append(ds)
    return datasets


def _missing_required_tags(datasets: list[pydicom.Dataset]) -> list[str]:
    required = ("ImageOrientationPatient", "ImagePositionPatient", "PixelSpacing")
    missing: set[str] = set()
    for ds in datasets:
        for name in required:
            if not hasattr(ds, name):
                missing.add(name)
    return sorted(missing)


def _affine_from_dicom(
    first: pydicom.Dataset, last: pydicom.Dataset, n_slices: int
) -> tuple[np.ndarray, np.ndarray]:
    """Build a NIfTI-style RAS+ affine from DICOM ImageOrientationPatient + PixelSpacing.

    DICOM is LPS+; NIfTI is conventionally RAS+. We negate the first two rows
    to flip x,y signs so axcodes computed from the resulting affine are
    interpretable as RAS-convention.
    """
    iop = np.array(first.ImageOrientationPatient, dtype=float)
    row_dir = iop[: int("3")]  # column direction in patient (LPS) space
    col_dir = iop[int("3") :]  # row direction in patient (LPS) space
    px_y, px_x = float(first.PixelSpacing[0]), float(first.PixelSpacing[1])

    ipp_first = np.array(first.ImagePositionPatient, dtype=float)
    ipp_last = np.array(last.ImagePositionPatient, dtype=float)
    if n_slices > 1:
        slice_step = (ipp_last - ipp_first) / (n_slices - 1)
        slice_spacing = float(np.linalg.norm(slice_step))
        slice_dir = slice_step / slice_spacing if slice_spacing > 0 else np.cross(row_dir, col_dir)
    else:
        slice_spacing = float(getattr(first, "SliceThickness", 1.0))
        slice_dir = np.cross(row_dir, col_dir)

    # LPS affine
    affine_lps = np.eye(int("4"))
    affine_lps[: int("3"), 0] = row_dir * px_x
    affine_lps[: int("3"), 1] = col_dir * px_y
    affine_lps[: int("3"), 2] = slice_dir * slice_spacing
    affine_lps[: int("3"), int("3")] = ipp_first

    # LPS -> RAS conversion: negate first two rows
    lps_to_ras = np.diag([float("-1.0"), float("-1.0"), float("1.0"), float("1.0")])
    affine_ras = lps_to_ras @ affine_lps
    return affine_ras, np.array([px_x, px_y, slice_spacing])


@app.command()
def main(
    dicom_dir: Path = typer.Argument(..., exists=True, file_okay=False),
    output: Path = typer.Option(None, "--output", "-o", help="output NIfTI path"),
) -> None:
    t0 = time.perf_counter()
    datasets = _read_series(dicom_dir)
    if not datasets:
        result = {
            "skill": "dicom_series_to_volume",
            "error": "no readable DICOM files with PixelData found",
            "n_slices": 0,
            "single_series": False,
            "modality": None,
        }
        print(json.dumps(result, indent=2))
        raise typer.Exit(2)

    missing_tags = _missing_required_tags(datasets)
    if missing_tags:
        result = {
            "skill": "dicom_series_to_volume",
            "error": "DICOM series is missing tags required for affine construction",
            "missing_tags": missing_tags,
            "n_slices": len(datasets),
            "single_series": False,
            "modality": None,
        }
        print(json.dumps(result, indent=2))
        raise typer.Exit(2)

    series_uids = {str(getattr(ds, "SeriesInstanceUID", "")) for ds in datasets}
    series_uids.discard("")
    single_series = len(series_uids) == 1
    modalities = {str(getattr(ds, "Modality", "")) for ds in datasets}
    modalities.discard("")

    # Sort by ImagePositionPatient projected onto cross(row, col) (slice axis).
    iop = np.array(datasets[0].ImageOrientationPatient, dtype=float)
    slice_axis = np.cross(iop[: int("3")], iop[int("3") :])

    def _z_proj(ds):
        return float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), slice_axis))

    datasets.sort(key=_z_proj)
    n_slices = len(datasets)

    pixel_arrays = []
    inconsistent_shape = False
    for ds in datasets:
        slope = float(getattr(ds, "RescaleSlope", 1.0) or 1.0)
        intercept = float(getattr(ds, "RescaleIntercept", 0.0) or 0.0)
        try:
            arr = ds.pixel_array.astype(np.float32) * slope + intercept
        except Exception as e:
            result = {
                "skill": "dicom_series_to_volume",
                "error": "could not decode DICOM pixel data",
                "detail": str(e),
                "n_slices": n_slices,
                "single_series": single_series,
                "modality": list(modalities)[0] if len(modalities) == 1 else None,
            }
            print(json.dumps(result, indent=2))
            raise typer.Exit(2)
        pixel_arrays.append(arr)
        if arr.shape != pixel_arrays[0].shape:
            inconsistent_shape = True

    volume = np.stack(pixel_arrays, axis=-1) if not inconsistent_shape else None
    affine, spacing = _affine_from_dicom(datasets[0], datasets[-1], n_slices)
    axcodes = list(nib.aff2axcodes(affine)) if volume is not None else []

    if output is None:
        output = dicom_dir.parent / (dicom_dir.name + ".nii.gz")
    output = output.resolve()

    if volume is not None:
        nii = nib.Nifti1Image(volume.astype(np.int16), affine)
        nib.save(nii, str(output))
        hu_range = [float(volume.min()), float(volume.max())]
        out_shape = list(volume.shape)
    else:
        hu_range = [None, None]
        out_shape = []

    # Surface a small DICOM-header summary so a downstream workflow step can
    # compose a structured fixture without re-reading the series. These
    # descriptors and dates are metadata, not a PHI-free guarantee; committed
    # fixtures are synthetic per repository policy.
    first = datasets[0]
    dicom_metadata = {
        "Modality": str(getattr(first, "Modality", "") or ""),
        "BodyPartExamined": str(getattr(first, "BodyPartExamined", "") or ""),
        "StudyInstanceUID": str(getattr(first, "StudyInstanceUID", "") or ""),
        "SeriesInstanceUID": str(getattr(first, "SeriesInstanceUID", "") or ""),
        "StudyDescription": str(getattr(first, "StudyDescription", "") or ""),
        "SeriesDescription": str(getattr(first, "SeriesDescription", "") or ""),
        "StudyDate": str(getattr(first, "StudyDate", "") or ""),
    }

    elapsed = time.perf_counter() - t0
    result = {
        "skill": "dicom_series_to_volume",
        "n_slices": n_slices,
        "single_series": single_series,
        "series_instance_uid": sorted(series_uids)[0] if len(series_uids) == 1 else None,
        "series_instance_uid_count": len(series_uids),
        "modality": list(modalities)[0] if len(modalities) == 1 else None,
        "modalities": sorted(modalities),
        "dicom_metadata": dicom_metadata,
        "input_dir": _public_path(dicom_dir),
        "output": {
            "path": _public_path(output) if volume is not None else None,
            "shape": out_shape,
            "spacing": [round(float(s), int("4")) for s in spacing.tolist()],
            "affine": [[round(float(v), int("4")) for v in row] for row in affine.tolist()],
            "axcodes": axcodes,
        },
        "hu_range": hu_range,
        "inconsistent_shape": inconsistent_shape,
        "runtime": {
            "conversion_seconds": round(elapsed, int("3")),
        },
        "intended_use_disclaimer": (
            "Engineering verification only. Not a vetted clinical DICOM-to-NIfTI "
            "converter; does not auto-reorient. A downstream gate is expected to "
            "assert orientation before this volume is fed to a model."
        ),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    app()
