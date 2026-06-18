#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the routing skill produced all three filtered parquets, the summary, and
# that the parquets preserve the input schema. All three parquets must exist even if empty —
# downstream modules expect a file.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *Routing_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  warnings=""

  for required in mining_gaps.parquet anomalygen_gaps.parquet routing_summary.txt; do
    if [ ! -f "$report_dir/$required" ]; then
      warnings="${warnings}\n- MISSING ARTIFACT: $required not found next to Routing_Report.md. Both parquets must be written even when empty (downstream modules expect a file)."
    fi
  done

  # Validate parquet schemas: each output must contain at least the columns of the input.
  schema_check=$(python3 - "$report_dir" << 'PYEOF'
import os, sys
report_dir = sys.argv[1]
try:
    import pandas as pd
except ImportError:
    print("PANDAS_MISSING")
    sys.exit(0)

required_cols = {"filepath", "label"}
issues = []
totals = {}
for name in ("mining_gaps.parquet", "anomalygen_gaps.parquet"):
    p = os.path.join(report_dir, name)
    if not os.path.isfile(p):
        continue
    try:
        df = pd.read_parquet(p)
        missing = required_cols - set(df.columns)
        if missing:
            issues.append(f"{name}: missing columns {sorted(missing)}")
        totals[name] = len(df)
    except Exception as e:
        issues.append(f"{name}: unreadable ({e})")

for issue in issues:
    print(f"ISSUE:{issue}")
for name, n in totals.items():
    print(f"COUNT:{name}:{n}")
PYEOF
)

  if echo "$schema_check" | grep -q "^PANDAS_MISSING$"; then
    : # pandas not installed in the validation environment; skip schema check silently.
  else
    while IFS= read -r line; do
      case "$line" in
        ISSUE:*) warnings="${warnings}\n- BAD PARQUET: ${line#ISSUE:}" ;;
      esac
    done <<< "$schema_check"

    mn_count=$(echo "$schema_check" | sed -n 's|^COUNT:mining_gaps.parquet:||p')
    ag_count=$(echo "$schema_check" | sed -n 's|^COUNT:anomalygen_gaps.parquet:||p')
    if [ -n "$mn_count" ] && [ -n "$ag_count" ] \
       && [ "$mn_count" = "0" ] && [ "$ag_count" = "0" ]; then
      warnings="${warnings}\n- ALL SUBSETS EMPTY: 0 rows in mining_gaps.parquet AND 0 rows in anomalygen_gaps.parquet. Either no labels matched any module (configuration mismatch) or the input gaps_parquet was empty. The report must call this out as a stop-the-iteration condition."
    fi
  fi

  # routing_summary.txt should mention each output parquet path
  if [ -f "$report_dir/routing_summary.txt" ]; then
    if ! grep -q "Mining subset" "$report_dir/routing_summary.txt"; then
      warnings="${warnings}\n- BAD SUMMARY: routing_summary.txt does not contain the 'Mining subset' line. Use the format from SKILL.md verbatim."
    fi
    if ! grep -q "AnomalyGen subset" "$report_dir/routing_summary.txt"; then
      warnings="${warnings}\n- BAD SUMMARY: routing_summary.txt does not contain the 'AnomalyGen subset' line. Use the format from SKILL.md verbatim."
    fi
    if ! grep -q "Per-label breakdown" "$report_dir/routing_summary.txt"; then
      warnings="${warnings}\n- BAD SUMMARY: routing_summary.txt missing 'Per-label breakdown' section."
    fi
  fi

  if [ -n "$warnings" ]; then
    echo -e "ROUTING ARTIFACT GAPS:$warnings"
  fi
fi
