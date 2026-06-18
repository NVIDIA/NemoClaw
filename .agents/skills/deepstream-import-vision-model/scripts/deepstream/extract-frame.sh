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

set -o pipefail
################################################################################
# Step 6: Extract first frame from output video as PNG for visual inspection.
#
# Usage: ./extract-frame.sh <input_video> <output_png>
# Example: ./extract-frame.sh yolox_output.mp4 yolox_frame_sample.png
################################################################################

INPUT="$1"
OUTPUT="$2"

if [ -z "$INPUT" ] || [ -z "$OUTPUT" ]; then
    echo "Usage: $0 <input_video> <output_png>"
    exit 1
fi

if [[ "$INPUT" == *.ogv ]]; then
    gst-launch-1.0 \
        filesrc location="${INPUT}" ! oggdemux ! theoradec ! videoconvert ! "video/x-raw,format=RGB" ! \
        pngenc snapshot=true ! filesink location="${OUTPUT}" \
        2>&1 | grep -v "^$"
else
    gst-launch-1.0 \
        filesrc location="${INPUT}" ! qtdemux ! queue ! h264parse ! queue ! nvv4l2decoder ! queue ! \
        nvvideoconvert ! "video/x-raw,format=RGB" ! videoconvert ! \
        pngenc snapshot=true ! filesink location="${OUTPUT}" \
        2>&1 | grep -v "^$"
fi
STATUS=$?

if [ $STATUS -eq 0 ] && [ -f "$OUTPUT" ]; then
    echo "Frame extracted: ${OUTPUT} ($(ls -lh "$OUTPUT" | awk '{print $5}'))"
else
    echo "ERROR: Pipeline failed with exit code $STATUS" >&2
    exit $STATUS
fi
