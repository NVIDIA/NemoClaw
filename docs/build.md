<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build Local Artifacts

Build from the repository root with Rust 1.98.1, pinned in [rust-toolchain.toml](../rust-toolchain.toml), and Protocol Buffers compiler 36.1.
Native builds also require a C toolchain for TLS dependencies.
Set `PROTOC` to the compiler’s path if it is outside `PATH`.
[versions.json](../versions.json) records tool versions, download checksums, and the SDK's default agent, gateway, sandbox runtime, and supervisor image pins.
The SDK generates its artifact constants from that manifest at build time.

## Build a Native Bundle

Use a separate `target` directory in each worktree; do not symlink it to another checkout or share `CARGO_TARGET_DIR` between revisions.
The bundle builder uses the current worktree's `target` directory.
Share downloaded dependencies through Cargo's cache instead of sharing compiled workspace artifacts.

Run the bundle builder:

```sh
cargo run -p nemoclaw-build -- bundle
```

The builder downloads and verifies the OpenTofu archive, builds the CLI and production provider with the lockfile, and writes `dist/<platform>`.
The manifest records each shipped file’s hash, including the OpenTofu license.
The SDK verifies the bundle before use.

Each bundle includes `schemas/nemoclaw-v1alpha1.schema.json`, generated from its SDK contract and covered by the manifest hash.
Use that file for [editor assistance](usage.md#editor-schema-assistance) with the bundled CLI.
The API version alone does not identify a source revision.

The builder records its source fingerprint at compilation and rejects changed inputs before bundle assembly.
If it reports `build tool source inputs changed`, rebuild and run it with the `cargo run` command above.
The builder also rejects source changes during assembly.
Bundles created before schema packaging must be rebuilt; the SDK rejects a manifest that omits the schema or a schema file that fails its recorded hash.

A source-derived provider version prevents reuse of a stale OpenTofu provider installation.

To select a target, pass `bundle --platform PLATFORM`.
The target names are `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64`.
Building another target requires its Rust standard library, linker, and native SDK.
[Native validation records](validation/rust-native-platforms.json) identify tested hosts; target selection alone does not qualify a runtime.

Add the bundle’s `bin` directory to `PATH` and run `nemoclaw --help` to check CLI access.
Continue with [deployment usage](usage.md).

Keep the bundle unchanged while an operation uses it.
The builder replaces `dist/<platform>`; copy the bundle to a dedicated location before a long live run.
Repository text uses LF on every platform so checkout newline conversion does not change source-derived provider versions.

## Retire a Local Development Bundle

Removing a source-built bundle only removes local tools; it does not stop deployments, remove images, or revoke credentials.
There is no v1 `uninstall` command or package-manager installation to reverse in this source-build procedure.

Before removing a bundle, identify every deployment using it and keep a verified copy wherever its original tooling is still needed for recovery or teardown.
Finish any operation using that bundle.
If retiring a deployment too, follow [destroy and retention](usage.md#destroy) first and retain its state for surviving resources.
Then remove that dedicated bundle directory using your host's file manager and remove only its `bin` entry from your shell's `PATH` configuration.
Open a new terminal and check `command -v nemoclaw` on a POSIX shell, or `Get-Command nemoclaw` in PowerShell, to identify any remaining installation.

Do not delete deployment state, model volumes, unrelated tool installations, or shared caches as part of removing the local bundle.
A complete supported purge of retained runtime data remains [TBD](state.md#deletion-and-retention).
Rebuild a bundle from the recorded source revision if the removed tools are needed again; compatibility with another revision is not implied.

## Build Agent Images

Use Docker with Buildx on a native host that matches the selected image target.
Agent builds default to Linux ARM64.
Set `AGENT_PLATFORM=linux/amd64` to select the native AMD64 locks and stages for Deep Agents or OpenClaw.
The remaining harnesses are ARM64-only until their pinned native dependencies have matching AMD64 artifacts and qualification.
Agent images use Node.js 24.21.0 LTS and Python 3.14.7.
The `nooa`, `nooa-bench`, and `hermes` targets use Python 3.13.15 because their pinned upstream releases require Python below 3.14.
Build stages use pinned Rust, Node, Python, and uv images, so the host needs no language toolchains for image assembly.
Initial builds need network access to fetch the pinned base images, source archives, and package dependencies.
Digest-based sandbox use requires a Docker image store that retains repository digests for local builds, such as the tested containerd store.

From the repository root:

```sh
mkdir -p .build
docker buildx bake openclaw --load --metadata-file .build/agent-images.json
docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Examples that omit `image` use the SDK pin for their selected harness from `versions.json`.
Hermes uses `images.hermes`; other harnesses use `images.agent`.
The selected image must still exist on the compute daemon.
The sandbox compute daemon must have access to that exact image.
Build metadata records the exported digest separately under the target's `containerimage.digest` key.
The commands build and load local images; they do not publish images or launch a deployment.

On a native Linux AMD64 host, build the general-purpose Deep Agents runtime with the platform selector:

```sh
mkdir -p .build
AGENT_PLATFORM=linux/amd64 docker buildx bake deepagents --load --metadata-file .build/agent-images-amd64.json
docker image inspect nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Replace `deepagents` with `openclaw` to build the other qualified AMD64 harness.
Run `AGENT_PLATFORM=linux/amd64 docker buildx bake agents --load` to build both.
The AMD64 builds and image tests do not establish successful gateway provisioning or an end-to-end agent response.

Select `hermes`, `pi`, or another name from the [harness matrix](reference/fabric-harnesses.md), or build every agent with `docker buildx bake agents --load`.
`docker buildx bake ollama-proxy --load` builds the separate proxy image as `nc-fabric:ollama-proxy`.
Set `IMAGE_PREFIX=nc-my-build` before Bake to use your own local repository name without replacing another build's tags.

[The Bake file](../docker-bake.hcl) selects the target platform, qualified harnesses, dependency locks, and named stages in the [shared agent Dockerfile](../image/fabric/Dockerfile).
Common Fabric wheels and base layers are shared; selected images contain only their required harness dependencies.
The builder verifies archive and wheel hashes, retains upstream archives and local build sources under `/opt/nemoclaw/source/`, and records local source hashes in `/opt/nemoclaw/provenance.json`.
The [source notice](../image/NOTICE.md) describes the retained local patches and licenses.
Pinned archives and wheels do not make the whole image bit-reproducible: Debian packages still come from the configured repositories.

Run [image checks](testing.md#image-source-checks) before changing or using an image recipe, and follow the [native fixture procedures](testing/fixtures.md#inference-api-fixtures) for behavior qualification.

## Build a Runtime Image

Runtime image builds require Linux, Docker, and Buildx.
The build host must match the artifact manifest's `platform`; omission selects `linux_arm64`, and `linux_amd64` requires a native AMD64 host.
The builder rejects a mismatched host before building the supervisor or loading an image.
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

For the AMD64 vLLM base used by the [Nemotron example](models.md#configure-nemotron-on-an-amd64-gpu-host), run on a Linux AMD64 build host:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/vllm-amd64/build.json
```

This build exports `.build/vllm-amd64/runtime.tar` and loads `nc-prototype-vllm-amd64:rust-v1`.
It adds the same supervisor to the pinned AMD64 vLLM 0.27.1 base and includes no preparation tools or model weights.
Selecting this artifact does not qualify GPU inference on the host.

For Qwen3.8 preparation on Linux ARM64, run:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/qwen38/build.json
```

This build exports `.build/qwen38/runtime.tar` and loads `nc-prototype-qwen38:spark-rust-v1`.
Its Dockerfile applies pinned patches and retains original and modified sources.
Use [the inline recipe guide](recipes.md) to declare preparation and serving requirements.

Use the immutable OCI manifest digest in the build output for `service.image`.
Do not substitute a mutable tag or a digest copied from another build.
If the selected daemon is remote, load the archive into that daemon before apply; a local image is not available there automatically.

## Retained Sources and Compatibility

The builder creates a source archive with normalized timestamps and compiles the supervisor offline from that archive.
It includes the Rust workspace, locked dependencies, their licenses, SDK policy attribution, and OpenShell protobuf inputs omitted by Cargo vendoring.
It excludes the entire `runtimes/` tree, so the supervisor archives contain no recipe scripts.
Each image separately retains its selected Dockerfile and build manifest under `/opt/nemoclaw/source/`.
The Qwen3.8 image also retains its preparation tools, upstream recipe, licenses, and modified vLLM sources.
The build excludes dependency paths and parent Git metadata from compiler inputs.

The [ARM64 vLLM notice](../runtimes/vllm/NOTICE.md), [AMD64 vLLM notice](../runtimes/vllm-amd64/NOTICE.md), and [Qwen3.8 notice](../runtimes/qwen38/NOTICE.md) identify retained sources and licenses.

Generated bundles, build inputs, and images are ignored by Git.
Model snapshots and prepared data belong to the deployment’s persistent volume, outside the build context.

The image contains `nemoclaw-runtime`.
The inline recipe supplies preparation and verification tools; `backend: vllm` selects serving behavior.
Managed containers use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
The former `nemoclaw-spark` entrypoint and `NEMOCLAW_SPARK_SPEC` environment alias are no longer accepted.
