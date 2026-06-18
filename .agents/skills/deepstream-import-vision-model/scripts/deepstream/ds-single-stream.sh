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
# Step 6: Single-stream DeepStream pipeline -- saves output video with OSD boxes.
#
# Usage: ./ds-single-stream.sh <config_file> <output_video> [input_video]
# Example: ./ds-single-stream.sh config_infer_primary_yolox.txt yolox_output.mp4
#
# Encoder policy (MANDATORY):
#   - Primary path uses nvv4l2h264enc (NVENC) with .mp4 container. nvdsosd
#     overlays are reliably preserved only with NVENC on the NVMM memory path.
#   - x264enc and openh264enc are PROHIBITED and must never be used.
#   - On NVENC-init failure, the script checks theoraenc + oggmux availability
#     (LGPL elements; both ship in gst-plugins-base):
#       * Available  → falls back to theoraenc+oggmux → saves <output>.ogv
#           nvvideoconvert ! "video/x-raw, format=I420" ! theoraenc quality=48 ! oggmux
#         Emits DS_SINGLE_STREAM_MODE=theoraenc-fallback and DS_SINGLE_STREAM_OUTPUT=<path>
#       * Unavailable → skips video creation, emits DS_SINGLE_STREAM_MODE=skipped, exit 0
#     The benchmark report must surface which encoder mode was used.
################################################################################

set -o pipefail

CONFIG="$1"
OUTPUT="$2"
VIDEO="${3:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"
MUXER_W=1280
MUXER_H=720

if [ -z "$CONFIG" ] || [ -z "$OUTPUT" ]; then
    echo "Usage: $0 <config_file> <output_video> [input_video]"
    exit 1
fi

OUTPUT_DIR="$(dirname "$OUTPUT")"
LOG_FILE="$(mktemp -t ds-single-stream-XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

mkdir -p "$OUTPUT_DIR"

echo "=== DeepStream Single-Stream Test ==="
echo "Config: $CONFIG"
echo "Input:  $VIDEO"
echo "Output: $OUTPUT (primary: nvv4l2h264enc)"
echo ""

gst-launch-1.0 \
    filesrc location="${VIDEO}" ! qtdemux ! queue ! h264parse ! queue ! nvv4l2decoder ! queue ! mux.sink_0 \
    nvstreammux name=mux batch-size=1 width=${MUXER_W} height=${MUXER_H} batched-push-timeout=-1 ! \
    nvinfer config-file-path="${CONFIG}" ! \
    nvvideoconvert ! nvdsosd ! nvvideoconvert ! \
    "video/x-raw(memory:NVMM), format=NV12" ! nvv4l2h264enc ! h264parse ! mp4mux ! \
    filesink location="${OUTPUT}" sync=0 \
    2>&1 | tee "$LOG_FILE"
STATUS=${PIPESTATUS[0]}

if [ $STATUS -eq 0 ] && [ -s "$OUTPUT" ]; then
    echo ""
    echo "Output saved to: ${OUTPUT}"
    echo "DS_SINGLE_STREAM_MODE=nvenc-primary"
    echo "DS_SINGLE_STREAM_OUTPUT=${OUTPUT}"
    exit 0
fi

# Detect NVENC-init failure -- the only condition under which we use the theoraenc fallback.
# x264enc and openh264enc are prohibited. Any other failure surfaces as a hard error.
if grep -qE "v4l2-nvenc.*failed during initialization|Could not open device.*v4l2-nvenc|nvv4l2h264enc.*not-negotiated" "$LOG_FILE"; then
    echo ""
    echo "WARNING: nvv4l2h264enc (NVENC) is unavailable on this GPU." >&2

    if ! gst-inspect-1.0 theoraenc > /dev/null 2>&1 || ! gst-inspect-1.0 oggmux > /dev/null 2>&1; then
        echo "WARNING: theoraenc/oggmux not available. Skipping video creation." >&2
        echo "DS_SINGLE_STREAM_MODE=skipped"
        exit 0
    fi

    echo "         Falling back to theoraenc+oggmux (OGV output)." >&2
    echo ""
    OGV_OUTPUT="$(echo "${OUTPUT}" | sed -E 's/\.[Mm][Pp]4$//').ogv"
    rm -f "$OUTPUT" "$OGV_OUTPUT"

    gst-launch-1.0 \
        filesrc location="${VIDEO}" ! qtdemux ! queue ! h264parse ! queue ! nvv4l2decoder ! queue ! mux.sink_0 \
        nvstreammux name=mux batch-size=1 width=${MUXER_W} height=${MUXER_H} batched-push-timeout=-1 ! \
        nvinfer config-file-path="${CONFIG}" ! \
        nvvideoconvert ! nvdsosd ! nvvideoconvert ! \
        "video/x-raw, format=I420" ! theoraenc quality=48 ! oggmux ! \
        filesink location="${OGV_OUTPUT}" sync=0 \
        2>&1
    THEORA_STATUS=$?

    if [ $THEORA_STATUS -eq 0 ] && [ -s "$OGV_OUTPUT" ]; then
        echo ""
        echo "theoraenc fallback succeeded. Output saved to: ${OGV_OUTPUT}"
        echo "DS_SINGLE_STREAM_MODE=theoraenc-fallback"
        echo "DS_SINGLE_STREAM_OUTPUT=${OGV_OUTPUT}"
        exit 0
    fi

    echo "ERROR: theoraenc fallback pipeline failed (exit ${THEORA_STATUS})." >&2
    exit ${THEORA_STATUS:-1}
fi

echo "Pipeline failed with exit code $STATUS (not an NVENC-init failure)." >&2
exit $STATUS
