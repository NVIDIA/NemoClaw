# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

ARG CUDA_DEV_IMAGE
ARG CUDA_RUNTIME_IMAGE

FROM ${CUDA_DEV_IMAGE} AS build

ARG LLAMA_CPP_REVISION
ARG LLAMA_CPP_ARCHIVE_SHA256
ARG CUDA_ARCHITECTURES
ARG GGML_BACKEND_DIR
ARG C_COMPILER
ARG CXX_COMPILER
ARG CUDA_HOST_CXX_COMPILER

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN test -n "${LLAMA_CPP_REVISION}" \
    && test -n "${LLAMA_CPP_ARCHIVE_SHA256}" \
    && test -n "${CUDA_ARCHITECTURES}" \
    && test -n "${GGML_BACKEND_DIR}" \
    && test -n "${C_COMPILER}" \
    && test -n "${CXX_COMPILER}" \
    && test -n "${CUDA_HOST_CXX_COMPILER}"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential=12.10ubuntu1 \
      ca-certificates=20260601~24.04.1 \
      cmake=3.28.3-1build7 \
      curl=8.5.0-2ubuntu10.11 \
      g++-14=14.2.0-4ubuntu2~24.04.1 \
      gcc-14=14.2.0-4ubuntu2~24.04.1 \
      libcurl4-openssl-dev=8.5.0-2ubuntu10.11 \
      libssl-dev=3.0.13-0ubuntu3.12 \
    && rm -rf /var/lib/apt/lists/*

ENV CC=${C_COMPILER} \
    CXX=${CXX_COMPILER} \
    CUDAHOSTCXX=${CUDA_HOST_CXX_COMPILER}

WORKDIR /src/llama.cpp

RUN curl --fail --location --proto '=https' --tlsv1.2 --retry 5 \
      --output /tmp/llama.cpp.tar.gz \
      "https://github.com/ggml-org/llama.cpp/archive/${LLAMA_CPP_REVISION}.tar.gz" \
    && printf '%s  %s\n' "${LLAMA_CPP_ARCHIVE_SHA256#sha256:}" /tmp/llama.cpp.tar.gz \
      | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/llama.cpp.tar.gz --strip-components=1 \
    && rm /tmp/llama.cpp.tar.gz

RUN cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
      -DGGML_BACKEND_DIR="${GGML_BACKEND_DIR}" \
      -DGGML_BACKEND_DL=ON \
      -DGGML_CPU_ALL_VARIANTS=ON \
      -DGGML_CUDA=ON \
      -DGGML_CURL=ON \
      -DGGML_NATIVE=OFF \
      -DGGML_RPC=OFF \
      -DLLAMA_BUILD_APP=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_TOOLS=ON \
      -DLLAMA_BUILD_UI=OFF \
      -DLLAMA_OPENSSL=ON \
      -DLLAMA_SUBPROCESS=OFF \
      -DLLAMA_USE_PREBUILT_UI=OFF \
      -DLLAMA_BUILD_COMMIT="${LLAMA_CPP_REVISION}" \
    && cmake --build build --config Release --target llama-server --parallel "$(nproc)" \
    && mkdir -p /opt/llama.cpp/bin /opt/llama.cpp/lib /opt/llama.cpp/licenses/llama.cpp \
    && cp build/bin/llama-server /opt/llama.cpp/bin/llama-server \
    && find build -type f -name '*.so*' -exec cp -P '{}' /opt/llama.cpp/lib/ \; \
    && find build -type l -name '*.so*' -exec cp -P '{}' /opt/llama.cpp/lib/ \; \
    && cp LICENSE AUTHORS /opt/llama.cpp/licenses/llama.cpp/ \
    && test -f "${GGML_BACKEND_DIR}/libggml-cuda.so" \
    && find /opt/llama.cpp/licenses -type d -exec chmod 0555 '{}' + \
    && find /opt/llama.cpp/licenses -type f -exec chmod 0444 '{}' +

FROM ${CUDA_RUNTIME_IMAGE} AS runtime

ARG CUDA_DEV_IMAGE
ARG CUDA_RUNTIME_IMAGE
ARG CUDA_ARCHITECTURES
ARG LLAMA_CPP_REVISION
ARG LLAMA_CPP_ARCHIVE_SHA256
ARG NEMOCLAW_REVISION
ARG TARGETPLATFORM
ARG RUNTIME_UID
ARG RUNTIME_GID

RUN test -n "${CUDA_DEV_IMAGE}" \
    && test -n "${CUDA_RUNTIME_IMAGE}" \
    && test -n "${CUDA_ARCHITECTURES}" \
    && test -n "${LLAMA_CPP_REVISION}" \
    && test -n "${LLAMA_CPP_ARCHIVE_SHA256}" \
    && test -n "${NEMOCLAW_REVISION}" \
    && test -n "${TARGETPLATFORM}" \
    && test -n "${RUNTIME_UID}" \
    && test -n "${RUNTIME_GID}"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates=20260601~24.04.1 \
      libcurl4t64=8.5.0-2ubuntu10.11 \
      libgomp1=14.2.0-4ubuntu2~24.04.1 \
    && groupadd --gid "${RUNTIME_GID}" nemoclaw-llama \
    && useradd --uid "${RUNTIME_UID}" --gid "${RUNTIME_GID}" \
      --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin nemoclaw-llama \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f \
      /bin/bash \
      /bin/dash \
      /bin/rbash \
      /bin/sh \
      /usr/bin/bash \
      /usr/bin/dash \
      /usr/bin/rbash \
      /usr/bin/sh

COPY --from=build --chmod=0555 /opt/llama.cpp/bin/llama-server /usr/local/bin/llama-server
COPY --from=build --chmod=0555 /opt/llama.cpp/lib/ /opt/llama.cpp/lib/
COPY --from=build /opt/llama.cpp/licenses/ /usr/local/share/licenses/

ENV CUDA_CACHE_PATH=/tmp/nemoclaw-cuda-cache \
    HOME=/tmp/nemoclaw-home \
    LD_LIBRARY_PATH=/opt/llama.cpp/lib:/usr/local/nvidia/lib:/usr/local/nvidia/lib64 \
    XDG_CACHE_HOME=/tmp/nemoclaw-cache

LABEL org.opencontainers.image.source="https://github.com/NVIDIA/NemoClaw" \
      org.opencontainers.image.revision="${NEMOCLAW_REVISION}" \
      org.opencontainers.image.title="NemoClaw llama.cpp server" \
      org.opencontainers.image.description="NemoClaw-owned CUDA llama-server runtime" \
      io.nvidia.nemoclaw.inference-server.contract="1" \
      io.nvidia.nemoclaw.inference-server.component="llama.cpp" \
      io.nvidia.nemoclaw.inference-server.platform="${TARGETPLATFORM}" \
      io.nvidia.nemoclaw.inference-server.upstream.repository="https://github.com/ggml-org/llama.cpp" \
      io.nvidia.nemoclaw.inference-server.upstream.revision="${LLAMA_CPP_REVISION}" \
      io.nvidia.nemoclaw.inference-server.upstream.archive-sha256="${LLAMA_CPP_ARCHIVE_SHA256}" \
      io.nvidia.nemoclaw.inference-server.cuda.development-base="${CUDA_DEV_IMAGE}" \
      io.nvidia.nemoclaw.inference-server.cuda.runtime-base="${CUDA_RUNTIME_IMAGE}" \
      io.nvidia.nemoclaw.inference-server.cuda.architectures="${CUDA_ARCHITECTURES}"

WORKDIR /opt/llama.cpp

EXPOSE 8081

USER ${RUNTIME_UID}:${RUNTIME_GID}

ENTRYPOINT ["/usr/local/bin/llama-server"]
