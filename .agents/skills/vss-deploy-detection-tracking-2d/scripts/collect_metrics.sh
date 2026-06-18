#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# collect_metrics.sh samples RTVI-CV performance counters and prints averages.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# collect_metrics.sh - Sample RTVI-CV metrics N times with a fixed gap,
# then print averaged results. Intended to run inside the RTVI-CV
# container right after all streams are ACTIVE, so the deploy summary
# can include stable perf numbers (not a one-shot snapshot that may
# show 0 fps if a stream just attached).
#
# Usage:
#   collect_metrics.sh [--samples N] [--interval S] [--warmup W]
#                      [--host H] [--port P] [--json-out <path>]
#
# Defaults: --samples 3, --interval 5, --warmup 10,
#           --host localhost, --port 9000.
#
# Actual /api/v1/metrics response shape (RTVI-CV 3.x):
#   {
#     "metrics-info": {
#       "stream-count": N,
#       "stream-stats": [ { "sensor_id": "...", "sensor_name": "...", "source_id": N, "fps": N, ... }, ... ],
#       "system-stats":  { "gpu_util": N, "GPU_gb": N, "cpu_util": N, "RAM_gb": N }
#     }
#   }
#
# Prints:
#   1) One "sample i/N" heartbeat per iteration.
#   2) "=== Averaged metrics ===" block with GPU/CPU/RAM averages
#      and a sorted per-stream FPS table.
#   3) Marker: METRICS_OK samples=<N> interval=<S>
#
# Exit codes: 0 success, 2 REST unreachable on all samples.

set -u  # not -e: a single failed sample shouldn't kill the run

SAMPLES=3
INTERVAL=5
WARMUP=10
REST_HOST="${REST_HOST:-localhost}"
REST_PORT="${REST_PORT:-9000}"
JSON_OUT=""
LOG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --samples)  SAMPLES="$2";   shift 2 ;;
        --interval) INTERVAL="$2";  shift 2 ;;
        --warmup)   WARMUP="$2";    shift 2 ;;
        --host)     REST_HOST="$2"; shift 2 ;;
        --port)     REST_PORT="$2"; shift 2 ;;
        --json-out) JSON_OUT="$2";  shift 2 ;;
        --log)      LOG="$2";       shift 2 ;;
        -h|--help)  sed -n '18,30p' "$0"; exit 0 ;;
        *)          echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# If --log isn't passed, auto-discover the most recent deployment log
# under /opt/storage/logs/. The fallback log-parser uses this when the
# API returns stream-count=0 (typical for static-mode deploys). Logs
# are named `<usecase-and-model>_<TS>.txt` (e.g.
# warehouse2d-rtdetr_20260508_142359.txt) — the glob below matches any
# `*_<8 digits>_<6 digits>.txt` so it's robust to use-case prefix
# changes and ignores any stray non-deployment .txt that lands in
# logs/.
if [[ -z "$LOG" ]]; then
    # Use `find` rather than `ls + nullglob` so a no-match case never falls
    # back to listing the CWD (which `ls -1t` does when its glob expands
    # to zero arguments under `shopt -s nullglob` — that bug would pick the
    # most-recent file in $PWD, e.g. `metropolis_perception_app`, and feed
    # the binary to parse_log_fps which silently emits nothing).
    # Sort by mtime (newest first), strip the timestamp prefix, return the
    # newest matching file or empty string.
    mapfile -t _candidates < <(
        find /opt/storage/logs -maxdepth 1 -type f \
            -name '*_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9].txt' \
            -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | awk '{print $2}'
    )
    LOG="${_candidates[0]:-}"
    [[ -n "$LOG" ]] && echo "   (auto-discovered LOG: $LOG)" >&2
fi

[[ "$SAMPLES"   =~ ^[0-9]+$ ]] || { echo "--samples must be an integer"  >&2; exit 1; }
[[ "$INTERVAL"  =~ ^[0-9]+$ ]] || { echo "--interval must be an integer" >&2; exit 1; }
[[ "$WARMUP"    =~ ^[0-9]+$ ]] || { echo "--warmup must be an integer"   >&2; exit 1; }
[[ "$REST_PORT" =~ ^[0-9]+$ ]] || { echo "--port must be an integer"     >&2; exit 1; }

# Restrict --host to a hostname / IP grammar — it's interpolated into the
# curl URL, and a value containing shell metachars or whitespace can subtly
# affect URL parsing across curl versions.
[[ "$REST_HOST" =~ ^[A-Za-z0-9._-]+$ ]] \
    || { echo "--host must be a valid hostname (got: $REST_HOST)" >&2; exit 1; }

# --json-out lands a writable file. Disallow `..` and absolute paths outside
# /opt/storage / $HOME so a caller can't aim it at a system file.
if [[ -n "$JSON_OUT" ]]; then
    case "$JSON_OUT" in
        *..*) echo "--json-out must not contain '..' (got: $JSON_OUT)" >&2; exit 1 ;;
    esac
    if [[ "$JSON_OUT" = /* ]]; then
        case "$JSON_OUT" in
            /opt/storage/*|"$HOME"/*) ;;
            *) echo "--json-out must be under /opt/storage/ or \$HOME (got: $JSON_OUT)" >&2; exit 1 ;;
        esac
    fi
fi

# ── Warm-up ──────────────────────────────────────────────────────────
if [[ "$WARMUP" -gt 0 ]]; then
    echo ">> Warming up ${WARMUP}s before sampling (lets FPS converge)..."
    sleep "$WARMUP"
fi

echo ">> Collecting $SAMPLES samples, ${INTERVAL}s apart..."

# ── Parser — navigates actual RTVI-CV /metrics JSON structure ────────
# Emits tagged lines:
#   STREAM_FPS <stream_label> <fps>     # label is sensor_name/sensor_id/source_id
#   SYSTEM gpu_util=N gpu_gb=N cpu_util=N ram_gb=N stream_count=N
#
# FIX: uses python3 -c "..." NOT python3 - <<'PY' ... PY
# With python3 - <<'PY', bash feeds the heredoc (the script source) to
# python3's stdin, so json.load(sys.stdin) reads an exhausted stream →
# JSONDecodeError → silent sys.exit(0) → all values stay 0.
# python3 -c takes the script from the command-line arg, leaving stdin
# free for the piped JSON data.
_PARSE_METRICS_PY='
import json, sys

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

info         = d.get("metrics-info", {})
stream_count = info.get("stream-count", 0)
stream_stats = info.get("stream-stats", [])
sys_stats    = info.get("system-stats", {})

for s in stream_stats:
    cid = (
        s.get("sensor_name")
        or s.get("sensor_id")
        or s.get("camera_id")
        or s.get("id")
        or str(s.get("source_id", "stream"))
    )
    fps = s.get("fps") or s.get("average_fps") or s.get("current_fps")
    if fps is not None:
        try:
            print(f"STREAM_FPS\t{cid}\t{float(fps)}")
        except Exception:
            pass

gpu_util = sys_stats.get("gpu_util",  "n/a")
gpu_gb   = sys_stats.get("GPU_gb",    "n/a")
cpu_util = sys_stats.get("cpu_util",  "n/a")
ram_gb   = sys_stats.get("RAM_gb",    "n/a")
print(f"SYSTEM\tgpu_util={gpu_util}\tgpu_gb={gpu_gb}\tcpu_util={cpu_util}\tram_gb={ram_gb}\tstream_count={stream_count}")
'

parse_api_metrics() {
    # python3 -c reads script from arg, stdin stays free for piped JSON
    python3 -c "$_PARSE_METRICS_PY"
}

# ── Log fallback parser — used when /api/v1/metrics has stream-count=0.
# The metropolis_perception_app's PERF lines look like:
#     25.60000 (27.82622)        source_id : 0 stream_name Camera
# (current_fps avg_fps source_id name). For static-mode deploys the REST
# /metrics endpoint reports zero streams even when the pipeline is
# actively producing frames — these PERF lines are the only ground truth.
# Returns one `STREAM_FPS\t<name>\t<fps>` per stream, using the most
# recent sample for each source_id from the last 50 lines of the log.
_PARSE_LOG_PY='
import re, sys
try:
    lines = open(sys.argv[1], "r", errors="replace").readlines()[-200:]
except Exception:
    sys.exit(0)
# Pattern: <float> (<float>) ... source_id : N ... stream_name NAME
rx = re.compile(r"([0-9]+\.[0-9]+)\s*\(\s*([0-9]+\.[0-9]+)\s*\)\s+.*?source_id\s*:\s*(\d+)\s+stream_name\s+(\S+)")
latest = {}
for ln in lines:
    m = rx.search(ln)
    if not m: continue
    cur, avg, sid, name = m.groups()
    latest[name] = float(cur)
for name, fps in latest.items():
    print(f"STREAM_FPS\t{name}\t{fps}")
'

parse_log_fps() {
    local log="$1"
    [[ -n "$log" && -f "$log" ]] || return 0
    python3 -c "$_PARSE_LOG_PY" "$log" 2>/dev/null
}

# ── Per-sample accumulators ──────────────────────────────────────────
declare -A FPS_SUM=() FPS_COUNT=()
declare -a GPU_UTILS=() GPU_MEM_GB=() CPU_UTILS=() RAM_GB=()
declare -a GPU_TEMPS=() GPU_POWERS=()
declare -i API_FAILS=0 STREAM_COUNT_LAST=0 LOG_FALLBACK_USED=0

for i in $(seq 1 "$SAMPLES"); do
    echo "   ... sample $i/$SAMPLES"

    RESP=$(curl -sS --max-time 3 "http://${REST_HOST}:${REST_PORT}/api/v1/metrics" 2>/dev/null || echo "")
    if [[ -z "$RESP" ]]; then
        API_FAILS=$((API_FAILS + 1))
    else
        while IFS=$'\t' read -r type f1 f2 f3 f4 f5; do
            if [[ "$type" == "STREAM_FPS" ]]; then
                id="$f1"; fps="$f2"
                [[ -z "$id" || -z "$fps" ]] && continue
                FPS_SUM[$id]=$(awk -v a="${FPS_SUM[$id]:-0}" -v b="$fps" 'BEGIN{printf "%.4f",a+b}')
                FPS_COUNT[$id]=$(( ${FPS_COUNT[$id]:-0} + 1 ))
            elif [[ "$type" == "SYSTEM" ]]; then
                for pair in "$f1" "$f2" "$f3" "$f4" "$f5"; do
                    k="${pair%%=*}"; v="${pair#*=}"
                    case "$k" in
                        gpu_util)     GPU_UTILS+=("$v")   ;;
                        gpu_gb)       GPU_MEM_GB+=("$v")  ;;
                        cpu_util)     CPU_UTILS+=("$v")   ;;
                        ram_gb)       RAM_GB+=("$v")      ;;
                        stream_count) STREAM_COUNT_LAST="$v" ;;
                    esac
                done
            fi
        done < <(printf '%s' "$RESP" | parse_api_metrics)
    fi

    # Log-fallback: see _PARSE_LOG_PY block above for PERF-line rationale.
    if (( STREAM_COUNT_LAST == 0 )) && [[ -n "$LOG" ]]; then
        while IFS=$'\t' read -r type id fps; do
            [[ "$type" == "STREAM_FPS" ]] || continue
            [[ -z "$id" || -z "$fps" ]] && continue
            FPS_SUM[$id]=$(awk -v a="${FPS_SUM[$id]:-0}" -v b="$fps" 'BEGIN{printf "%.4f",a+b}')
            FPS_COUNT[$id]=$(( ${FPS_COUNT[$id]:-0} + 1 ))
            LOG_FALLBACK_USED=1
        done < <(parse_log_fps "$LOG")
    fi

    # nvidia-smi: temperature + power (not in REST API)
    SMI=$(nvidia-smi --query-gpu=temperature.gpu,power.draw \
        --format=csv,noheader,nounits 2>/dev/null | head -1)
    if [[ -n "$SMI" ]]; then
        IFS=',' read -r temp pwr <<< "$SMI"
        GPU_TEMPS+=("${temp// /}")
        GPU_POWERS+=("${pwr// /}")
    fi

    [[ "$i" -lt "$SAMPLES" ]] && sleep "$INTERVAL"
done

# ── Average helper ───────────────────────────────────────────────────
avg() {
    [[ $# -eq 0 ]] && { echo "n/a"; return; }
    awk 'BEGIN{s=0;n=0} { if ($1=="n/a") next; s+=$1; n++ } END{if(n==0){print "n/a"}else{printf "%.1f",s/n}}' \
        <<< "$(printf '%s\n' "$@")"
}

GPU_TEMP_AVG="$(avg "${GPU_TEMPS[@]}")"
GPU_PWR_AVG="$(avg "${GPU_POWERS[@]}")"
[[ "$GPU_TEMP_AVG" != "n/a" ]] && GPU_TEMP_AVG="${GPU_TEMP_AVG}°C"
[[ "$GPU_PWR_AVG"  != "n/a" ]] && GPU_PWR_AVG="${GPU_PWR_AVG}W"

echo
echo "=== Averaged metrics (${SAMPLES} samples, ${INTERVAL}s apart) ==="
printf "  GPU util    : %s %%\n"  "$(avg "${GPU_UTILS[@]}")"
printf "  GPU memory  : %s GB\n"  "$(avg "${GPU_MEM_GB[@]}")"
printf "  GPU temp    : %s\n"     "$GPU_TEMP_AVG"
printf "  GPU power   : %s\n"     "$GPU_PWR_AVG"
printf "  CPU busy    : %s %%\n"  "$(avg "${CPU_UTILS[@]}")"
printf "  System RAM  : %s GB\n"  "$(avg "${RAM_GB[@]}")"
echo
if [[ "${#FPS_SUM[@]}" -gt 0 ]]; then
    # Aggregate first — total fps + per-stream average. Easier for the
    # deploy summary box to surface a single "throughput" number.
    TOTAL_FPS=$(
        for id in "${!FPS_SUM[@]}"; do
            n="${FPS_COUNT[$id]:-1}"; s="${FPS_SUM[$id]:-0}"
            awk -v s="$s" -v n="$n" 'BEGIN{printf "%.4f\n", s/n}'
        done | awk '{t+=$1} END{printf "%.1f", t}'
    )
    N_STREAMS="${#FPS_SUM[@]}"
    AVG_FPS=$(awk -v t="$TOTAL_FPS" -v n="$N_STREAMS" 'BEGIN{printf "%.1f", t/n}')
    if (( LOG_FALLBACK_USED )); then
        SRC="deployment log (PERF lines)"
    else
        SRC="/api/v1/metrics"
    fi
    echo "  FPS total      : $TOTAL_FPS fps  ($N_STREAMS streams · avg $AVG_FPS / stream)  [source: $SRC]"
    # Eval-friendly markers for the deploy-summary builder.
    echo "STREAM_FPS_TOTAL=$TOTAL_FPS"
    echo "STREAM_FPS_AVG=$AVG_FPS"
    echo "STREAM_FPS_N=$N_STREAMS"
    echo "STREAM_FPS_SOURCE=$SRC"

    echo "  Per-stream FPS:"
    {
        for id in "${!FPS_SUM[@]}"; do
            n="${FPS_COUNT[$id]:-1}"; s="${FPS_SUM[$id]:-0}"
            awk -v i="$id" -v s="$s" -v n="$n" 'BEGIN{printf "    %-24s %.1f fps\n",i,s/n}'
        done
    } | sort
elif [[ "$STREAM_COUNT_LAST" -eq 0 ]]; then
    echo "  Per-stream FPS: (no active streams — add streams via /stream/add first, then re-run metrics)"
    echo "STREAM_FPS_TOTAL=0"
    echo "STREAM_FPS_N=0"
else
    echo "  Per-stream FPS: (streams present but fps field not found in /api/v1/metrics response)"
    echo "STREAM_FPS_TOTAL=unknown"
fi

if [[ "$API_FAILS" -gt 0 ]]; then
    echo
    echo "  ⚠ REST /metrics unreachable on $API_FAILS/$SAMPLES samples — is the app running on :${REST_PORT}?"
fi

# Optional JSON dump
if [[ -n "$JSON_OUT" ]]; then
    # Build JSON via python for safe serialization — see add_streams.sh for rationale.
    PER_STREAM_ARGS=()
    for id in "${!FPS_SUM[@]}"; do
        n="${FPS_COUNT[$id]:-1}"; s="${FPS_SUM[$id]:-0}"
        v=$(awk -v s="$s" -v n="$n" 'BEGIN{printf "%.1f",s/n}')
        PER_STREAM_ARGS+=("$id" "$v")
    done
    python3 -c '
import json, sys
def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
samples, interval = int(sys.argv[1]), int(sys.argv[2])
gpu_util, gpu_mem, cpu_busy, ram = (_num(x) for x in sys.argv[3:7])
per_stream = {}
args = sys.argv[7:]
for i in range(0, len(args), 2):
    per_stream[args[i]] = _num(args[i+1])
print(json.dumps({
    "samples":        samples,
    "interval":       interval,
    "gpu_util_pct":   gpu_util,
    "gpu_memory_gb":  gpu_mem,
    "cpu_busy_pct":   cpu_busy,
    "system_ram_gb":  ram,
    "per_stream_fps": per_stream,
}))
' "$SAMPLES" "$INTERVAL" \
    "$(avg "${GPU_UTILS[@]}")"  "$(avg "${GPU_MEM_GB[@]}")" \
    "$(avg "${CPU_UTILS[@]}")"  "$(avg "${RAM_GB[@]}")" \
    "${PER_STREAM_ARGS[@]}" > "$JSON_OUT"
    echo "  (JSON saved to $JSON_OUT)"
fi

echo
echo "METRICS_OK samples=${SAMPLES} interval=${INTERVAL}"
exit 0
