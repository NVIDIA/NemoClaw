#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# run_app_and_wait.sh starts the app and waits for readiness and metrics.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# run_app_and_wait.sh — launch app, poll ready, cache engine, add streams, collect metrics.
# ONE docker exec call covers everything after the container is up.
#
# Usage:
#   run_app_and_wait.sh --usecase <uc> --batch <N> --sink <sink> --log <container-log-path>
#                       [--delay <sec>]        stream-add inter-add delay (default 5)
#                       [--onnx <path>]        container-side ONNX path for engine caching
#                                              (warehouse-2d / smartcity-rtdetr only)
#                       [--videos <dir>]       container-side videos dir — passed to
#                                              add_streams.sh to skip auto-discovery.
#                                              Required when multiple video dirs exist under
#                                              $RESOURCES (avoids RESOLVE_AMBIGUOUS).
#                       [--stream-mode <dynamic|static>]   default: static
#                                              (matches apply_config.sh default per
#                                              references/pipeline-config.md — keeping
#                                              the two defaults in sync prevents
#                                              double-stream-add when an agent invokes
#                                              this script directly without the flag)
#                       [--timeout <sec>]      max wait for REST ready (default 900)
#                       [--no-metrics]         skip collect_metrics step
#
# Output markers (parseable by the skill):
#   ENGINE_STATUS: cached | built | retrying | unknown
#   READY_OK elapsed=<N>
#   ENGINE_CACHE: LINKED ... | LINK_SKIP ...
#   STREAM_ADD_OK <N> stream(s) added
#   METRICS_OK samples=3 interval=5
#   LAUNCH_COMPLETE usecase=<uc> batch=<N> sink=<sink>

set -euo pipefail

USECASE=""
BATCH=""
DELAY=5
SINK="fakesink"
LOG=""
ONNX=""
VIDEOS=""
# Default matches apply_config.sh per references/pipeline-config.md
# § "Defaults — the skill is static-mode by default". Keeping the two
# script defaults aligned prevents a double-stream-add when an agent
# calls run_app_and_wait.sh directly without --stream-mode: with the
# static [source-list] block already populated by apply_config.sh, a
# stale `dynamic` default here would still POST batch /stream/add calls
# via add_streams.sh and end up with 2*BATCH active sources.
STREAM_MODE="static"
TIMEOUT=900
NO_METRICS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --usecase)     USECASE="$2";     shift 2 ;;
    --batch)       BATCH="$2";       shift 2 ;;
    --delay)       DELAY="$2";       shift 2 ;;
    --sink)        SINK="$2";        shift 2 ;;
    --log)         LOG="$2";         shift 2 ;;
    --onnx)        ONNX="$2";        shift 2 ;;
    --videos)      VIDEOS="$2";      shift 2 ;;
    --stream-mode) STREAM_MODE="$2"; shift 2 ;;
    --timeout)     TIMEOUT="$2";     shift 2 ;;
    --no-metrics)  NO_METRICS=1;     shift   ;;
    -h|--help)     sed -n '18,41p' "$0"; exit 0 ;;   # skip SPDX/license header
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate inputs against an allow-list before any path/exec construction.
case "$SINK" in fakesink|eglsink|filedump) ;;
  *) echo "✖ Invalid --sink: $SINK (allowed: fakesink|eglsink|filedump)" >&2; exit 1 ;;
esac
case "$STREAM_MODE" in dynamic|static) ;;
  *) echo "✖ Invalid --stream-mode: $STREAM_MODE (allowed: dynamic|static)" >&2; exit 1 ;;
esac
[[ -n "$USECASE" && -n "$BATCH" && -n "$LOG" ]] \
  || { echo "✖ --usecase, --batch and --log are required" >&2; exit 1; }
[[ "$BATCH"   =~ ^[1-9][0-9]*$ ]] || { echo "✖ --batch must be a positive integer (got: $BATCH)" >&2; exit 1; }
[[ "$DELAY"   =~ ^[0-9]+$ ]]      || { echo "✖ --delay must be a non-negative integer (got: $DELAY)" >&2; exit 1; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "✖ --timeout must be a positive integer (got: $TIMEOUT)" >&2; exit 1; }

DS_APP_DIR="/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app"

# smartcity usecases live under smartcities/<variant>/, not reference-configs/<usecase>/
case "$USECASE" in
  warehouse-2d)      USECASE_DIR="warehouse-2d" ;;
  warehouse-3d)      USECASE_DIR="warehouse-3d" ;;
  smartcity-rtdetr)  USECASE_DIR="smartcities/rt-detr" ;;
  smartcity-gdino)   USECASE_DIR="smartcities/gdino" ;;
  *) echo "✖ Unknown usecase: $USECASE"; exit 1 ;;
esac

# Locate the main config without parsing `ls` output. Order:
#   run_config* (smartcity) → *main*.yml → *main*.txt
# `find -print -quit` returns the first hit only; null-safe vs filenames with spaces.
CFG_DIR="$DS_APP_DIR/reference-configs/$USECASE_DIR"
[[ -d "$CFG_DIR" ]] || { echo "✖ Config dir not found: $CFG_DIR" >&2; exit 1; }
MAIN_CFG=$(find "$CFG_DIR" -maxdepth 1 -type f -name 'run_config*.txt' -print -quit 2>/dev/null)
[[ -z "$MAIN_CFG" ]] && MAIN_CFG=$(find "$CFG_DIR" -maxdepth 1 -type f -name '*main*.yml' -print -quit 2>/dev/null)
[[ -z "$MAIN_CFG" ]] && MAIN_CFG=$(find "$CFG_DIR" -maxdepth 1 -type f -name '*main*.txt' -print -quit 2>/dev/null)
[[ -n "$MAIN_CFG" ]] || { echo "✖ No main config found under $CFG_DIR" >&2; exit 1; }

# Build args directly — no shell-eval of caller-controlled strings.
APP_ARGS=(-c "$MAIN_CFG")
[[ "$SINK" == "eglsink" || "$SINK" == "filedump" ]] && APP_ARGS+=(--tiledtext)

# Self-heal: if the deployment log file is empty (caller skipped
# write_deployment_log.sh and just `mkdir -p`'d a path), initialise it
# now so the structured header + every config file content land BEFORE
# the runtime stdout/stderr is appended. The script gracefully degrades
# to "?" for any settings the caller didn't pass.
WDL=/tmp/scripts/write_deployment_log.sh
if [[ ! -s "$LOG" && -x "$WDL" ]]; then
    echo "ℹ run_app_and_wait.sh: log $LOG is empty — auto-initialising via write_deployment_log.sh"
    APP_CMD_STR=$(printf './metropolis_perception_app -c %q' "$MAIN_CFG")
    [[ "$SINK" == "eglsink" || "$SINK" == "filedump" ]] && APP_CMD_STR+=" --tiledtext"
    "$WDL" \
        --usecase     "$USECASE" \
        --batch       "$BATCH" \
        --sink        "$SINK" \
        --stream-mode "$STREAM_MODE" \
        --videos      "${VIDEOS:-?}" \
        --app-cmd     "$APP_CMD_STR" \
        --log-file    "$LOG" >/dev/null 2>&1 \
        || echo "⚠ write_deployment_log.sh failed; proceeding with raw log" >&2
fi

# ── 1. Launch app in background ────────────────────────────────────────────
echo "→ Launching $USECASE (sink=$SINK, batch=$BATCH)"

cd "$DS_APP_DIR"

# warehouse-3d needs Sparse4D libs pre-loaded
if [[ "$USECASE" == "warehouse-3d" ]]; then
  export LD_PRELOAD=/opt/nvidia/deepstream/deepstream/sources/sparse4d/libmsda_fp16.so
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:/opt/nvidia/deepstream/deepstream/sources/sparse4d:/usr/local/lib/python3/dist-packages/torch/lib"
fi

# Launch the app directly — no eval, no shell-string construction. set -e is
# disabled around the background launch so a transient redirect failure (e.g.
# noexec on $LOG's mount) returns a clean error instead of aborting the script.
set +e
./metropolis_perception_app "${APP_ARGS[@]}" >> "$LOG" 2>&1 &
APP_PID=$!
set -e
echo "   pid=$APP_PID log=$LOG"

# ── 2. Poll REST ready + report engine status ──────────────────────────────
echo "→ Polling /api/v1/ready (timeout=${TIMEOUT}s)..."
ELAPSED=0
ENGINE_STATUS="unknown"

# Brief init wait — lets the app bind its REST port before the first check.
# 3s is enough for a cache-hit launch; engine-build paths take much longer anyway.
sleep 3
ELAPSED=3

check_engine_status() {
  if grep -q 'deserialize cuda engine from file.*successfully' "$LOG" 2>/dev/null; then
    if [[ "$ENGINE_STATUS" != "cached" ]]; then
      echo "✔ Engine: loaded from cache — build skipped"
      echo "ENGINE_STATUS: cached"
      ENGINE_STATUS="cached"
    fi
  elif grep -q 'serialize cuda engine to file.*successfully' "$LOG" 2>/dev/null; then
    if [[ "$ENGINE_STATUS" != "built" ]]; then
      echo "✔ Engine: built from ONNX and written to disk"
      echo "ENGINE_STATUS: built"
      ENGINE_STATUS="built"
    fi
  elif grep -q 'Retrying without explicit FP16' "$LOG" 2>/dev/null; then
    if [[ "$ENGINE_STATUS" != "retrying" ]]; then
      echo "ℹ Engine: TRT kFP16 retry — expected for strongly-typed FP16 ONNX, waiting for serialize..."
      echo "ENGINE_STATUS: retrying"
      ENGINE_STATUS="retrying"
    fi
  fi
}

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  # Check if app died
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "✖ App exited unexpectedly (pid=$APP_PID). Check: $LOG"
    # Sniff the log tail for known fatal patterns and print a one-line
    # hint so the user doesn't have to read 60 lines of CUDA noise to
    # diagnose. Additive: same exit code, just extra context.
    if tail -200 "$LOG" 2>/dev/null | grep -qE 'Failed to initialize NVML|Cuda failure: status=100|NvBufSurfaceGetDeviceInfoImpl.*Failed to get GPU info'; then
      echo "ℹ Hint: container lost its GPU handle (stale NVML) — host driver service may have restarted since the container was created."
      echo "        Recover: docker stop <container> && docker rm <container>, then re-run the deploy (it will launch fresh)."
    fi
    tail -20 "$LOG" 2>/dev/null
    exit 1
  fi

  check_engine_status

  # Poll REST — check BEFORE sleeping so the first stream fires the moment
  # the app is ready (critical for cache-hit paths where ready comes fast).
  if curl -sf http://localhost:9000/api/v1/ready 2>/dev/null | grep -q 'ds-ready.*YES'; then
    echo "✔ REST ready (${ELAPSED}s elapsed)"
    echo "READY_OK elapsed=$ELAPSED"
    break
  fi

  # Heartbeat (printed before sleeping, so user sees state at check time)
  if [[ "$ENGINE_STATUS" == "unknown" || "$ENGINE_STATUS" == "retrying" ]]; then
    echo "⚠ Engine building from ONNX — ${ELAPSED}s elapsed. Please wait (~3-5 min total)."
  else
    echo "ℹ Polling /api/v1/ready... ${ELAPSED}s elapsed."
  fi

  sleep 30
  ELAPSED=$((ELAPSED + 30))
done

if [[ $ELAPSED -ge $TIMEOUT ]]; then
  echo "✖ Timed out after ${TIMEOUT}s waiting for REST ready"
  exit 1
fi

# ── 3. Cache engine — nvinfer use cases ONLY (warehouse-2d, smartcity-rtdetr) ──
# `cache_nvinfer_engine.sh` symlinks the DS-auto-built engine that lives
# next to the ONNX. That file only exists for the nvinfer-based use
# cases:
#   warehouse-2d     → DS auto-builds, helper symlinks into the cache
#   smartcity-rtdetr → same flow
#   smartcity-gdino  → uses Triton/nvinferserver, engine is a .plan
#                      managed by setup_gdino.sh during Step 4 — never
#                      call cache_nvinfer_engine.sh here.
#   warehouse-3d     → Sparse4D videotemplate plugin, engine is built
#                      by setup_sparse4d.sh into $ENGINE_CACHE_DIR
#                      during Step 4 — same: skip this step.
# Failure of cache_nvinfer_engine.sh used to abort the whole script
# (set -euo pipefail) before add_streams ran — leaving the app up with
# zero streams. We now run it only for the use cases it applies to.
case "$USECASE" in
  warehouse-2d|smartcity-rtdetr)
    if [[ -n "$ONNX" ]]; then
      echo "→ Caching engine..."
      /tmp/scripts/cache_nvinfer_engine.sh --onnx "$ONNX" --batch "$BATCH" \
        || echo "⚠ cache_nvinfer_engine.sh failed (rc=$?) — DS will rebuild on next deploy" >&2
    fi
    ;;
  smartcity-gdino|warehouse-3d)
    echo "→ Engine cache: handled in Step 4 (Triton .plan / Sparse4D), skipping here."
    ;;
esac

# ── 4. Add streams (dynamic mode only) ────────────────────────────────────
if [[ "$STREAM_MODE" == "dynamic" ]]; then
  echo "→ Adding $BATCH streams (inter-add delay=${DELAY}s)..."
  STREAM_ARGS=(--usecase "$USECASE" --batch "$BATCH" --delay "$DELAY")
  # Pass the already-resolved videos dir so discover_streams.sh skips re-scan.
  # Without this, discover_streams.sh finds every video dir under $RESOURCES
  # (warehouse NGCs + local-videos) and hits RESOLVE_AMBIGUOUS.
  [[ -n "$VIDEOS" ]] && STREAM_ARGS+=(--videos-dir "$VIDEOS")
  /tmp/scripts/add_streams.sh "${STREAM_ARGS[@]}"
fi

# ── 5. Collect metrics (fakesink / eglsink only — skip for filedump) ────────
# filedump: output is being written to a file; FPS metrics aren't relevant
#           and the REST /metrics endpoint may not have per-stream data during
#           a file-write pass. REST API (health, stream-info) still works fine.
# fakesink / eglsink: poll FPS + GPU/CPU for the deploy summary.
if [[ $NO_METRICS -eq 0 && "$SINK" != "filedump" ]]; then
  echo "→ Collecting metrics (3 samples × 5s, 10s warmup)..."
  # Pass --log for PERF-line fallback — see collect_metrics.sh for rationale.
  /tmp/scripts/collect_metrics.sh --samples 3 --interval 5 --warmup 10 --log "$LOG"
elif [[ "$SINK" == "filedump" ]]; then
  echo "ℹ Metrics skipped for filedump sink — output is being written to file."
  echo "  Check /api/v1/stream/get-stream-info for stream status."
  echo "METRICS_SKIP sink=filedump"
fi

# ── 6. Cache the tracker ReID TRT engine ──────────────────────────────────
# Runs for every use case that uses NvDCF_accuracy + ReID
# (warehouse-2d / smartcity-rtdetr / smartcity-gdino). NvDCF only
# builds the engine after the FIRST frame flows through the tracker
# (i.e. after stream-add, ~90-120 s on a typical RTX-class GPU). That's
# why this step lives here — after streams are added and the app has
# been running through metrics collection, not in §3.b before the
# pipeline has any data. `--wait 180` polls every 10 s for the engine
# file to land in /opt/.../samples/models/Tracker/, then caches it
# under $ENGINE_CACHE_DIR and leaves a symlink behind. Next deploy
# plants the symlink before launch, so the tracker deserialises in
# <1 s instead of rebuilding. Idempotent.
case "$USECASE" in
  warehouse-2d|smartcity-rtdetr|smartcity-gdino)
    echo "→ Caching tracker ReID engine (poll up to 180 s for build to finish)..."
    /tmp/scripts/setup_tracker_reid.sh --wait 180 \
      || echo "⚠ setup_tracker_reid.sh failed (rc=$?) — tracker engine will rebuild next deploy" >&2
    ;;
esac

echo "LAUNCH_COMPLETE usecase=$USECASE batch=$BATCH sink=$SINK"
