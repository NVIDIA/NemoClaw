# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# CUDA 13.3.0 / Ubuntu 24.04 development base, also pinned by NemoClaw main at
# 95d6505265ba1f2cb05355f83786353e654de096. Keep its NVIDIA driver constraints.
FROM docker.io/nvidia/cuda@sha256:ef2203909e80b8b976cfc672f7e2ae2b00bc0e25c404ee86d89e10a3802f1c52

# Validation-only distro packages resolve at build time; CI retains their versions.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates clang-18 g++ python3 \
    && ln -s /usr/bin/clang-18 /usr/local/bin/clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /lab
