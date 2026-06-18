#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

################################################################################
# DeepStream BS_OPT sweep — smart 2-phase approach.
#
# Phase 1: trtexec probe at BS=1,4,8 (~30s total, fast)
#   - Fits power-law curve: QPS = a × BS^(-alpha)
#   - Predicts BS where trtexec QPS = FPS_THRESHOLD / DS_EFFICIENCY
#   - This accounts for DeepStream pipeline overhead vs raw trtexec
#
# Phase 2: DeepStream confirmation (1-2 runs)
#   - Runs DS at BS_pred and BS_pred-step if needed
#   - Picks highest BS where DS fps/stream >= FPS_THRESHOLD
#   - Uses dynamic engine (no per-BS engine builds during sweep)
#
# Thumb rules:
#   - batch_size == num_streams (always equal)
#   - Dynamic engine: min=1, opt=10, max=max(BATCH_SIZES_PROBE) e.g. 8
#     Extended at build time to max=BS_pred+margin once predicted
#   - BS_OPT drives production engine build (static, timing cache reuse)
#
# Usage:
#   ./ds-sweep.sh <dynamic_engine> <onnx_path> <config_template> \
#                 <parser_so> <labels> <engines_dir> <configs_dir> [video]
################################################################################
set -euo pipefail

DYNAMIC_ENGINE="$1"
ONNX_PATH="$2"
CONFIG_TEMPLATE="$3"
PARSER_SO="$4"
LABELS="$5"
ENGINES_DIR="$6"
CONFIGS_DIR="$7"
VIDEO="${8:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"

# Derive INPUT_NAME, H, W from the ONNX model — mirrors how engine-build.md does it.
# Env var overrides let callers handle models with dynamic spatial dims (e.g. H=800 W=800 ./ds-sweep.sh ...).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSPECT_SCRIPT="$(realpath "${SCRIPT_DIR}/../../model/inspect-onnx.py")"
if [ -z "${INPUT_NAME:-}" ] || [ -z "${H:-}" ] || [ -z "${W:-}" ]; then
    INSPECT_OUT=$(python3 "${INSPECT_SCRIPT}" "${ONNX_PATH}")
    INPUT_NAME="${INPUT_NAME:-$(echo "${INSPECT_OUT}" | grep -oP 'input_name:\s*\K\S+')}"
    H="${H:-$(echo "${INSPECT_OUT}" | grep -oP 'height:\s*\K[0-9]+')}"
    W="${W:-$(echo "${INSPECT_OUT}" | grep -oP 'width:\s*\K[0-9]+')}"
fi
[ -z "${INPUT_NAME}" ] && { echo "ERROR: could not parse INPUT_NAME from ONNX — set INPUT_NAME env var"; exit 1; }
[ -z "${H}" ] && { echo "ERROR: H not detected (dynamic spatial dims) — set H env var, e.g. H=800"; exit 1; }
[ -z "${W}" ] && { echo "ERROR: W not detected (dynamic spatial dims) — set W env var, e.g. W=800"; exit 1; }

# DS_ERR_LOG: destination for GStreamer/DeepStream stderr output.
# Override via environment variable to redirect elsewhere (e.g. a file path or /dev/stderr).
# Defaults to a log file alongside the sweep engine logs so errors are preserved for diagnosis.
DS_ERR_LOG="${DS_ERR_LOG:-${ENGINES_DIR}/ds_sweep_gst_errors.log}"
mkdir -p "$(dirname "${DS_ERR_LOG}")"
# Truncate/create the log at the start of the sweep so it reflects the current run only.
: > "${DS_ERR_LOG}"
echo "[ds-sweep] GStreamer stderr → ${DS_ERR_LOG}"

# TIMING_CACHE="${ENGINES_DIR}/timing.cache"  # used by caller (nv-engine-build), not sweep
NS_PER_SEC=$(( 1000 * 1000 * 1000 ))  # nanoseconds per second (date +%s%N divisor)
FPS_THRESHOLD=30          # target fps/stream in DeepStream
DS_EFFICIENCY=0.65        # DS is ~65% of trtexec throughput (GStreamer pipeline overhead
                          # includes muxer, memory mgmt, custom parser, metadata — measured)
TRT_QPS_TARGET=$(echo "scale=4; ${FPS_THRESHOLD} / ${DS_EFFICIENCY}" | bc)  # ~46.2 QPS
PROBE_SIZES=(1 4 8)       # fast trtexec probe batch sizes
PROBE_DURATION=10         # seconds per trtexec probe run
# NEVER use filesrc num-buffers as a frame count — num-buffers counts file byte blocks (4096B),
# not video frames. Leave num-buffers unset so filesrc reads to natural EOS.
# Detect actual frame count and FPS via mediainfo — consistent with benchmark-ds.sh.
VIDEO_FPS=$(mediainfo --Inform="Video;%FrameRate%" "${VIDEO}" 2>/dev/null | awk '{printf "%.0f", $1+0}')
VIDEO_FPS="${VIDEO_FPS:-30}"
ACTUAL_FRAMES_PER_STREAM=$(mediainfo --Inform="Video;%FrameCount%" "${VIDEO}" 2>/dev/null)
if ! echo "${ACTUAL_FRAMES_PER_STREAM}" | grep -qE '^[0-9]+$' || [ "${ACTUAL_FRAMES_PER_STREAM:-0}" -eq 0 ]; then
    ACTUAL_FRAMES_PER_STREAM=1440   # fallback for sample_720p.mp4: ~48s × 30fps
fi
echo "  Video frames/stream: ${ACTUAL_FRAMES_PER_STREAM} (${VIDEO_FPS}fps detected)"
MUXER_W=1280
MUXER_H=720

mkdir -p "${CONFIGS_DIR}"

echo "======================================================"
echo "DS BS_OPT Sweep — 2-Phase Smart Search"
echo "  FPS threshold : ${FPS_THRESHOLD} fps/stream"
echo "  DS efficiency : ${DS_EFFICIENCY} (trtexec QPS target: ${TRT_QPS_TARGET})"
echo "  Probe sizes   : ${PROBE_SIZES[*]}"
echo "  Input tensor  : ${INPUT_NAME} (${H}x${W})"
echo "======================================================"

# ── PHASE 1: trtexec probe at BS=1,4,8 ──────────────────
echo ""
echo "PHASE 1: trtexec probe (BS=${PROBE_SIZES[*]})"

declare -a PROBE_BS_ARR PROBE_QPS_ARR

for BS in "${PROBE_SIZES[@]}"; do
    echo "  trtexec BS=${BS}..."
    LOG="${ENGINES_DIR}/probe_bs${BS}.log"
    trtexec \
        --loadEngine="${DYNAMIC_ENGINE}" \
        --fp16 \
        --shapes=${INPUT_NAME}:${BS}x3x${H}x${W} \
        --duration=${PROBE_DURATION} \
        --warmUp=2000 \
        > "${LOG}" 2>&1
    QPS=$(grep "Throughput:" "${LOG}" | grep -oP 'Throughput: \K[0-9.]+' | head -1)
    echo "    BS=${BS}: ${QPS} QPS"
    PROBE_BS_ARR+=("${BS}")
    PROBE_QPS_ARR+=("${QPS}")
done

# ── Power-law fit: QPS = a × BS^(-alpha) ────────────────
# Use BS=4 and BS=8 points to fit alpha (most stable region)
# alpha = log(QPS4/QPS8) / log(8/4)
QPS4="${PROBE_QPS_ARR[1]}"
QPS8="${PROBE_QPS_ARR[2]}"

ALPHA=$(python3 -c "
import math
qps4, qps8 = float('${QPS4}'), float('${QPS8}')
alpha = math.log(qps4 / qps8) / math.log(8.0 / 4.0)
print(f'{alpha:.4f}')
")
A_COEFF=$(python3 -c "
import math
qps8, alpha = float('${QPS8}'), float('${ALPHA}')
a = qps8 * (8.0 ** alpha)
print(f'{a:.4f}')
")

echo ""
echo "  Curve fit: QPS = ${A_COEFF} × BS^(-${ALPHA})"

# Solve for BS where QPS = TRT_QPS_TARGET
# BS_pred = (a / QPS_target)^(1/alpha)
# Guard: if alpha ~ 0 (flat curve — memory-bandwidth-bound or very small model),
# 1/alpha diverges. Use the cap directly and let Phase 2 DS runs confirm.
BS_PRED=$(python3 -c "
import math
a, alpha = float('${A_COEFF}'), float('${ALPHA}')
target = float('${TRT_QPS_TARGET}')
if abs(alpha) < 1e-3:
    bs_pred = 128
else:
    bs_pred = (a / target) ** (1.0 / alpha)
print(int(bs_pred))
")

echo "  Predicted BS_pred = ${BS_PRED} (trtexec QPS ≈ ${TRT_QPS_TARGET} at this batch)"
echo ""

# Clamp BS_pred to reasonable range [8, 128]
BS_PRED=$(python3 -c "print(max(8, min(128, int('${BS_PRED}'))))")

# ── PHASE 2: DeepStream confirmation ────────────────────
echo "PHASE 2: DeepStream confirmation around BS_pred=${BS_PRED}"

# Test BS_pred and BS_pred - small step if first fails
# Round BS_pred to nearest sensible value
BS_STEP=$(python3 -c "
bs = int('${BS_PRED}')
# step = ~10% of BS_pred, minimum 1
step = max(1, round(bs * 0.1))
print(step)
")

CANDIDATES=("${BS_PRED}")
BS_LOWER=$(( BS_PRED - BS_STEP ))
[ "${BS_LOWER}" -ge 1 ] && CANDIDATES+=("${BS_LOWER}")

best_bs=1
best_fps_stream=0
best_ips=0

for BS in "${CANDIDATES[@]}"; do
    echo ""
    echo "=== DS Confirmation BS=${BS} (${BS} streams) ==="

    # Write nvinfer config pointing to dynamic engine at this batch size
    BS_CONFIG="${CONFIGS_DIR}/config_infer_sweep_b${BS}.txt"
    sed \
        -e "s|model-engine-file=.*|model-engine-file=${DYNAMIC_ENGINE}|" \
        -e "s|batch-size=.*|batch-size=${BS}|" \
        -e "s|custom-lib-path=.*|custom-lib-path=${PARSER_SO}|" \
        -e "s|labelfile-path=.*|labelfile-path=${LABELS}|" \
        "${CONFIG_TEMPLATE}" > "${BS_CONFIG}"

    # actual frames = ACTUAL_FRAMES_PER_STREAM × BS (no num-buffers limit on filesrc —
    # let each source read to natural EOS so we always process the full video)
    TOTAL_FRAMES=$((ACTUAL_FRAMES_PER_STREAM * BS))
    SOURCES=""
    for i in $(seq 0 $((BS - 1))); do
        SOURCES+="filesrc location=${VIDEO} ! qtdemux ! queue ! h264parse ! queue ! nvv4l2decoder ! queue ! mux.sink_${i} "
    done

    START_TIME=$(date +%s%N)
    GST_DEBUG=0 gst-launch-1.0 -e \
        ${SOURCES} \
        nvstreammux name=mux batch-size=${BS} width=${MUXER_W} height=${MUXER_H} batched-push-timeout=40000 ! \
        queue ! \
        nvinfer config-file-path="${BS_CONFIG}" ! \
        queue ! \
        fakesink sync=0 2>>"${DS_ERR_LOG}" || true
    END_TIME=$(date +%s%N)

    # Warn if the pipeline wrote anything to stderr — likely a plugin/config error
    if [ -s "${DS_ERR_LOG}" ]; then
        echo "  [warn] GStreamer stderr output captured — see ${DS_ERR_LOG} for details" >&2
    fi

    ELAPSED_SEC=$(echo "scale=2; $(( END_TIME - START_TIME )) / $NS_PER_SEC" | bc)
    DS_IPS=$(echo "scale=1; ${TOTAL_FRAMES} / ${ELAPSED_SEC}" | bc)
    DS_FPS_STREAM=$(echo "scale=1; ${DS_IPS} / ${BS}" | bc)
    DS_REALTIME=$(echo "scale=2; ${DS_FPS_STREAM} / ${FPS_THRESHOLD}" | bc)
    DS_FPS_INT=$(echo "${DS_FPS_STREAM}" | cut -d. -f1)
    DS_IPS_INT=$(echo "${DS_IPS}" | cut -d. -f1)

    echo "  BS=${BS}: wall=${ELAPSED_SEC}s imgs/s=${DS_IPS} fps/stream=${DS_FPS_STREAM} realtime=${DS_REALTIME}x"

    if [ "${DS_FPS_INT}" -ge "${FPS_THRESHOLD}" ]; then
        best_bs="${BS}"
        best_fps_stream="${DS_FPS_STREAM}"
        best_ips="${DS_IPS_INT}"
        echo "  -> PASS (>=${FPS_THRESHOLD} fps/stream)"
        break   # highest candidate that passes is BS_OPT
    else
        echo "  -> FAIL (<${FPS_THRESHOLD} fps/stream), trying lower..."
    fi
done

# Write results
echo ""
echo "======================================================"
echo "SWEEP COMPLETE"
echo "  BS_OPT         = ${best_bs}"
echo "  DS fps/stream  = ${best_fps_stream} (threshold: ${FPS_THRESHOLD})"
echo "  DS imgs/sec    = ${best_ips}"
echo "  trtexec alpha  = ${ALPHA} (curve steepness)"
echo "  BS_pred was    = ${BS_PRED}"
echo "======================================================"

cat > "${ENGINES_DIR}/bs_opt.txt" << EOF
BS_OPT=${best_bs}
DS_FPS_PER_STREAM=${best_fps_stream}
DS_IPS=${best_ips}
TRT_ALPHA=${ALPHA}
TRT_A_COEFF=${A_COEFF}
BS_PRED=${BS_PRED}
EOF

# Print probe summary
echo ""
echo "Phase 1 trtexec probe summary:"
echo "batch,qps,imgs_per_sec"
for i in "${!PROBE_BS_ARR[@]}"; do
    BS="${PROBE_BS_ARR[$i]}"
    QPS="${PROBE_QPS_ARR[$i]}"
    IPS=$(echo "scale=0; ${QPS} * ${BS}" | bc)
    echo "${BS},${QPS},${IPS}"
done

echo "${best_bs}"
