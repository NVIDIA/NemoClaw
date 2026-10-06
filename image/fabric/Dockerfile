# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590
ARG PYTHON_IMAGE=python:3.13.15-slim-trixie@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285
ARG RUST_IMAGE=rust@sha256:ce84a5edd80c5f91e05c5533b1e53eb1da54028f33734dc06aa6b49fa190462d
ARG UV_IMAGE=ghcr.io/astral-sh/uv@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
FROM ${RUST_IMAGE} AS rust
FROM ${UV_IMAGE} AS uv
FROM ${OPENCLAW_IMAGE} AS openclaw-upstream
FROM ${NODE_IMAGE} AS node
# Only harnesses that run JavaScript copy this tree; the shared base has no Node.js.
RUN mkdir -p /node/usr/local/bin /node/usr/local/lib \
    && cp -a /usr/local/bin/node /node/usr/local/bin/ \
    && cp -a /usr/local/lib/node_modules /node/usr/local/lib/ \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /node/usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /node/usr/local/bin/npx

FROM ${PYTHON_IMAGE} AS base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 iproute2 nftables ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node \
    && python3 -m venv --without-pip /opt/fabric \
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
COPY image/fabric/fabric-error-codes.patch /build-patches/fabric-error-codes.patch
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev patch \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /src/fabric /wheels \
    && tar -xzf /sources/fabric.tar.gz -C /src/fabric --strip-components=1 \
    && patch --batch --fuzz=0 -d /src/fabric -p1 < /build-patches/fabric-error-codes.patch
# Archive extraction gives every Fabric revision the same paths and timestamps,
# so a shared Cargo target cache can link a newer binding against an older core.
# Share downloads only; compiled artifacts stay in this source-specific layer.
RUN --mount=type=cache,target=/root/.cache/uv --mount=type=cache,target=/usr/local/cargo/registry \
    uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels --config-setting build-args=--locked /src/fabric/sdk/python/nemo-fabric-runtime \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapter-contract/python \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapters/python/common

FROM common-wheels AS harness-wheels
ARG HARNESS
ARG ADAPTER
COPY image/fabric/ /build/
COPY image/NOTICE.md docker-bake.hcl .dockerignore /build/
RUN if [ "$ADAPTER" = openclaw ]; then \
        apt-get update && apt-get install -y --no-install-recommends patch \
        && rm -rf /var/lib/apt/lists/* \
        && patch --batch --fuzz=0 -d /src/fabric -p1 < /build/openclaw-reconfigure.patch \
        && cp /build/openclaw_configuration.py /src/fabric/adapters/python/openclaw/src/nemo_fabric_adapters/openclaw/configuration.py; \
    fi
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$ADAPTER" ]; then uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels "/src/fabric/adapters/python/$ADAPTER"; fi \
    && python3 /build/wheel_lock.py /wheels > /own-requirements.txt \
    && if [ "$HARNESS" = hermes ]; then cp /build/hermes-dependencies.lock /requirements.txt; \
       else uv export --project /src/fabric --frozen --no-default-groups --no-emit-local ${ADAPTER:+--extra=$ADAPTER} --output-file /requirements.txt; fi \
    && cat /own-requirements.txt >> /requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --find-links /wheels -r /requirements.txt \
    && python3 /build/provenance.py > /provenance.json

FROM base AS runtime-base
COPY --from=harness-wheels /opt/fabric /opt/fabric
COPY --from=harness-wheels /requirements.txt /opt/nemoclaw/source/requirements.txt
COPY --from=harness-wheels --chmod=0644 /sources/fabric.tar.gz /opt/nemoclaw/source/
COPY --from=harness-wheels /build /opt/nemoclaw/source/local/
COPY --from=harness-wheels /provenance.json /opt/nemoclaw/provenance.json
COPY image/fabric/backend.py image/fabric/fabric.py image/fabric/bridge_contract.py image/fabric/catalog.py image/fabric/runtime_metadata.py image/fabric/runtime.json /opt/nemoclaw/
COPY --chmod=0755 image/fabric/fabric-agent /usr/local/bin/fabric-agent
ENV PYTHONPATH=/opt/nemoclaw ADAPTER_PYTHON=/opt/fabric/bin/python
RUN /opt/fabric/bin/python /opt/nemoclaw/bridge_contract.py > /opt/nemoclaw/bridge.json

FROM runtime-base AS generic
USER node

FROM runtime-base AS interactive
COPY --from=node /node/ /
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*

FROM interactive AS openclaw
COPY --from=openclaw-upstream /app /app
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw
ADD --chown=node:node --checksum=sha256:2b403a4b2d2be7a793235a458e2d376f38588fd913f41b92e208e8421a2a1617 https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.9.4.tgz /tmp/brave.tgz
ADD --chown=node:node --checksum=sha256:9b250b5ed8660247947701c4df3fb8b1c6b32fd7e30b7a186c7ae763e30c29e8 https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.9.4.tgz /tmp/tavily.tgz
# catalog.py records this layout so planning checks explicit filesystem grants.
RUN printf '%s\n' '{"nvidia.fabric.openclaw": ["/app"]}' > /opt/nemoclaw/runtime-files.json
USER node
# Native installation owns extraction and peer dependencies; package its output
# in OpenClaw's bundled-plugin directory so each runtime discovers it naturally.
RUN --network=none OPENCLAW_STATE_DIR=/tmp/plugin-build OPENCLAW_CONFIG_PATH=/tmp/plugin-build/config.json \
    node /app/openclaw.mjs plugins install --force --accept-capabilities /tmp/brave.tgz \
    && OPENCLAW_STATE_DIR=/tmp/plugin-build OPENCLAW_CONFIG_PATH=/tmp/plugin-build/config.json \
    node /app/openclaw.mjs plugins install --force --accept-capabilities /tmp/tavily.tgz \
    && mv /tmp/plugin-build/extensions/brave /tmp/plugin-build/extensions/tavily /app/dist/extensions/ \
    && rm -rf /tmp/plugin-build /tmp/brave.tgz /tmp/tavily.tgz
COPY image/fabric/BRAVE-LICENSE /app/dist/extensions/brave/LICENSE
COPY image/fabric/BRAVE-NOTICE.md /app/dist/extensions/brave/NOTICE.md
COPY image/fabric/TAVILY-LICENSE /app/dist/extensions/tavily/LICENSE
COPY image/fabric/TAVILY-NOTICE.md /app/dist/extensions/tavily/NOTICE.md

FROM base AS hermes-assets
COPY --from=node /node/ /
ARG HERMES_REVISION=29112bef099274229cadff79cdff7bf7b99c4b77
ARG HERMES_SHA256=76b99a8be9b77d66833c3cfe2b35c6d6f6a58e4ff9637ef8effcfc1f420ab35a
ADD --checksum=sha256:${HERMES_SHA256} https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_REVISION} /sources/hermes.tar.gz
COPY --from=common-wheels /src/fabric/adapters/python/hermes/metadata-propagate.patch /sources/metadata-propagate.patch
COPY image/fabric/HERMES-NOTICE.md /sources/HERMES-NOTICE.md
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/hermes && tar -xzf /sources/hermes.tar.gz -C /opt/hermes --strip-components=1 \
    && patch --batch --fuzz=0 -d /opt/hermes -p1 < /sources/metadata-propagate.patch \
    && cp /sources/HERMES-NOTICE.md /opt/hermes/NEMOCLAW-NOTICE.md
RUN --mount=type=cache,target=/root/.npm \
    npm install --global npm@11.17.0 \
    && cd /opt/hermes/web && npm ci --ignore-scripts && npm run build \
    && cd /opt/hermes/ui-tui && npm ci --ignore-scripts && npm run build:ink && npm run build

FROM interactive AS hermes
COPY --from=hermes-assets /opt/hermes /opt/hermes
COPY --from=hermes-assets --chmod=0644 /sources/hermes.tar.gz /opt/nemoclaw/source/
# Hermes resolves bundled assets relative to its source checkout.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv pip install --python /opt/fabric/bin/python --offline --no-deps --no-build-isolation -e /opt/hermes --config-settings editable_mode=compat
COPY --from=common-wheels /src/fabric/adapters/python/hermes/src/nemo_fabric_adapters/hermes/plugins/tavily/ /opt/hermes/plugins/web/tavily/
ENV HERMES_DISABLE_LAZY_INSTALLS=1
RUN printf '%s\n' '{"nvidia.fabric.hermes": ["/opt/hermes"]}' > /opt/nemoclaw/runtime-files.json
USER node

FROM common-wheels AS pi-build
COPY --from=node /node/ /
RUN mkdir -p /opt/fabric-source/adapter-contract /opt/fabric-source/adapters \
    && cp -a /src/fabric/adapter-contract/typescript /opt/fabric-source/adapter-contract/ \
    && cp -a /src/fabric/adapters/typescript /opt/fabric-source/adapters/
RUN --mount=type=cache,target=/root/.npm \
    cd /opt/fabric-source/adapter-contract/typescript && npm ci --ignore-scripts --no-audit --no-fund && npm run build \
    && cd /opt/fabric-source/adapters/typescript \
    && npm ci --workspace nemo-fabric-adapters-pi --include-workspace-root --ignore-scripts --no-audit --no-fund \
    && npm run build --workspace nemo-fabric-adapters-common && npm run build --workspace nemo-fabric-adapters-pi

# Preserve npm ci's locked peer dependencies while installing only packed code.
RUN mkdir -p /opt/pi/adapters/typescript \
    && cp -a /opt/fabric-source/adapters/typescript/node_modules /opt/pi/adapters/typescript/ \
    && rm -f /opt/pi/adapters/typescript/node_modules/nemo-fabric-adapters-opencode \
    && for package in adapter-contract/typescript adapters/typescript/common adapters/typescript/pi; do \
        mkdir -p "/opt/pi/$package" \
        && (cd "/opt/fabric-source/$package" && npm pack --ignore-scripts --pack-destination "/opt/pi/$package") \
        && tar -xzf /opt/pi/$package/*.tgz -C "/opt/pi/$package" --strip-components=1 \
        && rm /opt/pi/$package/*.tgz || exit 1; \
    done

FROM runtime-base AS pi
COPY --from=node /node/ /
COPY --from=pi-build /opt/pi /opt/fabric-source
# Fabric discovery skips symlinked directories, so link only the descriptor.
# Its runner script resolves beside the real file under /opt/fabric-source.
RUN mkdir -p /opt/fabric/share/nemo-fabric/adapters/pi \
    && ln -s /opt/fabric-source/adapters/typescript/pi/pi.fabric-adapter.json \
        /opt/fabric/share/nemo-fabric/adapters/pi/pi.fabric-adapter.json \
    && printf '%s\n' '{"nvidia.fabric.pi": ["/opt/fabric-source"]}' > /opt/nemoclaw/runtime-files.json
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

# A small executable specification with no native agent or model dependencies.
FROM ${PYTHON_IMAGE} AS dummy
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node \
    && python3 -m venv --without-pip /opt/fabric \
    && install -d -m 0700 -o 1000 -g 1000 /sandbox
COPY image/fabric/fabric.py image/fabric/bridge_contract.py image/fabric/runtime.json /opt/nemoclaw/
COPY image/fabric/dummy_backend.py /opt/nemoclaw/backend.py
COPY --chmod=0755 image/fabric/fabric-agent /usr/local/bin/fabric-agent
ENV PYTHONPATH=/opt/nemoclaw ADAPTER_PYTHON=/opt/fabric/bin/python PYTHONDONTWRITEBYTECODE=1 HOME=/sandbox
RUN /opt/fabric/bin/python /opt/nemoclaw/bridge_contract.py > /opt/nemoclaw/bridge.json
LABEL io.nemoclaw.fabric.reference="dummy"
USER node
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/fabric-agent"]
CMD ["serve", "--agent", "main"]

FROM dummy AS reference-tests
COPY image/fabric/test_reference.py image/fabric/dummy_backend.py /tests/
RUN --network=none /opt/fabric/bin/python -B -m unittest discover -s /tests -p 'test_*.py'
