# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# The runtime supervisor that the vLLM and Ollama images run, with the sources
# they retain. Bake builds it for the host's platform only, so it never
# compiles under emulation.
ARG RUST_IMAGE=rust:1.100.0-bookworm@sha256:1b9dc70890ec494e466c87f5ad41ad544bfb30ea6acc99a3e068c47a4ae3f23e

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

# Compile exactly the retained archive, offline, from its vendored sources, and
# keep the notices of the Rust standard library the executable links.
FROM ${RUST_IMAGE} AS build
COPY --from=source /out/supervisor-source.tar.gz /out/supervisor-source.tar.gz
RUN set -eu; \
    mkdir /workspace; \
    tar -xzf /out/supervisor-source.tar.gz -C /workspace; \
    cd /workspace; \
    cargo build --locked --offline --release -p nemoclaw-runtime --target-dir /target; \
    install -m 0755 /target/release/nemoclaw-runtime /out/nemoclaw-runtime; \
    install -m 0644 "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" /out/rust-COPYRIGHT-library.html

# Keep the locked build inventory visible to image SBOM catalogers, which
# cannot discover Rust dependencies from the stripped executable or tarball.
FROM scratch AS supervisor
COPY --from=source /source/Cargo.lock /Cargo.lock
COPY --from=build /out/ /
