#!/usr/bin/env python3

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

"""Scrape the cuPyNumeric NumPy-vs-cuPyNumeric API comparison table.

The upstream page at https://nv-legate.github.io/cupynumeric/api/comparison.html
is the GitHub Pages mirror that tracks the in-development repo and is the
most up-to-date source during the documentation transition. The long-term
canonical URL is https://docs.nvidia.com/cupynumeric/latest/api/comparison.html;
pass --docs-nvidia-url to target it instead.

The page is HTML-only. This script extracts every row and emits a markdown
manifest the skill's agent consults to answer the question "is `numpy.<x>`
implemented in cuPyNumeric, and does it scale across multiple GPUs?"

The output is markdown rather than JSON because the only consumer is an
LLM agent (no Python code parses it); markdown compresses the 13-field
JSON to a one-glyph-per-line tier list that fits roughly 4-5x more
content into the same context budget while remaining trivially grep-able.

Each table row has four cells:
    1. numpy.<name>           - always a link
    2. cupynumeric.<name>     - link to the generated per-API docs page when
                                the API is implemented; empty <ul><li></li></ul>
                                otherwise
    3. single-GPU/CPU         - one of the support tokens (see below) or empty
    4. multi-GPU/CPU          - one of the support tokens (see below) or empty

Support-column token meanings (the upstream table is migrating from numeric
codes to glyphs; both formats are accepted):
    "1" or "✓"   - works without problem in this configuration
    "2" or "❌"  - does not work in this configuration (the API is exposed
                   by cuPyNumeric, but using it in this config will fail or
                   fall back)
    "3" or "🟡"  - partial support; consult the per-API generated docs for
                   caveats. Historically the only partials appeared under
                   Discrete Fourier Transform, where multi-GPU usage is
                   limited to data-parallel axis-wise batching.
    empty        - not listed for this configuration (treated as not
                   supported)

The emitted markdown collapses those tokens to a four-symbol vocabulary
keyed on the (single_gpu, multi_gpu) pair:
    ✓✓  implemented and works on multi-GPU (the best path; implies single-GPU)
    ✓   implemented but single-GPU/CPU only (caveats multi-node)
    🟡  partial support — see the per-line note
    ✗   not implemented on the cuPyNumeric distributed path.
        Behavior on call is version-specific (some unsupported APIs
        route through host NumPy, others raise an exception) —
        either way, hot-path use is a migration blocker

Run as:
    python fetch_api_support.py --default-path     # writes this skill's manifest
    python fetch_api_support.py --docs-nvidia-url --default-path   # use docs.nvidia.com
    python fetch_api_support.py --out a.md --out b.md    # explicit paths
    python fetch_api_support.py --print            # dump to stdout

Writes a single markdown manifest into this skill's `assets/api-support.md`.
Standalone - no other skills or files depend on it; Python stdlib only.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

SOURCE_URL = "https://nv-legate.github.io/cupynumeric/api/comparison.html"
_DOCS_NVIDIA_URL = (
    "https://docs.nvidia.com/cupynumeric/latest/api/comparison.html"
)

# Upstream is mid numeric->glyph transition; both formats are accepted.
# Extend these sets when upstream introduces a new glyph.
_SUPPORTED_TOKENS = frozenset({"1", "3", "✓", "🟡"})
_PARTIAL_TOKENS = frozenset({"3", "🟡"})

# Upstream uses "3"/"🟡" primarily for FFT today, where multi-GPU is limited
# to data-parallel axis-wise batching.
PARTIAL_FFT_NOTE = "multi-GPU partial: data-parallel axis-wise batching only"

_SCRIPT_DIR = Path(__file__).resolve().parent
_DEFAULT_OUTPUT = _SCRIPT_DIR.parent / "assets" / "api-support.md"

# Network and sanity-check thresholds.
_HTTP_TIMEOUT_SECONDS = 30.0
# If fewer than this many APIs parse as implemented, the upstream HTML format
# probably changed; warn against trusting the manifest.
_MIN_EXPECTED_IMPLEMENTED = 100
# Historical counts, surfaced in the warning so the operator has a baseline.
_HISTORICAL_IMPLEMENTED = 412
_HISTORICAL_TOTAL = 616

# Each comparison-table row has four columns, in this order.
_EXPECTED_CELL_COUNT = 4
_COL_NUMPY, _COL_CUPYNUMERIC, _COL_SINGLE_GPU, _COL_MULTI_GPU = 0, 1, 2, 3


@dataclass
class ApiEntry:
    numpy_name: str
    section: str
    implemented: bool
    cupynumeric_name: Optional[str]
    single_gpu: bool
    multi_gpu: bool
    # Raw upstream tokens; kept so the HTML-parser tests can pin the
    # numeric->glyph token-format transition.
    single_gpu_token: Optional[str]
    multi_gpu_token: Optional[str]
    # `partial_*` always implies the matching support boolean above is True.
    partial_single_gpu: bool
    partial_multi_gpu: bool
    docs_url: Optional[str]
    notes: Optional[str]

    @property
    def single_gpu_only(self) -> bool:
        return self.single_gpu and not self.multi_gpu


@dataclass
class _Cell:
    texts: list[str] = field(default_factory=list)
    hrefs: list[str] = field(default_factory=list)


@dataclass
class _Row:
    cells: list[_Cell] = field(default_factory=list)


class _ComparisonParser(HTMLParser):
    """Walk the comparison HTML and collect (section, row) pairs.

    The page nests `<section>` blocks; each carries an `id`. The most recent
    `<section>` whose id matches one of the known module groups is the row's
    section. Tables outside those sections are ignored.
    """

    SECTIONS = {
        "module-level": "Module-Level",
        "multi-dimensional-array": "Multi-Dimensional Array",
        "linear-algebra": "Linear Algebra",
        "discrete-fourier-transform": "Discrete Fourier Transform",
        "random-sampling": "Random Sampling",
    }

    def __init__(self) -> None:
        super().__init__()
        self._section_stack: list[Optional[str]] = []
        self._in_table = False
        self._in_thead = False
        self._in_row = False
        self._in_cell = False
        self._cur_row: Optional[_Row] = None
        self._cur_cell: Optional[_Cell] = None
        self.rows: list[tuple[str, _Row]] = []

    @property
    def _current_section(self) -> Optional[str]:
        for sec in reversed(self._section_stack):
            if sec is not None:
                return sec
        return None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, Optional[str]]]
    ) -> None:
        attr_dict = {k: v for k, v in attrs}
        if tag == "section":
            sec_id = attr_dict.get("id")
            self._section_stack.append(
                self.SECTIONS.get(sec_id) if sec_id else None
            )
            return
        if tag == "table":
            self._in_table = True
            return
        if not self._in_table:
            return
        if tag == "thead":
            self._in_thead = True
            return
        if tag == "tr" and not self._in_thead:
            self._in_row = True
            self._cur_row = _Row()
            return
        if tag in ("td", "th") and self._in_row:
            self._in_cell = True
            self._cur_cell = _Cell()
            return
        if tag == "a" and self._in_cell:
            href = attr_dict.get("href")
            if href:
                assert self._cur_cell is not None
                self._cur_cell.hrefs.append(href)
            return

    def handle_endtag(self, tag: str) -> None:
        if tag == "section":
            if self._section_stack:
                self._section_stack.pop()
            return
        if tag == "table":
            self._in_table = False
            self._in_thead = False
            return
        if tag == "thead":
            self._in_thead = False
            return
        if tag == "tr" and self._in_row:
            sec = self._current_section
            if sec and self._cur_row and self._cur_row.cells:
                self.rows.append((sec, self._cur_row))
            self._in_row = False
            self._cur_row = None
            return
        if tag in ("td", "th") and self._in_cell:
            assert self._cur_row is not None and self._cur_cell is not None
            self._cur_row.cells.append(self._cur_cell)
            self._in_cell = False
            self._cur_cell = None
            return

    def handle_data(self, data: str) -> None:
        if not self._in_cell:
            return
        text = data.strip()
        if not text:
            return
        assert self._cur_cell is not None
        self._cur_cell.texts.append(text)


def _classify_row(row: _Row, base_url: str):
    """Return classification tuple, or None to skip a malformed row."""
    if len(row.cells) < _EXPECTED_CELL_COUNT:
        return None
    np_cell = row.cells[_COL_NUMPY]
    cn_cell = row.cells[_COL_CUPYNUMERIC]
    sg_cell = row.cells[_COL_SINGLE_GPU]
    mg_cell = row.cells[_COL_MULTI_GPU]

    numpy_name = next(
        (t for t in np_cell.texts if t.startswith("numpy.")), None
    )
    if numpy_name is None:
        return None

    cupy_name = next(
        (t for t in cn_cell.texts if t.startswith("cupynumeric.")), None
    )
    implemented = cupy_name is not None

    docs_url: Optional[str] = None
    if implemented and cn_cell.hrefs:
        docs_url = urllib.parse.urljoin(base_url, cn_cell.hrefs[0])

    sg_token = next((t for t in sg_cell.texts if t), None)
    mg_token = next((t for t in mg_cell.texts if t), None)

    single_gpu = sg_token in _SUPPORTED_TOKENS
    multi_gpu = mg_token in _SUPPORTED_TOKENS
    partial_sg = sg_token in _PARTIAL_TOKENS
    partial_mg = mg_token in _PARTIAL_TOKENS

    return (
        numpy_name,
        implemented,
        cupy_name,
        single_gpu,
        multi_gpu,
        sg_token,
        mg_token,
        partial_sg,
        partial_mg,
        docs_url,
    )


def _notes_for(partial_sg: bool, partial_mg: bool) -> Optional[str]:
    if partial_sg or partial_mg:
        return PARTIAL_FFT_NOTE
    return None


def parse_comparison(html: str, base_url: str = SOURCE_URL) -> list[ApiEntry]:
    parser = _ComparisonParser()
    parser.feed(html)
    parser.close()
    out: list[ApiEntry] = []
    for section, row in parser.rows:
        classified = _classify_row(row, base_url)
        if classified is None:
            continue
        (
            numpy_name,
            implemented,
            cupy_name,
            single_gpu,
            multi_gpu,
            sg_token,
            mg_token,
            partial_sg,
            partial_mg,
            docs_url,
        ) = classified
        out.append(
            ApiEntry(
                numpy_name=numpy_name,
                section=section,
                implemented=implemented,
                cupynumeric_name=cupy_name,
                single_gpu=single_gpu,
                multi_gpu=multi_gpu,
                single_gpu_token=sg_token,
                multi_gpu_token=mg_token,
                partial_single_gpu=partial_sg,
                partial_multi_gpu=partial_mg,
                docs_url=docs_url,
                notes=_notes_for(partial_sg, partial_mg),
            )
        )
    return out


def fetch_html(
    url: str = SOURCE_URL, timeout: float = _HTTP_TIMEOUT_SECONDS
) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "cupynumeric-skill-fetcher/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return raw.decode("utf-8", errors="replace")


_WRAP_WIDTH = 120


def _wrap_glyph_line(
    glyph: str, names: list[str], width: int = _WRAP_WIDTH
) -> list[str]:
    """Emit one or more `glyph name, name, name` lines, wrapped at `width`.

    Continuation lines repeat the glyph so any single line of the output
    is self-describing (the agent never has to scroll up to figure out
    which tier a name belongs to). Names that are individually longer
    than `width` get their own line.
    """
    if not names:
        return []
    out: list[str] = []
    prefix = f"{glyph} "
    cur = prefix
    for name in names:
        sep = "" if cur == prefix else ", "
        if cur != prefix and len(cur) + len(sep) + len(name) > width:
            out.append(cur)
            cur = prefix + name
        else:
            cur += sep + name
    if cur != prefix:
        out.append(cur)
    return out


def render_markdown(entries: list[ApiEntry], source_url: str) -> str:
    """Render the API support manifest as compact markdown.

    Sections preserve the upstream order. Within each section the tiers
    are emitted in this fixed order:
        ✓✓ multi-GPU (best path)
        ✓  single-GPU only
        🟡 partial (one entry per line, with note)
        ✗  not implemented
    """
    fetched_at = _dt.datetime.now(_dt.timezone.utc).isoformat(
        timespec="seconds"
    )

    total = len(entries)
    implemented = sum(1 for e in entries if e.implemented)
    multi_gpu_count = sum(1 for e in entries if e.multi_gpu)
    single_only_count = sum(1 for e in entries if e.single_gpu_only)
    partial_count = sum(
        1 for e in entries if e.partial_single_gpu or e.partial_multi_gpu
    )
    not_impl_count = total - implemented

    lines: list[str] = [
        "# cuPyNumeric API support",
        f"Source: {source_url}",
        f"Fetched: {fetched_at}",
        (
            f"Counts: {total} total · {implemented} implemented · "
            f"{multi_gpu_count} multi-GPU · {single_only_count} single-GPU only · "
            f"{partial_count} partial · {not_impl_count} not implemented"
        ),
        "",
        "Legend",
        "- `✓✓` implemented and works on multi-GPU (the best path; implies single-GPU)",
        "- `✓`  implemented but single-GPU/CPU only (caveats multi-node)",
        "- `🟡` partial support — see the per-line note",
        "- `✗`  not implemented on the cuPyNumeric distributed path. "
        "Behavior on call is version-specific (some unsupported APIs route "
        "through host NumPy, others raise an exception) — either way, "
        "hot-path use is a migration blocker",
        "",
        (
            "The cuPyNumeric name is `cupynumeric.<tail>` of the NumPy name "
            "(e.g. `numpy.fft.fft` ↔ `cupynumeric.fft.fft`)."
        ),
        "",
    ]

    section_order = list(_ComparisonParser.SECTIONS.values())
    by_section: dict[str, list[ApiEntry]] = {s: [] for s in section_order}
    for e in entries:
        by_section.setdefault(e.section, []).append(e)

    for section in section_order:
        bucket = by_section.get(section) or []
        if not bucket:
            continue

        # Tier buckets. A "partial" entry is broken out on its own line so its
        # note is preserved; remove those from the full-support buckets.
        partials = [
            e for e in bucket if e.partial_single_gpu or e.partial_multi_gpu
        ]
        partial_names = {e.numpy_name for e in partials}
        multi_names = [
            e.numpy_name
            for e in bucket
            if e.multi_gpu and e.numpy_name not in partial_names
        ]
        single_names = [
            e.numpy_name
            for e in bucket
            if e.single_gpu_only and e.numpy_name not in partial_names
        ]
        missing_names = [e.numpy_name for e in bucket if not e.implemented]

        impl_count = sum(1 for e in bucket if e.implemented)
        lines.append(
            f"## {section} ({impl_count} of {len(bucket)} implemented)"
        )
        if multi_names:
            lines.extend(_wrap_glyph_line("✓✓", multi_names))
        if single_names:
            lines.extend(_wrap_glyph_line("✓ ", single_names))
        for p in partials:
            note = p.notes or "partial"
            lines.append(f"🟡 {p.numpy_name} — {note}")
        if missing_names:
            lines.extend(_wrap_glyph_line("✗ ", missing_names))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--url",
        default=None,
        help=(
            "Source URL. Defaults to the GitHub Pages mirror "
            f"({SOURCE_URL}). Override with --docs-nvidia-url or with an "
            "explicit URL."
        ),
    )
    ap.add_argument(
        "--docs-nvidia-url",
        action="store_true",
        help=(
            "Fetch from the long-term canonical URL "
            f"({_DOCS_NVIDIA_URL}) instead of the GitHub Pages mirror."
        ),
    )
    ap.add_argument(
        "--out",
        type=Path,
        action="append",
        default=None,
        help="Write markdown manifest to this path. Repeatable to write multiple copies.",
    )
    ap.add_argument(
        "--default-path",
        action="store_true",
        help="Write the manifest to this skill's assets/api-support.md.",
    )
    ap.add_argument(
        "--print", action="store_true", help="Also print markdown to stdout."
    )
    ap.add_argument(
        "--from-file",
        type=Path,
        default=None,
        help="Skip fetch; read HTML from a local file.",
    )
    args = ap.parse_args(argv)

    if args.url is not None:
        source_url = args.url
    elif args.docs_nvidia_url:
        source_url = _DOCS_NVIDIA_URL
    else:
        source_url = SOURCE_URL

    out_paths: list[Path] = list(args.out) if args.out else []
    if args.default_path:
        out_paths.append(_DEFAULT_OUTPUT)

    if args.from_file is not None:
        html = args.from_file.read_text(encoding="utf-8")
    else:
        html = fetch_html(source_url)

    entries = parse_comparison(html, base_url=source_url)
    if not entries:
        print(
            "ERROR: no rows parsed from "
            f"{source_url}; the upstream HTML structure may have changed, "
            "or the table may use a token format the scraper does not "
            "recognize. Try --docs-nvidia-url for the long-term mirror, "
            "or update _SUPPORTED_TOKENS / _PARTIAL_TOKENS if upstream "
            "introduced a new glyph.",
            file=sys.stderr,
        )
        return 2

    implemented = sum(1 for e in entries if e.implemented)
    if implemented < _MIN_EXPECTED_IMPLEMENTED:
        print(
            "WARNING: only "
            f"{implemented} APIs marked implemented "
            f"(historical baseline is ~{_HISTORICAL_IMPLEMENTED} of "
            f"~{_HISTORICAL_TOTAL}). The upstream page may "
            "have changed format or the scraper may be misclassifying "
            "tokens. Inspect the manifest before trusting it.",
            file=sys.stderr,
        )

    text = render_markdown(entries, source_url)

    not_impl = len(entries) - implemented
    single_only = sum(1 for e in entries if e.single_gpu_only)
    partial = sum(
        1 for e in entries if e.partial_single_gpu or e.partial_multi_gpu
    )
    for path in out_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(
            f"wrote {len(entries)} entries to {path}  "
            f"({implemented} implemented, "
            f"{not_impl} not implemented, "
            f"{single_only} single-GPU only, "
            f"{partial} partial)",
            file=sys.stderr,
        )
    if args.print or not out_paths:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
