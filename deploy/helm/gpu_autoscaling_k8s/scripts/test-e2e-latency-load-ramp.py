#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: GPU util ignores MAX_TOKENS; latency uses MAX_TOKENS=64; stop at 8."""

from __future__ import annotations

import os

from e2e_latency_load_ramp import (
    effective_replicas,
    gpuutil_load_for_replicas,
    latency_tokens_for_replicas,
    scale_load,
    should_stop_after_hold,
    use_short_prompts,
)

assert effective_replicas(0, 0) == 1
assert effective_replicas(1, 0) == 1
assert effective_replicas(6, 7) == 7

os.environ.pop("MAX_TOKENS", None)
os.environ.pop("E2E_GPUUTIL_TOKEN_START", None)
os.environ.pop("E2E_LATENCY_TOKEN_START", None)
os.environ.pop("E2E_GPUUTIL_INFLIGHT_MAX", None)
os.environ.pop("E2E_GPUUTIL_INFLIGHT_2_AT", None)
assert latency_tokens_for_replicas(1) == 64
assert latency_tokens_for_replicas(5) == 64
assert latency_tokens_for_replicas(6) == 64
assert latency_tokens_for_replicas(7) == 64
assert latency_tokens_for_replicas(8) is None
assert use_short_prompts(64) is True
assert use_short_prompts(4096) is False

assert gpuutil_load_for_replicas(1) == (4096, 3)
assert gpuutil_load_for_replicas(2) == (4096, 3)
assert gpuutil_load_for_replicas(5) == (4096, 3)
assert gpuutil_load_for_replicas(6) == (4096, 3)
assert gpuutil_load_for_replicas(8) == (None, 1)
os.environ["E2E_GPUUTIL_INFLIGHT_MAX"] = "2"
assert gpuutil_load_for_replicas(1)[1] == 2
os.environ.pop("E2E_GPUUTIL_INFLIGHT_MAX", None)
assert gpuutil_load_for_replicas(1)[1] == 3

os.environ["MAX_TOKENS"] = "32768"
assert gpuutil_load_for_replicas(1)[0] == 4096
assert latency_tokens_for_replicas(1) == 32768
os.environ["MAX_TOKENS"] = "64"
assert gpuutil_load_for_replicas(1)[0] == 4096
assert latency_tokens_for_replicas(1) == 64
os.environ.pop("MAX_TOKENS", None)
os.environ["E2E_GPUUTIL_TOKEN_START"] = "8192"
assert gpuutil_load_for_replicas(1)[0] == 8192
assert latency_tokens_for_replicas(1) == 64
os.environ.pop("E2E_GPUUTIL_TOKEN_START", None)
assert gpuutil_load_for_replicas(1)[0] == 4096

latency_at_1 = scale_load("nemoclaw_llm_latency_avg_milliseconds", 1)
assert latency_at_1["max_tokens"] == 64
assert latency_at_1["inflight"] == 1
assert latency_at_1["short"] is True
latency_at_6 = scale_load("nemoclaw_llm_latency_avg_milliseconds", 6)
assert latency_at_6["max_tokens"] == 64
assert latency_at_6["inflight"] == 1
gpu_at_5 = scale_load("gpu_utilization_percent", 5)
assert gpu_at_5["stop"] is False
assert gpu_at_5["max_tokens"] == 4096
assert gpu_at_5["short"] is False
assert gpu_at_5["inflight"] == 3
gpu_at_6 = scale_load("gpu_utilization_percent", 6)
assert gpu_at_6["stop"] is False
assert gpu_at_6["max_tokens"] == 4096
assert gpu_at_6["short"] is False
assert gpu_at_6["inflight"] == 3
gpu_at_8 = scale_load("gpu_utilization_percent", 8)
assert gpu_at_8["stop"] is True
assert gpu_at_8["max_tokens"] == 0

os.environ.pop("MAX_TOKENS", None)
unknown = scale_load("", 1)
assert unknown["max_tokens"] == 64
assert unknown["inflight"] == 1

latency_at_8 = scale_load("nemoclaw_llm_latency_avg_milliseconds", 8)
assert latency_at_8["stop"] is True
assert latency_at_8["max_tokens"] == 0
assert latency_at_8["inflight"] == 1

stop_now, since = should_stop_after_hold(False, 60, None, 10.0)
assert stop_now is False
assert since is None
stop_now, since = should_stop_after_hold(True, 60, None, 10.0)
assert stop_now is False
assert since == 10.0
stop_now, _since = should_stop_after_hold(True, 60, 10.0, 69.9)
assert stop_now is False
stop_now, _since = should_stop_after_hold(True, 60, 10.0, 70.0)
assert stop_now is True
stop_now, _since = should_stop_after_hold(True, 0, None, 10.0)
assert stop_now is True

print("OK: GPU util ignores MAX_TOKENS (4096, inflight 3 until stop at 8); latency MAX_TOKENS default 64")
