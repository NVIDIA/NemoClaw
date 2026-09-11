# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

FROM vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e
ADD --checksum=sha256:5c98f577c4f786cbfb976db9424efb01ad16f2136b357c139f8212081395681a https://codeload.github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/tar.gz/d03809008834124e80223c3482f2ddb59577a48f /opt/nemoclaw/source/recipe.tar.gz
RUN mkdir /opt/nemoclaw/source/recipe && tar -xzf /opt/nemoclaw/source/recipe.tar.gz -C /opt/nemoclaw/source/recipe --strip-components=1
COPY runtimes/qwen38/apply_patches.py runtimes/qwen38/pins.json runtimes/qwen38/NOTICE.md /opt/nemoclaw/source/
COPY internal/spark/model.json /opt/nemoclaw/model.json
COPY LICENSE /opt/nemoclaw/source/Apache-2.0.txt
RUN python3 /opt/nemoclaw/source/apply_patches.py
LABEL org.nemoclaw.backend="vllm-qwen38-spark-v1" \
      org.nemoclaw.recipe="d03809008834124e80223c3482f2ddb59577a48f" \
      org.nemoclaw.model="925d7be6c14c6c9442ef83e8f05b5a3c39304f69"
