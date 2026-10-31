# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG BUN_IMAGE=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG PYTHON_IMAGE=python:3.14.9-slim-trixie@sha256:b347e2dcbc7f0b6f9fb7182e9da6a187fb10ae715e0692518c1aed0eec94a700
ARG RUST_IMAGE=rust:1.99.1-slim-trixie@sha256:aab42391a986424e22d6a3ec14f37bc6dd3dacff4d457ca7cccd781e02297cc6
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0
# The Fabric source every harness installs; the reference dummy's descriptor
# follows the adapter contract at the same revision.
ARG FABRIC_REVISION=e7913b6c473a15095a1b4c3583a127e558e0c124
ARG FABRIC_SHA256=454edb1f7d9f34f0e6541a13c550cefe317c40ad5e291c67da76b29e667d8cf4
# OpenClaw release 2026.9.34, the only version the pinned Fabric's OpenClaw
# adapter supports; move it with the Fabric revision, not on its own.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:70e88573161a9248cfe992c069f638085ac066278e03f11a46bcbd115f38e3fc
# Hermes Agent's release image for HERMES_REVISION; only its built dashboard
# and TUI bundle are copied. Move it with HERMES_REVISION, not on its own.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.22.5@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d
# The harness stage the catalog and labeled stages build on.
ARG STAGE=generic
FROM ${RUST_IMAGE} AS rust
FROM ${UV_IMAGE} AS uv
FROM ${OPENCLAW_IMAGE} AS openclaw-upstream
FROM ${HERMES_IMAGE} AS hermes-upstream
FROM ${BUN_IMAGE} AS bun
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
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/sdk/python/nemo-fabric-evidence \
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
    && sh /build/inputs.sh lock /wheels > /own-requirements.txt \
    && uv export --project /src/fabric --frozen --no-default-groups --no-emit-local ${EXTRA:+--extra=$EXTRA} --output-file /requirements.txt \
    && cat /own-requirements.txt >> /requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --find-links /wheels -r /requirements.txt \
    && sh /build/inputs.sh provenance /build > /provenance.json

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
# Hermes Agent release v0.22.5, which includes its native Relay integration.
ARG HERMES_REVISION=bf0203a794a07aac3ff764972ab9087baa4e4f4e
ARG HERMES_SHA256=0dc2cca54657d162845a77f634e107c61c3fb0bd6c8505212aa2e200591b7cc9
ADD --checksum=sha256:${HERMES_SHA256} https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_REVISION} /sources/hermes.tar.gz
COPY image/fabric/HERMES-NOTICE.md /sources/HERMES-NOTICE.md
RUN mkdir -p /opt/hermes && tar -xzf /sources/hermes.tar.gz -C /opt/hermes --strip-components=1 \
    && cp /sources/HERMES-NOTICE.md /opt/hermes/NEMOCLAW-NOTICE.md
# Hermes's dashboard and browser chat need its built web assets and TUI bundle,
# which Hermes's release image builds from the same release. The build stops if
# any file that image shares with the pinned source differs, apart from the
# README.md its build empties. Hermes looks for both at these paths at runtime.
RUN --mount=type=bind,from=hermes-upstream,source=/opt/hermes,target=/upstream \
    status=0; diff -rq --no-dereference /opt/hermes /upstream > /tmp/upstream.diff || status=$?; \
    [ "$status" -le 1 ] \
    && ! grep -v -e '^Only in ' -e '^Files /opt/hermes/README.md and /upstream/README.md differ$' /tmp/upstream.diff \
    && cp -R /upstream/hermes_cli/web_dist /upstream/hermes_cli/tui_dist /opt/hermes/hermes_cli/ \
    && rm /tmp/upstream.diff

FROM base AS switchyard-assets
ARG TARGETARCH
ARG SWITCHYARD_PLUGIN_VERSION=0.3.1
ARG SWITCHYARD_PLUGIN_AMD64_SHA256=c3f46807d96deb1c057357a676f92be0f751f92d67571d3aa85240e78cfbd36a
ARG SWITCHYARD_PLUGIN_ARM64_SHA256=e55023684543d1cdbfe127af5328481c436f730cc0b5e4d3ca283f4226696b73
ADD --checksum=sha256:${SWITCHYARD_PLUGIN_AMD64_SHA256} https://github.com/NVIDIA/NeMo-Relay-Plugins/releases/download/switchyard-plugin-${SWITCHYARD_PLUGIN_VERSION}/switchyard-plugin-${SWITCHYARD_PLUGIN_VERSION}-linux-x86_64.tar.gz /sources/switchyard-amd64.tar.gz
ADD --checksum=sha256:${SWITCHYARD_PLUGIN_ARM64_SHA256} https://github.com/NVIDIA/NeMo-Relay-Plugins/releases/download/switchyard-plugin-${SWITCHYARD_PLUGIN_VERSION}/switchyard-plugin-${SWITCHYARD_PLUGIN_VERSION}-linux-arm64.tar.gz /sources/switchyard-arm64.tar.gz
RUN case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac \
    && mkdir -p /opt/nemo-relay/plugins/switchyard \
    && tar -xzf "/sources/switchyard-${TARGETARCH}.tar.gz" \
        -C /opt/nemo-relay/plugins/switchyard --strip-components=1

FROM interactive AS hermes
COPY --from=hermes-assets /opt/hermes /opt/hermes
COPY --from=hermes-assets --chmod=0644 /sources/hermes.tar.gz /opt/nemoclaw/source/
COPY --from=switchyard-assets /opt/nemo-relay /opt/nemo-relay
# Hermes owns its dependencies: its own lock, with the mcp extra, settles the
# packages it shares with Fabric, as Fabric installs into Hermes's environment.
# From the messaging extra, only aiohttp, which Hermes's API server needs, is
# installed; the messaging platform clients are pruned.
# Hermes's lock overrides some dependencies' requirements, such as
# browser-harness's Pillow pin, so the exported closure is installed without
# re-resolving it, and Hermes's own pm.pip_check accepts exactly the dependency
# check failures those overrides cause, as Hermes's installer does.
# Hermes resolves bundled assets relative to its source checkout.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv --mount=type=cache,target=/root/.cache/uv \
    uv export --project /opt/hermes --frozen --no-dev --extra mcp --extra messaging \
        --prune discord-py --prune python-telegram-bot --prune slack-bolt --prune slack-sdk --prune qrcode --prune brotlicffi \
        --no-emit-project --format requirements-txt --output-file /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --no-deps -r /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --no-deps -e /opt/hermes --config-settings editable_mode=compat \
    && if ! uv pip check --python /opt/fabric/bin/python > /tmp/pip-check.txt 2>&1; then \
        PYTHONPATH=/opt/hermes python3 -c 'import sys; from pathlib import Path; from pm.pip_check import unexpected_incompatibilities; sys.exit(unexpected_incompatibilities(sys.stdin.read(), Path("/opt/hermes/uv.lock")) != [])' \
            < /tmp/pip-check.txt || { cat /tmp/pip-check.txt; exit 1; }; \
    fi \
    && rm /tmp/pip-check.txt
ENV HERMES_DISABLE_LAZY_INSTALLS=1
# Hermes's dashboard and browser chat use these prebuilt assets and this Node.js
# instead of building or installing their own, which the read-only, offline
# sandbox would refuse.
ENV HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist HERMES_NODE=/usr/local/bin/node
# Browser chat runs Hermes's terminal UI in a pseudo-terminal, so this image's
# default policy lets the agent open one; catalog.py adds read_write to it.
RUN printf '%s\n' '{"nvidia.fabric.hermes": {"files": ["/opt/hermes", "/opt/nemo-relay/plugins/switchyard"], "binaries": [], "read_write": ["/dev/pts", "/dev/ptmx"]}}' > /opt/nemoclaw/adapters.json
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

FROM common-wheels AS opencode-build
COPY --from=node /node/ /
RUN mkdir -p /opt/fabric-source/adapter-contract /opt/fabric-source/adapters \
    && cp -a /src/fabric/adapter-contract/typescript /opt/fabric-source/adapter-contract/ \
    && cp -a /src/fabric/adapters/typescript /opt/fabric-source/adapters/
RUN --mount=type=cache,target=/root/.npm \
    cd /opt/fabric-source/adapter-contract/typescript && npm ci --ignore-scripts --no-audit --no-fund && npm run build \
    && cd /opt/fabric-source/adapters/typescript \
    && npm ci --workspace nemo-fabric-adapters-opencode --include-workspace-root --ignore-scripts --no-audit --no-fund \
    && npm run build --workspace nemo-fabric-adapters-common && npm run build --workspace nemo-fabric-adapters-opencode

# Keep the packed adapter and the OpenCode packages Fabric's lock pins for it.
RUN mkdir -p /opt/opencode/adapters/typescript \
    && cp -a /opt/fabric-source/adapters/typescript/node_modules /opt/opencode/adapters/typescript/ \
    && rm -f /opt/opencode/adapters/typescript/node_modules/nemo-fabric-adapters-pi \
    && for package in adapter-contract/typescript adapters/typescript/common adapters/typescript/opencode; do \
        mkdir -p "/opt/opencode/$package" \
        && (cd "/opt/fabric-source/$package" && npm pack --ignore-scripts --pack-destination "/opt/opencode/$package") \
        && tar -xzf /opt/opencode/$package/*.tgz -C "/opt/opencode/$package" --strip-components=1 \
        && rm /opt/opencode/$package/*.tgz || exit 1; \
    done

# Fabric's OpenCode adapter runs on Bun, so this image carries Bun instead of Node.js.
FROM runtime-base AS opencode
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=opencode-build /opt/opencode /opt/fabric-source
# Fabric discovery skips symlinked directories, so link only the descriptor.
RUN mkdir -p /opt/fabric/share/nemo-fabric/adapters/opencode \
    && ln -s /opt/fabric-source/adapters/typescript/opencode/opencode.fabric-adapter.json \
        /opt/fabric/share/nemo-fabric/adapters/opencode/opencode.fabric-adapter.json \
    && printf '%s\n' '{"nvidia.fabric.opencode": {"files": ["/opt/fabric-source"], "binaries": ["bun"]}}' > /opt/nemoclaw/adapters.json
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
RUN uv pip install --python /opt/fabric/bin/python /wheels/nemo_fabric_runtime-*.whl /wheels/nemo_fabric_evidence-*.whl /wheels/nemo_fabric_adapter_contract-*.whl /wheels/nemo_fabric_adapters_common-*.whl /wheels/nemo_fabric_adapter_catalog-*.whl \
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
