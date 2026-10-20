# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile.
FROM ollama/ollama@sha256:265409e1d931028a8f7d5a32bcbafddd7bffbc6cc629d77efe9560adf692a5e7
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /opt/nemoclaw/source/
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/ollama/NOTICE.md image/ollama/Dockerfile /opt/nemoclaw/source/
ADD --chmod=0644 --checksum=sha256:5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226 \
    https://raw.githubusercontent.com/ollama/ollama/2476d5ead197abe04629651028f83d48dc75d2b2/LICENSE \
    /opt/nemoclaw/source/ollama-LICENSE
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="ollama"
