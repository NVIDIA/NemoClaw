# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NIM 2.0.12 multi-platform index. Native scripts, models and licenses stay upstream-owned.
FROM nvcr.io/nim/meta/llama-3.1-8b-instruct@sha256:d2c94c1d654c3e80b8bc08cc83298d2ba4e219dff41d1092555795edb93c6545
USER 0:0
RUN mkdir -p /data /credentials && chown 1000:0 /data /credentials && chmod 0700 /data /credentials
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/nim/NOTICE.md image/nim/Dockerfile /opt/nemoclaw/source/
USER 1000:0
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.backend="nim"
