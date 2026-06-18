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

"""Basic tests for dicom_metadata_extract skill."""

import json
import subprocess
import sys
from pathlib import Path

import jsonschema
import pytest

SKILL_DIR = Path(__file__).resolve().parent.parent
SCRIPT = SKILL_DIR / "scripts" / "extract_metadata.py"
FIXTURE = SKILL_DIR / "fixtures" / "sample_ct.dcm"
SCHEMA = SKILL_DIR / "validators" / "output_schema.json"


@pytest.fixture(scope="session")
def fixture_path() -> Path:
    if not FIXTURE.exists():
        pytest.skip(f"fixture missing: {FIXTURE}")
    return FIXTURE


def _run(*args: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def test_script_runs_and_returns_json(fixture_path: Path) -> None:
    payload = _run(str(fixture_path))
    assert payload["modality"] == "CT"
    assert payload["transfer_syntax"]["uid"] is not None
    assert "phi_present" in payload
    assert "phi_scope_disclaimer" in payload


def test_phi_flag_true_for_synthetic_phi(fixture_path: Path) -> None:
    payload = _run(str(fixture_path))
    assert payload["phi_present"] is True
    assert "PatientName" in payload["phi_tags_found"]
    assert "PatientID" in payload["phi_tags_found"]


def test_required_schema_fields(fixture_path: Path) -> None:
    payload = _run(str(fixture_path))
    for k in (
        "path",
        "transfer_syntax",
        "modality",
        "study",
        "series",
        "image",
        "phi_present",
        "phi_tags_found",
        "phi_scope_disclaimer",
    ):
        assert k in payload, f"missing key: {k}"


def test_output_validates_against_schema(fixture_path: Path) -> None:
    payload = _run(str(fixture_path))
    schema = json.loads(SCHEMA.read_text())
    jsonschema.validate(payload, schema)
