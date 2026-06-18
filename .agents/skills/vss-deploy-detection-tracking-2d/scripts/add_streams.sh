#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# add_streams.sh posts one or more stream-add requests to the RTVI-CV REST API.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# add_streams.sh - Add streams to a running rtvi-cv deployment via REST,
# one at a time with a fixed delay between each add.
#
# Why one-at-a-time with a delay?
# -------------------------------
# Batching many /stream/add calls back-to-back can cause the perception app
# to interleave "Opening in BLOCKING MODE" messages and stall during caps
# negotiation. Spacing the adds gives each source time to attach cleanly.
#
# Usage modes
# -----------
# (A) Auto-discover from a use case (preferred) — cycles videos to fill BATCH:
#
#       add_streams.sh --usecase warehouse-2d --batch 4 --delay 20
#
# (B) Explicit id+url lists (semicolon-separated, same length):
#
#       add_streams.sh \
#           --ids  "Camera;Camera_01;Camera_02;Camera_03" \
#           --urls "file:///.../Camera.mp4;file:///.../Camera_01.mp4;..." \
#           --delay 20
#
# (C) Eval a pre-built env from discover_streams.sh:
#
#       eval "$(./discover_streams.sh warehouse-2d 4)"
#       add_streams.sh --ids "$STREAM_IDS" --urls "$STREAM_URLS" --delay 20
#
# Common flags
#   --base-url <url>       REST base URL (default: http://localhost:9000)
#   --delay <sec>          Delay between adds (default: 20)
#   --initial-wait <sec>   Wait before FIRST add (default: 0 — first stream fires
#                          immediately; the caller is expected to have already
#                          polled /api/v1/ready, so no extra stabilization wait
#                          is needed. Override if DS needs more warm-up time.)
#   --videos-dir <dir>     Pass a pre-resolved videos directory to discover_streams.sh,
#                          bypassing auto-discovery. Use when multiple video dirs exist
#                          under $RESOURCES (e.g. NGCwarehouse + local smartcity videos)
#                          to avoid RESOLVE_AMBIGUOUS. Mirrors --videos-dir in
#                          discover_streams.sh.
#   --continue-on-error    Don't abort on individual add failures
#
# Exit codes:  0 all added,  1 usage error,  2 one or more adds failed
#
# Prints per-add progress (stream i/N: id → url) so the user knows the
# pause is intentional.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BASE_URL="http://localhost:9000"
DELAY=20
INITIAL_WAIT=0
USECASE=""
BATCH=""
VIDEOS_DIR=""
IDS_CSV=""
URLS_CSV=""
CONTINUE_ON_ERROR=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --usecase)            USECASE="$2";    shift 2 ;;
        --batch)              BATCH="$2";      shift 2 ;;
        --videos-dir)         VIDEOS_DIR="$2"; shift 2 ;;
        --ids)                IDS_CSV="$2";    shift 2 ;;
        --urls)               URLS_CSV="$2";   shift 2 ;;
        --base-url)           BASE_URL="$2";   shift 2 ;;
        --delay)              DELAY="$2";      shift 2 ;;
        --initial-wait)       INITIAL_WAIT="$2"; shift 2 ;;
        --continue-on-error)  CONTINUE_ON_ERROR=1; shift ;;
        -h|--help)            sed -n '18,42p' "$0"; exit 0 ;;
        *)                    die "Unknown argument: $1" ;;
    esac
done

# ── Resolve id+url lists ────────────────────────────────────────
if [[ -n "$USECASE" ]]; then
    is_valid_usecase "$USECASE" || die "Invalid use case: $USECASE (valid: ${USECASES[*]})"
    [[ -n "$BATCH" ]] || die "--usecase requires --batch"
    # Reuse discover_streams.sh to do the enumeration + cycling.
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # --warn-cycle prints an informational WARN line when batch > video count
    # (cycling is allowed for every use case, including warehouse-3d).
    # --videos-dir skips auto-discovery when the caller already resolved the dir
    # (avoids RESOLVE_AMBIGUOUS when multiple video dirs coexist under $RESOURCES).
    DISCOVER_ARGS=("$USECASE" "$BATCH" --format env --warn-cycle)
    [[ -n "$VIDEOS_DIR" ]] && DISCOVER_ARGS+=(--videos-dir "$VIDEOS_DIR")
    # Capture exit code explicitly — eval "$(...)" swallows the subshell exit code
    # (eval of empty string = 0), so set -e never fires when discover_streams.sh
    # exits 3 (RESOLVE_AMBIGUOUS), leaving STREAM_IDS unbound and triggering set -u.
    DISCOVER_OUT=""
    DISCOVER_RC=0
    DISCOVER_OUT=$("$script_dir/discover_streams.sh" "${DISCOVER_ARGS[@]}") || DISCOVER_RC=$?
    if (( DISCOVER_RC == 3 )); then
        die "Multiple video directories found under \$RESOURCES — re-invoke with --videos-dir <absolute-path> to specify which one. Run discover_streams.sh $USECASE $BATCH to see candidates on stderr."
    elif (( DISCOVER_RC != 0 )); then
        die "discover_streams.sh failed (exit $DISCOVER_RC) — see above for details"
    fi
    eval "$DISCOVER_OUT"
    IDS_CSV="$STREAM_IDS"
    URLS_CSV="$STREAM_URLS"
fi

[[ -n "$IDS_CSV" && -n "$URLS_CSV" ]] || die "Provide either --usecase + --batch, or --ids + --urls"

IFS=';' read -r -a IDS  <<< "$IDS_CSV"
IFS=';' read -r -a URLS <<< "$URLS_CSV"
TOTAL=${#IDS[@]}
(( TOTAL > 0 )) || die "--ids list is empty"
(( TOTAL == ${#URLS[@]} )) || die "--ids and --urls must have the same number of entries (${TOTAL} vs ${#URLS[@]})"

[[ "$DELAY"        =~ ^[0-9]+$ ]] || die "--delay must be a non-negative integer"
[[ "$INITIAL_WAIT" =~ ^[0-9]+$ ]] || die "--initial-wait must be a non-negative integer"

# ── Sanity-check REST endpoint is reachable before we start ─────
if ! curl -s --max-time 5 --connect-timeout 3 "${BASE_URL}/api/v1/ready" >/dev/null 2>&1; then
    echo "WARN: ${BASE_URL}/api/v1/ready not reachable yet — is the perception app up?" >&2
fi

# ── Friendly summary so the user knows what to expect ──────────
total_sec=$(( INITIAL_WAIT + DELAY * (TOTAL - 1) ))
echo "────────────────────────────────────────────────────────────────────"
echo ">> Dynamic stream add plan"
echo "     Endpoint:         ${BASE_URL}/api/v1/stream/add"
echo "     Streams to add:   ${TOTAL}"
if (( INITIAL_WAIT > 0 )); then
    echo "     Initial wait:     ${INITIAL_WAIT}s (let DS stabilize)"
fi
echo "     Inter-add delay:  ${DELAY}s (between adds only; first stream fires immediately)"
echo "     Est. total time:  ${total_sec}s"
echo "────────────────────────────────────────────────────────────────────"

if (( INITIAL_WAIT > 0 )); then
    echo ">> Waiting ${INITIAL_WAIT}s before first /stream/add..."
    sleep "$INITIAL_WAIT"
fi

# ── Add loop ────────────────────────────────────────────────────
failed=0
for (( i=0; i<TOTAL; i++ )); do
    idx=$((i+1))
    id="${IDS[$i]}"
    url="${URLS[$i]}"
    echo ">> [${idx}/${TOTAL}] Adding  id='${id}'  url='${url}'"

    # Build the JSON body with python so a camera id or url that contains
    # `"`, `\`, or a literal newline can't escape the JSON string and inject
    # extra fields. python3.json.dumps handles every control char correctly.
    body=$(python3 -c '
import json, sys
cid, url = sys.argv[1], sys.argv[2]
print(json.dumps({
    "key": "sensor",
    "value": {
        "camera_id": cid, "camera_name": cid, "camera_url": url,
        "change": "camera_add", "metadata": {},
    },
}))
' "$id" "$url")

    # Pipe the body to curl via --data-binary @- so it never appears in argv
    # (otherwise visible to other users via `ps`). Capture body + HTTP status
    # in one call; write to a tmpfile so we can echo back to the user on fail.
    tmp=$(mktemp)
    code=$(printf '%s' "$body" \
        | curl -s -o "$tmp" -w '%{http_code}' \
                --max-time 30 --connect-timeout 5 \
                -X POST "${BASE_URL}/api/v1/stream/add" \
                -H 'Content-Type: application/json' \
                --data-binary @- \
        || echo "000")
    resp=$(cat "$tmp"); rm -f "$tmp"

    if [[ "$code" == "200" || "$code" == "201" ]]; then
        echo "   ✓ ADDED   (HTTP $code)"
    else
        echo "   ✗ FAILED  (HTTP $code)  body: $resp" >&2
        failed=$(( failed + 1 ))
        if (( CONTINUE_ON_ERROR == 0 )); then
            echo "STREAM_ADD_FAIL (aborting; use --continue-on-error to keep going)" >&2
            exit 2
        fi
    fi

    if (( idx < TOTAL )); then
        echo ">> Waiting ${DELAY}s before next /stream/add..."
        sleep "$DELAY"
    fi
done

echo "────────────────────────────────────────────────────────────────────"
if (( failed == 0 )); then
    echo "STREAM_ADD_OK  ${TOTAL} stream(s) added"
    exit 0
else
    echo "STREAM_ADD_PARTIAL  ${failed} of ${TOTAL} failed" >&2
    exit 2
fi
