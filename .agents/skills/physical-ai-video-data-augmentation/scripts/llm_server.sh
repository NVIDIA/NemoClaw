#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"
exec vllm serve "${LLM_MODEL}" \
    --host 0.0.0.0 --port 8001 \
    --tensor-parallel-size "${TENSOR_PARALLEL}" \
    --max-model-len 32768 \
    --gpu-memory-utilization 0.9 \
    --trust-remote-code --dtype auto \
    --disable-frontend-multiprocessing
