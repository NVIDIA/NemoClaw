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

"""Unit tests for dicom_series_preflight."""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

sys.path.insert(0, str(SCRIPTS))
from preflight_series import preflight  # noqa: E402


@pytest.fixture(scope="module")
def _ensure_fixtures():
    if not (FIXTURES / "clean_no_phi").is_dir():
        import subprocess
        import sys

        subprocess.run(
            [sys.executable, str(FIXTURES / "generate_fixtures.py")],
            check=True,
            cwd=REPO,
        )


def test_clean_no_phi_passes(_ensure_fixtures):
    result = preflight(FIXTURES / "clean_no_phi")
    assert result["preflight"]["verdict"] == "pass"
    assert result["orientation"]["axcodes_match"] is True
    assert result["inventory"]["n_corrupt"] == 0
    assert result["input_dir"] == "skills/dicom-series-preflight/fixtures/clean_no_phi"


def test_flipped_lr_fails(_ensure_fixtures):
    result = preflight(FIXTURES / "flipped_lr")
    assert result["preflight"]["verdict"] == "fail"
    assert result["orientation"]["axcodes_match"] is False


def test_clean_axial_warns_phi(_ensure_fixtures):
    result = preflight(FIXTURES / "clean_axial")
    assert result["preflight"]["verdict"] == "warn"
    assert result["phi"]["phi_present"] is True
