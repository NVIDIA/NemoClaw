#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the VCN gap analysis report has all 7 required sections with substantive content.
# Lighter than the ChangeNet equivalent — VCN does not have golden audits, defect types, or
# component-type clustering, so we check only the sections defined in SKILL.md.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  python3 - "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

with open(sys.argv[1]) as f:
    report = f.read()

# (heading_pattern, min_table_rows, [required_keywords])
checks = [
    ("Verdict",                  0, ["threshold", "kpi", "weak"]),
    ("Threshold Selection",      4, ["recall", "precision", "f1", "confusion"]),
    ("Weakness Distribution",    1, ["mean weakness", "misclassified"]),
    ("Top-K Weakest",            5, ["weakness", "siamese_score"]),
    ("Visual Spot Check",        5, ["![", "verdict"]),
    ("Per-Label Breakdown",      0, ["misclassified", "marginal"]),
    ("Recommended Actions",      0, ["relabel", "augment", "gaps.parquet"]),
]

warnings = []
for heading, min_rows, kws in checks:
    pat = rf'## .*?{re.escape(heading)}(.*?)(?=\n## |\Z)'
    m = re.search(pat, report, re.DOTALL | re.IGNORECASE)
    if not m:
        warnings.append(f"MISSING SECTION: '{heading}' not found.")
        continue
    body = m.group(1)
    if min_rows:
        rows = len([l for l in body.splitlines()
                    if l.strip().startswith('|') and '---' not in l])
        if rows < min_rows:
            warnings.append(f"SHALLOW: '{heading}' has only {rows} table rows (need {min_rows}+).")
    words = len(body.split())
    if words < 40:
        warnings.append(f"THIN: '{heading}' is only {words} words. Add the actual numbers from the analysis.")
    missing = [k for k in kws if not re.search(re.escape(k), body, re.IGNORECASE)]
    if missing:
        warnings.append(f"INCOMPLETE: '{heading}' missing key terms: {', '.join(missing)}")

# Cross-section: chosen threshold should appear in §1 Verdict and §2 Threshold Selection
verdict_m = re.search(r'## 1.*?Verdict(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
thr_m = re.search(r'Threshold Selection(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if verdict_m and thr_m:
    verdict_thr = re.findall(r'threshold[^0-9\-]*(-?\d+\.\d+)', verdict_m.group(1), re.IGNORECASE)
    sel_thr = re.findall(r'threshold[^0-9\-]*(-?\d+\.\d+)', thr_m.group(1), re.IGNORECASE)
    if verdict_thr and sel_thr and verdict_thr[0] != sel_thr[0]:
        warnings.append(f"INCONSISTENT THRESHOLD: Verdict says {verdict_thr[0]} but Threshold Selection says {sel_thr[0]}. The same value must appear in both.")

# Recommended Actions must reference gaps.parquet (the headline deliverable)
rec_m = re.search(r'Recommended Actions(.*)', report, re.DOTALL | re.IGNORECASE)
if rec_m and 'gaps.parquet' not in rec_m.group(1).lower():
    warnings.append("RECOMMENDATIONS: do not reference gaps.parquet. The augmentation queue is the headline deliverable.")

if warnings:
    print("VCN SECTION ISSUES:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
fi
