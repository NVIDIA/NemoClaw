#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the Mining_Report.md has all 7 required sections with substantive content.
# Toggle: export MINING_HOOKS=0 to disable

[[ "${MINING_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *Mining_Report.md ]]; then
  python3 - "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

with open(sys.argv[1]) as f:
    report = f.read()

# (heading_pattern, min_table_rows, [required_keywords])
checks = [
    ("Verdict",              0, ["targets", "mined", "encoder", "topn"]),
    ("Inputs",               2, ["target_parquet", "source_pool"]),
    ("Encoder Consistency",  0, ["model", "model_path", "match"]),
    ("Mining Run",           0, ["topn", "knn_metric", "filter_by_label"]),
    ("Per-Label Breakdown",  0, ["label"]),
    ("Output Sanity",        0, ["mined.parquet", "schema"]),
    ("Recommended Actions",  0, ["augment", "mined.parquet"]),
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
    if words < 30:
        warnings.append(f"THIN: '{heading}' is only {words} words. Add the actual numbers from the run.")
    missing = [k for k in kws if not re.search(re.escape(k), body, re.IGNORECASE)]
    if missing:
        warnings.append(f"INCOMPLETE: '{heading}' missing key terms: {', '.join(missing)}")

# Cross-section: Encoder Consistency must show match=yes (the most consequential pitfall)
ec_m = re.search(r'Encoder Consistency(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if ec_m and not re.search(r'match\??\s*[:=]?\s*(yes|true|✓|same)', ec_m.group(1), re.IGNORECASE):
    warnings.append("ENCODER CONSISTENCY UNCONFIRMED: section 3 must explicitly report Match=yes (or equivalent). Mining is meaningless when the two embedding steps used different encoders.")

# Recommended Actions must reference mined.parquet (the headline deliverable)
rec_m = re.search(r'Recommended Actions(.*)', report, re.DOTALL | re.IGNORECASE)
if rec_m and 'mined.parquet' not in rec_m.group(1).lower():
    warnings.append("RECOMMENDATIONS: do not reference mined.parquet. The mined source list is the headline deliverable.")

if warnings:
    print("MINING SECTION ISSUES:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
fi
