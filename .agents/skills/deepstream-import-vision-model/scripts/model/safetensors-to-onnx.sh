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
# Step 1 (alternate): Convert SafeTensors model to ONNX using optimum-cli.
# Uses an isolated Python venv with optimum, transformers, torch.
# If a venv already exists at the target location, it reuses it.
#
# Usage: ./safetensors-to-onnx.sh <hf_model_id_or_path> <output_dir> [--opset 17] [--dtype fp16]
# Examples:
#   ./safetensors-to-onnx.sh facebook/detr-resnet-50 ./onnx_export
#   ./safetensors-to-onnx.sh facebook/detr-resnet-50 ./onnx_export --opset 17 --dtype fp16
#   ./safetensors-to-onnx.sh ./local_model_dir ./onnx_export
################################################################################
set -euo pipefail

MODEL="$1"
OUTPUT_DIR="$2"
shift 2
EXTRA_ARGS=("$@")

if [ -z "$MODEL" ] || [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 <hf_model_id_or_path> <output_dir> [extra optimum-cli args]"
    echo ""
    echo "Examples:"
    echo "  $0 facebook/detr-resnet-50 ./onnx_export"
    echo "  $0 facebook/detr-resnet-50 ./onnx_export --opset 17 --dtype fp16"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
mkdir -p "$REPO_ROOT/build"
VENV_DIR="$REPO_ROOT/build/.venv_optimum"

echo "=== SafeTensors → ONNX Export ==="
echo "Model:      $MODEL"
echo "Output dir: $OUTPUT_DIR"
echo "Extra args: ${EXTRA_ARGS[*]}"
echo "Venv:       $VENV_DIR"
echo ""

# Create venv if it doesn't exist
if [ ! -f "$VENV_DIR/bin/optimum-cli" ]; then
    echo "Creating Python venv with optimum..."
    python3 -m venv "$VENV_DIR" || { echo "Failed to create venv at $VENV_DIR"; exit 1; }
    source "$VENV_DIR/bin/activate" || { echo "Failed to activate venv"; exit 1; }
    pip install --upgrade pip -q || { echo "Failed to upgrade pip"; exit 1; }
    pip install "optimum[exporters]>=1.20,<2.0" "torch<2.12" transformers onnxruntime matplotlib numpy markdown -q || { echo "Failed to install packages"; exit 1; }
    echo "Venv created and packages installed."
    echo ""
else
    source "$VENV_DIR/bin/activate"
    echo "Reusing existing venv."
    echo ""
fi

# Run export
echo "Running: optimum-cli export onnx -m $MODEL ${EXTRA_ARGS[*]} $OUTPUT_DIR"
echo ""
optimum-cli export onnx -m "$MODEL" "${EXTRA_ARGS[@]}" "$OUTPUT_DIR"
EXIT_CODE=$?

deactivate 2>/dev/null

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "=== Export Complete ==="
    echo "ONNX files:"
    ls -lh "$OUTPUT_DIR"/*.onnx 2>/dev/null
else
    echo ""
    echo "=== Export FAILED (exit code: $EXIT_CODE) ==="
fi

exit $EXIT_CODE
