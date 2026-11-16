# syntax=docker/dockerfile:1.7
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Extends the OpenClaw agent image with what the Agent Knowledge Foundation
# examples' agents run: Python 3.12 with their CPU libraries, as python3.12,
# and the examples' agent skills in /opt/akf/skills. Build it from a checkout
# of the examples repository, passed as the `akf` build context; see README.md.
# The sandbox's python3 is Fabric's own environment, so the examples' Python
# goes beside it rather than into it.

ARG BASE_IMAGE=nc-fabric:openclaw
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.8@sha256:5cc1805e2426484abca4ad46ea783bab281fdb225fd82d8ce6d66a81254bac85

FROM ${UV_IMAGE} AS uv

FROM ${BASE_IMAGE}
USER root
# The examples' own requirements: pandas, NumPy, NetworkX, scikit-learn,
# pydantic and the Kumo client from the market example, plus SciPy and
# requests, which the supply-chain example's CPU controls use.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    --mount=from=akf,source=examples/market-analysis/utilities/requirements.txt,target=/tmp/akf-requirements.txt \
    UV_PYTHON_INSTALL_DIR=/opt/akf/python UV_NO_CACHE=1 uv venv --python 3.12 /opt/akf/venv \
    && UV_NO_CACHE=1 uv pip install --python /opt/akf/venv/bin/python \
        -r /tmp/akf-requirements.txt 'scipy>=1.14' 'requests>=2.32' \
    # A symlink would hide the venv from Python, which looks for it beside the
    # path it was started as.
    && printf '#!/bin/sh\nexec /opt/akf/venv/bin/python3.12 "$@"\n' > /usr/local/bin/python3.12 \
    && chmod 755 /usr/local/bin/python3.12
COPY --from=akf --chown=root:root .agents/skills /opt/akf/skills
COPY --from=akf --chown=root:root skills.lock.json /opt/akf/skills.lock.json
USER 10001:10001
