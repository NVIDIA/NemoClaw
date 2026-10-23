# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# The runtime supervisor that the vLLM and Ollama images run, with the sources
# they retain. Bake builds it for the host's platform only, so it never
# compiles under emulation.
ARG RUST_IMAGE=rust:1.99.1-bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29

# The supervisor's Cargo package and its locked dependency sources, with their
# licenses: the archive the runtime images retain and compile from.
FROM ${RUST_IMAGE} AS source
ARG SOURCE_DATE_EPOCH
WORKDIR /repository
COPY Cargo.toml Cargo.lock rust-toolchain.toml LICENSE ./
COPY crates/ crates/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    set -eu; \
    cargo package --locked --no-verify --allow-dirty -p nemoclaw-runtime --target-dir /tmp/package; \
    mkdir -p /source/crates/nemoclaw-runtime /out; \
    tar -xzf /tmp/package/package/nemoclaw-runtime-*.crate -C /source/crates/nemoclaw-runtime --strip-components=1; \
    rm -f /source/crates/nemoclaw-runtime/.cargo_vcs_info.json; \
    mv /source/crates/nemoclaw-runtime/Cargo.lock /source/Cargo.lock; \
    cp LICENSE rust-toolchain.toml /source/; \
    printf '[workspace]\nmembers = ["crates/nemoclaw-runtime"]\nresolver = "3"\n' > /source/Cargo.toml; \
    cd /source; \
    mkdir .cargo; \
    cargo vendor --locked --versioned-dirs vendor > .cargo/config.toml; \
    tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner -cf - . \
      | gzip -n > /out/supervisor-source.tar.gz

# Compile exactly the retained archive, offline, from its vendored sources.
FROM ${RUST_IMAGE} AS build
COPY --from=source /out/supervisor-source.tar.gz /out/supervisor-source.tar.gz
RUN --mount=type=cache,target=/target \
    set -eu; \
    mkdir /workspace; \
    tar -xzf /out/supervisor-source.tar.gz -C /workspace; \
    cd /workspace; \
    cargo build --locked --offline --release -p nemoclaw-runtime --target-dir /target; \
    install -m 0755 /target/release/nemoclaw-runtime /out/nemoclaw-runtime

# Keep the locked build inventory visible to image SBOM catalogers, which
# cannot discover Rust dependencies from the stripped executable or tarball.
FROM scratch AS supervisor
COPY --from=source /source/Cargo.lock /Cargo.lock
COPY --from=build /out/ /
