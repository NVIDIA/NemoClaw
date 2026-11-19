# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG RUST_IMAGE=rust:1.100.0-alpine@sha256:de1e0058543a81ed7b046629167db587c67a94bdf37cce14eb27f0ec83baaffb

# musl links the proxy statically; retain its license, its build inventory, and
# the notices of what it links: its locked dependencies' license files and
# manifests, and the Rust standard library's and musl's notices.
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
    && install -m 0644 /tmp/proxy-source/Cargo.lock /out/usr/share/doc/nemoclaw-ollama-proxy/Cargo.lock \
    && install -m 0644 "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" \
        /out/usr/share/doc/nemoclaw-ollama-proxy/rust-COPYRIGHT-library.html \
    && cd /tmp/proxy-source && cargo vendor --quiet --locked --versioned-dirs /tmp/vendor > /dev/null \
    && cd /tmp/vendor && find . -mindepth 2 -maxdepth 2 -type f \( -name Cargo.toml -o -iname 'LICEN[CS]E*' \
        -o -iname 'COPYING*' -o -iname 'COPYRIGHT*' -o -iname 'NOTICE*' -o -iname 'UNLICENSE*' \) \
        -exec install -D -m 0644 {} /out/usr/share/doc/nemoclaw-ollama-proxy/dependencies/{} \;

FROM build AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo test --locked --release -p nemoclaw-ollama-proxy

FROM scratch AS runtime
COPY --from=build /out/ /
ENTRYPOINT ["/usr/local/bin/nemoclaw-ollama-proxy"]
