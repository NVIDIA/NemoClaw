#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Expert parallel is unstable on some hardware/image combos (for example,
# Blackwell + older vLLM builds). Keep it disabled by default and allow opt-in.
ENABLE_EXPERT_PARALLEL="${ENABLE_EXPERT_PARALLEL:-0}"
# Cap context length to avoid oversized KV-cache allocation on single-GPU runs.
VLM_MAX_MODEL_LEN="${VLM_MAX_MODEL_LEN:-32768}"

ARGS=(
  serve "${VLM_MODEL}"
  --host 0.0.0.0 --port 8000
  --tensor-parallel-size "${TENSOR_PARALLEL}"
  --max-model-len "${VLM_MAX_MODEL_LEN}"
  --mm-encoder-tp-mode data
  --async-scheduling
  --gpu-memory-utilization 0.9
  --trust-remote-code --dtype auto
  --disable-frontend-multiprocessing
)

if [ "${ENABLE_EXPERT_PARALLEL}" = "1" ] || [ "${ENABLE_EXPERT_PARALLEL}" = "true" ]; then
  ARGS+=(--enable-expert-parallel)
fi

exec vllm "${ARGS[@]}"
