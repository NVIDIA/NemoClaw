# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Move bun-LICENSE.md in versions.json to the release's commit with Bun.
ARG BUN_IMAGE=oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5
ARG PYTHON_IMAGE=python:3.14.10-slim-trixie@sha256:22eafb370920ad8b429e0aec3fff433e0669968519f5d60469d83729c138b28b
ARG RUST_IMAGE=rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.10@sha256:a3ea1357342c1a4bf9a0c53a3deb1b55379aefa037338d8113d5771efa01774f
# The remote sources this image copies, such as the Fabric source every harness
# installs, are pinned under imageSources.fabric in versions.json; Bake passes
# them as the sources context, which `cargo images fetch` fills.
# OpenClaw release 2026.9.34, the only version the pinned Fabric's OpenClaw
# adapter supports; move it with the Fabric revision, not on its own, and move
# openclaw-LICENSE in versions.json to the release's commit with it.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:70e88573161a9248cfe992c069f638085ac066278e03f11a46bcbd115f38e3fc
# Hermes Agent's release image for the pinned Hermes source; only its built
# dashboard and TUI bundle are copied. Move it with that source, not on its own.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.22.7@sha256:e6d81ae52ebf6a43efa529701405509f20054ba818f179ddd748bed4f8af584c
# The harness stage the catalog and labeled stages build on.
ARG STAGE=generic
FROM ${RUST_IMAGE} AS rust
FROM ${UV_IMAGE} AS uv
FROM ${OPENCLAW_IMAGE} AS openclaw-upstream
FROM ${HERMES_IMAGE} AS hermes-upstream
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS node
# Only harnesses that run JavaScript copy this tree; the shared base has no Node.js.
# Node.js's license carries the notices of the libraries its executable bundles.
RUN mkdir -p /node/usr/local/bin /node/usr/local/lib /node/usr/local/share/doc/node \
    && cp -a /usr/local/bin/node /node/usr/local/bin/ \
    && cp /usr/local/LICENSE /node/usr/local/share/doc/node/LICENSE \
    && cp -a /usr/local/lib/node_modules /node/usr/local/lib/ \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /node/usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /node/usr/local/bin/npx

FROM ${PYTHON_IMAGE} AS base
USER root
# Agents run as 10001:10001, the UID OpenShell's Kubernetes driver uses for
# sandboxes; Docker and Podman use the image's own user, so one image fits all.
# OpenShift instead runs sandboxes as the namespace's UID, which must be able
# to read /sandbox: OpenShell copies it to a private workspace volume.
# Node.js, which the JavaScript harnesses copy in, links libstdc++ and libatomic.
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 iproute2 nftables ca-certificates \
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
# The reference dummy's descriptor follows the adapter contract at this revision.
COPY --from=sources /fabric.tar.gz /sources/fabric.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /src/fabric /wheels \
    && install -m 0644 "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" /sources/rust-COPYRIGHT-library.html \
    && tar -xzf /sources/fabric.tar.gz -C /src/fabric --strip-components=1
# Retain Cargo's exact locked source closure beside the original Fabric archive.
# The relative vendor configuration also makes the native wheel use those files.
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    cd /src/fabric \
    && mkdir -p .cargo \
    && cargo vendor --locked --versioned-dirs vendor > .cargo/config.toml \
    && tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
        -I 'gzip -n' -cf /sources/fabric-vendor.tar.gz vendor .cargo
# Archive extraction gives every Fabric revision the same paths and timestamps,
# so a shared Cargo target cache can link a newer binding against an older core.
# Share downloads only; compiled artifacts stay in this source-specific layer.
RUN --mount=type=cache,target=/root/.cache/uv --mount=type=cache,target=/usr/local/cargo/registry \
    cd /src/fabric \
    && CARGO_NET_OFFLINE=true uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels --config-setting build-args=--locked /src/fabric/sdk/python/nemo-fabric-runtime \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/sdk/python/nemo-fabric-evidence \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapter-contract/python \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/adapters/python/common \
    && uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels /src/fabric/sdk/python/nemo-fabric-adapter-catalog

FROM base AS upstream-notices
COPY --from=sources \
    /rust-notice-whatisinternet--inflector--a4a95eac75043f4bffb127c7c8ec886b5b106053--LICENSE.md \
    /rust-notice-str4d--rage--1465e602c83c5e4d3db8f58d9bdfc2a10063f90d--LICENSE-APACHE \
    /rust-notice-str4d--rage--1465e602c83c5e4d3db8f58d9bdfc2a10063f90d--LICENSE-MIT \
    /rust-notice-str4d--rage--17446612f865c705e44fe392d9d41dd102fed137--LICENSE-APACHE \
    /rust-notice-str4d--rage--17446612f865c705e44fe392d9d41dd102fed137--LICENSE-MIT \
    /rust-notice-rusticata--asn1-rs--a20e5f7319c896737ad0f2557037817b91ad854f--LICENSE-APACHE \
    /rust-notice-rusticata--asn1-rs--a20e5f7319c896737ad0f2557037817b91ad854f--LICENSE-MIT \
    /rust-notice-nugine--simd--d74c030d9dc4f3cae02146d1f497ff62726ef09a--LICENSE \
    /rust-notice-rust-bakery--cookie-factory--d36b805dbd7dd65f2df947235c5bcc573afe2c76--LICENSES__MIT.txt \
    /rust-notice-akhilles--crc-catalog--b500ea693c552f8d946e290722a7b3ee8b9a7ee2--LICENSES__Apache-2.0.txt \
    /rust-notice-akhilles--crc-catalog--b500ea693c552f8d946e290722a7b3ee8b9a7ee2--LICENSES__MIT.txt \
    /rust-notice-projectfluent--fluent-langneg-rs--7fdc590466ea63ca2367ac10fb1b881fe561f1a8--LICENSE-APACHE \
    /rust-notice-projectfluent--fluent-langneg-rs--7fdc590466ea63ca2367ac10fb1b881fe561f1a8--LICENSE-MIT \
    /rust-notice-michael-f-bryan--include_dir--d742c6fffce99ee89da91b934e7ce6fb2a82680c--LICENSE \
    /rust-notice-zbraniecki--pluralrules--d0715d5b7cca72e228d6e6c4de154bd30dfdd06a--intl_pluralrules__LICENSE-APACHE \
    /rust-notice-zbraniecki--pluralrules--d0715d5b7cca72e228d6e6c4de154bd30dfdd06a--intl_pluralrules__LICENSE-MIT \
    /rust-notice-open-telemetry--opentelemetry-rust--285dc925f98403ff426acc70968f104dc820d4f2--LICENSE \
    /rust-notice-open-telemetry--opentelemetry-rust--00f97c948e95beb7b2c966fcdb5f946c2a89baeb--LICENSE \
    /rust-notice-facebook--starlark-rust--8978f3cd91b2908e1e61f6b58f84293097abf8f1--LICENSE \
    /rust-notice-plabayo--rama--4733273a10a791762e2b7727850032b0c9b8536d--LICENSE-APACHE \
    /rust-notice-plabayo--rama--4733273a10a791762e2b7727850032b0c9b8536d--LICENSE-MIT \
    /rust-notice-modelcontextprotocol--rust-sdk--51ccb42993d6eb5075399672ce7a0c21a0e55eea--LICENSE \
    /rust-notice-marwes--schemafy--5f835025d16d691f168315dda93efc52ae1e4e5e--LICENSE \
    /rust-notice-facebookexperimental--rust-shed--756ae7daba100d194aa0260131937b7d96672549--LICENSE-APACHE \
    /rust-notice-facebookexperimental--rust-shed--756ae7daba100d194aa0260131937b7d96672549--LICENSE-MIT \
    /rust-notice-facebook--starlark-rust--0c8d107ab963362ba47ee3ab9e0173bc39bd101d--LICENSE \
    /rust-notice-hyperium--tonic--ed4bafc35af7a284357cf4e77e26b9c3eb0266ca--LICENSE \
    /rust-notice-aleph-alpha--ts-rs--1dce5297090804082e9639d2b7d851ba815aa359--LICENSE \
    /notices/

# Build the unmodified sdist with our retained Cargo lock: upstream wheels do
# not publish their dependency lock or an embedded dependency SBOM.
FROM base AS tiktoken-wheels
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=uv /uv /usr/local/bin/uv
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
ARG SOURCE_DATE_EPOCH=1789516800
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sources /python-tiktoken-source.tar.gz /sources/
COPY image/fabric/tiktoken-Cargo.lock /tmp/tiktoken-Cargo.lock
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/root/.cache/uv \
    mkdir -p /src/tiktoken/.cargo /out \
    && tar -xzf /sources/python-tiktoken-source.tar.gz -C /src/tiktoken --strip-components=1 \
    && cd /src/tiktoken \
    && cp /tmp/tiktoken-Cargo.lock Cargo.lock \
    && cargo vendor --locked --versioned-dirs vendor > .cargo/config.toml \
    && CARGO_NET_OFFLINE=true uv build --python /usr/local/bin/python3 --wheel --out-dir /out . \
    && python3 -c 'import tomllib; assert tomllib.load(open("Cargo.lock", "rb")) == tomllib.load(open("/tmp/tiktoken-Cargo.lock", "rb")), "Tiktoken dependency pins changed"' \
    && tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
        -I 'gzip -n' -cf /out/tiktoken-cargo-source.tar.gz Cargo.lock .cargo vendor \
    && rm -rf /src/tiktoken

FROM common-wheels AS harness-wheels
ARG HARNESS
ARG ADAPTER
ARG EXTRA
COPY image/fabric/ /build/
COPY image/NOTICE.md image/SOURCES.md docker-bake.hcl .dockerignore /build/
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,from=tiktoken-wheels,source=/out,target=/tiktoken-wheels \
    mkdir -p /sources/runtime-extra \
    && case "$HARNESS" in \
        deepagents|mini-swe-agent) cp /tiktoken-wheels/*.whl /wheels/; \
            cp /tiktoken-wheels/tiktoken-cargo-source.tar.gz /sources/runtime-extra/; \
            set -- --no-emit-package tiktoken ;; \
        *) set -- ;; \
    esac \
    && if [ -n "$ADAPTER" ]; then uv build --python /usr/local/bin/python3 --wheel --out-dir /wheels "/src/fabric/adapters/python/$ADAPTER"; fi \
    && sh /build/inputs.sh lock /wheels > /own-requirements.txt \
    && uv export --project /src/fabric --frozen --no-default-groups --no-emit-local ${EXTRA:+--extra=$EXTRA} --output-file /requirements.txt "$@" \
    && cat /own-requirements.txt >> /requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --find-links /wheels -r /requirements.txt \
    && sh /build/inputs.sh provenance /build > /provenance.json
COPY --from=sources \
    /codex-rg-source.tar.gz \
    /python-nemo-relay-source.tar.gz \
    /python-fastuuid-source.tar.gz \
    /python-litellm-source.tar.gz \
    /python-tiktoken-source.tar.gz \
    /python-ormsgpack-source.tar.gz \
    /sources/
RUN --mount=type=cache,target=/root/.cache/nemoclaw-crates \
    --mount=type=bind,from=upstream-notices,source=/notices,target=/upstream-notices \
    case "$HARNESS" in \
        deepagents) set -- --lock /build/tiktoken-Cargo.lock --sdist /sources/python-ormsgpack-source.tar.gz --sdist /sources/python-tiktoken-source.tar.gz ;; \
        mini-swe-agent) set -- --lock /build/tiktoken-Cargo.lock --sdist /sources/python-fastuuid-source.tar.gz --sdist /sources/python-litellm-source.tar.gz --sdist /sources/python-tiktoken-source.tar.gz ;; \
        codex) python3 -c 'import tarfile; t=tarfile.open("/sources/codex-rg-source.tar.gz"); m=next(m for m in t if m.name.count("/")==1 and m.name.endswith("/Cargo.lock")); open("/sources/codex-rg-Cargo.lock", "wb").write(t.extractfile(m).read())'; \
            set -- --lock /sources/codex-rg-Cargo.lock ;; \
        *) set -- ;; \
    esac; \
    if [ -x /opt/fabric/bin/nemo-relay ]; then set -- "$@" --sdist /sources/python-nemo-relay-source.tar.gz; fi; \
    python3 /build/dependency_sources.py --sboms /opt/fabric/lib --cache /root/.cache/nemoclaw-crates \
        --upstream-notices /upstream-notices --output /sources/native-dependency-sources.tar.gz "$@"

FROM base AS runtime-base
COPY --from=harness-wheels /opt/fabric /opt/fabric
COPY --from=harness-wheels /requirements.txt /opt/nemoclaw/source/requirements.txt
COPY --from=harness-wheels --chmod=0644 /sources/fabric.tar.gz /opt/nemoclaw/source/
COPY --from=harness-wheels --chmod=0644 /sources/fabric-vendor.tar.gz /sources/rust-COPYRIGHT-library.html /opt/nemoclaw/source/
COPY --from=harness-wheels --chmod=0644 /sources/native-dependency-sources.tar.gz /opt/nemoclaw/source/
COPY --from=harness-wheels /sources/runtime-extra/ /opt/nemoclaw/source/
COPY --from=harness-wheels /build /opt/nemoclaw/source/local/
COPY --from=harness-wheels /provenance.json /opt/nemoclaw/provenance.json
COPY image/fabric/catalog.py image/fabric/runtime_metadata.py image/fabric/runtime.json /opt/nemoclaw/
# Commands run in the sandbox, such as through openshell sandbox exec, find
# Fabric's sandbox host on the default PATH.
RUN ln -s /opt/fabric/bin/fabric-agent-ctl /usr/local/bin/fabric-agent-ctl \
    && install -d -m 0755 /opt/nemoclaw/source/codex /opt/nemoclaw/source/deepagents /opt/nemoclaw/source/hf-xet
# Fabric runs Python adapters with this interpreter.
ENV ADAPTER_PYTHON=/opt/fabric/bin/python

FROM runtime-base AS generic
ARG ADAPTER_ID
# The workflow targets the adapter's package installs, space-separated.
ARG TARGET_IDS
# catalog.py publishes the adapters and targets each harness stage declares here.
RUN test -n "$ADAPTER_ID" \
    && python3 -c 'import json, os; print(json.dumps({os.environ["ADAPTER_ID"]: {"files": [], "binaries": [], "targets": {t: {} for t in os.environ.get("TARGET_IDS", "").split()}}}))' > /opt/nemoclaw/adapters.json
USER node

FROM common-wheels AS codex-vendor
COPY --from=sources /codex-source.tar.gz /sources/
COPY --from=upstream-notices /notices/ /out/upstream-notices/
# Retain every locked Cargo source, including notices embedded in source headers.
# Cargo 1.100 prepares the sources only; the shipped Codex binaries are unchanged.
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    mkdir -p /src/codex \
    && tar -xzf /sources/codex-source.tar.gz -C /src/codex --strip-components=1 \
    && cd /src/codex/codex-rs \
    && cp Cargo.lock /tmp/codex-original.lock \
    && cargo +1.100.0 update --workspace \
    && cargo +1.100.0 vendor --locked --versioned-dirs vendor-cargo > /tmp/codex-vendor.toml \
    && python3 -c 'import tomllib; a=tomllib.load(open("/tmp/codex-original.lock", "rb")); b=tomllib.load(open("Cargo.lock", "rb")); assert [p for p in a["package"] if "source" in p] == [p for p in b["package"] if "source" in p], "external Codex pins changed"' \
    && cat /tmp/codex-vendor.toml >> .cargo/config.toml \
    && cp -a /out/upstream-notices . \
    && tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
        -I 'gzip -n' -cf /out/codex-cargo-source.tar.gz vendor-cargo .cargo Cargo.lock upstream-notices \
    && rm -rf /src/codex

FROM base AS codex-sources
ARG TARGETARCH
COPY --from=sources /codex-source.tar.gz /codex-libcap-source.tar.xz /sources/
COPY --from=sources /codex-v8-source.tar.gz /sources/codex-v8-source.tar.gz
COPY --from=sources /codex-rust-notices.tar.xz /codex-rg-arm64-rust-notices.tar.xz /codex-rg-amd64-rust-notices.tar.xz /tmp/
COPY --from=sources /codex-icu-LICENSE.base64 /codex-libcxx-LICENSE.base64 /codex-libcxxabi-LICENSE.base64 /codex-llvm-libc-LICENSE.base64 /tmp/
# Extract notices only; the compiler distributions stay in this build stage.
RUN python3 - <<'PY'
import base64
import os
import tarfile
from pathlib import Path

rg_version = {"arm64": "1.97.0", "amd64": "nightly"}[os.environ["TARGETARCH"]]
inputs = [
    ("/sources/codex-source.tar.gz", "codex-6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/vendor/bubblewrap/COPYING", "codex-bubblewrap-COPYING"),
    ("/sources/codex-libcap-source.tar.xz", "libcap-2.75/License", "codex-libcap-License"),
    ("/sources/codex-v8-source.tar.gz", "v8-15.0.245.2/LICENSE", "codex-v8-LICENSE"),
    ("/tmp/codex-rust-notices.tar.xz", "rustc-1.95.0-x86_64-unknown-linux-gnu/rustc/share/doc/rust/COPYRIGHT-library.html", "codex-rust-COPYRIGHT-library.html"),
    (f"/tmp/codex-rg-{os.environ['TARGETARCH']}-rust-notices.tar.xz", f"rustc-{rg_version}-x86_64-unknown-linux-gnu/rustc/share/doc/rust/COPYRIGHT-library.html", "codex-rg-rust-COPYRIGHT-library.html"),
]
for archive, member, output in inputs:
    with tarfile.open(archive) as source:
        Path("/sources", output).write_bytes(source.extractfile(member).read())
for component in ("icu", "libcxx", "libcxxabi", "llvm-libc"):
    encoded = Path(f"/tmp/codex-{component}-LICENSE.base64").read_bytes()
    Path("/sources", f"codex-{component}-LICENSE").write_bytes(base64.b64decode(b"".join(encoded.split()), validate=True))
PY

FROM generic AS codex
COPY --from=codex-vendor --chmod=0644 /out/codex-cargo-source.tar.gz /opt/nemoclaw/source/codex/
# The locked Codex wheels omit these project-specific license and notice files.
COPY --from=sources --chmod=0644 /codex-LICENSE /codex-NOTICE /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /codex-rg-LICENSE-MIT /codex-zsh-LICENCE /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /codex-rusty-v8-LICENSE /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /codex-rg-source.tar.gz /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /codex-symphonia-source.tar.gz /codex-nucleo-source.tar.gz /option-ext-source.crate /opt/nemoclaw/source/codex/
COPY --from=codex-sources --chmod=0644 /sources/codex-source.tar.gz /sources/codex-libcap-source.tar.xz /sources/codex-bubblewrap-COPYING /sources/codex-libcap-License /sources/codex-rust-COPYRIGHT-library.html /sources/codex-rg-rust-COPYRIGHT-library.html /opt/nemoclaw/source/
COPY --from=codex-sources --chmod=0644 /sources/codex-v8-source.tar.gz /sources/codex-v8-LICENSE /opt/nemoclaw/source/
COPY --from=codex-sources --chmod=0644 /sources/codex-icu-LICENSE /sources/codex-libcxx-LICENSE /sources/codex-libcxxabi-LICENSE /sources/codex-llvm-libc-LICENSE /opt/nemoclaw/source/
COPY image/fabric/CODEX-SOURCES.md /opt/nemoclaw/source/codex/README.md

FROM generic AS deepagents
# These exact release notices supplement Fabric's attribution placeholders.
COPY --from=sources --chmod=0644 /langsmith-LICENSE /sqlite-vec-LICENSE-MIT /opt/nemoclaw/source/
COPY --from=sources --chmod=0644 /deepagents-orjson-source.tar.gz /opt/nemoclaw/source/deepagents/orjson-source.tar.gz

FROM generic AS mini-swe-agent
COPY --from=sources --chmod=u=rwX,go=rX /tokenizers-source.tar.gz /opt/nemoclaw/source/tokenizers/
COPY --from=sources --chmod=0644 /colored-source.crate /option-ext-source.crate /opt/nemoclaw/source/hf-xet/

FROM runtime-base AS interactive
COPY --from=node /node/ /
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*

FROM base AS openclaw-sources
ARG SOURCE_DATE_EPOCH=1789516800
COPY --from=sources /ubrn-source.tgz /sources/ubrn-source.tgz
COPY --from=sources /cua-source.tar.gz /tmp/cua-source.tar.gz
COPY image/fabric/OPENCLAW-SOURCES.md /sources/README.md
# Keep the driver subtree, license, and package metadata from the pinned repo.
RUN mkdir -p /src/cua \
    && tar -xzf /tmp/cua-source.tar.gz -C /src/cua --strip-components=1 \
        cua-36987990b292537770fe2df3a9e6dee2ef43db2f/LICENSE.md \
        cua-36987990b292537770fe2df3a9e6dee2ef43db2f/package.json \
        cua-36987990b292537770fe2df3a9e6dee2ef43db2f/libs/cua-driver \
    && cd /src/cua \
    && tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
        -I 'gzip -n' -cf /sources/cua-driver-source.tar.gz LICENSE.md package.json libs/cua-driver

FROM interactive AS openclaw
# Upstream owns /app as its own user; the sandbox only reads it.
COPY --from=openclaw-upstream --chown=0:0 /app /app
# OpenClaw's published image omits its license.
COPY --from=sources --chmod=0644 /openclaw-LICENSE /opt/nemoclaw/source/openclaw-LICENSE
COPY --from=openclaw-sources --chmod=0644 /sources/ubrn-source.tgz /sources/cua-driver-source.tar.gz /sources/README.md /opt/nemoclaw/source/openclaw/
RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw
# catalog.py publishes this declaration: the files the adapter reads, which
# explicit filesystem grants must allow, and the executables it runs.
RUN printf '%s\n' '{"nvidia.fabric.openclaw": {"files": ["/app"], "binaries": ["node"]}}' > /opt/nemoclaw/adapters.json
USER node

FROM base AS hermes-assets
# Hermes Agent release v0.22.7, which includes its native Relay integration.
COPY --from=sources /hermes.tar.gz /sources/hermes.tar.gz
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
COPY --from=sources /switchyard-amd64.tar.gz /switchyard-arm64.tar.gz /sources/
RUN case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac \
    && mkdir -p /opt/nemo-relay/plugins/switchyard \
    && tar -xzf "/sources/switchyard-${TARGETARCH}.tar.gz" \
        -C /opt/nemo-relay/plugins/switchyard --strip-components=1

FROM interactive AS hermes
COPY --from=sources --chmod=0644 /anydoc-LICENSE /xterm-LICENSE /jetbrains-mono-OFL.txt /opt/nemoclaw/source/
COPY image/fabric/hermes-NOTICES.md /opt/nemoclaw/source/hermes/
COPY --from=sources --chmod=0644 /hermes-pillow-heif-source.tar.gz /hermes-libheif-source.tar.gz /hermes-libde265-source.tar.gz /hermes-x265-source.tar.gz /opt/nemoclaw/source/hermes/
COPY image/fabric/HERMES-SOURCES.md /opt/nemoclaw/source/hermes/README.md
COPY --from=hermes-assets /opt/hermes /opt/hermes
COPY --from=hermes-assets --chmod=0644 /sources/hermes.tar.gz /opt/nemoclaw/source/
COPY --from=switchyard-assets /opt/nemo-relay /opt/nemo-relay
# Hermes owns its dependencies: its own lock, with the mcp extra, settles the
# packages it shares with Fabric, as Fabric installs into Hermes's environment.
# Hermes needs the anthropic extra's SDK to call a model through an anthropic
# provider, and can't install it later because lazy installs are disabled.
# From the messaging extra, only aiohttp, which Hermes's API server needs, is
# installed; the messaging platform clients are pruned.
# Hermes's lock overrides some dependencies' requirements, such as
# browser-harness's Pillow pin, so the exported closure is installed without
# re-resolving it, and Hermes's own pm.pip_check accepts exactly the dependency
# check failures those overrides cause, as Hermes's installer does.
# Hermes resolves bundled assets relative to its source checkout.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv --mount=type=cache,target=/root/.cache/uv \
    uv export --project /opt/hermes --frozen --no-dev --extra anthropic --extra mcp --extra messaging \
        --prune discord-py --prune python-telegram-bot --prune slack-bolt --prune slack-sdk --prune qrcode --prune brotlicffi \
        --no-emit-project --format requirements-txt --output-file /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --require-hashes --no-deps -r /opt/nemoclaw/source/hermes-requirements.txt \
    && uv pip install --python /opt/fabric/bin/python --no-deps -e /opt/hermes --config-settings editable_mode=compat \
    && if ! uv pip check --python /opt/fabric/bin/python > /tmp/pip-check.txt 2>&1; then \
        PYTHONPATH=/opt/hermes python3 -c 'import sys; from pathlib import Path; from pm.pip_check import unexpected_incompatibilities; sys.exit(unexpected_incompatibilities(sys.stdin.read(), Path("/opt/hermes/uv.lock")) != [])' \
            < /tmp/pip-check.txt || { cat /tmp/pip-check.txt; exit 1; }; \
    fi \
    && rm /tmp/pip-check.txt
RUN --mount=type=cache,target=/root/.cache/nemoclaw-crates \
    --mount=type=bind,from=upstream-notices,source=/notices,target=/upstream-notices \
    python3 /opt/nemoclaw/source/local/dependency_sources.py --sboms /opt/fabric/lib \
        --cache /root/.cache/nemoclaw-crates --upstream-notices /upstream-notices \
        --output /opt/nemoclaw/source/native-dependency-sources.tar.gz
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
COPY --from=sources --chmod=u=rwX,go=rX /pi-LICENSE /opt/nemoclaw/source/pi/
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
# Bun's image omits its license, which names the libraries Bun links statically.
COPY --from=sources --chmod=0644 /bun-LICENSE.md /opt/nemoclaw/source/bun-LICENSE.md
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
RUN --mount=type=cache,target=/root/.cache/uv uv tool run --from ruff==0.17.5 ruff check /repo \
    && uv tool run --from ruff==0.17.5 ruff format --check /repo

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
