# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG RUST_IMAGE=rust:1.100.0-alpine@sha256:de1e0058543a81ed7b046629167db587c67a94bdf37cce14eb27f0ec83baaffb

# Package the proxy and its locked dependency sources before compiling it.
FROM ${RUST_IMAGE} AS source
ARG SOURCE_DATE_EPOCH=1789689600
RUN apk add --no-cache tar gzip
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml LICENSE ./
COPY crates/ crates/
COPY image/SOURCES.md /source-instructions.md
COPY image/ollama-proxy/Dockerfile /proxy.Dockerfile
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    install -D -m 0644 LICENSE /out/usr/share/doc/nemoclaw-ollama-proxy/LICENSE \
    && cargo package --locked --no-verify --allow-dirty -p nemoclaw-ollama-proxy --target-dir /tmp/package \
    && mkdir /tmp/proxy-source \
    && tar -xzf /tmp/package/package/nemoclaw-ollama-proxy-*.crate -C /tmp/proxy-source --strip-components=1 \
    && install -m 0644 /tmp/proxy-source/Cargo.lock /out/usr/share/doc/nemoclaw-ollama-proxy/Cargo.lock \
    && install -m 0644 "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" \
        /out/usr/share/doc/nemoclaw-ollama-proxy/rust-COPYRIGHT-library.html \
    && cp LICENSE rust-toolchain.toml /tmp/proxy-source/ \
    && cp /source-instructions.md /tmp/proxy-source/SOURCES.md \
    && cp /proxy.Dockerfile /tmp/proxy-source/Dockerfile \
    && install -m 0644 /source-instructions.md /out/usr/share/doc/nemoclaw-ollama-proxy/SOURCES.md \
    && cd /tmp/proxy-source && mkdir .cargo \
    && cargo vendor --quiet --locked --versioned-dirs vendor > .cargo/config.toml \
    && rm -f .cargo_vcs_info.json \
    && tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
        -I 'gzip -n' -cf /out/usr/share/doc/nemoclaw-ollama-proxy/proxy-source.tar.gz . \
    && cd vendor && find . -mindepth 2 -maxdepth 2 -type f \( -name Cargo.toml -o -iname 'LICEN[CS]E*' \
        -o -iname 'COPYING*' -o -iname 'COPYRIGHT*' -o -iname 'NOTICE*' -o -iname 'UNLICENSE*' \) \
        -exec install -D -m 0644 {} /out/usr/share/doc/nemoclaw-ollama-proxy/dependencies/{} \;

# Compile exactly the retained archive, with musl, without dependency downloads.
FROM ${RUST_IMAGE} AS build
RUN apk add --no-cache musl-dev
COPY --from=source /out/ /out/
WORKDIR /proxy
RUN tar -xzf /out/usr/share/doc/nemoclaw-ollama-proxy/proxy-source.tar.gz -C /proxy
RUN --network=none --mount=type=cache,target=/target \
    cargo build --locked --offline --release --target-dir /target \
    && install -D -m 0755 /target/release/nemoclaw-ollama-proxy /out/usr/local/bin/nemoclaw-ollama-proxy

FROM build AS test
RUN --network=none --mount=type=cache,target=/target \
    cargo test --locked --offline --release --target-dir /target

FROM scratch AS runtime
COPY --from=build /out/ /
ENTRYPOINT ["/usr/local/bin/nemoclaw-ollama-proxy"]
