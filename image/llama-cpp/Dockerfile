# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Reuse Classic's immutable CUDA build and its retained llama.cpp source metadata and notices.
# Source 8e7f22b67ef4667b4ddd50230771287f328cfb3f; see NOTICE.md.
FROM ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:93efd0bec1ed2a7166660edfef9bb743fdfeb3c125d915b43801e69c0befca67
# The v1 credential/storage contract uses root-owned volumes, as vLLM does.
USER 0:0
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/llama-cpp/NOTICE.md image/llama-cpp/Dockerfile /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.backend="llama-cpp"
