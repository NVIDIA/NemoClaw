#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: same client ramps latency down and GPU-util inflight up."""

from __future__ import annotations

import os

from e2e_latency_load_ramp import (
    effective_replicas,
    gpuutil_load_for_replicas,
    latency_tokens_for_replicas,
    scale_load,
    use_short_prompts,
)

assert effective_replicas(0, 0) == 1
assert effective_replicas(1, 0) == 1
assert effective_replicas(6, 7) == 7

assert latency_tokens_for_replicas(1) == 2048
assert latency_tokens_for_replicas(5) == 2048
assert latency_tokens_for_replicas(6) == 32
assert latency_tokens_for_replicas(7) == 32
assert latency_tokens_for_replicas(8) is None
assert use_short_prompts(2048) is False
assert use_short_prompts(32) is True

os.environ.pop("MAX_TOKENS", None)
os.environ["E2E_GPUUTIL_INFLIGHT_MAX"] = "2"
assert gpuutil_load_for_replicas(1) == (2048, 1)
assert gpuutil_load_for_replicas(2) == (2048, 2)
assert gpuutil_load_for_replicas(8) == (2048, 2)

os.environ["MAX_TOKENS"] = "32"
assert gpuutil_load_for_replicas(1)[0] == 2048
os.environ["MAX_TOKENS"] = "64"
assert gpuutil_load_for_replicas(4) == (2048, 2)
os.environ.pop("MAX_TOKENS", None)

latency_at_8 = scale_load("nemoclaw_llm_latency_avg_milliseconds", 8)
assert latency_at_8["stop"] is True
assert latency_at_8["max_tokens"] == 0

gpu_at_8 = scale_load("gpu_utilization_percent", 8)
assert gpu_at_8["stop"] is False
assert gpu_at_8["max_tokens"] == 2048
assert gpu_at_8["inflight"] == 2
assert gpu_at_8["short"] is False

print("OK: latency ramps 2048→32→stop; GPU-util keeps 2048 and raises inflight")
