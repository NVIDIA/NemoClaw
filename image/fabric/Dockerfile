# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG NODE_IMAGE=node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG PYTHON_IMAGE=python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f
ARG RUST_IMAGE=rust:1.99.1-slim-trixie@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.3@sha256:bee0a2a458fd956c5df7b8b4c5fed2257b0af34866e3da7b51db0be3acb375d1
# The Fabric source every harness installs; the reference dummy's descriptor
# follows the adapter contract at the same revision.
ARG FABRIC_REVISION=5574117feb4be948c1b03f4c36a2fe9a11af910d
ARG FABRIC_SHA256=b1a7f2759ea26fd3dcf8136be30045897fa5d7c38a7b96e81afaecdde798e523
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
# The harness stage the catalog and labeled stages build on.
ARG STAGE=generic
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
# Agents run as 10001:10001, the UID OpenShell's Kubernetes driver uses for
# sandboxes; Docker and Podman use the image's own user, so one image fits all.
# OpenShift instead runs sandboxes as the namespace's UID, which must be able
# to read /sandbox: OpenShell copies it to a private workspace volume.
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 iproute2 nftables ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 node && useradd --uid 10001 --gid node --create-home node \
    && python3 -m venv --without-pip /opt/fabric \
    && install -d -m 0755 -o 10001 -g 10001 /sandbox /sandbox/tmp
ENV PYTHONDONTWRITEBYTECODE=1
HEALTHCHECK NONE

# All toolchains and native compilation stay in builder stages.
FROM base AS common-wheels
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=uv /uv /usr/local/bin/uv
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
ARG SOURCE_DATE_EPOCH=1789516800
ARG FABRIC_REVISION
ARG FABRIC_SHA256
ADD --checksum=sha256:${FABRIC_SHA256} https://codeload.github.com/NVIDIA/NeMo-Fabric/tar.gz/${FABRIC_REVISION} /sources/fabric.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /src/fabric /wheels \
    && tar -xzf /sources/fabric.tar.gz -C /src/fabric --strip-components=1
# Archive extraction gives every Fabric revision the same paths and timestamps,
# so a shared Cargo target cache can link a newer binding against an older core.
# Share downloads only; compiled artifacts stay in this source-specific layer.
RUN --mount=type=cache,target=/root/.cache/uv --mount=type=cache,target=/usr/local/cargo/registry \
    uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels --config-setting build-args=--locked /src/fabric/sdk/python/nemo-fabric-runtime \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapter-contract/python \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapters/python/common \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/sdk/python/nemo-fabric-adapter-catalog

FROM common-wheels AS harness-wheels
ARG HARNESS
ARG ADAPTER
ARG EXTRA
COPY image/fabric/ /build/
COPY image/NOTICE.md docker-bake.hcl .dockerignore /build/
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$ADAPTER" ]; then uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels "/src/fabric/adapters/python/$ADAPTER"; fi \
    && python3 /build/wheel_lock.py /wheels > /own-requirements.txt \
    && uv export --project /src/fabric --frozen --no-default-groups --no-emit-local ${EXTRA:+--extra=$EXTRA} --output-file /requirements.txt \
    && cat /own-requirements.txt >> /requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --find-links /wheels -r /requirements.txt \
    && python3 /build/provenance.py > /provenance.json

FROM base AS runtime-base
COPY --from=harness-wheels /opt/fabric /opt/fabric
COPY --from=harness-wheels /requirements.txt /opt/nemoclaw/source/requirements.txt
COPY --from=harness-wheels --chmod=0644 /sources/fabric.tar.gz /opt/nemoclaw/source/
COPY --from=harness-wheels /build /opt/nemoclaw/source/local/
COPY --from=harness-wheels /provenance.json /opt/nemoclaw/provenance.json
COPY image/fabric/catalog.py image/fabric/runtime_metadata.py image/fabric/runtime.json /opt/nemoclaw/
# Commands run in the sandbox, such as through openshell sandbox exec, find
# Fabric's sandbox host on the default PATH.
RUN ln -s /opt/fabric/bin/fabric-agent-ctl /usr/local/bin/fabric-agent-ctl
# Fabric runs Python adapters with this interpreter.
ENV ADAPTER_PYTHON=/opt/fabric/bin/python

FROM runtime-base AS generic
ARG ADAPTER_ID
# catalog.py publishes the adapters each harness stage declares here.
RUN test -n "$ADAPTER_ID" \
    && printf '{"%s": {"files": [], "binaries": []}}\n' "$ADAPTER_ID" > /opt/nemoclaw/adapters.json
USER node

FROM runtime-base AS interactive
COPY --from=node /node/ /
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*

FROM interactive AS openclaw
# Upstream owns /app as its own user; the sandbox only reads it.
COPY --from=openclaw-upstream --chown=0:0 /app /app
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw
# catalog.py publishes this declaration: the files the adapter reads, which
# explicit filesystem grants must allow, and the executables it runs.
RUN printf '%s\n' '{"nvidia.fabric.openclaw": {"files": ["/app"], "binaries": ["node"]}}' > /opt/nemoclaw/adapters.json
USER node

FROM base AS hermes-assets
# Hermes Agent release v2026.9.24, which Fabric documents for ordinary runs.
ARG HERMES_REVISION=f97608f178d1ffeca59860195ab7da295f7c8e5f
ARG HERMES_SHA256=babbdb9706ad1c96708d75914afb45d809cd4b73dec1ceae233a6814f5ed97e3
ADD --checksum=sha256:${HERMES_SHA256} https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_REVISION} /sources/hermes.tar.gz
COPY image/fabric/HERMES-NOTICE.md /sources/HERMES-NOTICE.md
RUN mkdir -p /opt/hermes && tar -xzf /sources/hermes.tar.gz -C /opt/hermes --strip-components=1 \
    && cp /sources/HERMES-NOTICE.md /opt/hermes/NEMOCLAW-NOTICE.md

FROM interactive AS hermes
COPY --from=hermes-assets /opt/hermes /opt/hermes
COPY --from=hermes-assets --chmod=0644 /sources/hermes.tar.gz /opt/nemoclaw/source/
# Hermes owns its dependencies: its own lock, with the mcp extra, settles the
# packages it shares with Fabric, as Fabric installs into Hermes's environment.
# Hermes resolves bundled assets relative to its source checkout.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv --mount=type=cache,target=/root/.cache/uv \
    uv export --project /opt/hermes --frozen --no-dev --extra mcp --no-emit-project --format requirements-txt --output-file /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes -r /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --no-deps -e /opt/hermes --config-settings editable_mode=compat \
    && uv pip check --python /opt/fabric/bin/python
ENV HERMES_DISABLE_LAZY_INSTALLS=1
RUN printf '%s\n' '{"nvidia.fabric.hermes": {"files": ["/opt/hermes"], "binaries": []}}' > /opt/nemoclaw/adapters.json
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
    done \
    # npm nests the Pi harness Fabric's lock pins (pi-coding-agent) under the
    # adapter package, which packing drops; keep it beside the packed adapter.
    && cp -a /opt/fabric-source/adapters/typescript/pi/node_modules /opt/pi/adapters/typescript/pi/

FROM runtime-base AS pi
COPY --from=node /node/ /
COPY --from=pi-build /opt/pi /opt/fabric-source
# Fabric discovery skips symlinked directories, so link only the descriptor.
# Its runner script resolves beside the real file under /opt/fabric-source.
RUN mkdir -p /opt/fabric/share/nemo-fabric/adapters/pi \
    && ln -s /opt/fabric-source/adapters/typescript/pi/pi.fabric-adapter.json \
        /opt/fabric/share/nemo-fabric/adapters/pi/pi.fabric-adapter.json \
    && printf '%s\n' '{"nvidia.fabric.pi": {"files": ["/opt/fabric-source"], "binaries": ["node"]}}' > /opt/nemoclaw/adapters.json
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
RUN uv pip install --python /opt/fabric/bin/python /wheels/nemo_fabric_runtime-*.whl /wheels/nemo_fabric_adapter_contract-*.whl /wheels/nemo_fabric_adapters_common-*.whl /wheels/nemo_fabric_adapter_catalog-*.whl \
    && uv pip install --python /opt/fabric/bin/python PyYAML==6.0.3
COPY image/fabric/ /tests/
RUN --network=none /opt/fabric/bin/python -B -m unittest discover -s /tests -p 'test_*.py'

# NemoClaw's test-only adapter, packaged and installed like Fabric's own.
FROM harness-wheels AS dummy-wheels
COPY image/fabric/test-adapter /src/test-adapter
RUN --mount=type=cache,target=/root/.cache/uv \
    uv build --python /usr/local/bin/python3 --wheel --out-dir /test-wheels /src/test-adapter \
    && uv pip install --python /opt/fabric/bin/python --no-deps /test-wheels/*.whl

# The reference agent: Fabric's runtime and fabric-agent-ctl, with only
# NemoClaw's test adapter, which needs no model or native harness.
FROM runtime-base AS dummy
COPY --from=dummy-wheels /opt/fabric /opt/fabric
RUN printf '%s\n' '{"org.nemoclaw.dummy": {"files": [], "binaries": [], "descriptor": "/opt/fabric/share/nemo-fabric/adapters/nemoclaw-dummy/dummy.fabric-adapter.json"}}' > /opt/nemoclaw/adapters.json
LABEL io.nemoclaw.fabric.reference="dummy"
USER node

FROM dummy AS reference-tests
COPY image/fabric/test_reference.py /tests/
ENV NEMOCLAW_REFERENCE_TESTS=1
RUN --network=none /opt/fabric/bin/python -B -m unittest discover -s /tests -p 'test_*.py'

# Plan reads an agent image's installed catalog from its
# io.nemoclaw.fabric.catalog label, which only the built image can produce.
# `cargo images build` exports it from `catalog`, then builds `labeled` with
# it as CATALOG; both reuse the harness stage's cache.
FROM ${STAGE} AS catalog-build
RUN --network=none /opt/fabric/bin/python /opt/nemoclaw/catalog.py --installed \
    --provenance /opt/nemoclaw/provenance.json --output /tmp/catalog.json

FROM scratch AS catalog
COPY --from=catalog-build /tmp/catalog.json /catalog.json

FROM ${STAGE} AS labeled
ARG CATALOG
# The label must be the catalog this image installs.
RUN --network=none --mount=type=bind,from=catalog-build,source=/tmp/catalog.json,target=/tmp/catalog.json \
    /opt/fabric/bin/python - <<'EOF'
import json, os, sys
try:
    labeled = json.loads(os.environ.get("CATALOG", ""))
except ValueError:
    labeled = None
if labeled != json.load(open("/tmp/catalog.json")):
    sys.exit("CATALOG must be this image's installed catalog; build with cargo images build")
EOF
LABEL io.nemoclaw.fabric.catalog=${CATALOG}
