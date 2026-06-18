#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# setup_sparse4d.sh builds or reuses Sparse4D engines and stages configs.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# setup_sparse4d.sh - Build (or reuse cached) Sparse4D TRT engine and stage configs.
#
# Usage:
#   setup_sparse4d.sh --batch <N> [--configs <path>] [--sparse4d-repo <path>] [--force]
#
# Caching strategy:
#   Engine is built INTO the cache at
#       $ENGINE_CACHE_DIR/<sparse4d-onnx-basename>_b<N>.engine
#   e.g.  $ENGINE_CACHE_DIR/sparse4d_warehouse_v2.1.onnx_b4.engine
#   so cache filenames are naturally version-scoped to the ONNX that
#   produced them. config.yaml's `engine_file:` is updated to point at
#   the cache path before sparse4d_setup.sh runs.
#
#   - Cache hit (exact):        b<N> cached -> skip setup.sh, point config at cached .engine
#   - Cache hit (compatible):   b<M>, M>=N -> skip setup.sh, point config at b<M>.engine
#                               (TRT dynamic shapes serve batch<=M from a b<M> engine)
#   - Cache miss:               run setup.sh to build into cache, then future runs hit
#   - --force or FORCE_ENGINE_REBUILD=1 bypasses the cache
#
# Requires LD_PRELOAD and LD_LIBRARY_PATH set (Step 2 of reference-configs/README.md)
# before running setup.sh. Pass --skip-env-check to bypass.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WH3D_CONFIGS="$CONFIGS/warehouse-3d"
BATCH=""
SKIP_ENV=0
FORCE="${FORCE_ENGINE_REBUILD:-0}"
SPARSE4D_ONNX_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --batch)             BATCH="$2"; shift 2 ;;
        --configs)           WH3D_CONFIGS="$2"; shift 2 ;;
        --sparse4d-repo)     SPARSE4D_REPO="$2"; shift 2 ;;
        # Explicit override when auto-detection is ambiguous (multiple
        # sparse4d*.onnx in $RESOURCES — e.g. two NGC resource versions
        # unpacked side by side).
        --sparse4d-onnx)     SPARSE4D_ONNX_OVERRIDE="$2"; shift 2 ;;
        --skip-env-check)    SKIP_ENV=1; shift ;;
        --force)             FORCE=1; shift ;;
        -h|--help)           sed -n '18,20p' "$0"; exit 0 ;;
        *)                   die "Unknown argument: $1" ;;
    esac
done

# Batch size fallback: read num_sensors from config.yaml if --batch not given.
if [[ -z "$BATCH" ]]; then
    BATCH=$(awk -F: '/^[[:space:]]*num_sensors[[:space:]]*:/ {gsub(/[[:space:]#].*/,"",$2); print $2; exit}' "$WH3D_CONFIGS/config.yaml" 2>/dev/null || true)
fi
[[ "$BATCH" =~ ^[0-9]+$ ]] || die "Could not determine batch size. Pass --batch <N>."

require_dir  "$WH3D_CONFIGS"
require_dir  "$SPARSE4D_REPO"
require_file "$WH3D_CONFIGS/config.yaml"
require_file "$WH3D_CONFIGS/calibration.json"

if [[ "$SKIP_ENV" -eq 0 ]]; then
    [[ -n "${LD_PRELOAD:-}" ]] || die "LD_PRELOAD is not set. Run:
  export LD_PRELOAD=$SPARSE4D_REPO/libmsda_fp16.so
  export LD_LIBRARY_PATH=\$LD_LIBRARY_PATH:$SPARSE4D_REPO:/usr/local/lib/python3/dist-packages/torch/lib"
    [[ "$LD_PRELOAD" == *libmsda_fp16.so* ]] \
        || echo "WARN: LD_PRELOAD does not include libmsda_fp16.so (current: $LD_PRELOAD)" >&2
fi

mkdir -p "$ENGINE_CACHE_DIR"

# Detect the Sparse4D ONNX so the cache is keyed by its basename (version-
# scoped). Resolution order:
#   1) --sparse4d-onnx CLI flag  (explicit user override)
#   2) config.yaml's `onnx_file:` key
#   3) a single matching `sparse4d*.onnx` under $RESOURCES
#      (via resolve_unique_path — multiple hits abort with AMBIGUOUS)
#   4) fall back to the legacy `sparse4d` stem (prints a warning)
SPARSE4D_ONNX=""
if [[ -n "$SPARSE4D_ONNX_OVERRIDE" ]]; then
    require_file "$SPARSE4D_ONNX_OVERRIDE"
    SPARSE4D_ONNX="$SPARSE4D_ONNX_OVERRIDE"
    echo "RESOLVE_OK: sparse4d-onnx=$SPARSE4D_ONNX (from --sparse4d-onnx flag)" >&2
elif [[ -f "$WH3D_CONFIGS/config.yaml" ]]; then
    SPARSE4D_ONNX=$(awk -F: '
        /^[[:space:]]*onnx_file[[:space:]]*:/ {
            sub(/^[^:]*:[[:space:]]*/, "")
            gsub(/^["'"'"']|["'"'"']$|[[:space:]#].*/, "")
            print
            exit
        }' "$WH3D_CONFIGS/config.yaml" 2>/dev/null || true)
    if [[ -n "$SPARSE4D_ONNX" && -f "$SPARSE4D_ONNX" ]]; then
        echo "RESOLVE_OK: sparse4d-onnx=$SPARSE4D_ONNX (from config.yaml onnx_file:)" >&2
    else
        SPARSE4D_ONNX=""
    fi
fi
if [[ -z "$SPARSE4D_ONNX" ]]; then
    # Filesystem glob — MAY match multiple hits if two NGC resource versions
    # are unpacked. resolve_unique_path handles each case loudly.
    set +e
    SPARSE4D_ONNX=$(resolve_unique_path sparse4d-onnx --find "$RESOURCES" -type f -name 'sparse4d*.onnx')
    rc=$?
    set -e
    case "$rc" in
        0) ;;  # unique hit — SPARSE4D_ONNX is set
        2) SPARSE4D_ONNX="" ;;  # no match — fall back below
        3) die "Multiple sparse4d*.onnx candidates found under $RESOURCES — pick one and re-run:
  setup_sparse4d.sh --sparse4d-onnx <absolute-path> --batch $BATCH [...]" ;;
        *) die "resolve_unique_path failed with unexpected exit code $rc" ;;
    esac
fi

if [[ -n "$SPARSE4D_ONNX" && -f "$SPARSE4D_ONNX" ]]; then
    STEM=$(onnx_cache_stem "$SPARSE4D_ONNX")
    echo ">> Sparse4D ONNX: $SPARSE4D_ONNX"
    echo ">> Cache stem   : $STEM"
else
    STEM=sparse4d
    echo "WARN: could not locate Sparse4D ONNX — falling back to logical cache stem '$STEM'" >&2
fi
CACHE_TARGET=$(engine_cache_path "$STEM" "$BATCH" .engine)

echo ">> Sparse4D setup"
echo "   Batch size    : $BATCH"
echo "   Configs dir   : $WH3D_CONFIGS"
echo "   Sparse4D repo : $SPARSE4D_REPO"
echo "   Cache dir     : $ENGINE_CACHE_DIR"
echo "   Cache target  : $CACHE_TARGET"

# ── Cache lookup (exact or compatible) — see setup_gdino.sh for comment ────
RESOLVED=""
if [[ "$FORCE" -eq 0 ]]; then
    if RESOLVED=$(engine_cache_hit "$STEM" "$BATCH" .engine); then
        STATUS=$(engine_cache_status "$STEM" "$BATCH" "$RESOLVED" .engine)
        if [[ "$STATUS" == "exact" ]]; then
            echo "ENGINE_CACHE: HIT_EXACT $STEM b${BATCH} -> $RESOLVED"
            echo ">> [CACHE HIT — EXACT] Reusing cached Sparse4D engine for batch=${BATCH}."
            echo ">> Saving ~3-5 min of engine build time. Engine: $RESOLVED"
        else
            RESOLVED_BATCH=$(basename "$RESOLVED" .engine | sed 's/.*_b//')
            echo "ENGINE_CACHE: HIT_COMPAT $STEM b${BATCH} <- b${RESOLVED_BATCH} ($RESOLVED)"
            echo ">> [CACHE HIT — COMPATIBLE] Reusing larger b${RESOLVED_BATCH} Sparse4D engine for batch=${BATCH} request."
            echo ">> Saving ~3-5 min of engine build time (TRT dynamic shapes allow running batch=${BATCH} on a b${RESOLVED_BATCH} engine)."
            echo ">> Engine: $RESOLVED"
        fi
    else
        echo "ENGINE_CACHE: MISS $STEM b${BATCH} -> will build $CACHE_TARGET"
        echo ">> [CACHE MISS] No cached Sparse4D engine for batch=${BATCH}. Will build (~3-5 min)."
    fi
else
    echo "ENGINE_CACHE: FORCE $STEM b${BATCH} -> will rebuild $CACHE_TARGET"
    echo ">> [FORCE REBUILD] Bypassing cache and rebuilding Sparse4D engine."
fi

# ── Stage configs + point engine_file at the resolved/target path ───
mkdir -p "$SPARSE4D_REPO/configs"
cp -f "$WH3D_CONFIGS/config.yaml"      "$SPARSE4D_REPO/configs/config.yaml"
cp -f "$WH3D_CONFIGS/calibration.json" "$SPARSE4D_REPO/calibration.json"

ENGINE_TO_USE="${RESOLVED:-$CACHE_TARGET}"
# Only modify the STAGED copy — never write back to $WH3D_CONFIGS (the source
# config.yaml often lives in a git-tracked, read-only-ish reference-configs
# mount; modifying it would dirty the user's working tree and on bind-mounts
# can even flip host-side file ownership to root).
# If the caller later re-copies $WH3D_CONFIGS/config.yaml into
# $SPARSE4D_REPO/configs/ (e.g. after enabling generate_3d_bbox), they must
# re-run this script or re-apply the engine_file update themselves.
update_yaml_flat "$SPARSE4D_REPO/configs/config.yaml" engine_file "$ENGINE_TO_USE"
echo ">> Pointed staged config.yaml engine_file -> $ENGINE_TO_USE"

# ── On cache hit, we're done. On miss, build. ───────────────────────
if [[ -n "$RESOLVED" ]]; then
    echo ">> Skipping sparse4d_setup.sh (engine reused from cache)."
    exit 0
fi

SETUP="$SPARSE4D_REPO/configs/sparse4d_setup.sh"
require_file "$SETUP"

echo ">> Running sparse4d_setup.sh (this takes a few minutes)..."
bash "$SETUP"

# ── Verify the engine landed at the cache path and populate cache ───
if [[ -f "$CACHE_TARGET" ]]; then
    echo ">> Engine built successfully: $CACHE_TARGET"
else
    # Some setup scripts may write to an alternative path — search and copy.
    BUILT=$(find "$SPARSE4D_REPO" -maxdepth 3 -type f -name '*.engine' -newer "$SETUP" 2>/dev/null | head -n1 || true)
    if [[ -n "$BUILT" ]]; then
        cache_engine "$BUILT" "$STEM" "$BATCH" .engine
        update_yaml_flat "$SPARSE4D_REPO/configs/config.yaml" engine_file "$CACHE_TARGET"
        update_yaml_flat "$WH3D_CONFIGS/config.yaml"          engine_file "$CACHE_TARGET"
    else
        die "Sparse4D setup completed but no .engine file found near $SPARSE4D_REPO"
    fi
fi

echo ">> Sparse4D setup complete. Engine cached at $CACHE_TARGET"
echo "   NOTE: re-copy config.yaml if you edit it later:"
echo "     cp $WH3D_CONFIGS/config.yaml $SPARSE4D_REPO/configs/config.yaml"
