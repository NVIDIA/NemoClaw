# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM vllm/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2
COPY nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY supervisor-source.tar.gz supervisor.json LICENSE /opt/nemoclaw/source/
COPY NOTICE.md /opt/nemoclaw/source/NOTICE.md
COPY Dockerfile build.json /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.backend="vllm" \
      org.nemoclaw.recipe.protocol="v1"
