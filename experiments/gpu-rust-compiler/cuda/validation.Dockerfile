# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# CUDA 13.3.0 / Ubuntu 24.04 development base, also pinned by NemoClaw main at
# 95d6505265ba1f2cb05355f83786353e654de096. Keep its NVIDIA driver constraints.
FROM docker.io/nvidia/cuda@sha256:ef2203909e80b8b976cfc672f7e2ae2b00bc0e25c404ee86d89e10a3802f1c52
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Validation-only distro packages resolve at build time; CI retains their versions.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates clang-18 g++ python3 cmake ninja-build git curl xz-utils libxml2 libzstd1 \
    && ln -s /usr/bin/clang-18 /usr/local/bin/clang \
    && rm -rf /var/lib/apt/lists/*

# Build-only development assets. Deployed adapters use the existing rustc LLVM
# library for fallback; the 126 MB llc executable is not a required compiler asset.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:/opt/llvm/bin:$PATH
RUN curl --fail --location --retry 3 \
      https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.8/LLVM-22.1.8-Linux-X64.tar.xz \
      --output /tmp/llvm.tar.xz \
    && echo 'df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384  /tmp/llvm.tar.xz' | sha256sum --check - \
    && mkdir -p /opt/llvm \
    && tar -xJf /tmp/llvm.tar.xz --strip-components=1 -C /opt/llvm \
    && rm /tmp/llvm.tar.xz \
    && curl --fail --location --retry 3 \
      https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init \
      --output /tmp/rustup-init \
    && echo '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  /tmp/rustup-init' | sha256sum --check - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --profile minimal --default-toolchain 1.98.1 --no-modify-path \
    && rm /tmp/rustup-init \
    && rustc +1.98.1 --version --verbose

# Fetch immutable upstream sources while the image build has network access.
# The qualification container runs without a network and consumes this checkout.
RUN git init /opt/tpde-source \
    && git -C /opt/tpde-source remote add origin https://github.com/tpde2/tpde.git \
    && git -C /opt/tpde-source fetch --depth 1 origin 9779acf4ada3736e779391da1e4b3369dba08024 \
    && git -C /opt/tpde-source checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/tpde-source rev-parse HEAD)" = 9779acf4ada3736e779391da1e4b3369dba08024 \
    && git -C /opt/tpde-source submodule update --init --recursive --depth 1 \
         deps/args deps/spdlog deps/fadec deps/disarm

WORKDIR /lab
