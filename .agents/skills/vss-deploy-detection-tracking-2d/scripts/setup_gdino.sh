#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# setup_gdino.sh builds or reuses the GDINO TensorRT engine for Triton.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# setup_gdino.sh - Build (or reuse cached) GDINO TRT engine for Triton.
#
# Usage:
#   setup_gdino.sh [--onnx <path>] [--batch <N>] [--triton-repo <path>] [--force]
#
# Triton requires the engine at a FIXED path with no batch in the filename:
#   $TRITON_REPO/gdino_trt/1/model.plan
#
# Caching strategy:
#   Cache file:  $ENGINE_CACHE_DIR/<onnx-basename>_b<N>.plan
#                (e.g. mgdino_mask_head_pruned_dynamic_batch.onnx_b4.plan)
#   Triton path: $TRITON_REPO/gdino_trt/1/model.plan  (symlink target)
#
#   - Cache hit (exact b<N>):        symlink model.plan -> <stem>_b<N>.plan, skip trtexec
#   - Cache hit (compatible b<M>):   symlink model.plan -> <stem>_b<M>.plan  (M>=N)
#                                    TRT dynamic shapes serve batch<=M from a b<M> engine
#   - Cache miss:                    run trtexec -> save to Triton path ->
#                                    copy to cache -> (optional) symlink
#   - --force or FORCE_ENGINE_REBUILD=1 bypasses the cache
#
# Cache filenames are keyed by the ONNX basename so a new ONNX version
# gets its own cache entry automatically (no stale-engine risk).
#
# Defaults:
#   --onnx         Auto-detected under $RESOURCES (mgdino_mask_head_pruned_dynamic_batch.onnx)
#   --batch        4
#   --triton-repo  $TRITON_REPO

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BATCH=4
ONNX=""
FORCE="${FORCE_ENGINE_REBUILD:-0}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --onnx)        ONNX="$2"; shift 2 ;;
        --batch)       BATCH="$2"; shift 2 ;;
        --triton-repo) TRITON_REPO="$2"; shift 2 ;;
        --force)       FORCE=1; shift ;;
        -h|--help)     sed -n '18,24p' "$0"; exit 0 ;;
        *)             die "Unknown argument: $1" ;;
    esac
done

if [[ -z "$ONNX" ]]; then
    # Filesystem glob — may match 0/1/many. resolve_unique_path handles all
    # three cases loudly so we never silently prefer `head -n1`.
    set +e
    ONNX=$(resolve_unique_path gdino-onnx --find "$RESOURCES" -type f -name 'mgdino_mask_head_pruned_dynamic_batch.onnx')
    rc=$?
    set -e
    case "$rc" in
        0) ;;  # unique hit — ONNX is set
        2) die "Could not auto-detect GDINO ONNX under $RESOURCES. Pass --onnx <path>." ;;
        3) die "Multiple mgdino_mask_head_pruned_dynamic_batch.onnx found under $RESOURCES — pick one and re-run:
  setup_gdino.sh --onnx <absolute-path> --batch $BATCH" ;;
        *) die "resolve_unique_path failed with unexpected exit code $rc" ;;
    esac
fi
require_file "$ONNX"
echo ">> GDINO ONNX: $ONNX"

DEST_DIR="$TRITON_REPO/gdino_trt/1"
DEST_ONNX="$DEST_DIR/model.onnx"
TRITON_PLAN="$DEST_DIR/model.plan"

mkdir -p "$DEST_DIR" "$ENGINE_CACHE_DIR"
STEM=$(onnx_cache_stem "$ONNX")
CACHE_TARGET=$(engine_cache_path "$STEM" "$BATCH" .plan)

echo ">> GDINO setup"
echo "   ONNX         : $ONNX"
echo "   Batch size   : $BATCH"
echo "   Triton path  : $TRITON_PLAN"
echo "   Cache dir    : $ENGINE_CACHE_DIR"
echo "   Cache target : $CACHE_TARGET"

# Copy ONNX into the Triton model repo (cheap, always do it — ensures Triton
# sees the latest ONNX even if the user pulled a newer NGC resource).
cp -f "$ONNX" "$DEST_ONNX"
echo ">> Copied ONNX -> $DEST_ONNX"

# ── Cache lookup (exact or compatible) ──────────────────────────────
# Prints machine-parseable marker lines: ENGINE_CACHE: HIT_EXACT|HIT_COMPAT|MISS|FORCE
# so the calling agent/skill can relay the cache decision to the user.
RESOLVED=""
if [[ "$FORCE" -eq 0 ]]; then
    if RESOLVED=$(engine_cache_hit "$STEM" "$BATCH" .plan); then
        STATUS=$(engine_cache_status "$STEM" "$BATCH" "$RESOLVED" .plan)
        if [[ "$STATUS" == "exact" ]]; then
            echo "ENGINE_CACHE: HIT_EXACT $STEM b${BATCH} -> $RESOLVED"
            echo ">> [CACHE HIT — EXACT] Reusing cached GDINO engine for batch=${BATCH}."
            echo ">> Saving ~5-10 min of engine build time. Engine: $RESOLVED"
        else
            RESOLVED_BATCH=$(basename "$RESOLVED" .plan | sed 's/.*_b//')
            echo "ENGINE_CACHE: HIT_COMPAT $STEM b${BATCH} <- b${RESOLVED_BATCH} ($RESOLVED)"
            echo ">> [CACHE HIT — COMPATIBLE] Reusing larger b${RESOLVED_BATCH} GDINO engine for batch=${BATCH} request."
            echo ">> Saving ~5-10 min of engine build time (TRT dynamic shapes allow running batch=${BATCH} on a b${RESOLVED_BATCH} engine)."
            echo ">> Engine: $RESOLVED"
        fi
        # Symlink Triton's fixed path to the cached engine — atomic replace.
        ln -sfn -T "$RESOLVED" "$TRITON_PLAN"
        echo ">> Symlinked Triton path -> cached engine: $TRITON_PLAN -> $RESOLVED"
        exit 0
    fi
    echo "ENGINE_CACHE: MISS $STEM b${BATCH} -> will build $CACHE_TARGET"
    echo ">> [CACHE MISS] No cached GDINO engine for batch=${BATCH}. Will build via trtexec (~5-10 min)."
else
    echo "ENGINE_CACHE: FORCE $STEM b${BATCH} -> will rebuild $CACHE_TARGET"
    echo ">> [FORCE REBUILD] Bypassing cache and rebuilding GDINO engine."
fi

# ── Build via trtexec directly into the Triton path ──────────────────
# Remove any existing symlink so trtexec writes a fresh file (not through a link).
[[ -L "$TRITON_PLAN" ]] && rm -f "$TRITON_PLAN"

MIN="inputs:1x3x544x960,input_ids:1x256,attention_mask:1x256,position_ids:1x256,token_type_ids:1x256,text_token_mask:1x256x256"
OPT="inputs:${BATCH}x3x544x960,input_ids:${BATCH}x256,attention_mask:${BATCH}x256,position_ids:${BATCH}x256,token_type_ids:${BATCH}x256,text_token_mask:${BATCH}x256x256"

echo ">> Building TensorRT engine (trtexec, several minutes)..."
/usr/src/tensorrt/bin/trtexec \
    --onnx="$DEST_ONNX" \
    --minShapes="$MIN" \
    --optShapes="$OPT" \
    --maxShapes="$OPT" \
    --fp16 \
    --useCudaGraph \
    --saveEngine="$TRITON_PLAN"

[[ -f "$TRITON_PLAN" ]] || die "trtexec finished but $TRITON_PLAN was not created"

# ── Populate cache from the freshly-built engine ─────────────────────
cache_engine "$TRITON_PLAN" "$STEM" "$BATCH" .plan

# Re-point Triton to the cached file via symlink so subsequent runs see
# the cache authoritative (lets `--force` rebuild a different batch later
# without touching the previous one). Atomic replace.
ln -sfn -T "$CACHE_TARGET" "$TRITON_PLAN"
echo ">> Symlinked $TRITON_PLAN -> $CACHE_TARGET"
echo ">> GDINO engine built and cached."
