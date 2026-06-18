#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Deep defect coverage validation — not just mentioned, but actually analyzed
# Verifies each defect type has: score data, sample count, failure mode, visual description,
# training coverage status, and appears in counterfactual analysis
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  inference_csv=""

  for candidate in "$report_dir/inference/inference.csv" "$report_dir/../inference/inference.csv"; do
    [ -f "$candidate" ] && inference_csv="$candidate" && break
  done
  [ -z "$inference_csv" ] && exit 0

  # Use Python for the deep analysis — bash string matching is too crude
  python3 - "$inference_csv" "$CLAUDE_FILE_PATH" << 'PYEOF'
import csv, sys, re

inference_csv = sys.argv[1]
report_path = sys.argv[2]

# Parse defect types and their counts from CSV
defect_info = {}
with open(inference_csv) as f:
    reader = csv.DictReader(f)
    for row in reader:
        label = row.get('label', row.get('Label', ''))
        if label and label.upper() != 'PASS':
            if label not in defect_info:
                defect_info[label] = {'count': 0, 'scores': []}
            defect_info[label]['count'] += 1
            try:
                score = float(row.get('siamese_score', row.get('score', 0)))
                defect_info[label]['scores'].append(score)
            except (ValueError, TypeError):
                pass

if not defect_info:
    sys.exit(0)

with open(report_path) as f:
    report = f.read()
report_lower = report.lower()

warnings = []

for dtype, info in sorted(defect_info.items()):
    issues = []
    dtype_lower = dtype.lower()
    dtype_pattern = re.escape(dtype)

    # Check 1: Is the defect type mentioned at all?
    if dtype_lower not in report_lower:
        warnings.append(f"MISSING: '{dtype}' ({info['count']} samples) not mentioned anywhere in report.")
        continue

    # Check 2: Does a table row contain this defect type with a score?
    # Look for table rows like "| Missing | 22 | ... | 0.212 |"
    table_pattern = rf'\|[^|]*{dtype_pattern}[^|]*\|.*\d+\.\d+'
    if not re.search(table_pattern, report, re.IGNORECASE):
        issues.append("no table row with score data")

    # Check 3: Is the sample count mentioned near the defect type?
    count = info['count']
    # Look for the count within 200 chars of the defect type name
    for m in re.finditer(dtype_pattern, report, re.IGNORECASE):
        nearby = report[max(0, m.start()-100):m.end()+200]
        if str(count) in nearby or (count == 1 and re.search(r'\b1\b', nearby)):
            break
    else:
        issues.append(f"sample count ({count}) not found near defect type mention")

    # Check 4: Is it discussed in the failure mode clustering section?
    fm_section = ""
    fm_match = re.search(r'(?:Failure Mode|3\.2)', report)
    if fm_match:
        fm_section = report[fm_match.start():fm_match.start()+5000]
    if fm_section and dtype_lower not in fm_section.lower():
        issues.append("not in Failure Mode Clustering section")

    # Check 5: Is training coverage status mentioned? (In Training? Yes/No)
    training_pattern = rf'{dtype_pattern}.*(?:in train|not in train|zero train|never seen|unseen|0 sample)'
    if not re.search(training_pattern, report, re.IGNORECASE):
        # Also check coverage matrix tables
        coverage_pattern = rf'{dtype_pattern}.*(?:Yes|No|\b0\b|\b1\b).*(?:Yes|No|\b0\b)'
        if not re.search(coverage_pattern, report, re.IGNORECASE):
            issues.append("training coverage status not documented")

    # Check 6: Does it appear in the per-defect-type score table?
    score_section = ""
    score_match = re.search(r'Per-Defect-Type', report)
    if score_match:
        score_section = report[score_match.start():score_match.start()+2000]
    if score_section and dtype_lower not in score_section.lower():
        issues.append("missing from Per-Defect-Type score table")

    # Check 7: If there are scores, verify at least one score appears in report
    if info['scores']:
        mean_score = sum(info['scores']) / len(info['scores'])
        score_str = f"{mean_score:.3f}"[:5]  # first 5 chars like "0.212"
        if score_str not in report:
            # Try with 2 decimal places
            score_str2 = f"{mean_score:.2f}"
            if score_str2 not in report:
                issues.append(f"mean score ({mean_score:.3f}) not found in report")

    if issues:
        warnings.append(f"SHALLOW on '{dtype}' ({info['count']} samples): {'; '.join(issues)}")

# Check 8: Cross-check — are ALL defect types in the Recommended Fixes?
fixes_match = re.search(r'Recommended Fixes', report)
if fixes_match:
    fixes_section = report[fixes_match.start():]
    types_in_fixes = sum(1 for d in defect_info if d.lower() in fixes_section.lower())
    if types_in_fixes == 0:
        warnings.append("NO defect types appear in Recommended Fixes section. Fixes should address specific defect type failures.")

# Check 9: Verify total defect count appears in report
total_defects = sum(info['count'] for info in defect_info.values())
if str(total_defects) not in report:
    warnings.append(f"Total defect count ({total_defects}) not found in report.")

if warnings:
    print("DEFECT COVERAGE GAPS:")
    for w in warnings:
        print(f"  - {w}")

PYEOF
fi
