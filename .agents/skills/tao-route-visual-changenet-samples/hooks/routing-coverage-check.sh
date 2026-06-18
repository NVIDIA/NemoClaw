#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify every label in the input gaps_parquet appears in the report's Per-Label
# Routing table. A silently dropped label is the single most likely failure mode of this
# skill, so we cross-check against the actual parquet rather than trusting the report.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *Routing_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")

  # Locate the input gaps parquet. Prefer the routing_summary path if it points to one;
  # otherwise look for the most plausible parent gap-analysis result.
  candidates=()
  for p in "$report_dir/../gaps.parquet" \
           "$report_dir/../../gaps.parquet" \
           "$report_dir/../../rca_results/"*"/gaps.parquet"; do
    [ -f "$p" ] && candidates+=("$p")
  done
  gaps_parquet=""
  if [ ${#candidates[@]} -gt 0 ]; then
    gaps_parquet="${candidates[0]}"
  fi
  [ -z "$gaps_parquet" ] && exit 0

  python3 - "$gaps_parquet" "$CLAUDE_FILE_PATH" << 'PYEOF'
import sys, re

gaps_path, report_path = sys.argv[1], sys.argv[2]
try:
    import pandas as pd
except ImportError:
    sys.exit(0)

try:
    df = pd.read_parquet(gaps_path)
except Exception:
    sys.exit(0)

if "label" not in df.columns:
    sys.exit(0)

label_counts = df["label"].astype(str).str.upper().value_counts().to_dict()
if not label_counts:
    sys.exit(0)

with open(report_path) as f:
    report = f.read()
report_upper = report.upper()

# Extract just the Per-Label Routing section; mention elsewhere is not enough — the
# decision table is the auditable artifact.
plr_m = re.search(r'## .*?PER-LABEL ROUTING(.*?)(?=\n## )', report_upper, re.DOTALL)
plr = plr_m.group(1) if plr_m else ""

warnings = []
for label, count in sorted(label_counts.items()):
    if label not in plr:
        warnings.append(f"MISSING FROM ROUTING TABLE: '{label}' ({count} rows) — every input label must have a row in §3 Per-Label Routing Decisions.")
        continue
    # Verify the row also reports the count.
    row_pat = rf'\|[^|]*{re.escape(label)}[^|]*\|[^|]*\b{count}\b'
    if not re.search(row_pat, plr):
        warnings.append(f"COUNT MISMATCH: '{label}' has {count} rows in gaps.parquet but no row in the routing table reports that count.")

# Cross-check: the Verdict's total should match len(df).
total = sum(label_counts.values())
v_m = re.search(r'## 1.*?VERDICT(.*?)(?=\n## )', report_upper, re.DOTALL)
if v_m and str(total) not in v_m.group(1):
    warnings.append(f"TOTAL MISMATCH: input gaps.parquet has {total} rows but Verdict does not report this number.")

if warnings:
    print("ROUTING COVERAGE GAPS:")
    for w in warnings:
        print(f"  - {w}")
PYEOF
fi
