#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# common.sh defines shared defaults and shell helpers for deploy scripts.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# common.sh - Shared helpers for rtvicv-deploy scripts.
# Source this file: source "$(dirname "$0")/common.sh"
#
# Provides:
#   - Default paths (CONFIGS, SPARSE4D_REPO, TRITON_REPO, RESOURCES)
#   - Use-case registry (USECASES[] + is_valid_usecase)
#   - Config editors:
#       update_ds_config  <file> <section> <key> <value>     # INI [section]/key=value
#       update_yaml_flat  <file> <key> <value>               # key: value  (flat or nested leaf)
#       update_pbtxt_max_batch <file> <N>                    # max_batch_size: N
#       update_engine_filename <file> <N>                    # _b<N>_gpu*_fp*.engine
#   - Small utilities: die, require_file, require_dir, backup_once

set -u

die()         { echo "ERROR: $*" >&2; exit 1; }
require_file(){ [[ -f "$1" ]] || die "Required file missing: $1"; }
require_dir() { [[ -d "$1" ]] || die "Required directory missing: $1"; }

# backup_once <file>
# Copies <file> -> <file>.bak on first call and is a no-op afterwards. Backups
# get the same mode as the source via cp -p; we additionally chmod 600 so a
# config that holds a credential (none today, but the contract should hold)
# never lands on disk world-readable via its backup copy.
backup_once() {
    [[ -f "${1}.bak" ]] && return 0
    cp -p "$1" "${1}.bak"
    chmod 600 "${1}.bak" 2>/dev/null || true
}

# sed_escape_replacement <string>
# Escapes &, |, and \ so a string is safe to use as the replacement side of a
# `sed s|find|REPL|` invocation that uses `|` as the delimiter. Filesystem
# paths can legitimately contain any of these and the unescaped form silently
# corrupts the edit (sed reinterprets & as the matched text and \ as an escape
# introducer). Output is on stdout so it can be captured.
sed_escape_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

# ── resolve_unique_path — pick exactly one path from a find, loudly ─────
# Wraps a `find` invocation so callers never silently pick the first match.
# Used everywhere a model ONNX or videos directory is auto-discovered, so a
# second NGC resource version on disk can't silently override the intended one.
#
#   resolve_unique_path <label> --find <find-args...>
#
# (Only `--find` is supported — shell globs are rejected because an unmatched
# bash glob without `nullglob` leaks the literal pattern back as a fake "hit".
# `find` with no matches prints nothing, which maps cleanly to rc=2.)
#
# Behaviour:
#   0 hits     → returns 2; stderr: `RESOLVE_MISS: <label> (no match)`
#   1 hit      → returns 0; stdout = the path;
#                stderr: `RESOLVE_OK: <label>=<path>`
#   N>1 hits   → returns 3; stderr: `RESOLVE_AMBIGUOUS: <label> count=<N>`
#                followed by one `  [<i>] <path>` line per candidate so the
#                agent (or human) can show them in a picker and rerun with
#                the ambiguity resolved.
#
# Callers should usually react to the 3 return codes as:
#   0 → proceed with the echoed path, print "Using <label>: <path>"
#   2 → fall back to a sane default, or die with actionable guidance
#   3 → abort and tell the user to pass an explicit --<label> flag
resolve_unique_path() {
    local label="$1"; shift
    case "${1:-}" in
        --find) shift ;;
        *) die "resolve_unique_path: expected --find after <label> (got: ${1:-<empty>})" ;;
    esac

    local -a hits=()
    mapfile -t hits < <(find "$@" 2>/dev/null | sort -u)

    local n=${#hits[@]}
    if (( n == 0 )); then
        echo "RESOLVE_MISS: $label (no match)" >&2
        return 2
    elif (( n == 1 )); then
        echo "RESOLVE_OK: $label=${hits[0]}" >&2
        printf '%s\n' "${hits[0]}"
        return 0
    else
        echo "RESOLVE_AMBIGUOUS: $label count=$n" >&2
        local i
        for ((i=0; i<n; i++)); do
            echo "  [$i] ${hits[$i]}" >&2
        done
        return 3
    fi
}

# ── Default paths (inside the RTVI-CV container) ─────────────────
: "${CONFIGS:=/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs}"
: "${SPARSE4D_REPO:=/opt/nvidia/deepstream/deepstream/sources/sparse4d}"
: "${TRITON_REPO:=/opt/nvidia/deepstream/deepstream/sources/TritonGdino/triton_model_repo}"
: "${STORAGE:=/opt/storage}"
: "${RESOURCES:=$STORAGE/resources}"
# Engine cache — persistent across container runs (mounted from host
# ~/rtvicv-storage/engines). Prevents 5-10 min trtexec rebuilds on every launch.
: "${ENGINE_CACHE_DIR:=$STORAGE/engines}"

# ── Use case registry ────────────────────────────────────────────
USECASES=(warehouse-2d warehouse-3d smartcity-rtdetr smartcity-gdino)

is_valid_usecase() {
    local uc="$1"
    for x in "${USECASES[@]}"; do [[ "$x" == "$uc" ]] && return 0; done
    return 1
}

# ── INI-style editor (DeepStream *.txt configs) ──────────────────
# Updates key=value inside [section]. If the key is missing, appends it
# at the end of the section. Idempotent. Pure bash — no python needed.
#
#   update_ds_config <file> <section> <key> <value>
# Example:
#   update_ds_config ds-main-config.txt "[streammux]" batch-size 4
#
# Note: pass the section WITH square brackets: "[streammux]".
update_ds_config() {
    local file="$1" section="$2" key="$3" value="$4"
    require_file "$file"
    backup_once "$file"

    # Match the section header literally (`grep -F`) so any regex metachar in
    # the section name (`.`, `*`, `$`, `\`, …) cannot match the wrong line.
    if ! grep -Fxq "$section" "$file"; then
        die "Section '$section' not found in $file"
    fi

    local tmp
    tmp=$(mktemp)
    local in_section=0 property_found=0

    while IFS= read -r line || [[ -n "$line" ]]; do
        # Leaving the current section -> append the key if not yet seen.
        if [[ $in_section -eq 1 ]] && echo "$line" | grep -q "^\[.*\]" && [[ "$line" != "$section" ]]; then
            [[ $property_found -eq 0 ]] && { echo "$key=$value" >> "$tmp"; property_found=1; }
            in_section=0
        fi

        # Entering the target section.
        if [[ "$line" == "$section" ]]; then
            in_section=1
        fi

        # Replace the key in the target section.
        if [[ $in_section -eq 1 ]] && echo "$line" | grep -q "^$key="; then
            echo "$key=$value" >> "$tmp"
            property_found=1
        else
            echo "$line" >> "$tmp"
        fi
    done < "$file"

    # Key not found anywhere in the target section -> append at EOF.
    [[ $in_section -eq 1 && $property_found -eq 0 ]] && echo "$key=$value" >> "$tmp"

    mv "$tmp" "$file"
}

# ── YAML editor (flat/nested leaf key) ───────────────────────────
# Replaces the VALUE of a leaf YAML key (matched by indentation-agnostic
# `^<ws>key: ...`). Adds the key if missing. Idempotent.
#
#   update_yaml_flat <file> <key> <value>
# Example:
#   update_yaml_flat config.yaml num_sensors 4
update_yaml_flat() {
    local file="$1" key="$2" value="$3"
    require_file "$file"
    backup_once "$file"

    # Escape three different things, since the key shows up in three
    # different positions:
    #   key_pat  → ERE pattern (used by both grep -qE and sed -E pattern)
    #              to match the existing line. Without this, an ERE
    #              metachar in the key would make grep and sed disagree.
    #   key_esc  → sed replacement string (preserves literal `&` / `\`).
    #   value_esc→ sed replacement string for the value.
    # The previous version used `$key` raw in the grep but `$key_esc`
    # in the sed replacement — they could match different lines if the
    # key happened to contain ERE metachars.
    local key_pat key_esc value_esc
    key_pat=$(sed -E 's/[][\\.*^$|+?(){}/-]/\\&/g' <<<"$key")
    key_esc=$(sed_escape_replacement "$key")
    value_esc=$(sed_escape_replacement "$value")

    if grep -qE "^[[:space:]]*${key_pat}[[:space:]]*:" "$file"; then
        # Preserve leading indentation of the matched line.
        sed -i -E "s|^([[:space:]]*)${key_pat}[[:space:]]*:.*|\1${key_esc}: ${value_esc}|" "$file"
    else
        printf '%s: %s\n' "$key" "$value" >> "$file"
    fi
}

# ── Triton config.pbtxt: max_batch_size: N ───────────────────────
update_pbtxt_max_batch() {
    local file="$1" n="$2"
    require_file "$file"
    backup_once "$file"
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || die "update_pbtxt_max_batch: N must be a positive integer (got: $n)"
    sed -i -E "s/^[[:space:]]*max_batch_size[[:space:]]*:[[:space:]]*[0-9]+/max_batch_size: ${n}/" "$file"
}

# ── Engine filename batch suffix (DeepStream engine cache) ───────
# Rewrites the _b<N>_ segment in engine filenames when batch size changes.
# Handles two naming conventions:
#   1) Skill/explicit cache (preferred): <onnx-basename>_b<N>.engine  or  <onnx-basename>_b<N>.plan
#      e.g. /opt/storage/engines/rtdetr_warehouse_v1.0.1.fp16.onnx_b4.engine
#   2) DeepStream default auto-build:     <onnx-basename>_b<N>_gpu<G>_fp<P>.engine
#      e.g. rtdetr_warehouse_v1.0.1.fp16.onnx_b4_gpu0_fp16.engine
update_engine_filename() {
    local file="$1" n="$2"
    require_file "$file"
    backup_once "$file"
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || die "update_engine_filename: N must be a positive integer (got: $n)"
    sed -i -E \
        -e "s/(_b)[0-9]+(_gpu[0-9]+_fp[0-9]+\.(engine|plan))/\1${n}\2/g" \
        -e "s/(_b)[0-9]+(\.(engine|plan))([^0-9A-Za-z_]|$)/\1${n}\2\4/g" \
        "$file"
}

# ── Tile grid computation (for [tiled-display] rows/columns) ─────
# Given a batch size N, computes a grid that's closest to square:
#   ROW = floor(sqrt(N))
#   COL = ceil(N / ROW)
# Examples:
#   N=1  -> 1x1
#   N=2  -> 1x2
#   N=4  -> 2x2
#   N=6  -> 2x3
#   N=8  -> 2x4
#   N=9  -> 3x3
#   N=16 -> 4x4
#
# Prints two space-separated integers "<ROW> <COL>" on stdout.
#
#   read -r ROW COL < <(compute_tile_grid 8)
compute_tile_grid() {
    local n="$1"
    [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] || die "compute_tile_grid: N must be a positive integer (got: $n)"
    awk -v n="$n" 'BEGIN {
        row = int(sqrt(n))
        if (row < 1) row = 1
        col = int((n + row - 1) / row)
        print row, col
    }'
}

# ── Engine cache (persistent across container runs) ─────────────
# Cache filenames now mirror the ONNX they were built from, plus a batch
# suffix — e.g. `rtdetr_warehouse_v1.0.1.fp16.onnx_b4.engine`. Using the
# ONNX basename as the stem means:
#   1) You can tell at a glance which model+version the engine serves.
#   2) Bumping the NGC resource (new ONNX version) yields a new cache
#      entry automatically — no risk of silently reusing a stale engine.
#
# All helpers take a "stem" (usually the ONNX basename, kept with its
# `.onnx` extension) plus the batch size.

# Return the cache stem for a given ONNX path — the basename, with the
# `.onnx` extension retained so engine names and their source ONNX are
# trivially linkable by eye:
#     onnx_cache_stem /opt/.../rtdetr_warehouse_v1.0.1.fp16.onnx
#         -> rtdetr_warehouse_v1.0.1.fp16.onnx
onnx_cache_stem() { basename -- "$1"; }

# Canonical path for a cached engine file.
#   engine_cache_path <stem> <batch> [ext]
# <stem> should normally be the ONNX basename; fall back to a logical name
# (e.g. `sparse4d`) only when the ONNX path cannot be discovered.
engine_cache_path() {
    local stem="$1" batch="$2" ext="${3:-.engine}"
    echo "${ENGINE_CACHE_DIR}/${stem}_b${batch}${ext}"
}

# Tiered engine cache lookup — exact match OR compatible (larger-batch) match.
# TRT engines built with dynamic shapes for batch 1..maxBatch can run any batch
# size <= maxBatch. So a cached engine built for batch=8 can serve a batch=4
# request — no need to rebuild for smaller batches.
#
#   engine_cache_hit <stem> <batch> [ext]
#
# <stem> should be the ONNX basename (e.g. `rtdetr_warehouse_v1.0.1.fp16.onnx`)
# so cache entries are version-scoped to the exact ONNX they came from.
#
# Prints the resolved engine path on stdout and returns 0 on hit.
# Returns 1 if nothing usable is cached.
#
# Match order:
#   1) EXACT match:       <stem>_b<N>.<ext>      (best TRT performance)
#   2) COMPATIBLE match:  smallest <stem>_b<M>.<ext> with M >= N  (reuses a larger engine)
#
# Set ENGINE_EXACT_MATCH_ONLY=1 to disable the compatible fallback.
# Caller should print something like "cache hit: exact" or "cache hit: compatible (b8 for b4 request)".
engine_cache_hit() {
    local stem="$1" batch="$2" ext="${3:-.engine}"

    # 1) Exact match
    local exact="${ENGINE_CACHE_DIR}/${stem}_b${batch}${ext}"
    if [[ -f "$exact" ]]; then
        echo "$exact"
        return 0
    fi

    # 2) Compatible match (disabled if ENGINE_EXACT_MATCH_ONLY=1)
    [[ "${ENGINE_EXACT_MATCH_ONLY:-0}" -eq 1 ]] && return 1

    local best_batch=0 best_path=""
    local f fname fstem b
    for f in "${ENGINE_CACHE_DIR}/${stem}_b"*"${ext}"; do
        [[ -f "$f" ]] || continue
        fname=${f##*/}
        fstem=${fname%${ext}}
        b=${fstem##${stem}_b}
        [[ "$b" =~ ^[0-9]+$ ]] || continue
        if (( b >= batch )); then
            if (( best_batch == 0 )) || (( b < best_batch )); then
                best_batch=$b
                best_path=$f
            fi
        fi
    done

    if [[ -n "$best_path" ]]; then
        echo "$best_path"
        return 0
    fi
    return 1
}

# Classify a cache hit — echoes "exact" | "compatible" | "miss" for logging.
#   engine_cache_status <stem> <batch> <resolved_path> [ext]
engine_cache_status() {
    local stem="$1" batch="$2" resolved="$3" ext="${4:-.engine}"
    local exact_name="${stem}_b${batch}${ext}"
    [[ -z "$resolved" ]] && { echo miss; return; }
    [[ "${resolved##*/}" == "$exact_name" ]] && { echo exact; return; }
    echo compatible
}

# Copy a freshly-built engine into the cache directory so future runs can
# reuse it without calling trtexec.
#   cache_engine <src_engine> <stem> <batch> [ext]
cache_engine() {
    local src="$1" stem="$2" batch="$3" ext="${4:-.engine}"
    mkdir -p "$ENGINE_CACHE_DIR"
    [[ -f "$src" ]] || { echo "cache_engine: source not found: $src" >&2; return 1; }
    local dst
    dst=$(engine_cache_path "$stem" "$batch" "$ext")
    # Same file? (e.g. build target already IS the cache path) — skip copy.
    if [[ "$src" -ef "$dst" ]]; then
        echo "cache_engine: source already at cache path: $dst"
        return 0
    fi
    cp -f "$src" "$dst"
    echo "cached: $dst"
}
