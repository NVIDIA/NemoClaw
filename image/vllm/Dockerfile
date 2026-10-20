# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile.
FROM vllm/vllm-openai@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /opt/nemoclaw/source/
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/vllm/NOTICE.md image/vllm/Dockerfile /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.inference.routes="openai-v2" \
      org.nemoclaw.backend="vllm" \
      org.nemoclaw.recipe.protocol="v1"
