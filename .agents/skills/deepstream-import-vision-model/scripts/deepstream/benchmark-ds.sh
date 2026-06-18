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

set -euo pipefail
################################################################################
# DeepStream benchmark using gst-launch-1.0
# Thumb rule: batch_size == num_streams (always equal).
# Measures total throughput by timing full video processing with fakesink.
#
# Usage: ./benchmark-ds.sh <config_file> <num_streams> [input_video]
# Example: ./benchmark-ds.sh config_infer_primary_b21.txt 21 video.mp4
#
# batch_size in the nvinfer config must match num_streams.
################################################################################

CONFIG="${1:-}"
NUM_STREAMS="${2:-}"
VIDEO="${3:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"
MUXER_W=1280
MUXER_H=720
NS_PER_SEC=$(( 1000 * 1000 * 1000 ))

if [ -z "$CONFIG" ] || [ -z "$NUM_STREAMS" ]; then
    echo "Usage: $0 <config_file> <num_streams> [input_video]"
    exit 1
fi

# Detect video FPS via mediainfo; fall back to 30 for the standard sample
VIDEO_FPS=$(mediainfo --Inform="Video;%FrameRate%" "${VIDEO}" 2>/dev/null | awk '{printf "%.0f", $1+0}')
VIDEO_FPS="${VIDEO_FPS:-30}"

# Detect actual frame count; fall back to 1440 if mediainfo unavailable or fails
if [ -n "$3" ]; then
    FRAMES_PER_STREAM=$(mediainfo --Inform="Video;%FrameCount%" "${VIDEO}" 2>/dev/null)
    if ! echo "$FRAMES_PER_STREAM" | grep -qE '^[0-9]+$' || [ "$FRAMES_PER_STREAM" -eq 0 ]; then
        echo "Warning: mediainfo failed, falling back to 1440 frames" >&2
        FRAMES_PER_STREAM=1440
    fi
else
    # Default sample_720p.mp4 is ~1440 frames at 30fps
    FRAMES_PER_STREAM=1440
fi
TOTAL_FRAMES=$((FRAMES_PER_STREAM * NUM_STREAMS))

echo "=== DeepStream Benchmark ==="
echo "Config:  $CONFIG"
echo "Streams: $NUM_STREAMS"
echo "Frames/stream: $FRAMES_PER_STREAM"
echo "Total frames:  $TOTAL_FRAMES"
echo ""

# Build source elements
SOURCES=""
for i in $(seq 0 $((NUM_STREAMS - 1))); do
    SOURCES+="filesrc location=${VIDEO} ! qtdemux ! queue ! h264parse ! queue ! nvv4l2decoder ! queue ! mux.sink_${i} "
done

PIPELINE="${SOURCES} nvstreammux name=mux batch-size=${NUM_STREAMS} width=${MUXER_W} height=${MUXER_H} batched-push-timeout=-1 ! \
    queue ! nvinfer config-file-path=${CONFIG} ! queue ! fakesink sync=0"

echo "Starting pipeline..."
START_TIME=$(date +%s%N)

GST_DEBUG=0 gst-launch-1.0 -e ${PIPELINE} 2>&1 | grep -v "^$" || true

END_TIME=$(date +%s%N)
ELAPSED_NS=$((END_TIME - START_TIME))
ELAPSED_SEC=$(echo "scale=2; $ELAPSED_NS / $NS_PER_SEC" | bc)
FPS=$(echo "scale=1; $TOTAL_FRAMES / $ELAPSED_SEC" | bc)
REALTIME=$(echo "scale=2; $FPS / (${NUM_STREAMS} * ${VIDEO_FPS})" | bc)

echo ""
echo "=== Results ==="
echo "Wall time:     ${ELAPSED_SEC}s"
echo "Total frames:  ${TOTAL_FRAMES}"
echo "Throughput:    ${FPS} img/s"
echo "Per-stream:    $(echo "scale=1; $FPS / $NUM_STREAMS" | bc) fps"
echo "Real-time factor: ${REALTIME}x (${NUM_STREAMS} streams @ ${VIDEO_FPS}fps)"
echo "==============="
