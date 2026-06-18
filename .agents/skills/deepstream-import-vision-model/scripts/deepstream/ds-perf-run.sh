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
# Step 7c: DeepStream perf-measurement run via deepstream-app.
#
# Replaces the older `gst-launch-1.0 ... ! fpsdisplaysink ...` benchmark, which
# pulled in `gstreamer1.0-plugins-bad`. `deepstream-app` is part of the NVIDIA
# DeepStream SDK and emits `**PERF: fps_run0 (fps_avg0)  fps_run1 (fps_avg1)  ...`
# lines (one pair per active source) that the report-generation phase parses.
#
# Usage: ./ds-perf-run.sh <nvinfer_config> <num_streams> <log_path> [input_video]
# Example:
#   ./ds-perf-run.sh config_infer_ds_yolox.txt 32 \
#       models/yolox/benchmarks/ds/ds_s32_run1.log \
#       /opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4
#
# Notes:
#   - `[primary-gie] batch-size` and `[streammux] batch-size` are both set to N
#     (matches the skill-wide rule batch_size == num_streams).
#   - `num-sources=N` fans the single input video out to N pipeline sources;
#     deepstream-app handles the file-loop / EOS bookkeeping.
#   - The nvinfer config must already point at the engine, parser, and labels.
#     This script does NOT mutate the nvinfer config.
################################################################################
set -euo pipefail

NVINFER_CONFIG="${1:-}"
NUM_STREAMS="${2:-}"
LOG_PATH="${3:-}"
VIDEO="${4:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"

if [ -z "$NVINFER_CONFIG" ] || [ -z "$NUM_STREAMS" ] || [ -z "$LOG_PATH" ]; then
    echo "Usage: $0 <nvinfer_config> <num_streams> <log_path> [input_video]"
    exit 1
fi

[ -f "$NVINFER_CONFIG" ] || { echo "ERROR: nvinfer config not found: $NVINFER_CONFIG"; exit 1; }
[ -f "$VIDEO" ] || { echo "ERROR: video file not found: $VIDEO"; exit 1; }
command -v deepstream-app >/dev/null 2>&1 || { echo "ERROR: deepstream-app not on PATH"; exit 1; }

NVINFER_CONFIG="$(realpath "$NVINFER_CONFIG")"
VIDEO="$(realpath "$VIDEO")"
LOG_PATH="$(realpath -m "$LOG_PATH")"
mkdir -p "$(dirname "$LOG_PATH")"

N="$NUM_STREAMS"
MUXER_W=1280
MUXER_H=720

echo "=== DeepStream Perf Run ==="
echo "nvinfer config: $NVINFER_CONFIG"
echo "Streams (=N):   $N"
echo "Input video:    $VIDEO"
echo "Log path:       $LOG_PATH"
echo ""

trap 'rm -f "${TMPCONFIG:-}"' EXIT
TMPCONFIG=$(mktemp /tmp/ds_perf_XXXXXX.txt)

cat > "$TMPCONFIG" <<EOF
[application]
enable-perf-measurement=1
perf-measurement-interval-sec=2

[tiled-display]
enable=0

[source0]
enable=1
type=3
uri=file://${VIDEO}
num-sources=${N}
gpu-id=0

[sink0]
enable=1
type=1
sync=0

[osd]
enable=0

[streammux]
live-source=0
batch-size=${N}
batched-push-timeout=-1
width=${MUXER_W}
height=${MUXER_H}

[primary-gie]
enable=1
batch-size=${N}
gie-unique-id=1
config-file=${NVINFER_CONFIG}

[tests]
file-loop=1
EOF

echo "Temp config: $TMPCONFIG"
echo "Running deepstream-app..."

set +o pipefail
# file-loop=1 has no built-in stop condition; timeout(1) kills deepstream-app
# after 60 s and returns exit 124 — treated as success below.
timeout 60s deepstream-app -c "$TMPCONFIG" 2>&1 | tee "$LOG_PATH"
DS_EXIT_CODE=${PIPESTATUS[0]}
set -o pipefail

# exit 124 = timeout fired as expected (file-loop=1, 60 s cap)
if [ $DS_EXIT_CODE -ne 0 ] && [ $DS_EXIT_CODE -ne 124 ]; then
    echo "ERROR: deepstream-app exited with code $DS_EXIT_CODE — see $LOG_PATH" >&2
    exit "$DS_EXIT_CODE"
fi

# Average stream-0 instantaneous FPS across the last 10 **PERF: lines.
# Using stream 0 (the \K capture after `**PERF:`) gives exactly 1 value per
# measurement window so tail -10 always covers 10 windows regardless of N.
# Multiply by N for total throughput.
PERF_FPS=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$LOG_PATH" | tail -10 | python3 -c "
import sys
vals = [float(line) for line in sys.stdin if line.strip()]
print(round(sum(vals)/len(vals), 2) if vals else 0)
")

if [ -z "$PERF_FPS" ] || [ "$PERF_FPS" = "0" ]; then
    echo "ERROR: no **PERF: lines parsed from $LOG_PATH" >&2
    exit 1
fi

TOTAL_FPS=$(python3 -c "print(round(float('$PERF_FPS') * $N, 2))")

echo ""
echo "=== Perf Summary ==="
echo "Streams:        $N"
echo "FPS/stream:     $PERF_FPS"
echo "Total imgs/sec: $TOTAL_FPS"
echo "Log:            $LOG_PATH"
echo "===================="
