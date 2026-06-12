#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build a trusted timing-only trace artifact from target-ref trace output.

The E2E script under test controls NEMOCLAW_TRACE_DIR, so the reusable trusted
workflow must never upload that raw directory from a secret-bearing job. This
helper reads candidate NemoClaw trace JSON files, validates the minimal timing
shape needed by the scorecard, and writes a single allowlisted summary that
contains no attributes, events, file names, prompts, environment dumps, or raw
error messages.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "nemoclaw.trace_timing.v1"
OUTPUT_FILE = "cloud-onboard-trace-timing-summary.json"
ONBOARD_ROOT_SPAN = "nemoclaw.onboard"
ONBOARD_PHASE_PREFIX = "nemoclaw.onboard.phase."
MAX_JSON_FILES = 100
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_SLOWEST_SPANS = 10
TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
STATUS_VALUES = {"OK", "ERROR", "UNSET"}


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def safe_status(value: Any) -> str:
    return value if isinstance(value, str) and value in STATUS_VALUES else "UNSET"


def safe_span_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    if value == ONBOARD_ROOT_SPAN or value.startswith(ONBOARD_PHASE_PREFIX):
        return value
    return None


def iter_json_files(source: Path) -> list[Path]:
    if not source.exists():
        return []
    if source.is_file():
        return [source] if source.suffix == ".json" and not source.is_symlink() else []
    if not source.is_dir() or source.is_symlink():
        return []
    files: list[Path] = []
    for path in sorted(source.rglob("*.json")):
        if path.is_file() and not path.is_symlink():
            files.append(path)
            if len(files) >= MAX_JSON_FILES:
                break
    return files


def load_json(path: Path) -> Any | None:
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def first_dict(values: Any) -> dict[str, Any]:
    if isinstance(values, list) and values and isinstance(values[0], dict):
        return values[0]
    return {}


def extract_spans(artifact: Any) -> list[dict[str, Any]]:
    if not isinstance(artifact, dict):
        return []
    resource = first_dict(artifact.get("resource_spans"))
    scope = first_dict(resource.get("scope_spans"))
    spans = scope.get("spans", [])
    return [span for span in spans if isinstance(span, dict)] if isinstance(spans, list) else []


def extract_candidate(artifact: Any) -> dict[str, Any] | None:
    if not isinstance(artifact, dict):
        return None
    spans = extract_spans(artifact)
    if not any(span.get("name") == ONBOARD_ROOT_SPAN for span in spans):
        return None

    summary = artifact.get("summary") if isinstance(artifact.get("summary"), dict) else {}
    total_ms = finite_number(summary.get("total_duration_ms"))
    if total_ms is None:
        return None

    phases: dict[str, float] = {}
    for span in spans:
        name = span.get("name")
        duration_ms = finite_number(span.get("duration_ms"))
        if isinstance(name, str) and name.startswith(ONBOARD_PHASE_PREFIX) and duration_ms is not None:
            phases[name] = phases.get(name, 0.0) + duration_ms

    if not phases:
        return None

    slowest_spans = []
    for span in summary.get("slowest_spans", []) if isinstance(summary.get("slowest_spans"), list) else []:
        if not isinstance(span, dict):
            continue
        name = safe_span_name(span.get("name"))
        duration_ms = finite_number(span.get("duration_ms"))
        if name is None or duration_ms is None:
            continue
        slowest_spans.append(
            {
                "name": name,
                "duration_ms": round(duration_ms, 3),
                "status": safe_status(span.get("status")),
            }
        )
        if len(slowest_spans) >= MAX_SLOWEST_SPANS:
            break

    trace_id = summary.get("trace_id")
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id if isinstance(trace_id, str) and TRACE_ID_RE.fullmatch(trace_id) else None,
        "total_duration_ms": round(total_ms, 3),
        "phases": {name: round(phases[name], 3) for name in sorted(phases)},
        "slowest_spans": slowest_spans,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: sanitize-trace-artifacts.py <source-file-or-dir> <output-dir>", file=sys.stderr)
        return 2

    source_input = Path(argv[1]).absolute()
    if source_input.is_symlink():
        print("trace source must not be a symlink", file=sys.stderr)
        return 2

    source = source_input.resolve(strict=False)
    output_dir = Path(argv[2]).absolute()
    if source == output_dir.resolve(strict=False):
        print("trace source and trusted output directory must be distinct", file=sys.stderr)
        return 2

    if output_dir.exists() or output_dir.is_symlink():
        if output_dir.is_symlink():
            output_dir.unlink()
        elif output_dir.is_dir():
            shutil.rmtree(output_dir)
        else:
            output_dir.unlink()
    output_dir.mkdir(parents=True, mode=0o700)

    candidates = []
    for json_file in iter_json_files(source):
        artifact = load_json(json_file)
        candidate = extract_candidate(artifact)
        if candidate is not None:
            candidates.append(candidate)

    if not candidates:
        print("No valid NemoClaw onboard trace found; no timing summary emitted.")
        return 0

    selected = max(candidates, key=lambda item: item["total_duration_ms"])
    output = output_dir / OUTPUT_FILE
    output.write_text(json.dumps(selected, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(output, 0o600)
    print(f"Wrote trusted trace timing summary: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
