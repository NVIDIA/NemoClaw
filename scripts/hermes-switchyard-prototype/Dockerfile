# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

FROM rust:1.96.1-trixie@sha256:1f0dbad1df66647807e6952d1db85d0b2bda7606cb2139d82517e4f009967376 AS relay-builder

WORKDIR /src
COPY relay/ ./
COPY prototype/relay-revision /tmp/relay-revision

RUN test "$(cat /tmp/relay-revision)" = "44438179c37cfb214901fd80c126605e075f3935" \
    && test "$(grep -F -c 'rev = "aa0a31126cc7ca922a6acdf4f1ef656744698c6c"' Cargo.toml)" = "3" \
    && test "$(grep -F -c 'rev=aa0a31126cc7ca922a6acdf4f1ef656744698c6c#aa0a31126cc7ca922a6acdf4f1ef656744698c6c' Cargo.lock)" = "3"

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo fetch --locked

RUN --network=none \
    --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --frozen --release -p nemo-relay-cli --features switchyard \
    && install -D -m 0755 target/release/nemo-relay /out/nemo-relay

FROM ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:c4899e00817acb3421037efba013c720a79895bc8c4448b47aa9aca0def3104b

LABEL com.nvidia.nemoclaw.prototype="hermes-relay-switchyard" \
      com.nvidia.nemoclaw.prototype.relay-pull-ref="refs/pull/586/head" \
      com.nvidia.nemoclaw.prototype.relay-revision="44438179c37cfb214901fd80c126605e075f3935" \
      com.nvidia.nemoclaw.prototype.switchyard-revision="aa0a31126cc7ca922a6acdf4f1ef656744698c6c"

USER root
COPY --from=relay-builder --chown=root:root /out/nemo-relay /opt/nemoclaw-prototype/nemo-relay
COPY --chown=root:root prototype/ /opt/nemoclaw-prototype/
RUN chmod 0555 \
        /opt/nemoclaw-prototype/nemo-relay \
        /opt/nemoclaw-prototype/run.sh \
        /opt/nemoclaw-prototype/fake-provider.py \
        /opt/nemoclaw-prototype/verify.py \
    && chmod 0444 \
        /opt/nemoclaw-prototype/classifier-plugins.toml \
        /opt/nemoclaw-prototype/relay-revision

USER sandbox:sandbox
ENTRYPOINT ["/bin/bash", "/opt/nemoclaw-prototype/run.sh"]
