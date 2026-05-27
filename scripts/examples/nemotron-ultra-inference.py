#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Reference client for Nemotron Ultra on inference-api.nvidia.com.
# Canonical model/URL constants: src/lib/inference/config.ts
#
#   NVIDIA_INFERENCE_OPENAI_BASE_URL = https://inference-api.nvidia.com
#   NVIDIA_NEMOTRON_ULTRA_MODEL = nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1
#
# Usage:
#   export NVIDIA_INFERENCE_HUB_API_KEY=sk-...   # Inference Hub (not NVIDIA Build nvapi-)
#   pip install openai
#   python scripts/examples/nemotron-ultra-inference.py

from __future__ import annotations

import asyncio
import os

from openai import AsyncOpenAI, OpenAI

API_KEY = os.environ.get("NVIDIA_INFERENCE_HUB_API_KEY", "sk-your-inference-hub-key")
BASE_URL = "https://inference-api.nvidia.com"
MODEL = "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1"
MESSAGES = [{"role": "user", "content": "Capital of United States"}]
TEMPERATURE = 0.9
MAX_TOKENS = 128
TOP_P = 0.7

# NOTE: Streaming is preferred for better performance and resource efficiency.


def sync_non_streaming() -> None:
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
    response = client.chat.completions.create(
        model=MODEL,
        messages=MESSAGES,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        top_p=TOP_P,
        stream=False,
    )
    print(response.choices[0].message.content)


def sync_streaming() -> None:
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
    stream = client.chat.completions.create(
        model=MODEL,
        messages=MESSAGES,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        stream=True,
    )
    for chunk in stream:
        if chunk.choices[0].delta.content is not None:
            print(chunk.choices[0].delta.content, end="", flush=True)
    print()


async def async_non_streaming() -> None:
    async_client = AsyncOpenAI(api_key=API_KEY, base_url=BASE_URL)
    response = await async_client.chat.completions.create(
        model=MODEL,
        messages=MESSAGES,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        top_p=TOP_P,
        stream=False,
    )
    print(response.choices[0].message.content)


async def async_streaming() -> None:
    async_client = AsyncOpenAI(api_key=API_KEY, base_url=BASE_URL)
    stream = await async_client.chat.completions.create(
        model=MODEL,
        messages=MESSAGES,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        stream=True,
    )
    async for chunk in stream:
        if chunk.choices[0].delta.content is not None:
            print(chunk.choices[0].delta.content, end="", flush=True)
    print()


if __name__ == "__main__":
    print("=== sync streaming (recommended) ===")
    sync_streaming()
    # print("=== sync non-streaming ===")
    # sync_non_streaming()
    # asyncio.run(async_non_streaming())
    # asyncio.run(async_streaming())
