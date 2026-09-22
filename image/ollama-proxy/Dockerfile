# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM python:3.14.7-slim-trixie@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS runtime
COPY image/ollama-proxy/proxy.py /opt/nemoclaw/ollama_proxy.py
ENTRYPOINT ["python3", "/opt/nemoclaw/ollama_proxy.py"]

FROM runtime AS test
COPY image/ollama-proxy/ /tests/
RUN --network=none python3 -B -m unittest discover -s /tests -p 'test_*.py'
