# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM node@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY proxy.py /opt/nemoclaw/ollama_proxy.py
ENTRYPOINT ["python3", "/opt/nemoclaw/ollama_proxy.py"]
