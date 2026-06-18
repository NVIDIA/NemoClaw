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
# Step 8a: TensorRT benchmark using trtexec for arbitrary batch sizes.
# Runs 10-second benchmarks and reports GPU compute time + throughput.
#
# Usage: ./benchmark-trtexec.sh <bs:engine> [<bs:engine> ...] [duration_sec]
# Example: ./benchmark-trtexec.sh 1:yolox_nano_b1.engine 64:yolox_nano_b64.engine
#          ./benchmark-trtexec.sh 1:b1.engine 64:b64.engine 20
################################################################################

# Last plain-integer arg is treated as duration; all others are bs:engine pairs.
DURATION=10
ENGINE_PAIRS=()
for arg in "$@"; do
    if [[ "$arg" =~ ^[0-9]+$ ]]; then
        DURATION="$arg"
    else
        ENGINE_PAIRS+=("$arg")
    fi
done

if [ ${#ENGINE_PAIRS[@]} -eq 0 ]; then
    echo "Usage: $0 <bs:engine> [<bs:engine> ...] [duration_sec]"
    echo "  e.g. $0 1:model_b1.engine 64:model_b64.engine"
    exit 1
fi

TRTEXEC="/usr/src/tensorrt/bin/trtexec"

echo "=== TensorRT Benchmark ==="
echo "Duration: ${DURATION}s per engine"
echo ""

for ENGINE_INFO in "${ENGINE_PAIRS[@]}"; do
    BATCH="${ENGINE_INFO%%:*}"
    ENGINE="${ENGINE_INFO#*:}"

    if [ ! -f "$ENGINE" ]; then
        echo "SKIP Batch ${BATCH}: ${ENGINE} not found"
        echo ""
        continue
    fi

    echo "--- Batch ${BATCH}: ${ENGINE} ---"
    OUTPUT=$($TRTEXEC --loadEngine="$ENGINE" --fp16 --duration="$DURATION" 2>&1)

    THROUGHPUT=$(echo "$OUTPUT" | grep "\[I\] Throughput:" | grep -oP 'Throughput: \K[0-9.]+')
    GPU_MEAN=$(echo "$OUTPUT" | grep "GPU Compute Time:" | grep -oP 'mean = \K[0-9.]+')
    GPU_MIN=$(echo "$OUTPUT" | grep "GPU Compute Time:" | grep -oP 'min = \K[0-9.]+')
    GPU_MAX=$(echo "$OUTPUT" | grep "GPU Compute Time:" | grep -oP 'max = \K[0-9.]+')
    IMGS_PER_SEC=$(echo "scale=0; $THROUGHPUT * $BATCH" | bc 2>/dev/null)

    echo "  GPU Compute: ${GPU_MEAN} ms (min=${GPU_MIN}, max=${GPU_MAX})"
    echo "  Throughput:  ${THROUGHPUT} qps"
    echo "  Images/sec:  ${IMGS_PER_SEC}"
    echo ""
done

echo "=== Benchmark Complete ==="
