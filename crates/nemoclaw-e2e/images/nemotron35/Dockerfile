# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Test-only backport of vLLM #64506; remove when the candidate base contains it.
# The caller builds BASE_IMAGE from this exact candidate before deriving it.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY fix.py /opt/nemoclaw/source/nemotron35-config-fix.py
RUN python3 /opt/nemoclaw/source/nemotron35-config-fix.py
