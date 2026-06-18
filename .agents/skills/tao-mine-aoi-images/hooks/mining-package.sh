#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Package mining output into timestamped folder with all artifacts
# Trigger: PostToolUse on Write tool when file matches *Mining_Report.md
# Toggle: export MINING_HOOKS=0 to disable

[[ "${MINING_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

log_file="/tmp/mining-hook-debug.log"
echo "[$(date)] file_path=$HOOK_FILE_PATH transcript=$HOOK_TRANSCRIPT" >> "$log_file" 2>/dev/null

if [[ "$CLAUDE_FILE_PATH" == *Mining_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  timestamp=$(date +"%Y-%m-%d_%H%M%S")

  echo "[$(date)] Hook triggered for: $CLAUDE_FILE_PATH" >> "$log_file" 2>/dev/null

  # If already in a timestamped mining_results folder, use it directly
  if [[ "$report_dir" == *mining_results/* ]]; then
    out_dir="$report_dir"
  else
    out_dir="$report_dir/mining_results/$timestamp"
    mkdir -p "$out_dir"
    cp "$CLAUDE_FILE_PATH" "$out_dir/Mining_Report.md"
    for art in target_embeddings.parquet source_embeddings.parquet mined.parquet mining_summary.txt; do
      [ -f "$report_dir/$art" ] && cp "$report_dir/$art" "$out_dir/$art"
    done
  fi

  project_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"

  mkdir -p "$out_dir/mining_config"

  for src in skills commands hooks; do
    if [ -d "$project_root/.claude/$src" ]; then
      cp -r "$project_root/.claude/$src" "$out_dir/mining_config/$src" 2>>"$log_file"
    fi
  done

  for f in "$project_root/.claude/settings.json" "$project_root/.claude/settings.local.json"; do
    [ -f "$f" ] && cp "$f" "$out_dir/mining_config/" 2>>"$log_file"
  done

  if [ -n "$HOOK_TRANSCRIPT" ] && [ -f "$HOOK_TRANSCRIPT" ]; then
    cp "$HOOK_TRANSCRIPT" "$out_dir/claude_session.jsonl" 2>>"$log_file"
  else
    project_dir_encoded=$(echo "$project_root" | sed 's|[/_]|-|g')
    project_sessions_dir="$HOME/.claude/projects/$project_dir_encoded"
    if [ -d "$project_sessions_dir" ]; then
      latest_log=$(find "$project_sessions_dir" -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-)
      if [ -n "$latest_log" ] && [ -f "$latest_log" ]; then
        cp "$latest_log" "$out_dir/claude_session.jsonl" 2>>"$log_file"
      fi
    fi
  fi

  echo "Mining run packaged to: $out_dir"
else
  echo "[$(date)] Hook skipped (not Mining_Report.md): $CLAUDE_FILE_PATH" >> "$log_file" 2>/dev/null
fi
