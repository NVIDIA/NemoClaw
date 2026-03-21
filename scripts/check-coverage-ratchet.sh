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

# Extract actual coverage percentages from the vitest JSON summary.
actual_lines=$(python3 -c "import json; print(json.load(open('$SUMMARY_FILE'))['total']['lines']['pct'])")
actual_functions=$(python3 -c "import json; print(json.load(open('$SUMMARY_FILE'))['total']['functions']['pct'])")
actual_branches=$(python3 -c "import json; print(json.load(open('$SUMMARY_FILE'))['total']['branches']['pct'])")
actual_statements=$(python3 -c "import json; print(json.load(open('$SUMMARY_FILE'))['total']['statements']['pct'])")

# Extract thresholds.
thresh_lines=$(python3 -c "import json; print(json.load(open('$THRESHOLD_FILE'))['lines'])")
thresh_functions=$(python3 -c "import json; print(json.load(open('$THRESHOLD_FILE'))['functions'])")
thresh_branches=$(python3 -c "import json; print(json.load(open('$THRESHOLD_FILE'))['branches'])")
thresh_statements=$(python3 -c "import json; print(json.load(open('$THRESHOLD_FILE'))['statements'])")

TOLERANCE=1
failed=0
improved=0

check_metric() {
  local name="$1"
  local actual="$2"
  local threshold="$3"

  # python3 for float comparison
  local below
  below=$(python3 -c "print(1 if $actual < $threshold - $TOLERANCE else 0)")
  local above
  above=$(python3 -c "print(1 if $actual > $threshold + $TOLERANCE else 0)")

  if [ "$below" -eq 1 ]; then
    echo "FAIL: $name coverage is ${actual}%, threshold is ${threshold}% (tolerance ${TOLERANCE}%)"
    failed=1
  elif [ "$above" -eq 1 ]; then
    echo "IMPROVED: $name coverage is ${actual}%, above threshold ${threshold}%"
    improved=1
  else
    echo "OK: $name coverage is ${actual}% (threshold ${threshold}%)"
  fi
}

echo "=== Coverage Ratchet Check ==="
echo ""
check_metric "lines" "$actual_lines" "$thresh_lines"
check_metric "functions" "$actual_functions" "$thresh_functions"
check_metric "branches" "$actual_branches" "$thresh_branches"
check_metric "statements" "$actual_statements" "$thresh_statements"
echo ""

if [ "$failed" -eq 1 ]; then
  echo "Coverage regression detected. Add tests to bring coverage back above the threshold."
  exit 1
fi

if [ "$improved" -eq 1 ]; then
  # Compute new thresholds: floor of actual coverage to avoid flaky 0.01% diffs.
  new_json=$(python3 -c "
import json, math
new = {
    'lines': math.floor($actual_lines),
    'functions': math.floor($actual_functions),
    'branches': math.floor($actual_branches),
    'statements': math.floor($actual_statements),
}
# Only ratchet upward — never lower a threshold.
old = json.load(open('$THRESHOLD_FILE'))
for k in new:
    new[k] = max(new[k], old[k])
print(json.dumps(new, indent=2))
")
  echo "Coverage improved! Update ci/coverage-threshold.json to ratchet the floor:"
  echo ""
  echo "$new_json"
  echo ""
  echo "Run:  echo '$new_json' > ci/coverage-threshold.json"
fi

echo "Coverage ratchet passed."
