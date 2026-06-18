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

"""
Calibration manager for Sparse4D batch size scaling.

Checks existing calibration sensor count and generates new calibration files
with circularly duplicated camera data when batch_size > available sensors.
Sensor IDs match the circular naming used by update_stream_sources.sh
(and discover_streams.sh): original names for i <= orig_count, "{name}_{i}"
for extra streams.

Subcommands:
    check   Print the sensor count in a calibration file (for shell: exits 0
            if sensors >= required batch size, exits 1 otherwise).
    ensure  Check-then-generate: reuse existing calibration if it has enough
            sensors, otherwise generate a new one with circular duplication.
            Writes the resolved calibration path to stdout (last line).

Usage from shell:
    # Query sensor count
    python3 scripts/calibration_manager.py check calibration.json

    # Check if calibration covers batch size 6
    python3 scripts/calibration_manager.py check calibration.json --batch-size 6

    # Ensure calibration for batch size 8 (generates if needed)
    CALIB=$(python3 scripts/calibration_manager.py ensure calibration.json \\
                --batch-size 8 --cache-dir /opt/storage/calibrations)
"""

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

# How many leading sensor rows to print before the elision when bs > MAPPING_INLINE_THRESHOLD.
MAPPING_LEAD_ROWS = 4
# How many trailing sensor rows to print after the elision.
MAPPING_TRAIL_ROWS = 2
# Print every row inline (no "...") when batch_size is at most this large; the
# leading + trailing windows already cover the entire mapping at this point.
MAPPING_INLINE_THRESHOLD = MAPPING_LEAD_ROWS + MAPPING_TRAIL_ROWS
# Minimum acceptable batch size.
MIN_BATCH_SIZE = 1


class CalibrationError(Exception):
    """Raised for malformed / unusable calibration input."""


def load_calibration(filepath: Path) -> dict[str, Any]:
    """Read a calibration JSON file.

    Raises CalibrationError on malformed JSON or read errors — callers
    catch this and convert to a clean stderr message + non-zero exit.
    """
    try:
        with open(filepath, "r") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise CalibrationError(f"malformed JSON in {filepath}: {e}") from e
    except OSError as e:
        raise CalibrationError(f"cannot read {filepath}: {e}") from e


def get_sensor_count(data: dict[str, Any]) -> int:
    return len(data.get("sensors", []))


def _sensor_ids(sensors: list[dict[str, Any]]) -> list[str]:
    try:
        return [s["id"] for s in sensors]
    except KeyError:
        raise CalibrationError(
            "sensor entry missing required 'id' field"
        ) from None


def generate_sensor_id(
    orig_names: list[str], target_index: int, orig_count: int
) -> str:
    """Mirror the circular ID scheme from update_stream_sources.sh.

    For i <= orig_count: use original name.
    For i  > orig_count: use "{orig_name}_{i}" (1-based i).
    """
    src_idx = target_index % orig_count
    if target_index < orig_count:
        return orig_names[src_idx]
    return f"{orig_names[src_idx]}_{target_index + 1}"


def generate_calibration(
    original_data: dict[str, Any], batch_size: int
) -> dict[str, Any]:
    """Generate calibration with circularly duplicated sensors.

    Sensor IDs follow the same naming convention as the stream source
    list (Camera, Camera_01, ..., Camera_5, Camera_01_6, ...).

    Raises CalibrationError if the source has no sensors to cycle from.
    """
    original_sensors = original_data.get("sensors") or []
    orig_count = len(original_sensors)
    if orig_count == 0:
        raise CalibrationError(
            "source calibration has no sensors — nothing to cycle from"
        )

    result = copy.deepcopy(original_data)
    orig_names = _sensor_ids(original_sensors)
    new_sensors = []

    for i in range(batch_size):
        src_idx = i % orig_count
        sensor = copy.deepcopy(original_sensors[src_idx])
        sensor["id"] = generate_sensor_id(orig_names, i, orig_count)
        new_sensors.append(sensor)

    result["sensors"] = new_sensors
    return result


def cmd_check(args: argparse.Namespace) -> int:
    filepath = Path(args.calibration_file)
    if not filepath.exists():
        print(f"error: file not found: {filepath}", file=sys.stderr)
        return 1

    try:
        data = load_calibration(filepath)
    except CalibrationError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    count = get_sensor_count(data)

    if args.batch_size is not None:
        if count >= args.batch_size:
            print(count)
            return 0
        print(count)
        return 1

    print(count)
    return 0


def cmd_ensure(args: argparse.Namespace) -> int:
    src_path = Path(args.calibration_file)
    if not src_path.exists():
        print(f"error: file not found: {src_path}", file=sys.stderr)
        return 1

    bs = args.batch_size
    if bs < MIN_BATCH_SIZE:
        print(
            f"error: batch_size must be >= {MIN_BATCH_SIZE}, got {bs}",
            file=sys.stderr,
        )
        return 1

    try:
        data = load_calibration(src_path)
    except CalibrationError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    count = get_sensor_count(data)

    if count >= bs:
        print(
            f"[calibration] Reusing {src_path} (sensors={count}, "
            f"batch_size={bs})",
            file=sys.stderr,
        )
        print(str(src_path))
        return 0

    cache_dir = Path(args.cache_dir) if args.cache_dir else src_path.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"calibration_{bs}.json"

    if cached.exists():
        try:
            cached_data = load_calibration(cached)
        except CalibrationError as e:
            # Stale / corrupt cache — fall through to regenerate.
            print(
                f"[calibration] Ignoring unreadable cache {cached}: {e}",
                file=sys.stderr,
            )
        else:
            cached_count = get_sensor_count(cached_data)
            if cached_count >= bs:
                print(
                    f"[calibration] Cache hit: {cached} "
                    f"(sensors={cached_count}, batch_size={bs})",
                    file=sys.stderr,
                )
                print(str(cached))
                return 0

    print(
        f"[calibration] Generating: {cached} "
        f"(source sensors={count}, target batch_size={bs})",
        file=sys.stderr,
    )
    try:
        new_data = generate_calibration(data, bs)
    except CalibrationError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    orig_names = _sensor_ids(data.get("sensors") or [])
    _print_mapping(new_data, orig_names, count, bs)

    with open(cached, "w") as f:
        json.dump(new_data, f, indent=4)
    print(
        f"[calibration] Saved: {cached} ({bs} sensors)",
        file=sys.stderr,
    )
    print(str(cached))
    return 0


def _print_mapping(
    new_data: dict[str, Any],
    orig_names: list[str],
    orig_count: int,
    bs: int,
) -> None:
    sensors = new_data["sensors"]

    def row(i: int) -> None:
        print(
            f"  {sensors[i]['id']} <- {orig_names[i % orig_count]}",
            file=sys.stderr,
        )

    # When the leading window plus the trailing window already cover every
    # row, print everything inline — a "..." separator would be misleading
    # since nothing is actually being elided.
    if bs <= MAPPING_INLINE_THRESHOLD:
        for i in range(bs):
            row(i)
        return

    # bs > MAPPING_INLINE_THRESHOLD: print the head, "...", then the tail.
    for i in range(MAPPING_LEAD_ROWS):
        row(i)
    print("  ...", file=sys.stderr)
    for i in range(bs - MAPPING_TRAIL_ROWS, bs):
        row(i)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sparse4D calibration manager: check or ensure "
        "calibration covers the required batch size."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser(
        "check",
        help="Print sensor count; exit 0 if >= batch_size, 1 otherwise.",
    )
    p_check.add_argument("calibration_file", help="Path to calibration JSON")
    p_check.add_argument(
        "--batch-size", "-b", type=int, default=None,
        help="Required batch size (omit to just print count)",
    )

    p_ensure = sub.add_parser(
        "ensure",
        help="Ensure calibration exists for batch_size; generate if needed. "
        "Prints resolved path to stdout.",
    )
    p_ensure.add_argument("calibration_file", help="Source calibration JSON")
    p_ensure.add_argument(
        "--batch-size", "-b", type=int, required=True,
        help="Required batch size",
    )
    p_ensure.add_argument(
        "--cache-dir", type=str, default=None,
        help="Directory for cached calibration_{N}.json files "
        "(default: same dir as source)",
    )

    args = parser.parse_args()
    if args.command == "check":
        return cmd_check(args)
    elif args.command == "ensure":
        return cmd_ensure(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
