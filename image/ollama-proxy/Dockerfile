# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG RUST_IMAGE=rust:1.99.1-alpine@sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9

# musl links the proxy statically; retain its license and build inventory.
FROM ${RUST_IMAGE} AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml LICENSE ./
COPY crates/ crates/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p nemoclaw-ollama-proxy \
    && install -D -m 0755 target/release/nemoclaw-ollama-proxy /out/usr/local/bin/nemoclaw-ollama-proxy \
    && install -D -m 0644 LICENSE /out/usr/share/doc/nemoclaw-ollama-proxy/LICENSE \
    && cargo package --locked --no-verify --allow-dirty -p nemoclaw-ollama-proxy --target-dir /tmp/package \
    && mkdir /tmp/proxy-source \
    && tar -xzf /tmp/package/package/nemoclaw-ollama-proxy-*.crate -C /tmp/proxy-source --strip-components=1 \
    && install -m 0644 /tmp/proxy-source/Cargo.lock /out/usr/share/doc/nemoclaw-ollama-proxy/Cargo.lock

FROM build AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo test --locked --release -p nemoclaw-ollama-proxy

FROM scratch AS runtime
COPY --from=build /out/ /
ENTRYPOINT ["/usr/local/bin/nemoclaw-ollama-proxy"]
