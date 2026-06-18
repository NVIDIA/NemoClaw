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

"""Generate synthetic DICOM CT series fixtures for the dicom_series_to_volume skill.

Produces two series:
  clean_axial/      — ImageOrientationPatient = [1,0,0, 0,1,0] (canonical axial CT)
  flipped_lr/       — ImageOrientationPatient = [-1,0,0, 0,1,0] (LR axis declared
                      reversed; reflects a real-world PACS-export bug class)

Both contain a small "spleen-like" blob of mid-HU intensity so VISTA3D has
something to look at if the workflow proceeds past the orientation gate.
No real PHI; PatientName / PatientID set to synthetic values. Engineering
verification only -- not a clinical fixture.
"""

from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    generate_uid,
)

ROOT = Path(__file__).resolve().parent
SHAPE = (32, 64, 64)  # (n_slices, rows, cols)
SLICE_SPACING_MM = 2.0
PIXEL_SPACING_MM = tuple(float(x) for x in ("1.0", "1.0"))


def _make_volume() -> np.ndarray:
    """Synthetic CT in HU: air background + soft tissue body + small blob."""
    n_slices, rows, cols = SHAPE
    vol = np.full(SHAPE, -1000.0, dtype=np.float32)  # air

    # body cylinder (mid CT)
    yy, xx = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    cy, cx = rows / 2, cols / 2
    body_mask = (xx - cx) ** 2 + (yy - cy) ** 2 < (min(rows, cols) * 0.45) ** 2
    for z in range(2, n_slices - 2):
        vol[z][body_mask] = 40.0  # soft tissue HU ~ 40

    # spleen-like blob (mid HU ~ 60), placed slightly LEFT of center on the
    # patient: this is the L/R asymmetry the orientation gate protects.
    blob_z, blob_y, blob_x = n_slices // 2, int(rows * 0.55), int(cols * 0.65)
    rad = 5
    zz = np.arange(n_slices)[:, None, None]
    yyy = np.arange(rows)[None, :, None]
    xxx = np.arange(cols)[None, None, :]
    blob = ((zz - blob_z) ** 2 + (yyy - blob_y) ** 2 + (xxx - blob_x) ** 2) < rad**2
    vol[blob] = 60.0
    return vol


def _make_dataset(
    slice_idx: int,
    pixel_2d: np.ndarray,
    series_uid: str,
    study_uid: str,
    iop: list[float],
    position: list[float],
) -> FileDataset:
    """Build one CT slice DICOM with the given orientation + position."""
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()

    ds = FileDataset("", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.PatientName = "SYNTHETIC^FIXTURE"
    ds.PatientID = "SYNTH-001"
    ds.PatientBirthDate = "19000101"
    ds.PatientSex = "O"

    ds.StudyInstanceUID = study_uid
    ds.StudyDate = "20260509"
    ds.StudyDescription = "Synthetic CT fixture for orientation gate demo"
    ds.AccessionNumber = "ACC-FIX-001"

    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = "1"
    ds.SeriesDescription = "Synthetic axial CT"
    ds.Modality = "CT"
    ds.BodyPartExamined = "ABDOMEN"

    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.InstanceNumber = str(slice_idx + 1)

    rows, cols = pixel_2d.shape
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1  # signed

    ds.PixelSpacing = [str(PIXEL_SPACING_MM[0]), str(PIXEL_SPACING_MM[1])]
    ds.SliceThickness = str(SLICE_SPACING_MM)
    ds.ImageOrientationPatient = [str(v) for v in iop]
    ds.ImagePositionPatient = [str(v) for v in position]
    ds.RescaleSlope = "1"
    ds.RescaleIntercept = "0"

    pixel_int16 = pixel_2d.astype(np.int16)
    ds.PixelData = pixel_int16.tobytes()

    return ds


def write_series(out_dir: Path, iop: list[float], series_label: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.dcm"):
        old.unlink()

    vol = _make_volume()
    series_uid = generate_uid()
    study_uid = generate_uid()
    n_slices = vol.shape[0]

    # Stack along z = +slice_axis (cross of row and col directions)
    row_dir = np.array(iop[:3], dtype=float)
    col_dir = np.array(iop[3:], dtype=float)
    slice_axis = np.cross(row_dir, col_dir)
    origin = np.array([0.0, 0.0, 0.0])

    for z in range(n_slices):
        position = (origin + z * SLICE_SPACING_MM * slice_axis).tolist()
        ds = _make_dataset(z, vol[z], series_uid, study_uid, iop, position)
        ds.save_as(str(out_dir / f"slice_{z:03d}.dcm"), enforce_file_format=True)
    print(f"wrote {n_slices} slices to {out_dir} (IOP={iop}, label={series_label!r})")


def main() -> None:
    write_series(ROOT / "clean_axial", iop=[1, 0, 0, 0, 1, 0], series_label="clean")
    write_series(ROOT / "flipped_lr", iop=[-1, 0, 0, 0, 1, 0], series_label="flipped_lr")


if __name__ == "__main__":
    main()
