#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# clean_engine_cache.sh removes non-engine files from the TRT engine cache.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# clean_engine_cache.sh — Move non-engine files OUT of the engine cache.
#
# The engine cache dir ($ENGINE_CACHE_DIR, default /opt/storage/engines/)
# should only contain:
#   *.engine         (TRT engines for nvinfer / Sparse4D / tracker ReID)
#   *.plan           (TRT plans for Triton / GDINO)
#
# Past versions of this skill (or accidental user actions) have left
# stray binaries, .o object files, or other build artefacts in the
# cache dir. They take up space, can confuse downstream lookups, and
# pollute `ls -1`.
#
# This helper relocates anything that doesn't match the allowlist into
# `<cache>/.quarantine/` (a sibling subdir) so the user can inspect and
# delete manually. Idempotent. Never deletes anything outright.
#
# Usage:
#   clean_engine_cache.sh                    # default cache dir
#   clean_engine_cache.sh --cache-dir <path> # explicit override
#   clean_engine_cache.sh --dry-run          # report only, don't move
#
# Exit codes:
#   0  success (or nothing to do)
#   1  invalid args / cache dir not found

set -euo pipefail

CACHE_DIR="${ENGINE_CACHE_DIR:-/opt/storage/engines}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cache-dir) CACHE_DIR="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   sed -n '18,41p' "$0"; exit 0 ;;   # skip SPDX header; full usage block
        *)           echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ -d "$CACHE_DIR" ]] || { echo "✖ cache dir not found: $CACHE_DIR" >&2; exit 1; }

QUARANTINE="$CACHE_DIR/.quarantine"
moved=0
shopt -s nullglob

for f in "$CACHE_DIR"/*; do
    [[ -e "$f" ]] || continue
    name=$(basename "$f")
    # Allowed: regular files or symlinks ending in .engine or .plan.
    case "$name" in
        *.engine|*.plan) continue ;;
    esac
    # Skip the quarantine dir itself.
    [[ "$name" == ".quarantine" ]] && continue
    # Skip directories that aren't quarantine — relocate the directory
    # itself rather than recursing into it.

    if (( DRY_RUN )); then
        echo "CLEAN_CACHE: WOULD_MOVE  $f"
    else
        mkdir -p "$QUARANTINE"
        mv -f "$f" "$QUARANTINE/" 2>/dev/null && {
            moved=$((moved+1))
            echo "CLEAN_CACHE: MOVED  $name  →  $QUARANTINE/"
        } || echo "CLEAN_CACHE: SKIP  $f (move failed — permissions?)" >&2
    fi
done

shopt -u nullglob

if (( moved > 0 )); then
    echo "CLEAN_CACHE: $moved non-engine file(s) moved to $QUARANTINE/"
    echo "             review with 'ls -la $QUARANTINE/' and 'rm -rf $QUARANTINE/' once verified."
elif (( DRY_RUN == 0 )); then
    echo "CLEAN_CACHE: cache is clean — only *.engine / *.plan files present"
fi
