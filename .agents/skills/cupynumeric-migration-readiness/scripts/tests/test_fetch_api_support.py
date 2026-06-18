# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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
"""Smoke test for scripts/fetch_api_support.py.

Feeds a fixture HTML snippet covering all four token formats the scraper
must survive (legacy numeric tokens "1"/"2"/"3" and glyph tokens
"✓"/"❌"/"🟡") through parse_comparison() and asserts the resulting
ApiEntry fields. Then exercises render_markdown() to lock in the tier
layout and the compactness guarantee. Pure stdlib; no network calls.

NV-BASE's dependency audit can flag untested standalone scripts; this
covers the only function that classifies upstream support tokens.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "fetch_api_support.py"
_spec = importlib.util.spec_from_file_location(
    "fetch_api_support", _SCRIPT_PATH
)
fetch_api_support = importlib.util.module_from_spec(_spec)
sys.modules["fetch_api_support"] = fetch_api_support
_spec.loader.exec_module(fetch_api_support)


_FIXTURE_HTML = """
<html><body>
<section id="module-level">
  <h1>Module-Level</h1>
  <table>
    <thead><tr><th>NumPy</th><th>cuPyNumeric</th><th>SG</th><th>MG</th></tr></thead>
    <tbody>
      <tr>
        <td><a href="np/zeros.html">numpy.zeros</a></td>
        <td><a href="/cn/zeros.html">cupynumeric.zeros</a></td>
        <td>1</td><td>1</td>
      </tr>
      <tr>
        <td><a href="np/where.html">numpy.where</a></td>
        <td><a href="/cn/where.html">cupynumeric.where</a></td>
        <td>✓</td><td>✓</td>
      </tr>
      <tr>
        <td><a href="np/flip.html">numpy.flip</a></td>
        <td><a href="/cn/flip.html">cupynumeric.flip</a></td>
        <td>1</td><td>2</td>
      </tr>
      <tr>
        <td><a href="np/poly.html">numpy.polyfit</a></td>
        <td><ul><li></li></ul></td>
        <td>2</td><td>2</td>
      </tr>
      <tr>
        <td><a href="np/setdiff.html">numpy.setdiff1d</a></td>
        <td><ul><li></li></ul></td>
        <td>❌</td><td>❌</td>
      </tr>
    </tbody>
  </table>
</section>
<section id="discrete-fourier-transform">
  <h1>Discrete Fourier Transform</h1>
  <table>
    <thead><tr><th>NumPy</th><th>cuPyNumeric</th><th>SG</th><th>MG</th></tr></thead>
    <tbody>
      <tr>
        <td><a href="np/fft.html">numpy.fft.fft</a></td>
        <td><a href="/cn/fft.html">cupynumeric.fft.fft</a></td>
        <td>1</td><td>3</td>
      </tr>
      <tr>
        <td><a href="np/fft2.html">numpy.fft.fft2</a></td>
        <td><a href="/cn/fft2.html">cupynumeric.fft.fft2</a></td>
        <td>✓</td><td>🟡</td>
      </tr>
    </tbody>
  </table>
</section>
</body></html>
"""


def _by_name(entries, name):
    matches = [e for e in entries if e.numpy_name == name]
    assert len(matches) == 1, (
        f"expected exactly one entry for {name}, got {len(matches)}"
    )
    return matches[0]


def test_parse_comparison_covers_all_token_formats():
    entries = fetch_api_support.parse_comparison(
        _FIXTURE_HTML, base_url="https://example.test/comparison.html"
    )
    assert len(entries) == 7, f"expected 7 rows, got {len(entries)}"

    # Numeric "1" — fully supported on both configs, implemented
    zeros = _by_name(entries, "numpy.zeros")
    assert zeros.implemented is True
    assert zeros.single_gpu is True and zeros.multi_gpu is True
    assert (
        zeros.partial_single_gpu is False and zeros.partial_multi_gpu is False
    )
    assert zeros.cupynumeric_name == "cupynumeric.zeros"
    assert zeros.section == "Module-Level"
    assert zeros.docs_url is not None

    # Glyph "✓" — same meaning as "1", different format
    where = _by_name(entries, "numpy.where")
    assert where.implemented is True
    assert where.single_gpu is True and where.multi_gpu is True

    # SG "1", MG "2" — single-GPU-only convenience flag
    flip = _by_name(entries, "numpy.flip")
    assert flip.single_gpu_only is True

    # Numeric "2" — exposed by cuPyNumeric absent (no implementation linked)
    polyfit = _by_name(entries, "numpy.polyfit")
    assert polyfit.implemented is False
    assert polyfit.single_gpu is False and polyfit.multi_gpu is False
    assert polyfit.cupynumeric_name is None

    # Glyph "❌" — same meaning as "2", different format
    setdiff = _by_name(entries, "numpy.setdiff1d")
    assert setdiff.implemented is False
    assert setdiff.single_gpu is False and setdiff.multi_gpu is False

    # Numeric "3" — partial multi-GPU support (FFT case)
    fft = _by_name(entries, "numpy.fft.fft")
    assert fft.implemented is True
    assert fft.single_gpu is True and fft.multi_gpu is True
    assert fft.partial_multi_gpu is True
    assert fft.notes is not None
    assert fft.section == "Discrete Fourier Transform"

    # Glyph "🟡" — same meaning as "3", different format
    fft2 = _by_name(entries, "numpy.fft.fft2")
    assert fft2.implemented is True
    assert fft2.partial_multi_gpu is True
    assert (
        fft2.single_gpu_only is False
    )  # multi_gpu is True even though partial


def test_single_gpu_only_property():
    # SG "1", MG "2" — supported single-GPU only
    html = """
    <html><body><section id="linear-algebra"><table><thead><tr></tr></thead><tbody>
      <tr>
        <td><a href=\"x\">numpy.linalg.qr</a></td>
        <td><a href=\"y\">cupynumeric.linalg.qr</a></td>
        <td>1</td><td>2</td>
      </tr>
    </tbody></table></section></body></html>
    """
    entries = fetch_api_support.parse_comparison(
        html, base_url="https://example.test/c.html"
    )
    assert len(entries) == 1
    qr = entries[0]
    assert qr.single_gpu is True
    assert qr.multi_gpu is False
    assert qr.single_gpu_only is True


def test_constants_drift_canary():
    # If upstream introduces a new glyph, _SUPPORTED_TOKENS must grow.
    # This canary fails loudly if anyone removes one of the historical
    # tokens during a refactor.
    assert "1" in fetch_api_support._SUPPORTED_TOKENS
    assert "3" in fetch_api_support._SUPPORTED_TOKENS
    assert "✓" in fetch_api_support._SUPPORTED_TOKENS
    assert "🟡" in fetch_api_support._SUPPORTED_TOKENS
    assert "3" in fetch_api_support._PARTIAL_TOKENS
    assert "🟡" in fetch_api_support._PARTIAL_TOKENS


def test_render_markdown_emits_section_headings_and_legend():
    entries = fetch_api_support.parse_comparison(
        _FIXTURE_HTML, base_url="https://example.test/comparison.html"
    )
    md = fetch_api_support.render_markdown(
        entries, source_url="https://example.test/comparison.html"
    )
    assert md.startswith("# cuPyNumeric API support")
    assert "Source: https://example.test/comparison.html" in md
    assert "Fetched:" in md
    assert "7 total" in md
    assert "`✓✓`" in md and "`✓`" in md and "`🟡`" in md and "`✗`" in md
    assert "## Module-Level (3 of 5 implemented)" in md
    assert "## Discrete Fourier Transform (2 of 2 implemented)" in md


def test_render_markdown_groups_by_tier():
    entries = fetch_api_support.parse_comparison(
        _FIXTURE_HTML, base_url="https://example.test/comparison.html"
    )
    md = fetch_api_support.render_markdown(
        entries, source_url="https://example.test/comparison.html"
    )
    lines = md.splitlines()

    def line_for(prefix: str, contains: str) -> str | None:
        for line in lines:
            if line.startswith(prefix) and contains in line:
                return line
        return None

    multi_line = line_for("✓✓ ", "numpy.zeros")
    assert multi_line is not None, f"no ✓✓ line for numpy.zeros: {md}"
    assert "numpy.where" in multi_line

    single_line = line_for("✓ ", "numpy.flip")
    assert single_line is not None, f"no ✓ line for numpy.flip: {md}"

    fft_line = line_for("🟡 ", "numpy.fft.fft")
    assert fft_line is not None
    assert "partial" in fft_line.lower()

    miss_line = line_for("✗ ", "numpy.polyfit")
    assert miss_line is not None
    assert "numpy.setdiff1d" in miss_line


def test_render_markdown_drops_redundant_fields():
    """Internal ApiEntry bookkeeping (token strings, docs_url, cupynumeric_name)
    must not leak into the LLM-facing markdown surface."""
    entries = fetch_api_support.parse_comparison(
        _FIXTURE_HTML, base_url="https://example.test/comparison.html"
    )
    md = fetch_api_support.render_markdown(
        entries, source_url="https://example.test/comparison.html"
    )
    for needle in (
        "single_gpu_token",
        "multi_gpu_token",
        "partial_single_gpu",
        "partial_multi_gpu",
        "single_gpu_only",
        "docs_url",
        "cupynumeric.zeros",
        "cupynumeric.where",  # implicit from numpy name
    ):
        assert needle not in md, f"compact markdown leaked {needle!r}"


def test_wrap_glyph_line_wraps_long_lists():
    names = [f"numpy.func_{i:04d}" for i in range(200)]
    out = fetch_api_support._wrap_glyph_line("✓✓", names, width=80)
    assert len(out) > 1
    for line in out:
        assert line.startswith("✓✓ ")
        # Allow a single-name overflow past width.
        assert len(line) <= 80 + len("numpy.func_0000")
