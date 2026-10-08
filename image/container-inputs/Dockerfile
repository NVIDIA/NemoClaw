# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
ARG RUST_IMAGE=rust:1.98.1-alpine@sha256:7cc1c22d77d9432f7fe012a70e6d3e555af54c2a6832700ed7d553f1769ae89f
FROM ${RUST_IMAGE} AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml LICENSE ./
COPY crates/ crates/
COPY examples/onboarding-tui/ examples/onboarding-tui/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p nemoclaw-container-inputs \
    && install -D -m 0755 target/release/nemoclaw-container-inputs /out/usr/local/bin/nemoclaw-container-inputs \
    && install -D -m 0644 LICENSE /out/usr/share/doc/nemoclaw-container-inputs/LICENSE
FROM build AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo test --locked --release -p nemoclaw-container-inputs
FROM scratch AS runtime
COPY --from=build /out/ /
LABEL io.nemoclaw.container-inputs="1"
ENTRYPOINT ["/usr/local/bin/nemoclaw-container-inputs"]
