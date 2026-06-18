#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hook: Deep image evidence validation in RCA reports
# Not just counting images — verifying they exist, are diverse, and cover required categories
# Toggle: export RCA_HOOKS=0 to disable, RCA_HOOKS=1 to enable (default: enabled)

[[ "${RCA_HOOKS:-1}" == "0" ]] && exit 0

source "$(dirname "$0")/_parse-stdin.sh"

if [[ "$CLAUDE_FILE_PATH" == *RCA_Report.md ]]; then
  report_dir=$(dirname "$CLAUDE_FILE_PATH")
  warnings=""

  # --- Check 1: Minimum inline image count ---
  img_count=$(grep -c '!\[' "$CLAUDE_FILE_PATH" 2>/dev/null || true)
  img_count=${img_count:-0}
  img_count=$(echo "$img_count" | tr -d '[:space:]')
  if [ "$img_count" -lt 20 ]; then
    warnings="${warnings}\n- Only $img_count inline images (need 20+). Before writing the report, run 'ls rca_images/' and embed thumbnails in EVERY row of sections 3.1-3.4 using ![caption](rca_images/<filename>.jpg) syntax."
  fi

  # --- Check 1b: Per-section inline image checks ---
  # Section 3.2 (Failure Mode Clustering) should have most images — roughly 2 per defect sample
  fm_imgs=$(sed -n '/Failure Mode Clustering/,/^### /p' "$CLAUDE_FILE_PATH" 2>/dev/null | grep -c '!\[' || true)
  fm_imgs=${fm_imgs:-0}
  fm_imgs=$(echo "$fm_imgs" | tr -d '[:space:]')
  fm_rows=$(sed -n '/Failure Mode Clustering/,/^### /p' "$CLAUDE_FILE_PATH" 2>/dev/null | grep -c '^|' || true)
  fm_rows=${fm_rows:-0}
  fm_rows=$(echo "$fm_rows" | tr -d '[:space:]')
  if [ "$fm_rows" -gt 3 ] && [ "$fm_imgs" -lt 4 ]; then
    warnings="${warnings}\n- Section 3.2 Failure Mode Clustering has $fm_rows table rows but only $fm_imgs inline images. Each defect row needs test + golden thumbnails. Run 'ls rca_images/' to get filenames."
  fi

  # Section 3.3 (False Positive Analysis) should have 2 images per FP
  fp_imgs=$(sed -n '/False Positive/,/^### /p' "$CLAUDE_FILE_PATH" 2>/dev/null | grep -c '!\[' || true)
  fp_imgs=${fp_imgs:-0}
  fp_imgs=$(echo "$fp_imgs" | tr -d '[:space:]')
  if [ "$fp_imgs" -lt 4 ]; then
    warnings="${warnings}\n- Section 3.3 False Positive Analysis has only $fp_imgs inline images. Top 10 FPs each need test + golden thumbnails."
  fi

  # --- Check 2: Verify referenced images actually exist on disk ---
  missing_imgs=0
  total_refs=0
  while IFS= read -r img_path; do
    total_refs=$((total_refs + 1))
    # Resolve relative path from report location
    full_path="$report_dir/$img_path"
    if [ ! -f "$full_path" ]; then
      missing_imgs=$((missing_imgs + 1))
    fi
  done < <(grep -oP '!\[.*?\]\(\K[^)]+' "$CLAUDE_FILE_PATH" 2>/dev/null)

  if [ "$missing_imgs" -gt 0 ]; then
    warnings="${warnings}\n- $missing_imgs of $total_refs referenced images are missing from disk. Generate thumbnails before writing the report."
  fi

  # --- Check 3: rca_images/ directory exists and has content ---
  rca_imgs_dir="$report_dir/rca_images"
  if [ ! -d "$rca_imgs_dir" ]; then
    warnings="${warnings}\n- No rca_images/ directory found. Thumbnails must be generated for all viewed images."
  else
    thumb_count=$(find "$rca_imgs_dir" -type f \( -name '*.jpg' -o -name '*.png' \) 2>/dev/null | wc -l)
    if [ "$thumb_count" -lt 20 ]; then
      warnings="${warnings}\n- Only $thumb_count thumbnails in rca_images/. Expected 50+ (all defect pairs + FP pairs + golden audit + training)."
    fi
  fi

  # --- Check 4: Image diversity — not all from same sample ---
  if [ -d "$rca_imgs_dir" ]; then
    unique_prefixes=$(ls "$rca_imgs_dir" 2>/dev/null | sed 's/_SolderLight.*//;s/_[0-9]*\./\./' | sort -u | wc -l)
    if [ "$unique_prefixes" -lt 10 ]; then
      warnings="${warnings}\n- Low image diversity: only $unique_prefixes unique component prefixes. Ensure images span defects, FPs, goldens, and training."
    fi
  fi

  # --- Check 5: Visual Evidence section has test+golden pairs described ---
  golden_mentions=$(grep -ciE 'golden.*(dark|dim|black|bright|mean|intensity|quality)' "$CLAUDE_FILE_PATH" 2>/dev/null || true)
  golden_mentions=${golden_mentions:-0}
  golden_mentions=$(echo "$golden_mentions" | tr -d '[:space:]')
  if [ "$golden_mentions" -lt 3 ]; then
    warnings="${warnings}\n- Golden image quality barely discussed ($golden_mentions mentions). Every audited golden needs: mean intensity, visual verdict, quality tier."
  fi

  # --- Check 6: Failure mode clustering covers individual samples ---
  failure_mode_rows=$(sed -n '/Failure Mode Clustering/,/^## /p' "$CLAUDE_FILE_PATH" 2>/dev/null | grep -c "^|" || true)
  failure_mode_rows=${failure_mode_rows:-0}
  failure_mode_rows=$(echo "$failure_mode_rows" | tr -d '[:space:]')
  if [ "$failure_mode_rows" -lt 10 ]; then
    warnings="${warnings}\n- Failure mode clustering has only $failure_mode_rows table rows. Every defect sample needs its own row with: score, failure mode, visual description, golden quality."
  fi

  if [ -n "$warnings" ]; then
    echo "IMAGE EVIDENCE GAPS:$warnings"
  fi
fi
