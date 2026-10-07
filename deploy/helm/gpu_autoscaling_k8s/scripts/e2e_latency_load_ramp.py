#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Same client.sh load for both HPA metrics.

Latency: 2048-token answers through 5 GPUs, 32 at 6 and 7, then 0 new chats at 8.
GPU util: 2048-token answers until 8 GPUs, then 0 new chats. Do not drop to 32
at 6 GPUs — that load cannot hold 40% util, so HPA never reaches 8.
A leftover MAX_TOKENS=32/64 flag must not starve GPU-util.
A failed HPA poll (0/0) is treated as 1 GPU, never as 8.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_START = 2048
DEFAULT_LOW = 32
DEFAULT_GPUUTIL_TOKENS = 2048
DEFAULT_TARGET = 8
REDUCE_AT = 6
GPUUTIL_INFLIGHT_2_AT = 2
RAMP_FILE = Path(os.environ.get("E2E_LATENCY_RAMP_FILE") or "/tmp/e2e-latency-ramp.json")


def is_latency_metric(metric: str) -> bool:
    return "latency" in (metric or "").lower()


def is_gpuutil_metric(metric: str) -> bool:
    name = (metric or "").lower()
    return "gpu_utilization" in name


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def token_bands(start: int | None = None) -> tuple[int, int]:
    if start is None:
        start = env_int("E2E_LATENCY_TOKEN_START", DEFAULT_START)
    start = max(8, start)
    low = min(env_int("E2E_LATENCY_TOKEN_LOW", DEFAULT_LOW), start)
    return start, max(8, low)


def gpuutil_token_cap() -> int:
    """GPU-util MAX_TOKENS. Ignore leftover latency 32/64 flags."""
    raw = os.environ.get("MAX_TOKENS")
    if raw not in (None, ""):
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 128:
            return max(8, value)
    return max(8, env_int("E2E_GPUUTIL_TOKEN_START", DEFAULT_GPUUTIL_TOKENS))


def effective_replicas(current: int, desired: int) -> int:
    """Live GPU count for the ramp. 0/0 (failed poll) is idle 1, not 8."""
    n = max(current, desired)
    return n if n > 0 else 1


def latency_tokens_for_replicas(
    replicas: int,
    *,
    target: int = DEFAULT_TARGET,
    start: int | None = None,
    reduce_at: int = REDUCE_AT,
) -> int | None:
    """max_tokens for this replica count, or None to stop new chats at the target."""
    high, low = token_bands(start)
    if replicas >= target:
        return None
    if replicas >= reduce_at:
        return low
    return high


def gpuutil_inflight_for_replicas(replicas: int) -> int:
    """Concurrent chats per user. 1 GPU stays inflight 1; 2+ GPUs raise to 2."""
    inflight_max = env_int("E2E_GPUUTIL_INFLIGHT_MAX", 1)
    if inflight_max < 1:
        inflight_max = 1
    two_at = env_int("E2E_GPUUTIL_INFLIGHT_2_AT", GPUUTIL_INFLIGHT_2_AT)
    if replicas >= two_at and inflight_max >= 2:
        return min(2, inflight_max)
    return 1


def gpuutil_load_for_replicas(replicas: int) -> tuple[int, int]:
    return gpuutil_token_cap(), gpuutil_inflight_for_replicas(replicas)


def scale_load(metric: str, replicas: int, target: int = DEFAULT_TARGET) -> dict[str, object]:
    """Client load for the live HPA metric and replica count."""
    if is_latency_metric(metric):
        tokens = latency_tokens_for_replicas(replicas, target=target)
        stop = tokens is None
        return {
            "mode": "latency",
            "max_tokens": 0 if stop else int(tokens),
            "inflight": 1,
            "stop": stop,
            "short": False if stop else use_short_prompts(int(tokens)),
        }
    if is_gpuutil_metric(metric):
        tokens, inflight = gpuutil_load_for_replicas(replicas)
        stop = replicas >= target
        return {
            "mode": "gpuutil",
            "max_tokens": 0 if stop else int(tokens),
            "inflight": 1 if stop else inflight,
            "stop": stop,
            "short": False,
        }
    return {
        "mode": "",
        "max_tokens": gpuutil_token_cap(),
        "inflight": 1,
        "stop": False,
        "short": False,
    }


def use_short_prompts(max_tokens: int, start: int | None = None) -> bool:
    high, _low = token_bands(start)
    return max_tokens < high


def prompt_for_tokens(max_tokens: int, agent: str = "openclaw", start: int | None = None) -> list[str]:
    short = use_short_prompts(max_tokens, start)
    if agent == "deepagents":
        if short:
            return [
                "Do not use tools. In one sentence, what is Kubernetes HPA?",
                "Do not use tools. In one sentence, what is GPU utilization?",
                "Do not use tools. In one sentence, what is NIM?",
            ]
        return [
            "Do not use tools. Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
            "Do not use tools. Write a detailed 2000-word summary of transformer inference on NVIDIA GPUs, covering batching, KV cache, and tensor parallelism. Keep writing until the answer is long.",
            "Do not use tools. Write a detailed 2000-word description of how NIM serves models and batches concurrent chat requests, with examples. Keep writing until the answer is long.",
        ]
    third = "vLLM" if agent == "hermes" else "Ollama"
    if short:
        return [
            "Do not use tools. In one sentence, what is Kubernetes HPA?",
            "Do not use tools. In one sentence, what is GPU utilization?",
            f"Do not use tools. In one sentence, what is {third}?",
        ]
    return [
        "Do not use tools. Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
        "Do not use tools. Write a detailed 2000-word summary of transformer inference on NVIDIA GPUs, covering batching, KV cache, and tensor parallelism. Keep writing until the answer is long.",
        f"Do not use tools. Write a detailed 2000-word description of how {third} serves models and batches concurrent chat requests, with examples. Keep writing until the answer is long.",
    ]


def ramp_payload(
    max_tokens: int | None,
    start: int | None = None,
    inflight: int = 1,
    stop: bool | None = None,
) -> dict[str, object]:
    halted = bool(stop) or max_tokens is None
    if halted:
        return {"max_tokens": 0, "stop": True, "short": True, "inflight": 1}
    tokens = int(max_tokens)
    return {
        "max_tokens": tokens,
        "stop": False,
        "short": use_short_prompts(tokens, start),
        "inflight": max(1, int(inflight)),
    }


def write_ramp_file(
    max_tokens: int | None,
    path: Path | None = None,
    start: int | None = None,
    inflight: int = 1,
    stop: bool | None = None,
) -> Path:
    dest = path or RAMP_FILE
    dest.write_text(json.dumps(ramp_payload(max_tokens, start, inflight, stop)) + "\n", encoding="utf-8")
    return dest


def load_tokens(load: dict[str, object]) -> int | None:
    """max_tokens for the helper, or None when new chats must stop."""
    if load.get("stop"):
        return None
    try:
        return int(load.get("max_tokens") or 0)
    except (TypeError, ValueError):
        return 0


def write_scale_load(load: dict[str, object], path: Path | None = None) -> Path:
    tokens = load.get("max_tokens")
    token_value = None if load.get("stop") else int(tokens or 0)
    return write_ramp_file(
        token_value,
        path,
        inflight=int(load.get("inflight") or 1),
        stop=bool(load.get("stop")),
    )


def read_ramp_file(path: Path | None = None) -> dict[str, object]:
    dest = path or RAMP_FILE
    high = token_bands()[0]
    try:
        data = json.loads(dest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"max_tokens": high, "stop": False, "short": False, "inflight": 1}
    if not isinstance(data, dict):
        return {"max_tokens": high, "stop": False, "short": False, "inflight": 1}
    stop = bool(data.get("stop"))
    try:
        tokens = int(data.get("max_tokens") or 0)
    except (TypeError, ValueError):
        tokens = 0
    try:
        inflight = int(data.get("inflight") or 1)
    except (TypeError, ValueError):
        inflight = 1
    short = bool(data["short"]) if "short" in data else tokens < high
    return {"max_tokens": tokens, "stop": stop, "short": short, "inflight": max(1, inflight)}
