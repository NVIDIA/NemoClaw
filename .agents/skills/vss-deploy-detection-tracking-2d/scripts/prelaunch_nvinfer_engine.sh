#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# prelaunch_nvinfer_engine.sh selects a reusable nvinfer engine before launch.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# prelaunch_nvinfer_engine.sh - Tiered engine lookup for nvinfer-based models
# BEFORE the perception app launches.
#
# TRT engines built with dynamic shapes (min:1..max:M) can serve any batch size
# 1..M. So if you ran batch=4 yesterday and want batch=3 today, no need to
# rebuild — just symlink the b4 engine as b3 and DS will happily load it.
#
# Implements a check_engine_file() pattern for nvinfer: scans the ONNX-adjacent
# directory (where DS auto-writes) and
# $ENGINE_CACHE_DIR for compatible larger-batch engines and creates a symlink
# at the expected path for the requested batch.
#
# Usage:
#   prelaunch_nvinfer_engine.sh --onnx <path> --batch <N> \
#       --pgie-config <yml-path> \
#       [--model <name>] [--gpu 0] [--precision fp16] [--exact-only]
#
# Arg reference:
#   --onnx         Full absolute path to the ONNX file (primary search dir).
#   --batch        Requested batch size
#   --pgie-config  REQUIRED on HIT — path to the PGIE yml config. On cache HIT
#                  the script uncomments and sets model-engine-file so DS
#                  deserializes instead of rebuilding. Without this, DS ignores
#                  the cached engine entirely (model-engine-file commented out =
#                  DS always builds from ONNX).
#   --model        Optional logical label used only in log lines
#   --gpu          GPU index in the engine filename (default 0)
#   --precision    Precision suffix (fp16 or fp32, default fp16)
#   --exact-only   Disable the compatible-larger-batch fallback
#
# Prints machine-readable markers on stdout:
#   ENGINE_PRELAUNCH: HIT_EXACT     <batch> -> <path>
#   ENGINE_PRELAUNCH: HIT_COMPAT    <batch> <- <M> (<path>)
#   ENGINE_PRELAUNCH: HIT_SYMLINK   <batch> -> <target>  (pre-existing valid symlink)
#   ENGINE_PRELAUNCH: MISS          <batch>  (DS will build from ONNX)

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MODEL=""
ONNX=""
BATCH=""
PGIE_CONFIG=""
GPU=0
PRECISION="fp16"
EXACT_ONLY="${ENGINE_EXACT_MATCH_ONLY:-0}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)       MODEL="$2";       shift 2 ;;
        --onnx)        ONNX="$2";        shift 2 ;;
        --batch)       BATCH="$2";       shift 2 ;;
        --pgie-config) PGIE_CONFIG="$2"; shift 2 ;;
        --gpu)         GPU="$2";         shift 2 ;;
        --precision)   PRECISION="$2";   shift 2 ;;
        --exact-only)  EXACT_ONLY=1;     shift   ;;
        -h|--help)     sed -n '18,35p' "$0"; exit 0 ;;
        *)             die "Unknown argument: $1" ;;
    esac
done

[[ -n "$ONNX" && -n "$BATCH" ]] \
    || die "Missing required args. Usage: --onnx <path> --batch <N> [--model <name>]"
[[ "$BATCH" =~ ^[0-9]+$ ]] || die "batch must be a positive integer (got: $BATCH)"
require_file "$ONNX"

PREC_NUM="${PRECISION#fp}"
ONNX_DIR=$(dirname "$ONNX")
ONNX_BASE=$(basename "$ONNX")
: "${MODEL:=$ONNX_BASE}"   # only used in log lines
TARGET="$ONNX_DIR/${ONNX_BASE}_b${BATCH}_gpu${GPU}_fp${PREC_NUM}.engine"

# ── Helper: write model-engine-file into the PGIE yml config ─────────
# DS only reuses a cached engine when model-engine-file is explicitly set.
# If the key is commented out, DS always rebuilds from ONNX regardless of
# whether the engine file exists on disk.
set_pgie_engine_file() {
    local engine_path="$1"
    [[ -z "$PGIE_CONFIG" ]] && return 0
    [[ -f "$PGIE_CONFIG" ]] || { echo ">> WARNING: --pgie-config $PGIE_CONFIG not found" >&2; return 0; }

    # Escape & | \ in the engine path before passing it to sed — TRT cache
    # paths can legitimately contain `|` and `&` (extension-tagged ONNX names),
    # which would otherwise be reinterpreted as sed metachars and corrupt the
    # config.
    local engine_path_esc
    engine_path_esc=$(sed_escape_replacement "$engine_path")

    # Detect separator: YAML uses "key: value", DS INI uses "key=value".
    # Match the commented line to determine which format this config uses.
    if grep -qE '^\s*#?\s*model-engine-file\s*:' "$PGIE_CONFIG"; then
        # YAML format (warehouse-2d ds-ppl-analytics-pgie-config.yml).
        # Single sed handles both the commented and uncommented cases.
        sed -i "s|^\(\s*\)#\?\s*model-engine-file\s*:.*|\1model-engine-file: $engine_path_esc|" "$PGIE_CONFIG"
        if grep -qF "model-engine-file: $engine_path" "$PGIE_CONFIG"; then
            echo ">> [ENGINE PRELAUNCH] Set model-engine-file: $engine_path  ✓"
        else
            echo ">> WARNING: YAML model-engine-file update may not have landed" >&2
        fi
    else
        # INI format (smartcity-rtdetr rtdetr-960x544.txt — uses key=value).
        sed -i "s|^\(\s*\)#\?\s*model-engine-file\s*=.*|\1model-engine-file=$engine_path_esc|" "$PGIE_CONFIG"
        if grep -qF "model-engine-file=$engine_path" "$PGIE_CONFIG"; then
            echo ">> [ENGINE PRELAUNCH] Set model-engine-file=$engine_path  ✓"
        else
            echo ">> WARNING: INI model-engine-file update may not have landed" >&2
        fi
    fi
}

# ── 1) Exact match — DS will reuse directly. ───────────────────
if [[ -f "$TARGET" && ! -L "$TARGET" ]]; then
    echo "ENGINE_PRELAUNCH: HIT_EXACT b${BATCH} -> $TARGET"
    echo ">> [ENGINE PRELAUNCH — EXACT] Engine already present for batch=${BATCH}."
    set_pgie_engine_file "$TARGET"
    echo ">> DS will deserialize it directly (no build)."
    exit 0
fi

# ── 1b) Pre-existing valid symlink from a previous prelaunch invocation ────
if [[ -L "$TARGET" ]]; then
    RESOLVED=$(readlink -f "$TARGET" 2>/dev/null || true)
    if [[ -n "$RESOLVED" && -f "$RESOLVED" ]]; then
        echo "ENGINE_PRELAUNCH: HIT_SYMLINK b${BATCH} -> $RESOLVED"
        echo ">> [ENGINE PRELAUNCH — SYMLINK] Engine symlink already present, resolves to $RESOLVED."
        set_pgie_engine_file "$TARGET"
        exit 0
    else
        echo ">> [ENGINE PRELAUNCH] Removing stale symlink: $TARGET"
        rm -f "$TARGET"
    fi
fi

if [[ "$EXACT_ONLY" -eq 1 ]]; then
    echo "ENGINE_PRELAUNCH: MISS b${BATCH} (exact-only mode, compat search disabled)"
    echo ">> [ENGINE PRELAUNCH — MISS] No exact match; DS will build a fresh engine (~3-5 min)."
    exit 0
fi

# ── 2) Compatible match — smallest M >= BATCH with a valid non-symlink engine
#      next to the ONNX. ───────────────────────────────────────────────
BEST_BATCH=0
BEST_FILE=""
shopt -s nullglob
for f in "$ONNX_DIR/${ONNX_BASE}_b"*"_gpu${GPU}_fp${PREC_NUM}.engine"; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    fname=$(basename "$f")
    # Extract M from "<onnx>_b<M>_gpu<G>_fp<P>.engine"
    m="${fname#${ONNX_BASE}_b}"
    m="${m%%_gpu*}"
    [[ "$m" =~ ^[0-9]+$ ]] || continue
    if (( m >= BATCH )); then
        if (( BEST_BATCH == 0 )) || (( m < BEST_BATCH )); then
            BEST_BATCH=$m
            BEST_FILE=$f
        fi
    fi
done
shopt -u nullglob

# ── 2b) Also check $ENGINE_CACHE_DIR — keyed by the ONNX basename, populated
#       by a previous cache_nvinfer_engine.sh run. ────────────────────
if [[ -z "$BEST_FILE" ]]; then
    shopt -s nullglob
    for f in "$ENGINE_CACHE_DIR/${ONNX_BASE}_b"*".engine"; do
        [[ -f "$f" ]] || continue
        fname=$(basename "$f" .engine)
        m="${fname#${ONNX_BASE}_b}"
        [[ "$m" =~ ^[0-9]+$ ]] || continue
        if (( m >= BATCH )); then
            if (( BEST_BATCH == 0 )) || (( m < BEST_BATCH )); then
                BEST_BATCH=$m
                # Resolve to the actual engine file (in case it's a symlink)
                BEST_FILE=$(readlink -f "$f" 2>/dev/null || echo "$f")
            fi
        fi
    done
    shopt -u nullglob
fi

if [[ -n "$BEST_FILE" && -f "$BEST_FILE" ]]; then
    # Atomic replace via rename(2). Avoids a TOCTOU window where the previous
    # symlink is removed but the new one hasn't been created.
    ln -sfn -T "$BEST_FILE" "$TARGET"
    echo "ENGINE_PRELAUNCH: HIT_COMPAT b${BATCH} <- b${BEST_BATCH} ($BEST_FILE)"
    echo ">> [ENGINE PRELAUNCH — COMPATIBLE] Reusing larger b${BEST_BATCH} engine for batch=${BATCH} request."
    echo ">> Saving ~3-5 min of engine build time (TRT dynamic shapes allow b${BATCH} on a b${BEST_BATCH} engine)."
    echo ">> Symlinked $TARGET -> $BEST_FILE"
    set_pgie_engine_file "$TARGET"
    exit 0
fi

echo "ENGINE_PRELAUNCH: MISS b${BATCH}"
echo ">> [ENGINE PRELAUNCH — MISS] No cached engine for b${BATCH} or larger. DS will build from ONNX (~3-5 min)."
exit 0
