# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590
ARG PYTHON_IMAGE=python:3.14.7-slim-trixie@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6
ARG RUST_IMAGE=rust@sha256:ce84a5edd80c5f91e05c5533b1e53eb1da54028f33734dc06aa6b49fa190462d
ARG UV_IMAGE=ghcr.io/astral-sh/uv@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
FROM ${RUST_IMAGE} AS rust
FROM ${UV_IMAGE} AS uv
FROM ${OPENCLAW_IMAGE} AS openclaw-upstream
FROM ${NODE_IMAGE} AS node

FROM ${PYTHON_IMAGE} AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 iproute2 nftables ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node \
    && python3 -m venv /opt/fabric \
    && install -d -m 0700 -o 1000 -g 1000 /sandbox
ENV PYTHONDONTWRITEBYTECODE=1
HEALTHCHECK NONE

# All toolchains and native compilation stay in builder stages.
FROM base AS common-wheels
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=uv /uv /usr/local/bin/uv
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
ARG SOURCE_DATE_EPOCH=1789516800
ARG FABRIC_REVISION=24f068c895e5cbc30286bc743498be4e5014d658
ARG FABRIC_SHA256=77f78f66a24a8cd8e6f33f9cf49f3db8c5de39e12e095f5599cb63909a05865f
ADD --checksum=sha256:${FABRIC_SHA256} https://codeload.github.com/NVIDIA/NeMo-Fabric/tar.gz/${FABRIC_REVISION} /sources/fabric.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /src/fabric /wheels \
    && tar -xzf /sources/fabric.tar.gz -C /src/fabric --strip-components=1
RUN --mount=type=cache,target=/root/.cache/uv --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/fabric/target \
    uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels --config-setting build-args=--locked /src/fabric/sdk/python/nemo-fabric-runtime \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapter-contract/python \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapters/python/common

FROM common-wheels AS harness-wheels
ARG HARNESS
ARG ADAPTER
ARG LOCKFILE
COPY image/fabric/ /build/
COPY image/NOTICE.md docker-bake.hcl .dockerignore /build/
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$ADAPTER" ]; then uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels "/src/fabric/adapters/python/$ADAPTER"; fi \
    && python3 /build/wheel_lock.py /wheels > /own-requirements.txt \
    && cat "/build/$LOCKFILE" /own-requirements.txt > /requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --find-links /wheels -r /requirements.txt \
    && python3 /build/provenance.py > /provenance.json

FROM base AS runtime-base
COPY --from=harness-wheels /opt/fabric /opt/fabric
COPY --from=harness-wheels /requirements.txt /opt/nemoclaw/source/requirements.txt
COPY --from=harness-wheels --chmod=0644 /sources/fabric.tar.gz /opt/nemoclaw/source/
COPY --from=harness-wheels /build /opt/nemoclaw/source/local/
COPY --from=harness-wheels /provenance.json /opt/nemoclaw/provenance.json
COPY image/fabric/fabric.py image/fabric/health.py image/fabric/catalog.py /opt/nemoclaw/
ENV PYTHONPATH=/opt/nemoclaw ADAPTER_PYTHON=/opt/fabric/bin/python

FROM runtime-base AS generic
USER node

FROM runtime-base AS interactive
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*

FROM interactive AS openclaw
COPY --from=openclaw-upstream /app /app
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw
ADD --checksum=sha256:2b403a4b2d2be7a793235a458e2d376f38588fd913f41b92e208e8421a2a1617 https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.9.4.tgz /tmp/brave.tgz
RUN mkdir -p /opt/nemoclaw/plugins/brave/node_modules \
    && tar -xzf /tmp/brave.tgz -C /opt/nemoclaw/plugins/brave --strip-components=1 \
    && ln -s /app /opt/nemoclaw/plugins/brave/node_modules/openclaw && rm /tmp/brave.tgz
COPY image/fabric/BRAVE-LICENSE /opt/nemoclaw/plugins/brave/LICENSE
COPY image/fabric/BRAVE-NOTICE.md /opt/nemoclaw/plugins/brave/NOTICE.md
ADD --checksum=sha256:9b250b5ed8660247947701c4df3fb8b1c6b32fd7e30b7a186c7ae763e30c29e8 https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.9.4.tgz /tmp/tavily.tgz
RUN mkdir -p /opt/nemoclaw/plugins/tavily/node_modules \
    && tar -xzf /tmp/tavily.tgz -C /opt/nemoclaw/plugins/tavily --strip-components=1 \
    && ln -s /app /opt/nemoclaw/plugins/tavily/node_modules/openclaw && rm /tmp/tavily.tgz
COPY image/fabric/TAVILY-LICENSE /opt/nemoclaw/plugins/tavily/LICENSE
COPY image/fabric/TAVILY-NOTICE.md /opt/nemoclaw/plugins/tavily/NOTICE.md
USER node

FROM base AS hermes-assets
ARG HERMES_REVISION=29112bef099274229cadff79cdff7bf7b99c4b77
ARG HERMES_SHA256=76b99a8be9b77d66833c3cfe2b35c6d6f6a58e4ff9637ef8effcfc1f420ab35a
ADD --checksum=sha256:${HERMES_SHA256} https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_REVISION} /sources/hermes.tar.gz
RUN mkdir -p /opt/hermes && tar -xzf /sources/hermes.tar.gz -C /opt/hermes --strip-components=1
RUN --mount=type=cache,target=/root/.npm \
    npm install --global npm@11.17.0 \
    && cd /opt/hermes/web && npm ci --ignore-scripts && npm run build \
    && cd /opt/hermes/ui-tui && npm ci --ignore-scripts && npm run build:ink && npm run build

FROM interactive AS hermes
COPY --from=hermes-assets /opt/hermes /opt/hermes
COPY --from=hermes-assets --chmod=0644 /sources/hermes.tar.gz /opt/nemoclaw/source/
# Hermes resolves bundled assets relative to its source checkout.
RUN /opt/fabric/bin/pip install --no-index --no-deps --no-build-isolation -e /opt/hermes --config-settings editable_mode=compat
COPY --from=common-wheels /src/fabric/adapters/python/hermes/src/nemo_fabric_adapters/hermes/plugins/tavily/ /opt/hermes/plugins/web/tavily/
ENV HERMES_DISABLE_LAZY_INSTALLS=1
USER node

FROM common-wheels AS pi-build
RUN mkdir -p /opt/fabric-source/adapter-contract /opt/fabric-source/adapters \
    && cp -a /src/fabric/adapter-contract/typescript /opt/fabric-source/adapter-contract/ \
    && cp -a /src/fabric/adapters/typescript /opt/fabric-source/adapters/
RUN --mount=type=cache,target=/root/.npm \
    cd /opt/fabric-source/adapter-contract/typescript && npm ci --no-audit --no-fund && npm run build \
    && cd /opt/fabric-source/adapters/typescript && npm ci --no-audit --no-fund && npm run build
RUN --network=none node --test /opt/fabric-source/adapters/typescript/pi/test/pi-sdk.test.mjs \
        /opt/fabric-source/adapters/typescript/pi/test/runtime.test.mjs

FROM runtime-base AS pi
COPY --from=pi-build /opt/fabric-source /opt/fabric-source
RUN mkdir -p /opt/fabric/share/nemo-fabric/adapters \
    && ln -s /opt/fabric-source/adapters/typescript/pi /opt/fabric/share/nemo-fabric/adapters/pi
USER node

FROM base AS lint
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /repo/image
COPY ruff.toml /repo/
COPY image/ /repo/image/
RUN --mount=type=cache,target=/root/.cache/uv uv tool run --from ruff==0.16.7 ruff check /repo \
    && uv tool run --from ruff==0.16.7 ruff format --check /repo

FROM common-wheels AS unit-tests
COPY image/fabric/ /catalog/image/fabric/
RUN uv pip install --python /opt/fabric/bin/python /wheels/nemo_fabric_runtime-*.whl /wheels/nemo_fabric_adapter_contract-*.whl /wheels/nemo_fabric_adapters_common-*.whl /src/fabric/tests/fixtures/discovery \
    && uv pip install --python /opt/fabric/bin/python PyYAML==6.0.3
COPY image/fabric/ /tests/
ENV ADAPTER_PYTHON=/opt/fabric/bin/python NEMOCLAW_FABRIC_SOURCE=/src/fabric NEMOCLAW_TEST_FABRIC_DESCRIPTOR=/src/fabric/tests/fixtures/discovery/future.fabric-adapter.json
RUN --network=none /opt/fabric/bin/python -B -m unittest discover -s /tests -p 'test_*.py'
