#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Verify the DEFT mining run produced all required artifacts alongside the report.
# The skill must write: target_embeddings.parquet, source_embeddings.parquet, mined.parquet,
# and mining_summary.txt (the launcher emits this next to mined.parquet).
# Toggle: export MINING_HOOKS=0 to disable

[[ "${MINING_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *Mining_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  warnings=""

  for required in target_embeddings.parquet source_embeddings.parquet mined.parquet mining_summary.txt; do
    if [ ! -f "$report_dir/$required" ]; then
      warnings="${warnings}\n- MISSING ARTIFACT: $required not found next to Mining_Report.md. The skill must produce it before writing the report."
    fi
  done

  # Each embedding parquet should have an embedding column and at least one row.
  for embed_pq in target_embeddings.parquet source_embeddings.parquet; do
    pq_path="$report_dir/$embed_pq"
    [ ! -f "$pq_path" ] && continue
    result=$(python3 - "$pq_path" 2>/dev/null << 'PYEOF'
import sys
try:
    import pandas as pd
    df = pd.read_parquet(sys.argv[1])
    if "filepath" not in df.columns:
        print("NO_FILEPATH")
    elif "embedding" not in df.columns and "image_embed" not in df.columns:
        print(f"NO_EMBEDDING_COL:{','.join(df.columns)}")
    elif len(df) == 0:
        print("EMPTY")
    else:
        print(f"OK:{len(df)}")
except Exception as e:
    print(f"ERROR:{e}")
PYEOF
)
    case "$result" in
      NO_FILEPATH)
        warnings="${warnings}\n- BAD SCHEMA: $embed_pq missing required 'filepath' column."
        ;;
      NO_EMBEDDING_COL:*)
        cols=${result#NO_EMBEDDING_COL:}
        warnings="${warnings}\n- BAD SCHEMA: $embed_pq has no embedding column (got: $cols). Step 1/2 did not write embeddings."
        ;;
      EMPTY)
        warnings="${warnings}\n- EMPTY PARQUET: $embed_pq has 0 rows. The embedding step processed nothing — check the input parquet's filepath column."
        ;;
      ERROR:*)
        warnings="${warnings}\n- UNREADABLE PARQUET: $embed_pq failed to load (${result#ERROR:})."
        ;;
    esac
  done

  # mined.parquet should have a filepath column and >=1 row.
  mined_pq="$report_dir/mined.parquet"
  if [ -f "$mined_pq" ]; then
    result=$(python3 - "$mined_pq" 2>/dev/null << 'PYEOF'
import sys
try:
    import pandas as pd
    df = pd.read_parquet(sys.argv[1])
    if "filepath" not in df.columns:
        print(f"NO_FILEPATH:{','.join(df.columns)}")
    elif len(df) == 0:
        print("EMPTY")
    else:
        print(f"OK:{len(df)}")
except Exception as e:
    print(f"ERROR:{e}")
PYEOF
)
    case "$result" in
      NO_FILEPATH:*)
        cols=${result#NO_FILEPATH:}
        warnings="${warnings}\n- BAD MINED SCHEMA: mined.parquet missing 'filepath' column (got: $cols)."
        ;;
      EMPTY)
        warnings="${warnings}\n- EMPTY MINED PARQUET: mined.parquet has 0 rows. Either the source pool was empty, the encoders disagreed, or the label filter dropped every pair. Check mining_summary.txt and re-read the launcher log."
        ;;
      ERROR:*)
        warnings="${warnings}\n- UNREADABLE PARQUET: mined.parquet failed to load (${result#ERROR:})."
        ;;
    esac
  fi

  if [ -n "$warnings" ]; then
    echo -e "MINING ARTIFACT GAPS:$warnings"
  fi
fi
