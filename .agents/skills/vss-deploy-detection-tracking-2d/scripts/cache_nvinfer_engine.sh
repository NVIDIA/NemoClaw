#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# cache_nvinfer_engine.sh preserves auto-built nvinfer engines for later runs.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# cache_nvinfer_engine.sh - Symlink a DeepStream-auto-built nvinfer engine
# into $ENGINE_CACHE_DIR so the model-engine-file path in the PGIE config
# resolves on subsequent deploys (saves 3-5 min rebuild).
#
# Use this AFTER the app has started and the engine has been built next to
# the ONNX by DeepStream's built-in nvinfer. Applies to models that rely on
# DS's auto-build (warehouse-2d, smartcity-rtdetr) — NOT Sparse4D or GDINO
# (their setup_*.sh scripts build directly into the cache).
#
# Usage:
#   cache_nvinfer_engine.sh --model <name> --onnx <path> --batch <N> [--precision fp16] [--gpu 0]
#
# Example:
#   cache_nvinfer_engine.sh \
#       --onnx /opt/storage/resources/vss-warehouse-app-data_v.../models/mtmc/rtdetr_warehouse_v1.0.1.fp16.onnx \
#       --batch 4
#   # -> $ENGINE_CACHE_DIR/rtdetr_warehouse_v1.0.1.fp16.onnx_b4.engine
#
# What it does:
#   1. Computes DS auto-build path: <ONNX>_b<N>_gpu<G>_fp<P>.engine
#   2. If the engine exists, symlinks it to
#      $ENGINE_CACHE_DIR/<onnx-basename>_b<N>.engine
#      (cache name is derived from the ONNX basename so it's naturally
#       version-scoped — a newer ONNX gets its own cache entry).
#   3. On next run, DS's model-engine-file config path resolves via symlink
#      and the engine is reused (no rebuild).
#
# Note:  --model is still accepted for log-line cosmetics but the cache
#        filename is always driven by the ONNX basename.
#
# Idempotent: safe to re-run.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MODEL=""
ONNX=""
BATCH=""
PRECISION="fp16"
GPU=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)     MODEL="$2"; shift 2 ;;
        --onnx)      ONNX="$2"; shift 2 ;;
        --batch)     BATCH="$2"; shift 2 ;;
        --precision) PRECISION="$2"; shift 2 ;;
        --gpu)       GPU="$2"; shift 2 ;;
        -h|--help)   sed -n '18,23p' "$0"; exit 0 ;;
        *)           die "Unknown argument: $1" ;;
    esac
done

[[ -n "$ONNX" && -n "$BATCH" ]] \
    || die "Missing required args. Usage: --onnx <path> --batch <N> [--model <name>]"
[[ "$BATCH" =~ ^[0-9]+$ ]] || die "batch must be a positive integer (got: $BATCH)"

require_file "$ONNX"
# Cache stem is the ONNX basename (with .onnx) — version-scoped.
STEM=$(onnx_cache_stem "$ONNX")
# Fall back to stem for the log label if --model wasn't provided.
: "${MODEL:=$STEM}"

# DeepStream auto-build naming convention (fixed, not configurable): each
# built engine is saved next to the ONNX with suffix _b<N>_gpu<G>_fp<P>.
AUTO_ENGINE="${ONNX}_b${BATCH}_gpu${GPU}_fp${PRECISION#fp}.engine"
# Support both fp16 and fp32 spellings in the suffix.
if [[ ! -f "$AUTO_ENGINE" ]]; then
    # Try fallback: glob pattern (precision/gpu may vary from defaults).
    ALT=$(find "$(dirname "$ONNX")" -maxdepth 1 -type f \
          -name "$(basename "$ONNX")_b${BATCH}_gpu*_fp*.engine" 2>/dev/null | head -n1)
    [[ -n "$ALT" && -f "$ALT" ]] && AUTO_ENGINE="$ALT"
fi

if [[ ! -f "$AUTO_ENGINE" ]]; then
    echo "ENGINE_CACHE: LINK_SKIP $MODEL b${BATCH} — DS-auto-built engine not found yet" >&2
    echo ">> Engine file not found at expected path: $AUTO_ENGINE" >&2
    echo ">> Has DS finished building? Try again after the app is ready." >&2
    exit 1
fi

mkdir -p "$ENGINE_CACHE_DIR"
CACHE_PATH=$(engine_cache_path "$STEM" "$BATCH" .engine)

# Idempotent: if the symlink already points at the same engine, do nothing.
if [[ -L "$CACHE_PATH" && "$(readlink -f "$CACHE_PATH")" == "$(readlink -f "$AUTO_ENGINE")" ]]; then
    echo "ENGINE_CACHE: LINK_EXISTS $MODEL b${BATCH} -> $CACHE_PATH (unchanged)"
    exit 0
fi

# Atomic replace — `ln -sfn -T` writes the symlink in a single rename(2) so
# concurrent readers never see a window where $CACHE_PATH is missing.
ln -sfn -T "$AUTO_ENGINE" "$CACHE_PATH"

echo "ENGINE_CACHE: LINKED $MODEL b${BATCH} -> $AUTO_ENGINE"
echo ">> Cached engine symlink created:"
echo "     $CACHE_PATH"
echo "       -> $AUTO_ENGINE"
echo ">> Next deploy will reuse this engine via model-engine-file (3-5 min saved)."
