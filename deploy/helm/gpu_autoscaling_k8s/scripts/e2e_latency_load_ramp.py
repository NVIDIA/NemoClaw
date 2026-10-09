#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Same client.sh load for both HPA metrics.

GPU util does not take MAX_TOKENS (OpenClaw built-in 4096). Latency uses
MAX_TOKENS (default 64). OpenClaw GPU util uses three in-flight chats so 1→8
can keep new 0% GPUs from diluting the HPA average. Four chats hung the
gateway; 16384-token chats left inflight slots stuck while GPUs went idle.
Tokens stay at that pin until 8 GPUs; the client then holds and stops. A
failed HPA poll (0/0) is treated as 1 GPU, never as 8.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_START = 64
SHORT_PROMPT_AT = 128
DEFAULT_GPUUTIL_TOKENS = 4096
DEFAULT_GPUUTIL_INFLIGHT = 3
DEFAULT_TARGET = 8
DEFAULT_HOLD_SEC = 60.0
GPUUTIL_INFLIGHT_2_AT = 1
RAMP_FILE = Path(os.environ.get("E2E_LATENCY_RAMP_FILE") or "/tmp/e2e-latency-ramp.json")


def is_latency_metric(metric: str) -> bool:
    return "latency" in (metric or "").lower()


def is_gpuutil_metric(metric: str) -> bool:
    name = (metric or "").lower()
    return "gpu_utilization" in name or name == "gpu"


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def latency_token_start() -> int:
    """MAX_TOKENS is the latency flag. GPU util ignores it."""
    if os.environ.get("MAX_TOKENS"):
        return max(8, env_int("MAX_TOKENS", DEFAULT_START))
    return max(8, env_int("E2E_LATENCY_TOKEN_START", DEFAULT_START))


def token_bands(start: int | None = None) -> tuple[int, int]:
    """Constant pin for this run. Both tuple slots are that pin (no token drop)."""
    if start is None:
        start = latency_token_start()
    start = max(8, start)
    return start, start


def gpuutil_token_cap() -> int:
    """GPU util built-in start. Does not read MAX_TOKENS."""
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
) -> int | None:
    """Pinned max_tokens, or None to stop new chats at the target."""
    high, _same = token_bands(start)
    if replicas >= target:
        return None
    return high


def gpuutil_inflight_for_replicas(replicas: int) -> int:
    """Concurrent chats per user on the one agent in that sandbox."""
    inflight_max = env_int("E2E_GPUUTIL_INFLIGHT_MAX", DEFAULT_GPUUTIL_INFLIGHT)
    if inflight_max < 1:
        inflight_max = 1
    two_at = env_int("E2E_GPUUTIL_INFLIGHT_2_AT", GPUUTIL_INFLIGHT_2_AT)
    if replicas >= two_at:
        return inflight_max
    return 1


def gpuutil_tokens_for_replicas(
    replicas: int,
    *,
    target: int = DEFAULT_TARGET,
) -> int | None:
    """Pinned GPU-util built-in, or None to stop new chats at the target."""
    return latency_tokens_for_replicas(
        replicas, target=target, start=gpuutil_token_cap()
    )


def gpuutil_load_for_replicas(
    replicas: int, target: int = DEFAULT_TARGET
) -> tuple[int | None, int]:
    tokens = gpuutil_tokens_for_replicas(replicas, target=target)
    if tokens is None:
        return None, 1
    return tokens, gpuutil_inflight_for_replicas(replicas)


def scale_load(metric: str, replicas: int, target: int = DEFAULT_TARGET) -> dict[str, object]:
    """Client load for the live HPA metric and replica count."""
    if is_gpuutil_metric(metric):
        tokens, inflight = gpuutil_load_for_replicas(replicas, target=target)
        stop = tokens is None
        return {
            "mode": "gpuutil",
            "max_tokens": 0 if stop else int(tokens),
            "inflight": 1 if stop else inflight,
            "stop": stop,
            "short": False if stop else use_short_prompts(int(tokens), start=gpuutil_token_cap()),
        }
    tokens = latency_tokens_for_replicas(replicas, target=target)
    stop = tokens is None
    return {
        "mode": "latency" if is_latency_metric(metric) else "",
        "max_tokens": 0 if stop else int(tokens),
        "inflight": 1,
        "stop": stop,
        "short": False if stop else use_short_prompts(int(tokens)),
    }


def should_stop_after_hold(
    stop_requested: bool,
    hold_sec: float,
    at_max_since: float | None,
    now: float,
) -> tuple[bool, float | None]:
    """After HPA hits 8, wait hold_sec before ending chats so sit-at-8 stays ~1 min."""
    if not stop_requested:
        return False, None
    since = now if at_max_since is None else at_max_since
    wait = hold_sec if hold_sec > 0 else 0.0
    return (now - since) >= wait, since


def use_short_prompts(max_tokens: int, start: int | None = None) -> bool:
    del start
    return max_tokens <= SHORT_PROMPT_AT


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
