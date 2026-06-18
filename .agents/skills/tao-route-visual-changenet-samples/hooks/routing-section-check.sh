#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the routing report has all 6 required sections with substantive content.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *Routing_Report.md ]]; then
  python3 - "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

with open(sys.argv[1]) as f:
    report = f.read()

# (heading_pattern, min_table_rows, [required_keywords])
checks = [
    ("Verdict",                    0, ["mining", "anomalygen", "weak"]),
    ("Inputs",                     2, ["gaps_parquet", "source_pool"]),
    ("Per-Label Routing",          1, ["mining", "anomalygen", "routed to"]),
    ("Module-Level Summaries",     0, ["mining", "anomalygen", "pool"]),
    ("Dropped Labels",             0, []),
    ("Recommended Actions",        0, ["mining", "anomalygen"]),
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
    if words < 25:
        warnings.append(f"THIN: '{heading}' is only {words} words. Include the actual numbers / decisions.")
    missing = [k for k in kws if not re.search(re.escape(k), body, re.IGNORECASE)]
    if missing:
        warnings.append(f"INCOMPLETE: '{heading}' missing key terms: {', '.join(missing)}")

# §3 must have a "Routed To" verdict column and one of the canonical verdicts per row.
plr_m = re.search(r'## .*?Per-Label Routing(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if plr_m:
    plr = plr_m.group(1)
    canonical_verdicts = (
        r'mining only|anomalygen only|'
        r'mining\+anomalygen|'
        r'neither'
    )
    verdicts = re.findall(canonical_verdicts, plr, re.IGNORECASE)
    if not verdicts:
        warnings.append(
            "PER-LABEL TABLE: no rows use the canonical 'Routed To' verdicts "
            "(mining only / anomalygen only / mining+anomalygen / neither). "
            "Use one of these exactly."
        )

# §1 totals must match the §2 inputs sanity-check.
v_m = re.search(r'## .*?Verdict(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if v_m:
    v = v_m.group(1).lower()
    if 'mining' not in v or 'anomalygen' not in v:
        warnings.append("VERDICT: must state both subset row counts (Mining and AnomalyGen) at the top.")

# Dropped Labels section: empty table is acceptable but the section heading must exist.
dl_m = re.search(r'## .*?Dropped Labels(.*?)(?=\n## )', report, re.DOTALL | re.IGNORECASE)
if dl_m:
    dl = dl_m.group(1)
    has_table = any(l.strip().startswith('|') for l in dl.splitlines())
    if not has_table:
        warnings.append("DROPPED LABELS: section must contain a table (even if empty — show the schema so reviewers know nothing was dropped).")

if warnings:
    print("ROUTING SECTION ISSUES:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
fi
