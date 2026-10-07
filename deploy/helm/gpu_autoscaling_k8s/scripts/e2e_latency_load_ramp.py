#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Latency HPA demo load.

Keep ~2000–3000 token answers from 1 GPU through 5 GPUs so 1→2 moves.
Drop to a short cap at 6 and 7 GPUs. Stop new chats at 8.
GPU-util HPA keeps a fixed MAX_TOKENS and does not use this ramp.
A failed HPA poll (0/0) is treated as 1 GPU, never as 8.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_START = 2048
DEFAULT_LOW = 32
DEFAULT_TARGET = 8
REDUCE_AT = 6
RAMP_FILE = Path(os.environ.get("E2E_LATENCY_RAMP_FILE") or "/tmp/e2e-latency-ramp.json")


def is_latency_metric(metric: str) -> bool:
    return "latency" in (metric or "").lower()


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
            "In one sentence, what is Kubernetes HPA?",
            "In one sentence, what is GPU utilization?",
            f"In one sentence, what is {third}?",
        ]
    return [
        "Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
        "Write a detailed 2000-word summary of transformer inference on NVIDIA GPUs, covering batching, KV cache, and tensor parallelism. Keep writing until the answer is long.",
        f"Write a detailed 2000-word description of how {third} serves models and batches concurrent chat requests, with examples. Keep writing until the answer is long.",
    ]


def ramp_payload(max_tokens: int | None, start: int | None = None) -> dict[str, object]:
    if max_tokens is None:
        return {"max_tokens": 0, "stop": True, "short": True}
    return {
        "max_tokens": int(max_tokens),
        "stop": False,
        "short": use_short_prompts(max_tokens, start),
    }


def write_ramp_file(max_tokens: int | None, path: Path | None = None, start: int | None = None) -> Path:
    dest = path or RAMP_FILE
    dest.write_text(json.dumps(ramp_payload(max_tokens, start)) + "\n", encoding="utf-8")
    return dest


def read_ramp_file(path: Path | None = None) -> dict[str, object]:
    dest = path or RAMP_FILE
    high = token_bands()[0]
    try:
        data = json.loads(dest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"max_tokens": high, "stop": False, "short": False}
    if not isinstance(data, dict):
        return {"max_tokens": high, "stop": False, "short": False}
    stop = bool(data.get("stop"))
    try:
        tokens = int(data.get("max_tokens") or 0)
    except (TypeError, ValueError):
        tokens = 0
    short = bool(data["short"]) if "short" in data else tokens < high
    return {"max_tokens": tokens, "stop": stop, "short": short}
