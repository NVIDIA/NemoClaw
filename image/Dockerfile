# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 nftables \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 1000 -g 1000 /sandbox
USER node
# The agent runs in OpenShell's inner network namespace. Probe it through the
# OpenShell execution API; the base image's outer-container probe cannot see it.
HEALTHCHECK NONE
