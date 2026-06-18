#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify every ground-truth label found in inference.csv shows up in the report's
# Weakness Distribution and Top-K tables. VCN labels are typically PASS / NO_PASS but the
# CSV may use any string convention — derive labels from the data, not from a hardcoded list.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  inference_csv=""
  for cand in "$report_dir/inference/inference.csv" \
              "$report_dir/../inference/inference.csv" \
              "$report_dir/../../inference/inference.csv"; do
    [ -f "$cand" ] && inference_csv="$cand" && break
  done
  [ -z "$inference_csv" ] && exit 0

  python3 - "$inference_csv" "$CLAUDE_FILE_PATH" << 'PYEOF'
import csv, sys, re

inference_csv, report_path = sys.argv[1], sys.argv[2]

label_counts = {}
with open(inference_csv) as f:
    reader = csv.DictReader(f)
    for row in reader:
        lbl = (row.get('label') or row.get('Label') or '').strip()
        if not lbl:
            continue
        label_counts[lbl] = label_counts.get(lbl, 0) + 1

if not label_counts:
    sys.exit(0)

with open(report_path) as f:
    report = f.read()
report_lower = report.lower()

warnings = []
for lbl, count in sorted(label_counts.items()):
    lbl_lower = lbl.lower()
    if lbl_lower not in report_lower:
        warnings.append(f"MISSING LABEL: '{lbl}' ({count} samples) not mentioned anywhere in the report.")
        continue

    # Verify the label appears in the Weakness Distribution table (§3) with a numeric column.
    wd_m = re.search(r'Weakness Distribution(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
    if wd_m:
        wd = wd_m.group(1)
        row_pat = rf'\|[^|]*{re.escape(lbl)}[^|]*\|.*\d+\.?\d*'
        if not re.search(row_pat, wd, re.IGNORECASE):
            warnings.append(f"NO DISTRIBUTION ROW: '{lbl}' has no row with numeric stats in Weakness Distribution.")

    # Verify the label appears in the Top-K table.
    tk_m = re.search(r'Top-K Weakest(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
    if tk_m and lbl_lower not in tk_m.group(1).lower():
        warnings.append(f"NO TOP-K ROWS: '{lbl}' has no rows in Top-K Weakest Samples.")

    # The total sample count should appear somewhere near the label name.
    found_count = False
    for m in re.finditer(re.escape(lbl), report, re.IGNORECASE):
        nearby = report[max(0, m.start() - 100):m.end() + 200]
        if str(count) in nearby:
            found_count = True
            break
    if not found_count:
        warnings.append(f"NO COUNT: total sample count ({count}) for '{lbl}' not reported near any mention.")

# Cross-check: at least PASS and one NO_PASS-equivalent label should be discussed in §5
spot_m = re.search(r'Visual Spot Check(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if spot_m:
    spot = spot_m.group(1).lower()
    labels_in_spot = [l for l in label_counts if l.lower() in spot]
    if len(labels_in_spot) < 2:
        warnings.append(f"SPOT CHECK INCOMPLETE: only {len(labels_in_spot)} label(s) covered in Visual Spot Check (need both PASS and NO_PASS sides).")

if warnings:
    print("VCN LABEL COVERAGE:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
fi
