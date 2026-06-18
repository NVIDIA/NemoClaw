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

"""DICOM metadata extraction skill.

Reads a DICOM file and emits structured JSON with metadata + a PHI-tag-presence flag.

Scope: standard DICOM PS3.15 basic-profile tags only. NOT a de-identifier.
Private tags and burnt-in pixel PHI are explicitly out of scope.
"""

import json
from pathlib import Path
from typing import Any

import pydicom
import typer

app = typer.Typer(add_completion=False)

# Standard PHI tag names from DICOM PS3.15 Basic Application Confidentiality Profile.
# Subset sufficient for engineering verification — NOT for clinical de-identification.
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


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(value)
    except Exception:
        return repr(value)


def _public_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def extract(path: Path) -> dict:
    """Extract metadata from a DICOM file. Returns a JSON-serialisable dict."""
    try:
        ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    except Exception as e:
        raise typer.BadParameter(f"could not read DICOM header from {path}: {e}") from e

    ts_uid = None
    ts_name = None
    if hasattr(ds, "file_meta") and ds.file_meta is not None:
        if hasattr(ds.file_meta, "TransferSyntaxUID"):
            ts_uid = str(ds.file_meta.TransferSyntaxUID)
            ts_name = ds.file_meta.TransferSyntaxUID.name

    study = {
        "StudyInstanceUID": _safe_str(getattr(ds, "StudyInstanceUID", None)),
        "StudyDate": _safe_str(getattr(ds, "StudyDate", None)),
        "StudyTime": _safe_str(getattr(ds, "StudyTime", None)),
        "StudyDescription": _safe_str(getattr(ds, "StudyDescription", None)),
        "AccessionNumber": _safe_str(getattr(ds, "AccessionNumber", None)),
    }
    series = {
        "SeriesInstanceUID": _safe_str(getattr(ds, "SeriesInstanceUID", None)),
        "SeriesNumber": _safe_str(getattr(ds, "SeriesNumber", None)),
        "SeriesDescription": _safe_str(getattr(ds, "SeriesDescription", None)),
        "Modality": _safe_str(getattr(ds, "Modality", None)),
        "BodyPartExamined": _safe_str(getattr(ds, "BodyPartExamined", None)),
    }
    image = {
        "SOPInstanceUID": _safe_str(getattr(ds, "SOPInstanceUID", None)),
        "InstanceNumber": _safe_str(getattr(ds, "InstanceNumber", None)),
        "Rows": getattr(ds, "Rows", None),
        "Columns": getattr(ds, "Columns", None),
        "BitsAllocated": getattr(ds, "BitsAllocated", None),
        "PixelRepresentation": getattr(ds, "PixelRepresentation", None),
        "PhotometricInterpretation": _safe_str(getattr(ds, "PhotometricInterpretation", None)),
        "NumberOfFrames": getattr(ds, "NumberOfFrames", None),
    }

    phi_tags_found = []
    for tag_name in PHI_TAGS_STANDARD:
        if hasattr(ds, tag_name):
            value_str = _safe_str(getattr(ds, tag_name, None))
            if value_str is not None and value_str.strip() != "":
                phi_tags_found.append(tag_name)

    return {
        "path": _public_path(path),
        "transfer_syntax": {"uid": ts_uid, "name": ts_name},
        "modality": _safe_str(getattr(ds, "Modality", None)),
        "study": study,
        "series": series,
        "image": image,
        "phi_present": len(phi_tags_found) > 0,
        "phi_tags_found": phi_tags_found,
        "phi_scope_disclaimer": PHI_SCOPE_DISCLAIMER,
    }


@app.command()
def main(
    dicom_path: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    output: Path = typer.Option(None, "--output", "-o", help="JSON output path; stdout if omitted"),
) -> None:
    """Extract metadata from a DICOM file."""
    result = extract(dicom_path)
    payload = json.dumps(result, indent=2, default=str)
    if output:
        output.write_text(payload)
        print(f"wrote {output}")
    else:
        print(payload)


if __name__ == "__main__":
    app()
