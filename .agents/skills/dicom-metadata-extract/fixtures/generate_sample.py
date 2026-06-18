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

"""Generate a synthetic CT DICOM fixture for skill testing.

Has populated standard PHI tags with obviously-synthetic values so the
PHI-presence flag can be tested. Run once: produces sample_ct.dcm.
"""

from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset


def generate(out_path: Path) -> None:
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = pydicom.uid.CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = (
        "1.2.826.0.1.3680043.8.498.87363990806676731690652303827211061652"
    )
    file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian

    ds = FileDataset(str(out_path), {}, file_meta=file_meta, preamble=b"\0" * 128)

    # Standard PHI tags — synthetic values, obviously fake
    ds.PatientName = "ANON^TEST^SYNTHETIC"
    ds.PatientID = "TEST_ID_001"
    ds.PatientBirthDate = "20000101"
    ds.PatientSex = "O"
    ds.InstitutionName = "TEST_INSTITUTION_DO_NOT_USE"
    ds.ReferringPhysicianName = "TEST^Physician"

    ds.StudyDate = "20260518"
    ds.StudyTime = "102957"
    ds.StudyInstanceUID = "1.2.826.0.1.3680043.8.498.70205069167432896821744418685172690618"
    ds.StudyDescription = "Synthetic test study (no clinical content)"
    ds.SeriesInstanceUID = "1.2.826.0.1.3680043.8.498.31550974118702976965686593096238327316"
    ds.SeriesNumber = 1
    ds.SeriesDescription = "Synthetic CT for skill testing"
    ds.Modality = "CT"
    ds.BodyPartExamined = "ABDOMEN"
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.InstanceNumber = 1

    ds.Rows = 64
    ds.Columns = 64
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"

    rng = np.random.default_rng(42)
    pixel_array = rng.integers(0, 4096, size=(64, 64), dtype=np.uint16)
    ds.PixelData = pixel_array.tobytes()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        ds.save_as(str(out_path), enforce_file_format=True)
    except TypeError:
        ds.save_as(str(out_path), write_like_original=False)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent / "sample_ct.dcm"
    generate(out)
