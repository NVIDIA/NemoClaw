# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile, and
# the sources context from `cargo images fetch`, as versions.json pins them.
# llama.cpp's server-cuda13-b12375 image: CUDA 13.5, source 9d25e0014c4b4b316873c01f4938c0e3c687287d.
FROM ghcr.io/ggml-org/llama.cpp@sha256:c1c63d621e3a87c31680d538a0009ac83d165ef04d13bad84683dbb20c114fbe
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /rust-COPYRIGHT-library.html /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/llama-cpp/NOTICE.md image/llama-cpp/Dockerfile /opt/nemoclaw/source/
COPY image/llama-cpp/llama-ui-NOTICES.md /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /llama-source.tar.gz /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /llama.cpp-LICENSE /nlohmann-json-LICENSE /cpp-httplib-LICENSE /rotate-bits-LICENSE.md /xxhash-LICENSE /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /llama-brand-LICENSE /llama-brand-BRAND-USAGE.md /llama-brand-fonts-OFL.txt /llama-ui-big-integer-LICENSE /llama-ui-nerdamer-LICENSE /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.backend="llama-cpp"
