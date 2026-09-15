# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e
COPY nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY supervisor-source.tar.gz supervisor.json LICENSE /opt/nemoclaw/source/
COPY NOTICE.md /opt/nemoclaw/source/NOTICE.md
COPY Dockerfile build.json /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="vllm" \
      org.nemoclaw.recipe.protocol="v1"
