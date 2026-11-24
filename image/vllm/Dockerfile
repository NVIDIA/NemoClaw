# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Bake supplies the supervisor context from image/supervisor/Dockerfile.
# Retain uv's original release source and locked dependency sources without
# replacing the executable inherited from the upstream image.
ARG RUST_IMAGE=rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea
FROM ${RUST_IMAGE} AS uv-source
ARG SOURCE_DATE_EPOCH
WORKDIR /source
COPY --from=sources --chmod=u=rwX,go=rX /uv-source.tar.gz /out/uv-source.tar.gz
COPY --from=sources --chmod=u=rwX,go=rX \
    /rust-notice-astral-sh--astral-codec--072c722cbe4632ac4e938fa53bf15ce27ad4d5df--LICENSE-APACHE \
    /rust-notice-astral-sh--astral-codec--072c722cbe4632ac4e938fa53bf15ce27ad4d5df--LICENSE-MIT \
    /rust-notice-rusticata--asn1-rs--a20e5f7319c896737ad0f2557037817b91ad854f--LICENSE-APACHE \
    /rust-notice-rusticata--asn1-rs--a20e5f7319c896737ad0f2557037817b91ad854f--LICENSE-MIT \
    /rust-notice-axodotdev--axoupdater--a08bbbdc06dfb2f18c1a55eb780e042f12fcd7d4--LICENSE-APACHE \
    /rust-notice-axodotdev--axoupdater--a08bbbdc06dfb2f18c1a55eb780e042f12fcd7d4--LICENSE-MIT \
    /rust-notice-knurling-rs--defmt--4a8cdb44891ed57b8ff5a023b6bec7137c48708f--LICENSE-APACHE \
    /rust-notice-knurling-rs--defmt--4a8cdb44891ed57b8ff5a023b6bec7137c48708f--LICENSE-MIT \
    /rust-notice-dimakudosh--difflib--f035fb8e656f27119e23eca9d5b996df14f3885e--LICENSE \
    /rust-notice-redox-os--seahash--74c02182146d1edd7c91a9e6eddefc7390682a70--LICENSE \
    /source/upstream-notices/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    set -eu; \
    tar -xzf /out/uv-source.tar.gz -C /source --strip-components=1; \
    mkdir .cargo; \
    RUSTUP_TOOLCHAIN=1.100.0 cargo vendor --locked --versioned-dirs vendor > .cargo/config.toml; \
    tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner -cf - \
      Cargo.lock .cargo vendor upstream-notices | gzip -n > /out/uv-cargo-source.tar.gz

FROM vllm/vllm-openai@sha256:20fdb089454afbb324efa4110a2c025ff7b27cc1a086e07aa580b18df8ad1ce1
COPY --from=uv-source --chmod=u=rwX,go=rX /out/uv-source.tar.gz /out/uv-cargo-source.tar.gz /opt/nemoclaw/source/
COPY --from=sources --chmod=u=rwX,go=rX /tokenizers-source.tar.gz /opt/nemoclaw/source/tokenizers/
COPY --from=sources --chmod=u=rwX,go=rX /orjson-source.tar.gz /opt/nemoclaw/source/orjson/
COPY --from=sources --chmod=u=rwX,go=rX /mooncake-LICENSE /opt/nemoclaw/source/mooncake/
COPY --from=sources --chmod=u=rwX,go=rX \
    /mooncake-go-github.com--coreos--go-semver--v0.3.0.zip \
    /mooncake-go-github.com--coreos--go-systemd--v22--v22.3.2.zip \
    /mooncake-go-github.com--gogo--protobuf--v1.3.2.zip \
    /mooncake-go-github.com--golang--protobuf--v1.5.4.zip \
    /mooncake-go-go.etcd.io--etcd--api--v3--v3.5.34.zip \
    /mooncake-go-go.etcd.io--etcd--client--pkg--v3--v3.5.34.zip \
    /mooncake-go-go.etcd.io--etcd--client--v3--v3.5.34.zip \
    /mooncake-go-go.uber.org--atomic--v1.7.0.zip \
    /mooncake-go-go.uber.org--multierr--v1.6.0.zip \
    /mooncake-go-go.uber.org--zap--v1.17.0.zip \
    /mooncake-go-golang.org--x--net--v0.60.0.zip \
    /mooncake-go-golang.org--x--sys--v0.48.0.zip \
    /mooncake-go-golang.org--x--text--v0.42.0.zip \
    /mooncake-go-google.golang.org--genproto--googleapis--api--v0.0.0-20260526163538-3dc84a4a5aaa.zip \
    /mooncake-go-google.golang.org--genproto--googleapis--rpc--v0.0.0-20260526163538-3dc84a4a5aaa.zip \
    /mooncake-go-google.golang.org--grpc--v1.83.2.zip \
    /mooncake-go-google.golang.org--protobuf--v1.36.12.zip \
    /opt/nemoclaw/source/mooncake/go/
COPY --from=supervisor /nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
COPY --from=supervisor /supervisor-source.tar.gz /rust-COPYRIGHT-library.html /opt/nemoclaw/source/
COPY --from=supervisor /Cargo.lock /opt/nemoclaw/source/supervisor/Cargo.lock
COPY LICENSE /opt/nemoclaw/source/LICENSE
COPY image/supervisor/Dockerfile /opt/nemoclaw/source/supervisor.Dockerfile
COPY image/vllm/NOTICE.md image/vllm/Dockerfile /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.inference.authentication="bearer-v1" \
      org.nemoclaw.inference.routes="openai-v2" \
      org.nemoclaw.backend="vllm" \
      org.nemoclaw.recipe.protocol="v1"
