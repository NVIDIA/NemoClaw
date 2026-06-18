#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Package RCA output into timestamped folder with all artifacts
# Trigger: PostToolUse on Write tool when file matches *RCA_Report.md
# Toggle: export RCA_HOOKS=0 to disable
#
# Claude Code passes hook context via stdin as JSON with fields:
#   tool_input.file_path  - the file that was written
#   transcript_path       - path to current session log
#   session_id            - current session ID
# Env vars available: CLAUDE_PROJECT_DIR, CLAUDE_CODE_ENTRYPOINT

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

log_file="/tmp/rca-hook-debug.log"
echo "[$(date)] file_path=$HOOK_FILE_PATH transcript=$HOOK_TRANSCRIPT" >> "$log_file" 2>/dev/null

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  timestamp=$(date +"%Y-%m-%d_%H%M%S")

  echo "[$(date)] Hook triggered for: $CLAUDE_FILE_PATH" >> "$log_file" 2>/dev/null

  # If already in a timestamped rca_results folder, use it directly
  if [[ "$report_dir" == *rca_results/* ]]; then
    out_dir="$report_dir"
  else
    out_dir="$report_dir/rca_results/$timestamp"
    mkdir -p "$out_dir"
    cp "$CLAUDE_FILE_PATH" "$out_dir/RCA_Report.md"
    if [ -d "$report_dir/rca_images" ]; then
      cp -r "$report_dir/rca_images" "$out_dir/rca_images"
    fi
  fi

  # Use CLAUDE_PROJECT_DIR (set by Claude Code), fall back to git or PWD
  project_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"

  # Copy RCA config for reproducibility
  mkdir -p "$out_dir/rca_config"

  for src in skills commands hooks; do
    if [ -d "$project_root/.claude/$src" ]; then
      cp -r "$project_root/.claude/$src" "$out_dir/rca_config/$src" 2>>"$log_file"
    fi
  done

  for f in "$project_root/.claude/settings.json" "$project_root/.claude/settings.local.json"; do
    [ -f "$f" ] && cp "$f" "$out_dir/rca_config/" 2>>"$log_file"
  done

  # Copy session log — use transcript_path from stdin (most reliable)
  if [ -n "$HOOK_TRANSCRIPT" ] && [ -f "$HOOK_TRANSCRIPT" ]; then
    cp "$HOOK_TRANSCRIPT" "$out_dir/claude_session.jsonl" 2>>"$log_file"
  else
    # Fallback: find session log by project dir encoding
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

  echo "RCA packaged to: $out_dir"
else
  echo "[$(date)] Hook skipped (not RCA_Report.md): $CLAUDE_FILE_PATH" >> "$log_file" 2>/dev/null
fi
