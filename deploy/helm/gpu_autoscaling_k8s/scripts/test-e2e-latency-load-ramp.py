#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: latency load is 2048 tokens through 5 GPUs, 32 at 6/7, stop at 8."""

from __future__ import annotations

from e2e_latency_load_ramp import (
    effective_replicas,
    latency_tokens_for_replicas,
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
print("OK: latency ramp is 2048 until 6 GPUs, 32 at 6/7, stop at 8")
