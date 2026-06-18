#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the VCN gap analysis docker run produced all required artifacts alongside the report.
# The container writes: gaps.parquet, threshold.txt, metrics.json, weak_samples_breakdown.txt
# (and unreachable_kpi.txt iff the recall target was not reachable). The skill itself writes rca_images/.
# Toggle: export RCA_HOOKS=0 to disable

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  warnings=""

  # KPI unreachable: launcher exits early and the spot-check is intentionally skipped.
  # Only require the early-exit artifact and the report itself in that case.
  if [ -f "$report_dir/unreachable_kpi.txt" ]; then
    if [ ! -s "$report_dir/unreachable_kpi.txt" ]; then
      warnings="${warnings}\n- EMPTY UNREACHABLE FILE: unreachable_kpi.txt exists but is empty. The launcher should record the actual recall the model achieves."
    fi
    if [ -n "$warnings" ]; then
      echo -e "VCN ARTIFACT GAPS:$warnings"
    fi
    exit 0
  fi

  for required in gaps.parquet threshold.txt metrics.json weak_samples_breakdown.txt; do
    if [ ! -f "$report_dir/$required" ]; then
      warnings="${warnings}\n- MISSING ARTIFACT: $required not found next to RCA_Report.md. The container run (docker run ... \$DS_IMAGE gap_analysis vcn_aoi ..., where DS_IMAGE = tao_toolkit.data_services from versions.yaml) must write it before the report is produced."
    fi
  done

  if [ ! -d "$report_dir/rca_images" ]; then
    warnings="${warnings}\n- MISSING DIR: rca_images/ not found. View 10 weak samples (5 PASS + 5 NO_PASS) and copy each test image into rca_images/."
  else
    thumb_count=$(find "$report_dir/rca_images" -type f \( -name '*.jpg' -o -name '*.png' -o -name '*.jpeg' \) 2>/dev/null | wc -l)
    if [ "$thumb_count" -lt 10 ]; then
      warnings="${warnings}\n- THIN VISUAL SPOT CHECK: only $thumb_count images in rca_images/ (need 10 — 5 weakest PASS + 5 weakest NO_PASS)."
    fi
  fi

  # metrics.json should contain confusion-matrix + per-label distribution stats
  if [ -f "$report_dir/metrics.json" ]; then
    metrics_check=$(python3 - "$report_dir/metrics.json" 2>/dev/null << 'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        m = json.load(f)
    top = {"precision", "recall", "f1", "confusion_matrix", "per_label"}
    missing = top - set(m)
    if missing:
        print(f"KEYS_MISSING:{','.join(sorted(missing))}")
    elif not isinstance(m.get("per_label"), dict) or not m["per_label"]:
        print("EMPTY_PER_LABEL")
    else:
        print("OK")
except Exception as e:
    print(f"ERROR:{e}")
PYEOF
)
    case "$metrics_check" in
      KEYS_MISSING:*)
        keys=${metrics_check#KEYS_MISSING:}
        warnings="${warnings}\n- BAD METRICS: metrics.json missing top-level keys: $keys. Expected: precision, recall, f1, confusion_matrix, per_label."
        ;;
      EMPTY_PER_LABEL)
        warnings="${warnings}\n- BAD METRICS: metrics.json has an empty per_label block; the Weakness Distribution table will be empty."
        ;;
      ERROR:*)
        warnings="${warnings}\n- UNREADABLE METRICS: metrics.json failed to load (${metrics_check#ERROR:})."
        ;;
    esac
  fi

  # threshold.txt should contain a single float
  if [ -f "$report_dir/threshold.txt" ]; then
    thr_content=$(tr -d '[:space:]' < "$report_dir/threshold.txt")
    if ! echo "$thr_content" | grep -qE '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'; then
      warnings="${warnings}\n- BAD THRESHOLD: threshold.txt does not contain a single numeric float (got: $(head -c 60 "$report_dir/threshold.txt"))."
    fi
  fi

  # gaps.parquet should have rows
  if [ -f "$report_dir/gaps.parquet" ]; then
    rows=$(python3 - "$report_dir/gaps.parquet" 2>/dev/null << 'PYEOF'
import sys
try:
    import pandas as pd
    df = pd.read_parquet(sys.argv[1])
    expected = {"filepath", "label", "siamese_score", "weakness"}
    missing = expected - set(df.columns)
    if missing:
        print(f"COLUMNS_MISSING:{','.join(sorted(missing))}")
    else:
        print(f"ROWS:{len(df)}")
except Exception as e:
    print(f"ERROR:{e}")
PYEOF
)
    case "$rows" in
      ROWS:0)
        warnings="${warnings}\n- EMPTY PARQUET: gaps.parquet has 0 rows. Either every sample is correctly classified (suspicious — verify) or the threshold sweep produced no candidates."
        ;;
      COLUMNS_MISSING:*)
        cols=${rows#COLUMNS_MISSING:}
        warnings="${warnings}\n- BAD PARQUET SCHEMA: gaps.parquet missing columns: $cols. Required schema: filepath, label, siamese_score, weakness."
        ;;
      ERROR:*)
        warnings="${warnings}\n- UNREADABLE PARQUET: gaps.parquet failed to load (${rows#ERROR:})."
        ;;
    esac
  fi

  if [ -n "$warnings" ]; then
    echo -e "VCN ARTIFACT GAPS:$warnings"
  fi
fi
