# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile, and
# the sources context from `cargo images fetch`, as versions.json pins them.
FROM ollama/ollama@sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /rust-COPYRIGHT-library.html /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/ollama/NOTICE.md image/ollama/Dockerfile /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /ollama-LICENSE /opt/nemoclaw/source/ollama-LICENSE
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="ollama"
