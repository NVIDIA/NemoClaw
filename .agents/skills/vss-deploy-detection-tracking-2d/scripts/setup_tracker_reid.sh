#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# setup_tracker_reid.sh prepares NvDCF ReID model files and cached engines.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# setup_tracker_reid.sh — Ensure the NvDCF_accuracy ReID model
# (resnet50_market1501.etlt) is at the path the shipped tracker config
# expects, AND symlink the cached TRT engine back into place if one
# was built on a previous run. Idempotent.
#
# Two artifacts are managed here:
#
#   (1) ETLT model file — `resnet50_market1501.etlt`
#       Expected at:    /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
#       Bundled at:     deeper in the perception-app sources tree
#       Action:         copy (or --symlink) into the expected path
#
#   (2) Built TRT engine — `resnet50_market1501.etlt_b<N>_gpu<G>_fp<P>.engine`
#       Expected at:    /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
#       Cached at:      $ENGINE_CACHE_DIR (default /opt/storage/engines/)
#       Action:         on first build (engine appears at expected path),
#                       move it into the persistent cache and replace
#                       with a symlink. On subsequent runs (engine
#                       already in cache), just create the symlink so
#                       the tracker deserialises in <1s instead of
#                       rebuilding from the etlt (~2 minutes).
#
#   Without (2), every fresh container build the tracker engine from
#   scratch — even though the host-side ~/rtvicv-storage/engines/ dir
#   could store it persistently like every other engine in this skill.
#
# Usage:
#   setup_tracker_reid.sh                 # auto-detect, copy etlt, link cached engine
#   setup_tracker_reid.sh --symlink       # symlink etlt instead of copy
#   setup_tracker_reid.sh --src <path>    # explicit etlt source override
#   setup_tracker_reid.sh --wait <sec>    # if no engine in Tracker dirs or cache,
#                                         # poll for one to appear (10 s interval).
#                                         # Used post-stream-add: tracker builds the
#                                         # ReID engine ~90-120 s after the first
#                                         # frame flows, so we wait that long before
#                                         # caching it. Default: 0 (no wait, current
#                                         # behaviour — useful pre-launch).
#
# Exit codes:
#   0  success (copied/linked/already present)
#   1  invalid args
#   2  source etlt not found anywhere under /opt/nvidia/deepstream

set -euo pipefail

REID_BASENAME="resnet50_market1501.etlt"
DEST_DIR="/opt/nvidia/deepstream/deepstream/samples/models/Tracker"
DEST="$DEST_DIR/$REID_BASENAME"

USE_SYMLINK=0
SRC_OVERRIDE=""
WAIT_SEC=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --symlink)  USE_SYMLINK=1; shift ;;
        --src)      SRC_OVERRIDE="$2"; shift 2 ;;
        --wait)     WAIT_SEC="$2"; shift 2 ;;
        -h|--help)  sed -n '18,59p' "$0"; exit 0 ;;
        *)          echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ "$WAIT_SEC" =~ ^[0-9]+$ ]] || { echo "✖ --wait must be a non-negative integer" >&2; exit 1; }

mkdir -p "$DEST_DIR"

# (1) etlt model — copy/link into the expected path if it's not already
# there. Falls through to (2) regardless of branch so the engine cache
# step always runs. Without that fall-through the cache step would be
# skipped any time the etlt was already present (i.e. every reuse and
# every post-stream caching pass).
if [[ -e "$DEST" ]]; then
    echo "TRACKER_REID: ALREADY_PRESENT  $DEST"
else
    # Find the source: either explicit override or the most-likely
    # bundled copy inside the perception-app sources tree. We exclude
    # $DEST_DIR itself from the search so we never match the file
    # we're trying to populate.
    if [[ -n "$SRC_OVERRIDE" ]]; then
        SRC="$SRC_OVERRIDE"
    else
        SRC=$(find /opt/nvidia/deepstream \
                -maxdepth 10 -type f -name "$REID_BASENAME" \
                -not -path "$DEST_DIR/*" \
                2>/dev/null | head -n 1)
    fi

    if [[ -z "$SRC" || ! -f "$SRC" ]]; then
        echo "TRACKER_REID: MISSING  could not locate $REID_BASENAME under /opt/nvidia/deepstream" >&2
        echo "  Pass --src <path> with an explicit source if the model lives elsewhere." >&2
        exit 2
    fi

    if (( USE_SYMLINK )); then
        ln -sfn -T "$SRC" "$DEST"
        echo "TRACKER_REID: LINKED  $DEST  →  $SRC"
    else
        cp -f "$SRC" "$DEST"
        echo "TRACKER_REID: COPIED  $SRC  →  $DEST"
    fi
fi

# ── (2) ReID TRT engine — persistent cache + symlink ──────────────────────
# The tracker writes the built engine next to the etlt, with a name like
#   resnet50_market1501.etlt_b<N>_gpu<G>_fp<P>.engine
# (typically b100_gpu0_fp16.engine on the default config). Without
# caching, every fresh container rebuilds from the etlt — about 90-120
# seconds of avoidable work. Cache it under $ENGINE_CACHE_DIR so it
# survives docker teardown like every other engine in this skill, and
# symlink it back so the tracker deserialises directly.
#
# Path-discovery note: depending on the container build, the tracker
# writes the engine to either the symlinked path
# (/opt/nvidia/deepstream/deepstream/samples/models/Tracker/) OR the
# versioned canonical path (/opt/nvidia/deepstream/deepstream-9.0/...).
# When `deepstream` is a real symlink they're the same dir, but on some
# images they're distinct. We glob BOTH candidate roots and link both.
ENGINE_CACHE_DIR="${ENGINE_CACHE_DIR:-/opt/storage/engines}"
mkdir -p "$ENGINE_CACHE_DIR" 2>/dev/null || true

# Build the list of Tracker/ dirs to inspect: the canonical symlink path
# plus every versioned `deepstream-N.M/` Tracker dir that exists.
TRACKER_DIRS=("$DEST_DIR")
shopt -s nullglob
for d in /opt/nvidia/deepstream/deepstream-[0-9]*/samples/models/Tracker; do
    [[ -d "$d" ]] || continue
    # Skip if it's the same physical dir as DEST_DIR (deepstream → deepstream-N.M symlink).
    if [[ "$(readlink -f "$d" 2>/dev/null)" != "$(readlink -f "$DEST_DIR" 2>/dev/null)" ]]; then
        TRACKER_DIRS+=("$d")
    fi
done
shopt -u nullglob

# Discover engine candidates (any batch / gpu / precision combo) across
# every Tracker dir. Sort by mtime newest-first so the most recently
# built one wins when there are stale variants.
discover_engine_candidates() {
    shopt -s nullglob
    ENGINE_CANDIDATES=()
    for tdir in "${TRACKER_DIRS[@]}"; do
        for f in "$tdir/${REID_BASENAME}"_b*_gpu*_fp*.engine; do
            [[ -e "$f" ]] && ENGINE_CANDIDATES+=("$f")
        done
    done
    # Sort by mtime newest-first.
    if (( ${#ENGINE_CANDIDATES[@]} > 1 )); then
        mapfile -t ENGINE_CANDIDATES < <(printf '%s\n' "${ENGINE_CANDIDATES[@]}" | xargs -d '\n' ls -1t 2>/dev/null)
    fi
    shopt -u nullglob
}

discover_engine_candidates

# Post-stream-add poll: when called with --wait <sec> and the cache is
# also empty, the tracker is still building its engine. Re-discover
# every 10 s until the engine lands or the timeout expires. We only
# enter this branch when there's nothing yet in either Tracker dirs OR
# the cache — a cache hit means we'll plant symlinks below without
# waiting.
if (( WAIT_SEC > 0 && ${#ENGINE_CANDIDATES[@]} == 0 )); then
    shopt -s nullglob
    CACHE_EXISTING=( "$ENGINE_CACHE_DIR/${REID_BASENAME}"_b*_gpu*_fp*.engine )
    shopt -u nullglob
    if (( ${#CACHE_EXISTING[@]} == 0 )); then
        echo "TRACKER_ENGINE: WAITING  poll up to ${WAIT_SEC}s for tracker to build the ReID engine..."
        WAITED=0
        while (( WAITED < WAIT_SEC )); do
            sleep 10
            WAITED=$((WAITED + 10))
            discover_engine_candidates
            if (( ${#ENGINE_CANDIDATES[@]} > 0 )); then
                echo "TRACKER_ENGINE: APPEARED  after ${WAITED}s wait — caching now"
                break
            fi
            echo "TRACKER_ENGINE: STILL_BUILDING  ${WAITED}s elapsed (typical build: 90-120s)"
        done
    fi
fi

if (( ${#ENGINE_CANDIDATES[@]} > 0 )); then
    # Cache (or refresh) every found engine, then plant symlinks in
    # ALL Tracker dirs so both the symlinked and versioned paths
    # resolve to the cache.
    declare -A SEEN_BASENAMES=()
    for ENGINE_AT_DEST in "${ENGINE_CANDIDATES[@]}"; do
        ENGINE_BASENAME=$(basename "$ENGINE_AT_DEST")
        # Skip duplicates already handled (same basename in multiple Tracker dirs).
        [[ -n "${SEEN_BASENAMES[$ENGINE_BASENAME]:-}" ]] && continue
        SEEN_BASENAMES[$ENGINE_BASENAME]=1
        ENGINE_IN_CACHE="$ENGINE_CACHE_DIR/$ENGINE_BASENAME"

        # If the discovered file is a real (non-symlink) file, copy it
        # into the cache. If it's already a symlink to our cache, skip
        # the copy. If it's a symlink to somewhere else, leave the
        # symlink target alone but ensure our cache copy stays current.
        if [[ -L "$ENGINE_AT_DEST" ]]; then
            RESOLVED=$(readlink -f "$ENGINE_AT_DEST" 2>/dev/null || true)
            if [[ "$RESOLVED" != "$ENGINE_IN_CACHE" && -f "$RESOLVED" && ! -f "$ENGINE_IN_CACHE" ]]; then
                cp -f "$RESOLVED" "$ENGINE_IN_CACHE"
                echo "TRACKER_ENGINE: CACHED  $RESOLVED  →  $ENGINE_IN_CACHE"
            fi
        else
            # Real file — cache it (refresh if our copy is older).
            if [[ ! -f "$ENGINE_IN_CACHE" ]]; then
                cp -f "$ENGINE_AT_DEST" "$ENGINE_IN_CACHE"
                echo "TRACKER_ENGINE: CACHED  $ENGINE_AT_DEST  →  $ENGINE_IN_CACHE"
            elif [[ "$ENGINE_AT_DEST" -nt "$ENGINE_IN_CACHE" ]]; then
                cp -f "$ENGINE_AT_DEST" "$ENGINE_IN_CACHE"
                echo "TRACKER_ENGINE: REFRESHED_CACHE  $ENGINE_IN_CACHE (newer build)"
            fi
        fi

        # Plant symlinks in ALL Tracker dirs so any config-referenced
        # path resolves to the cache.
        for tdir in "${TRACKER_DIRS[@]}"; do
            target="$tdir/$ENGINE_BASENAME"
            current=$(readlink -f "$target" 2>/dev/null || true)
            if [[ "$current" == "$ENGINE_IN_CACHE" ]]; then
                continue   # already linked correctly
            fi
            mkdir -p "$tdir" 2>/dev/null || true
            ln -sfn -T "$ENGINE_IN_CACHE" "$target" 2>/dev/null || continue
            echo "TRACKER_ENGINE: LINKED  $target  →  $ENGINE_IN_CACHE"
        done
    done
else
    # No engine in any Tracker dir yet. If the cache has one, plant
    # symlinks in every Tracker dir so the tracker can deserialise on
    # first launch instead of rebuilding.
    shopt -s nullglob
    mapfile -t CACHED_ENGINES < <(
        ls -1t "$ENGINE_CACHE_DIR/${REID_BASENAME}"_b*_gpu*_fp*.engine 2>/dev/null
    )
    shopt -u nullglob
    if (( ${#CACHED_ENGINES[@]} > 0 )); then
        for ENGINE_IN_CACHE in "${CACHED_ENGINES[@]}"; do
            ENGINE_BASENAME=$(basename "$ENGINE_IN_CACHE")
            for tdir in "${TRACKER_DIRS[@]}"; do
                mkdir -p "$tdir" 2>/dev/null || true
                ln -sfn -T "$ENGINE_IN_CACHE" "$tdir/$ENGINE_BASENAME" 2>/dev/null || continue
                echo "TRACKER_ENGINE: LINKED  $tdir/$ENGINE_BASENAME  →  $ENGINE_IN_CACHE  (skip rebuild)"
            done
        done
    else
        echo "TRACKER_ENGINE: NO_BUILD_YET  no engine in Tracker dirs (${TRACKER_DIRS[*]}) or $ENGINE_CACHE_DIR — will build on first launch (~90-120 s)"
    fi
fi
