# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM ollama/ollama@sha256:0ff452f6a4c3c5bb4ab063a1db190b261d5834741a519189ed5301d50e4434d1
COPY nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY supervisor-source.tar.gz supervisor.json LICENSE /opt/nemoclaw/source/
COPY NOTICE.md /opt/nemoclaw/source/NOTICE.md
COPY ollama-LICENSE /opt/nemoclaw/source/ollama-LICENSE
COPY Dockerfile build.json /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="ollama"
