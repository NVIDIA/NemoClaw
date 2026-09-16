# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM node@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY image/ollama-proxy/proxy.py /opt/nemoclaw/ollama_proxy.py
ENTRYPOINT ["python3", "/opt/nemoclaw/ollama_proxy.py"]

FROM runtime AS test
COPY image/ollama-proxy/ /tests/
RUN --network=none python3 -B -m unittest discover -s /tests -p 'test_*.py'
