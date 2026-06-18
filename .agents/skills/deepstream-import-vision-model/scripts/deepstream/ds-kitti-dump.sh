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
# Step 6: KITTI dump using deepstream-app (built-in KITTI support)
# Generates a temporary deepstream-app config, runs for N frames, dumps KITTI.
#
# Usage: ./ds-kitti-dump.sh <nvinfer_config> <kitti_output_dir> [num_frames] [input_video]
# Example: ./ds-kitti-dump.sh config_infer_primary_yolox.txt kitti_output 100
################################################################################
set -euo pipefail

NVINFER_CONFIG="$1"
KITTI_DIR="$2"
NUM_FRAMES="${3:-100}"
VIDEO="${4:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"

if [ -z "$NVINFER_CONFIG" ] || [ -z "$KITTI_DIR" ]; then
    echo "Usage: $0 <nvinfer_config> <kitti_output_dir> [num_frames] [input_video]"
    exit 1
fi

# Validate inputs before resolving paths
[ -f "$NVINFER_CONFIG" ] || { echo "ERROR: nvinfer config not found: $NVINFER_CONFIG"; exit 1; }
[ -f "$VIDEO" ] || { echo "ERROR: video file not found: $VIDEO"; exit 1; }

# Resolve to absolute paths
NVINFER_CONFIG="$(realpath "$NVINFER_CONFIG")"
KITTI_DIR="$(realpath -m "$KITTI_DIR")"
VIDEO="$(realpath "$VIDEO")"

mkdir -p "${KITTI_DIR}"

echo "=== DeepStream KITTI Dump ==="
echo "nvinfer config: $NVINFER_CONFIG"
echo "KITTI dir:      $KITTI_DIR"
echo "Max frames:     $NUM_FRAMES"
echo "Input video:    $VIDEO"
echo ""

# Generate temporary deepstream-app config
trap 'rm -f "${TMPCONFIG:-}"' EXIT
TMPCONFIG=$(mktemp /tmp/ds_kitti_XXXXXX.txt)

cat > "$TMPCONFIG" << EOF
[application]
enable-perf-measurement=0
gie-kitti-output-dir=${KITTI_DIR}

[tiled-display]
enable=0

[source0]
enable=1
type=3
uri=file://${VIDEO}
num-sources=1
gpu-id=0

[sink0]
enable=1
type=1
#1=FakeSink
sync=0

[osd]
enable=0

[streammux]
live-source=0
batch-size=1
batched-push-timeout=-1
width=1280
height=720

[primary-gie]
enable=1
batch-size=1
gie-unique-id=1
config-file=${NVINFER_CONFIG}

[tests]
file-loop=0
EOF

echo "Temp config: $TMPCONFIG"
echo "Running deepstream-app..."

# Run deepstream-app (it will process entire video).
# Temporarily disable pipefail so head -30 closing the pipe early (SIGPIPE to grep)
# doesn't trigger set -e before we can capture deepstream-app's exit code.
set +o pipefail
timeout 120 deepstream-app -c "$TMPCONFIG" 2>&1 | grep -v "^$" | head -30
DS_EXIT_CODE=${PIPESTATUS[0]}
set -o pipefail

if [ $DS_EXIT_CODE -eq 124 ]; then
    echo "Warning: deepstream-app timed out after 120 seconds"
elif [ $DS_EXIT_CODE -ne 0 ]; then
    echo "Error: deepstream-app failed with exit code $DS_EXIT_CODE"
    exit 1
fi

# Count KITTI files generated
TOTAL_FILES=$(ls -1 "${KITTI_DIR}"/*.txt 2>/dev/null | wc -l)
echo ""
echo "Total KITTI files generated: ${TOTAL_FILES}"

# Keep only first N frames, remove the rest
if [ "$TOTAL_FILES" -gt "$NUM_FRAMES" ]; then
    # Guard against misconfigured KITTI_DIR blowing away something else
    [ -n "$KITTI_DIR" ] && [ -d "$KITTI_DIR" ] && [ "$KITTI_DIR" != "/" ] \
        || { echo "ERROR: invalid KITTI_DIR for cleanup: $KITTI_DIR"; exit 1; }
    TO_REMOVE=$((TOTAL_FILES - NUM_FRAMES))
    echo "Trimming to first ${NUM_FRAMES} frames (removing ${TO_REMOVE})..."
    # NUL-delimited read so filenames with spaces/newlines are handled safely.
    KITTI_FILES=()
    while IFS= read -r -d '' f; do
        KITTI_FILES+=("$f")
    done < <(find "$KITTI_DIR" -maxdepth 1 -type f -name '*.txt' -print0 | sort -z)
    for ((i = NUM_FRAMES; i < ${#KITTI_FILES[@]}; i++)); do
        rm -f -- "${KITTI_FILES[i]}"
    done
    TOTAL_FILES=$(find "$KITTI_DIR" -maxdepth 1 -type f -name '*.txt' 2>/dev/null | wc -l)
    echo "Kept ${TOTAL_FILES} KITTI files"
fi

# Show sample KITTI output
echo ""
echo "=== Sample KITTI Output (first 3 files) ==="
for f in $(ls -1 "${KITTI_DIR}"/*.txt 2>/dev/null | sort | head -3); do
    echo "--- $(basename $f) ---"
    cat "$f"
done

echo ""
echo "=== KITTI Dump Complete ==="
