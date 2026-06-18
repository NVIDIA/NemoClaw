#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# update_stream_sources.sh rewrites DeepStream source-list entries.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# update_stream_sources.sh - Apply [source-list] configuration for a given use case.
# Implements an update_source_list_config() pattern scoped to the
# vss-deploy-detection-tracking-2d skill.
#
# The DS main config's [source-list] section is SHARED between the two input
# modes: dynamic (REST add-stream) and static (config-declared URLs). Because
# the keys persist across runs, switching modes requires an explicit reset.
#
# This script makes the mode switch explicit and verified:
#   dynamic  -> num-source-bins=0, list=, sensor-id-list=, sensor-name-list=
#   static   -> num-source-bins=N, list / sensor-*-list populated from args
# Both modes verify every written key before returning.
#
# Usage
# -----
#   update_stream_sources.sh <usecase> dynamic
#   update_stream_sources.sh <usecase> static --batch-size N --urls "u1;u2;..." --names "n1;n2;..."
#
# Arguments
#   usecase          warehouse-2d | warehouse-3d | smartcity-rtdetr | smartcity-gdino
#   dynamic|static   mode
#
# Static-mode flags (required when mode=static):
#   --batch-size N            Number of streams to pre-populate (matches [streammux] batch-size).
#   --urls   "u1;u2;..."      Semicolon-separated URL list. Length <= N. If < N, entries are
#                             recycled (with _2/_3/... suffix on names) to fill N.
#   --names  "n1;n2;..."      Semicolon-separated sensor names (used for both sensor-id-list
#                             and sensor-name-list). Length must match --urls.
#
# Optional flags (static mode only):
#   --http-port 9000          REST API port written as [source-list] http-port (default 9000).

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

USECASE="${1:-}"
MODE="${2:-}"
[[ -n "$USECASE" && -n "$MODE" ]] || die "Usage: $0 <usecase> <dynamic|static> [static-mode flags]"
shift $(( $# >= 2 ? 2 : $# )) 2>/dev/null || true

is_valid_usecase "$USECASE" || die "Invalid use case: $USECASE (valid: ${USECASES[*]})"
case "$MODE" in dynamic|static) ;; *) die "Invalid mode: $MODE (must be dynamic|static)" ;; esac

BATCH_SIZE=""; URLS=""; NAMES=""; HTTP_PORT=9000
while [[ $# -gt 0 ]]; do
    case "$1" in
        --batch-size) BATCH_SIZE="$2"; shift 2 ;;
        --urls)       URLS="$2";       shift 2 ;;
        --names)      NAMES="$2";      shift 2 ;;
        --http-port)  HTTP_PORT="$2";  shift 2 ;;
        -h|--help)    sed -n '18,48p' "$0"; exit 0 ;;
        *)            die "Unknown argument: $1" ;;
    esac
done

case "$USECASE" in
    warehouse-2d)     MAIN="$CONFIGS/warehouse-2d/ds-main-config.txt" ;;
    warehouse-3d)     MAIN="$CONFIGS/warehouse-3d/ds-main-config.txt" ;;
    smartcity-rtdetr) MAIN="$CONFIGS/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt" ;;
    smartcity-gdino)  MAIN="$CONFIGS/smartcities/gdino/run_config-api-rtdetr-protobuf.txt" ;;
esac
require_file "$MAIN"

echo ">> Updating [source-list] for $USECASE: mode=$MODE"
echo "   Main config: $MAIN"

# ── Mode-specific value derivation ──────────────────────────────
if [[ "$MODE" == "dynamic" ]]; then
    EXPECT_NUM=0
    EXPECT_LIST=""
    EXPECT_IDS=""
    EXPECT_NAMES=""
else
    [[ -n "$BATCH_SIZE" ]] || die "static mode requires --batch-size"
    [[ -n "$URLS"       ]] || die "static mode requires --urls"
    [[ -n "$NAMES"      ]] || die "static mode requires --names"
    [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || die "--batch-size must be an integer"

    # Trim trailing ';' if user passed "a;b;" style.
    URLS="${URLS%;}"; NAMES="${NAMES%;}"

    # Split into arrays, then recycle to fill BATCH_SIZE (same as automation repo).
    IFS=';' read -r -a U_ARR <<< "$URLS"
    IFS=';' read -r -a N_ARR <<< "$NAMES"
    (( ${#U_ARR[@]} == ${#N_ARR[@]} )) || die "--urls and --names must have the same number of entries (got ${#U_ARR[@]} vs ${#N_ARR[@]})"
    (( ${#U_ARR[@]} > 0 ))              || die "--urls must contain at least one entry"

    FULL_LIST=""; FULL_IDS=""; FULL_NAMES=""
    orig_count=${#U_ARR[@]}
    for i in $(seq 1 "$BATCH_SIZE"); do
        idx=$(( (i - 1) % orig_count ))
        FULL_LIST="${FULL_LIST}${U_ARR[$idx]};"
        if (( i <= orig_count )); then
            FULL_IDS="${FULL_IDS}${N_ARR[$idx]};"
            FULL_NAMES="${FULL_NAMES}${N_ARR[$idx]};"
        else
            # Cycle suffix — prevents duplicate sensor-id collisions.
            FULL_IDS="${FULL_IDS}${N_ARR[$idx]}_${i};"
            FULL_NAMES="${FULL_NAMES}${N_ARR[$idx]}_${i};"
        fi
    done
    # Strip trailing ';' to match DS canonical format.
    FULL_LIST="${FULL_LIST%;}"; FULL_IDS="${FULL_IDS%;}"; FULL_NAMES="${FULL_NAMES%;}"

    EXPECT_NUM="$BATCH_SIZE"
    EXPECT_LIST="$FULL_LIST"
    EXPECT_IDS="$FULL_IDS"
    EXPECT_NAMES="$FULL_NAMES"
fi

# ── Apply ────────────────────────────────────────────────────────
update_ds_config "$MAIN" "[source-list]" num-source-bins  "$EXPECT_NUM"
update_ds_config "$MAIN" "[source-list]" list             "$EXPECT_LIST"
update_ds_config "$MAIN" "[source-list]" sensor-id-list   "$EXPECT_IDS"
update_ds_config "$MAIN" "[source-list]" sensor-name-list "$EXPECT_NAMES"
update_ds_config "$MAIN" "[source-list]" http-port        "$HTTP_PORT"

# ── Verify ───────────────────────────────────────────────────────
# Pulls "key=value" from [source-list]. Prints value (may be empty string).
get_src_key() {
    awk -v k="$1" '
        $0 == "[source-list]" { insec=1; next }
        /^\[/                 { insec=0 }
        insec && $0 ~ "^"k"=" { sub("^"k"=",""); print; exit }
    ' "$MAIN"
}

fail=0
_check() {
    local key="$1" expect="$2"
    local got; got=$(get_src_key "$key")
    if [[ "$got" != "$expect" ]]; then
        echo "   FAIL $key  expected='${expect}'  got='${got}'" >&2
        fail=1
    fi
}
_check num-source-bins  "$EXPECT_NUM"
_check list             "$EXPECT_LIST"
_check sensor-id-list   "$EXPECT_IDS"
_check sensor-name-list "$EXPECT_NAMES"
_check http-port        "$HTTP_PORT"

if (( fail != 0 )); then
    echo "STREAM_SOURCES_FAIL $USECASE $MODE — see diffs above" >&2
    exit 1
fi

if [[ "$MODE" == "dynamic" ]]; then
    echo "   cleared stale static state (num-source-bins=0, list/sensor-*-list empty)"
    echo "   REST endpoint: http://localhost:${HTTP_PORT}/api/v1/stream/add"
else
    echo "   populated $EXPECT_NUM static stream(s); http-port=$HTTP_PORT"
fi
echo "STREAM_SOURCES_OK $USECASE $MODE"
