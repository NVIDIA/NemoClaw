<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build Local Artifacts

Build from the repository root with Rust 1.98.1, pinned in [rust-toolchain.toml](../rust-toolchain.toml), and Protocol Buffers compiler 36.1.
Native builds also require a C toolchain for TLS dependencies.
Set `PROTOC` to the compiler’s path if it is outside `PATH`.
[versions.json](../versions.json) records tool versions and download checksums.

## Build a Native Bundle

Run the bundle builder:

```sh
cargo run -p nemoclaw-build -- bundle
```

The builder downloads and verifies the OpenTofu archive, builds the CLI and production provider with the lockfile, and writes `dist/<platform>`.
The manifest records each shipped file’s hash, including the OpenTofu license.
The SDK verifies the bundle before use.

A source-derived provider version prevents reuse of a stale OpenTofu provider installation.

To select a target, pass `bundle --platform PLATFORM`.
The target names are `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64`.
Building another target requires its Rust standard library, linker, and native SDK.
[Native validation records](validation/rust-native-platforms.json) identify tested hosts; target selection alone does not qualify a runtime.

Add the bundle’s `bin` directory to `PATH` and run `nemoclaw --help` to check CLI access.
Continue with [deployment usage](usage.md).

Keep the bundle unchanged while an operation uses it.
The builder replaces `dist/<platform>`; copy the bundle to a dedicated location before a long live experiment.
Repository text uses LF on every platform so checkout newline conversion does not change source-derived provider versions.

## Build a Runtime Image

Both runtime image builds require the qualified Linux ARM64 build host, Docker, and Buildx.
The artifact manifest selects its Dockerfile, local inputs, immutable source downloads, image name, and reproducible timestamp.
It downloads pinned sources and dependencies, builds locally, and loads the image into the selected local Docker daemon.

It does not launch inference or publish an image.

For ordinary safetensors models, run:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/vllm/build.json
```

This build exports `.build/vllm/runtime.tar` and loads `nc-prototype-vllm:rust-v1`.
The image contains the shared supervisor and pinned vLLM base, without Qwen3.8 patches or preparation tools.
Select the model through [model configuration](models.md).

For Qwen3.8 preparation, run:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/qwen38/build.json
```

This build exports `.build/qwen38/runtime.tar` and loads `nc-prototype-qwen38:spark-rust-v1`.
Its Dockerfile applies pinned patches and retains original and modified sources.
Use [the inline recipe guide](recipes.md) to declare preparation and serving requirements.

Use the immutable OCI manifest digest in the build output for `image.ref`.
Do not substitute a mutable tag or a digest copied from another build.
If the selected daemon is remote, load the archive into that daemon before apply; a local image is not available there automatically.

## Retained Sources and Compatibility

The builder creates a source archive with normalized timestamps and compiles the supervisor offline from that archive.
It includes locked dependencies, their licenses, and OpenShell protobuf inputs omitted by Cargo vendoring.
The build excludes dependency paths and parent Git metadata from compiler inputs.

The [vLLM notice](../runtimes/vllm/NOTICE.md) and [Qwen3.8 notice](../runtimes/qwen38/NOTICE.md) identify retained sources and licenses.

Generated bundles, build inputs, and images are ignored by Git.
Model snapshots and prepared data belong to the deployment’s persistent volume, outside the build context.

The image contains `nemoclaw-runtime`.
The inline recipe supplies preparation and verification tools; `backend: vllm` selects serving behavior.
Managed containers use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
The former `nemoclaw-spark` entrypoint and `NEMOCLAW_SPARK_SPEC` environment alias are no longer accepted.
