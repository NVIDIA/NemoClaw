#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compares Vitest coverage output against ci/coverage-threshold.json.
# Fails if any metric drops below the threshold (with 1% tolerance).
# Prints updated thresholds when coverage improves, so contributors
# can update the file and ratchet the floor upward.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THRESHOLD_FILE="$REPO_ROOT/ci/coverage-threshold.json"
SUMMARY_FILE="$REPO_ROOT/nemoclaw/coverage/coverage-summary.json"

if [ ! -f "$THRESHOLD_FILE" ]; then
  echo "ERROR: Threshold file not found: $THRESHOLD_FILE"
  exit 1
fi

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "ERROR: Coverage summary not found: $SUMMARY_FILE"
  echo "Run 'npx vitest run --coverage' in nemoclaw/ first."
  exit 1
fi

# Single Python invocation handles all parsing, comparison, and output.
python3 - "$SUMMARY_FILE" "$THRESHOLD_FILE" <<'PY'
import json, math, sys

summary_path, threshold_path = sys.argv[1], sys.argv[2]
try:
    with open(summary_path) as f:
        summary = json.load(f)["total"]
    with open(threshold_path) as f:
        thresholds = json.load(f)
except (json.JSONDecodeError, KeyError) as e:
    print(f"ERROR: Failed to parse coverage files: {e}")
    sys.exit(1)

TOLERANCE = 1
METRICS = ["lines", "functions", "branches", "statements"]

failed = False
improved = False

print("=== Coverage Ratchet Check ===")
print()

for metric in METRICS:
    actual = summary[metric]["pct"]
    threshold = thresholds[metric]

    if actual < threshold - TOLERANCE:
        print(f"FAIL: {metric} coverage is {actual}%, threshold is {threshold}% (tolerance {TOLERANCE}%)")
        failed = True
    elif actual > threshold + TOLERANCE:
        print(f"IMPROVED: {metric} coverage is {actual}%, above threshold {threshold}%")
        improved = True
    else:
        print(f"OK: {metric} coverage is {actual}% (threshold {threshold}%)")

print()

if failed:
    print("Coverage regression detected. Add tests to bring coverage back above the threshold.")
    sys.exit(1)

if improved:
    new = {}
    for metric in METRICS:
        new[metric] = max(math.floor(summary[metric]["pct"]), thresholds[metric])
    new_json = json.dumps(new, indent=2)
    print("Coverage improved! Update ci/coverage-threshold.json to ratchet the floor:")
    print()
    print(new_json)
    print()
    print(f"Run:  echo '{new_json}' > ci/coverage-threshold.json")

print("Coverage ratchet passed.")
PY
