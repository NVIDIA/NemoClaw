#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Reduce raw NemoClaw traces to an allowlisted scorecard artifact.

The E2E target controls the raw trace directory, so CI must never upload it.
This script accepts only the onboard timing shape needed by the scorecard and
the final sandbox identity-settlement state needed for lifecycle diagnosis.
Timing and settlement keep their own trace provenance. The script writes a
single allowlisted summary without raw attributes, events, paths, prompts,
environment data, or error messages.

Source-of-truth note: raw trace shape is produced by src/lib/trace.ts
TraceArtifact. This reducer is intentionally narrower than that source schema:
raw traces remain useful local diagnostics, while CI only needs timing evidence.
If the producer grows an equivalent allowlisted artifact, this post-run reducer
can be removed in favor of that source artifact.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "nemoclaw.trace_timing.v1"
OUTPUT_FILE = "cloud-onboard-trace-timing-summary.json"
ONBOARD_ROOT_SPAN = "nemoclaw.onboard"
ONBOARD_PHASE_PREFIX = "nemoclaw.onboard.phase."
ONBOARD_PHASE_NAMES = {
    f"{ONBOARD_PHASE_PREFIX}preflight",
    f"{ONBOARD_PHASE_PREFIX}gateway",
    f"{ONBOARD_PHASE_PREFIX}provider_selection",
    f"{ONBOARD_PHASE_PREFIX}inference",
    f"{ONBOARD_PHASE_PREFIX}sandbox",
}
MAX_JSON_FILES = 100
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_SLOWEST_SPANS = 10
TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
STATUS_VALUES = {"OK", "ERROR", "UNSET"}
IDENTITY_SETTLEMENT_EVENT = "sandbox_create_identity_settlement"
CREATE_OPERATION_STATES = {"ready", "create_client_exited"}
IDENTITY_SETTLEMENT_STATES = {"matched", "failed"}
IDENTITY_CORRELATION_RE = re.compile(r"^[0-9a-f]{16}$")
TRACE_EVENT_TIME_RE = re.compile(r"^[1-9][0-9]{15,20}$")


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
    if value == ONBOARD_ROOT_SPAN or value in ONBOARD_PHASE_NAMES:
        return value
    return None


def iter_json_files(source: Path) -> tuple[list[Path], bool]:
    if not source.exists():
        return [], False
    if source.is_file():
        files = [source] if source.suffix == ".json" and not source.is_symlink() else []
        return files, False
    if not source.is_dir() or source.is_symlink():
        return [], False
    files: list[Path] = []
    for path in sorted(source.rglob("*.json")):
        if path.is_file() and not path.is_symlink():
            if len(files) >= MAX_JSON_FILES:
                return files, True
            files.append(path)
    return files, False


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


def extract_identity_settlements(
    spans: list[dict[str, Any]],
    expected_trace_id: str | None,
) -> list[tuple[int, dict[str, Any]]] | None:
    """Return ordered settlement evidence, or reject a malformed event."""
    settlements = []
    for span in spans:
        if safe_span_name(span.get("name")) is None:
            continue
        events = span.get("events", [])
        for event in events if isinstance(events, list) else []:
            if not isinstance(event, dict) or event.get("name") != IDENTITY_SETTLEMENT_EVENT:
                continue
            span_trace_id = span.get("trace_id")
            if (
                expected_trace_id is None
                or not isinstance(span_trace_id, str)
                or not TRACE_ID_RE.fullmatch(span_trace_id)
                or span_trace_id != expected_trace_id
            ):
                return None
            attributes = event.get("attributes")
            if not isinstance(attributes, dict):
                return None
            operation_state = attributes.get("create_operation_state")
            identity_state = attributes.get("identity_state")
            correlation = attributes.get("returned_identity_correlation")
            event_time = event.get("time_unix_nano")
            valid_operation_state = (
                isinstance(operation_state, str) and operation_state in CREATE_OPERATION_STATES
            )
            if not valid_operation_state:
                return None
            valid_identity_state = (
                isinstance(identity_state, str) and identity_state in IDENTITY_SETTLEMENT_STATES
            )
            if not valid_identity_state:
                return None
            if correlation is not None and (
                not isinstance(correlation, str) or not IDENTITY_CORRELATION_RE.fullmatch(correlation)
            ):
                return None
            if identity_state == "matched" and correlation is None:
                return None
            if not isinstance(event_time, str) or not TRACE_EVENT_TIME_RE.fullmatch(event_time):
                return None
            settlements.append(
                (
                    int(event_time),
                    {
                        "create_operation_state": operation_state,
                        "event_time_unix_nano": event_time,
                        "identity_state": identity_state,
                        "returned_identity_correlation": correlation,
                        "trace_id": expected_trace_id,
                    },
                )
            )
    return settlements


def select_latest_identity_settlement(
    settlements: list[tuple[int, dict[str, Any]]],
) -> tuple[dict[str, Any] | None, bool]:
    """Select the latest settlement and report whether the selection is unambiguous."""
    if not settlements:
        return None, True
    latest_time = max(timestamp for timestamp, _evidence in settlements)
    latest_evidence = [evidence for timestamp, evidence in settlements if timestamp == latest_time]
    if any(evidence != latest_evidence[0] for evidence in latest_evidence[1:]):
        return None, False
    return latest_evidence[0], True


def extract_candidate(artifact: Any) -> dict[str, Any] | None:
    """Extract the allowlisted subset of src/lib/trace.ts TraceArtifact."""
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
        if name in ONBOARD_PHASE_NAMES and duration_ms is not None:
            phases[name] = phases.get(name, 0.0) + duration_ms
    if not phases:
        return None

    slowest_spans = []
    raw_slowest = summary.get("slowest_spans", [])
    for span in raw_slowest if isinstance(raw_slowest, list) else []:
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
    candidate = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id if isinstance(trace_id, str) and TRACE_ID_RE.fullmatch(trace_id) else None,
        "total_duration_ms": round(total_ms, 3),
        "phases": {name: round(phases[name], 3) for name in sorted(phases)},
        "slowest_spans": slowest_spans,
    }
    return candidate


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: sanitize-trace-timing.py <source-file-or-dir> <output-dir>", file=sys.stderr)
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

    if output_dir.is_symlink() or (output_dir.exists() and not output_dir.is_dir()):
        print("trusted output must be a real directory", file=sys.stderr)
        return 2
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    candidates = []
    identity_settlements = []
    identity_settlements_valid = True
    source_files_valid = True
    json_files, source_truncated = iter_json_files(source)
    for json_file in json_files:
        artifact = load_json(json_file)
        if artifact is None:
            source_files_valid = False
            continue
        candidate = extract_candidate(artifact)
        if candidate is not None:
            candidates.append(candidate)
            settlements = extract_identity_settlements(
                extract_spans(artifact), candidate["trace_id"]
            )
            if settlements is None:
                identity_settlements_valid = False
            else:
                identity_settlements.extend(settlements)
    if not candidates:
        print("No valid NemoClaw onboard trace found; no timing summary emitted.")
        return 0

    selected = dict(max(candidates, key=lambda item: item["total_duration_ms"]))
    identity_settlement, selection_valid = select_latest_identity_settlement(
        identity_settlements
    )
    if (
        not source_files_valid
        or not identity_settlements_valid
        or source_truncated
        or not selection_valid
    ):
        selected["sandbox_identity_settlement_evidence"] = "invalid"
    elif identity_settlement is not None:
        selected["sandbox_identity_settlement"] = identity_settlement
    output = output_dir / OUTPUT_FILE
    if output.is_symlink():
        print("trusted timing summary must not be a symlink", file=sys.stderr)
        return 2
    output.write_text(json.dumps(selected, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(output, 0o600)
    print(f"Wrote trusted trace summary: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
