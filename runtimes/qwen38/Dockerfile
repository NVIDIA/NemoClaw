# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e
ARG SOURCE_DATE_EPOCH=1788974180
COPY recipe.tar.gz /opt/nemoclaw/source/recipe.tar.gz
RUN mkdir /opt/nemoclaw/source/recipe && tar -xzf /opt/nemoclaw/source/recipe.tar.gz -C /opt/nemoclaw/source/recipe --strip-components=1
COPY apply_patches.py pins.json NOTICE.md AGPL-3.0-or-later.txt /opt/nemoclaw/source/
COPY verify_packed.py /opt/nemoclaw/source/verify_packed.py
COPY model.json /opt/nemoclaw/model.json
COPY LICENSE /opt/nemoclaw/source/Apache-2.0.txt
RUN SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH python3 /opt/nemoclaw/source/apply_patches.py
COPY --chmod=755 prepare.py verify.py /opt/nemoclaw/recipe/
COPY nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY supervisor-source.tar.gz supervisor.json /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="vllm" \
      org.nemoclaw.recipe.protocol="v1" \
      org.nemoclaw.feature.ple="1" \
      org.nemoclaw.recipe="d03809008834124e80223c3482f2ddb59577a48f" \
      org.nemoclaw.model="925d7be6c14c6c9442ef83e8f05b5a3c39304f69"
