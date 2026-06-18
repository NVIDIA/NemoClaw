#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Derive the best inference step from an anomalygen checkpoint. Three cases:
#
#   1. Trained + validated     → valid/<STEP>/valid_kpi.csv tree exists →
#                                pick argmax avg(nn_score) per anomalygen contract
#                                (skills/anomalygen/references/finetune.md
#                                §"Best checkpoint selection").
#   2. Trained, NOT validated  → trainer output (*/checkpoints/model/iter_*.pt)
#                                exists but no valid_kpi.csv tree (e.g. cookbook
#                                misconfig: validation_iter > max_iter) →
#                                pick the latest saved iter from trainer output.
#   3. Shipped checkpoint      → flat iter_*.pt next to ag_config.yaml, no trainer
#                                layout, no valid/ tree → echo <fallback_step>.
#
# Usage:  pick_best_step.sh <ckpt_root> <fallback_step>
#
# CSV schema (case 1, written by ag_train):
#   kpi,<defect_type_1>,...,Average
#   cradio_v3_base_fid,...
#   mnn_score,...
#   nn_score,<per-defect>,...,<avg>            ← this row, last column

set -euo pipefail

CKPT_ROOT="${1:?usage: pick_best_step.sh <ckpt_root> <fallback_step>}"
FALLBACK="${2:?usage: pick_best_step.sh <ckpt_root> <fallback_step>}"

# Case 1: trained + validated. Filter out validated steps that have no matching
# iter_*.pt — happens when cookbook validation_iter % save_iter != 0 (e.g.
# val=1500, save=2000): valid_kpi.csv at 1500 has no saved checkpoint, so
# returning that step would crash inference at load time.
VALID_DIR=$(find "$CKPT_ROOT" -type d -name valid -maxdepth 8 2>/dev/null | head -1)
if [ -n "$VALID_DIR" ] && ls "$VALID_DIR"/*/valid_kpi.csv >/dev/null 2>&1; then
  MODEL_DIR=$(find "$CKPT_ROOT" -type d -path "*/checkpoints/model" -print -quit 2>/dev/null)
  BEST=$(
    for csv in "$VALID_DIR"/*/valid_kpi.csv; do
      step=$(basename "$(dirname "$csv")")
      [ "$step" = "0" ] && continue          # iter 0 = pre-training baseline, no checkpoint
      if [ -n "$MODEL_DIR" ]; then
        padded=$(printf "iter_%09d.pt" "$step")
        [ -f "$MODEL_DIR/$padded" ] || continue
      fi
      avg=$(awk -F',' '$1=="nn_score"{print $NF}' "$csv")
      [ -n "$avg" ] && echo "$avg $step"
    done | sort -gr | head -1 | awk '{print $2}'
  )
  if [ -n "$BEST" ]; then
    echo "[pick_best_step] best=$BEST (peak avg nn_score among validated steps with saved iter_*.pt in $VALID_DIR)" >&2
    echo "$BEST"
    exit 0
  fi
  echo "[pick_best_step] WARN: no validated step has both an nn_score and a matching saved iter_*.pt under $VALID_DIR (check cookbook validation_iter % save_iter == 0) — trying trainer-output fallback" >&2
fi

# Case 2: trainer output exists but no validation logs.
LATEST_TRAINED=$(find "$CKPT_ROOT" -path "*/checkpoints/model/iter_*.pt" -printf '%f\n' 2>/dev/null \
  | sed 's/iter_0*//; s/\.pt//' \
  | sort -gr | head -1)
if [ -n "$LATEST_TRAINED" ]; then
  echo "[pick_best_step] no valid_kpi.csv tree but trainer output present — using latest trained iter=$LATEST_TRAINED (no per-step KPIs; check cookbook validation_iter vs max_iter)" >&2
  echo "$LATEST_TRAINED"
  exit 0
fi

# Case 3: shipped checkpoint layout (flat iter_*.pt, no trainer-nested layout, no valid/).
echo "$FALLBACK"
