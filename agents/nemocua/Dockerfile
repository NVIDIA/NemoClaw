# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

ARG BASE_IMAGE
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

USER root

COPY agents/nemocua/nemocua-runtime.sh /usr/local/bin/nemocua-runtime
COPY agents/nemocua/runtime-artifacts.json /usr/local/share/nemoclaw/nemocua-runtime-artifacts.json

RUN chown root:root \
        /usr/local/bin/nemocua-runtime \
        /usr/local/share/nemoclaw/nemocua-runtime-artifacts.json \
    && chmod 0755 /usr/local/bin/nemocua-runtime \
    && chmod 0444 /usr/local/share/nemoclaw/nemocua-runtime-artifacts.json \
    && /usr/local/bin/nemocua-runtime version \
    && /usr/local/bin/nemocua-runtime smoke --image-build

USER sandbox
