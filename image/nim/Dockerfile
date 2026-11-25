# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NIM 2.1.7 multi-platform index. Native scripts, models and licenses stay upstream-owned.
FROM nvcr.io/nim/meta/llama-3.1-8b-instruct@sha256:5ada92d1ca5c30069956e6e1322f0fbb250b4683b566aedb6547b10a64faf00b
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
