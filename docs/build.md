<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build Local Artifacts

Build from the repository root with Rust 1.98.1, pinned in [rust-toolchain.toml](../rust-toolchain.toml).
Native bundles also require Protocol Buffers compiler 36.1.
Native builds also require a C toolchain for TLS dependencies.
Run `cargo ci tools` to install the pinned compiler in `.tools/protoc-36.1`; the bundle builder and `cargo ci` find it there.
Otherwise, set `PROTOC` to the compiler’s path if it is outside `PATH`.
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
Pass `--platform linux/arm64` or `--platform linux/amd64` to the agent image builder.
Direct Bake checks and proxy builds require the corresponding `AGENT_PLATFORM` environment variable.
ARM64 selects all ten harnesses; AMD64 selects Deep Agents and OpenClaw.
The remaining harnesses are ARM64-only until their pinned native dependencies have matching AMD64 artifacts and qualification.
Agent images use Node.js 24.21.0 LTS and a shared Python 3.13.15 base.
Image qualification checks that interpreter against every Python adapter’s declared version range in the pinned Fabric source.
Build stages use pinned Rust, Node, Python, and uv images, so the host needs no language toolchains for image assembly.
Initial builds need network access to fetch the pinned base images, source archives, and package dependencies.
Digest-based sandbox use requires a Docker image store that retains repository digests for local builds, such as the tested containerd store.

On a native Linux ARM64 host, run from the repository root:

```sh
python3 image/build_fabric.py --platform linux/arm64 openclaw
docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Examples that omit `image` use the generic default agent image pin from `versions.json`.
Select an explicit image containing the chosen Fabric adapter; a harness identifier does not select a different image.
The selected image must still exist on the compute daemon.
The sandbox compute daemon must have access to that exact image.
The builder starts a temporary process with networking disabled to read installed Fabric discovery metadata, then labels the final local image.
It removes its temporary image tag after completion; it does not start an adapter or request model responses.
The commands build and load local images; they do not publish images or launch a deployment.

Installed discovery also requires the image-owned runtime manifest and resolves descriptor-required executables inside the image.
If catalog generation reports a missing runtime manifest, required path, or executable, correct the image recipe before retrying.
See the [image metadata contract](../image/NOTICE.md) before changing the image layout.

Plan requires the selected image's runtime metadata to supply its bridge command, environment, default policy, and executable grants.
For an external gateway, also set `spec.gateway.engine` to the engine containing that same immutable sandbox image; NemoClaw does not assume the client host's Docker socket.
This engine is used only for image inspection and does not authorize managing the external gateway.
A missing image, missing metadata, or omitted external engine stops planning with a diagnostic; load a matching image or rebuild it, then retry.
Keep the original bundle and state to operate or destroy deployments created before runtime metadata was retained; this change does not migrate their sandbox bindings.

On a native Linux AMD64 host, build the general-purpose Deep Agents runtime with the platform selector:

```sh
python3 image/build_fabric.py --platform linux/amd64 deepagents
docker image inspect nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Replace `deepagents` with `openclaw` to build the other qualified AMD64 harness.
Run `python3 image/build_fabric.py --platform linux/amd64 agents` to build both.
The AMD64 builds and image tests do not establish successful gateway provisioning or an end-to-end agent response.

On ARM64, select `hermes`, `pi`, or another name from the [harness matrix](reference/fabric-harnesses.md), or build every agent with `python3 image/build_fabric.py --platform linux/arm64 agents`.
`AGENT_PLATFORM=linux/arm64 docker buildx bake ollama-proxy --load` builds the separate proxy image as `nc-fabric:ollama-proxy`; select `linux/amd64` on an AMD64 host.
The proxy and its `proxy-tests` target use the same explicit platform selector.
Set `IMAGE_PREFIX=nc-my-build` before the builder to use your own local repository name without replacing another build's tags.

[The Bake file](../docker-bake.hcl) selects the target platform, qualified harnesses and named stages in the [shared agent Dockerfile](../image/fabric/Dockerfile).
Common Fabric wheels and base layers are shared; images other than Hermes export dependencies from Fabric's frozen root lock, selecting the Python adapter's extra when present.
Hermes retains a separate native dependency supplement, described in the [source notice](../image/NOTICE.md).
The exact Python base-image pins remain image-build inputs; uv validates installed adapter `Requires-Python` constraints.
The builder verifies archive and wheel hashes, retains upstream archives and local build sources under `/opt/nemoclaw/source/`, and records local source hashes in `/opt/nemoclaw/provenance.json`.
The [source notice](../image/NOTICE.md) describes retained sources and licenses.
Pinned archives and wheels do not make the whole image bit-reproducible: Debian packages still come from the configured repositories.

Run [image checks](testing.md#image-source-checks) before changing or using an image recipe, and follow the [native fixture procedures](testing/fixtures.md#inference-api-fixtures) for behavior qualification.

### Reference Contract Image

Build the dummy `fabric-agent` image to exercise the provisioning interface without Fabric, a native agent, credentials, or a model.
It uses the same command host as all ten interim adapter images and supplies a deterministic reference backend.
It is a test fixture, excluded from the production `agents` target and SDK harness catalog.
On Linux ARM64, run from the repository root:

```sh
IMAGE_PREFIX=nc-contract python3 image/build_fabric.py --platform linux/arm64 dummy
python3 image/qualify_contract.py nc-contract:dummy
```

Use `linux/amd64` on a native AMD64 host.
The qualifier uses the inspected image ID and an owned disposable container with networking disabled, a read-only root filesystem, and temporary writable sandbox storage.
It removes that container on success, failure, or timeout; the built image remains local.
The suite exercises standalone validation and all six commands, including generation conflicts and readiness failure that preserves the configured runtime.
The [contract description](design/fabric-management.md#image-contract-and-reference-implementation) defines the dummy's settings and the real adapter backend boundary.

To roll the same interface into all ten production adapter images on a native Linux ARM64 host, run:

```sh
IMAGE_PREFIX=nc-contract python3 image/build_fabric.py --platform linux/arm64 agents
python3 image/qualify_contract.py nc-contract:openclaw nc-contract:hermes nc-contract:pi
```

Pass each remaining built image to the same qualifier; CI runs it for every selected target.
On a native Linux AMD64 host, build and qualify its two production targets instead:

```sh
IMAGE_PREFIX=nc-contract python3 image/build_fabric.py --platform linux/amd64 agents
python3 image/qualify_contract.py nc-contract:deepagents nc-contract:openclaw
```

The build adds a versioned `io.nemoclaw.fabric.bridge` label to every image, matching `/opt/nemoclaw/bridge.json`.
Production images additionally retain their Fabric discovery catalog.
A passing command contract does not establish native readiness: production backends still report unsupported health at the pinned Fabric revision.
See [upstream ownership](design/fabric-management.md#upstream-ownership) for the remaining Fabric and OpenShell work.

## Build a Runtime Image

Runtime image builds require Linux, Buildx, and a Docker daemon using the containerd image store.
Use `--no-default-features` below to compile the runtime builder without the SDK or Protocol Buffers compiler.
Run `docker info --format '{{json .DriverStatus}}'` against the selected daemon and check for `["driver-type","io.containerd.snapshotter.v1"]`.
The builder checks this requirement before downloading sources or compiling the supervisor.
Docker's classic image store is unsupported; use a daemon configured with the [containerd image store](https://docs.docker.com/engine/storage/containerd/) before retrying.
The builder does not change Docker configuration.
The artifact manifest must set `platform` to `linux_arm64` or `linux_amd64`; omission is rejected.
The build host must match that platform, which selects both the supervisor's Rust compilation target and the image platform.
The builder rejects a mismatched host before building the supervisor or loading an image.
The artifact manifest selects its Dockerfile, local inputs, immutable source downloads, image name, and reproducible timestamp.
It downloads pinned sources and dependencies, builds locally, and loads the image into the selected Docker daemon.

It does not launch inference or publish an image.

For ordinary safetensors models on Linux ARM64, run:

```sh
cargo run -p nemoclaw-build --no-default-features -- runtime runtimes/vllm/build.json
```

This build exports `.build/vllm/runtime.tar` and loads `nc-prototype-vllm:rust-v1`.
The image contains the shared supervisor and pinned vLLM base, without Qwen3.8 patches or preparation tools.
Select the model through [model configuration](models.md).

For the AMD64 vLLM base used by the [Nemotron example](models.md#configure-nemotron-on-an-amd64-gpu-host), run on a Linux AMD64 build host:

```sh
cargo run -p nemoclaw-build --no-default-features -- runtime runtimes/vllm-amd64/build.json
```

This build exports `.build/vllm-amd64/runtime.tar` and loads `nc-prototype-vllm-amd64:rust-v1`.
It adds the same supervisor to the pinned AMD64 vLLM 0.27.1 base and includes no preparation tools or model weights.
Selecting this artifact does not qualify GPU inference on the host.

For Qwen3.8 preparation on Linux ARM64, run:

```sh
cargo run -p nemoclaw-build --no-default-features -- runtime runtimes/qwen38/build.json
```

This build exports `.build/qwen38/runtime.tar` and loads `nc-prototype-qwen38:spark-rust-v1`.
Its Dockerfile applies pinned patches and retains original and modified sources.
Use [the inline recipe guide](recipes.md) to declare preparation and serving requirements.

The builder exports an OCI archive, loads it, and verifies access by its exported digest and target platform.
It sets `org.nemoclaw.runtime.spec=v1` from the shared runtime contract and verifies that label on the loaded image.
The retained `supervisor.json` records the same `runtimeSpecVersion` alongside the runtime source version.
Use the immutable image reference printed as `Runtime image loaded: NAME@sha256:DIGEST` for `spec.services.<name>.image`.
Do not substitute a mutable tag or a digest copied from another build.
If deployment uses a different Docker daemon, load the archive into that daemon before apply; images are not transferred automatically.

## Retained Sources and Compatibility

Source collection may download the pinned dependency sources through Cargo.
The builder creates a source archive with normalized timestamps and compiles the supervisor offline from that archive.
It contains the runtime crate, its standalone workspace manifest and pruned lockfile, Cargo-vendored dependencies with their licenses, and runtime policy attribution.
The archive excludes the SDK, provider, OpenShell, Fabric, onboarding, and image recipes.
The runtime source version covers only these runtime build inputs; changes to other repository components do not change it.
Each image separately retains its selected Dockerfile and build manifest under `/opt/nemoclaw/source/`.
The Qwen3.8 image also retains its preparation tools, upstream recipe, licenses, and modified vLLM sources.
The build excludes dependency paths and parent Git metadata from compiler inputs.

The [ARM64 vLLM notice](../runtimes/vllm/NOTICE.md), [AMD64 vLLM notice](../runtimes/vllm-amd64/NOTICE.md), and [Qwen3.8 notice](../runtimes/qwen38/NOTICE.md) identify retained sources and licenses.

Generated bundles, build inputs, and images are ignored by Git.
Model snapshots and prepared data belong to the deployment’s persistent volume, outside the build context.

The image contains `nemoclaw-runtime`.
The inline recipe supplies preparation and verification tools; `kind: vllm` selects the service installer and serving behavior.
Managed containers use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
The former `nemoclaw-spark` entrypoint and `NEMOCLAW_SPARK_SPEC` environment alias are no longer accepted.

The SDK checks a managed vLLM or Ollama image's runtime-spec label, required backend/recipe/authentication labels, and platform through the provider before creating runtime resources.
An already loaded image with a missing or incompatible runtime-spec label fails plan and apply with rebuild guidance.
When the image must be acquired, plan reports compatibility as deferred; apply may pull the image, then checks it before creating storage, networks, or containers.
A matching label establishes the declared runtime contract, not successful model loading or inference.

For a runtime-spec mismatch, rebuild the selected artifact from the bundle's source revision using the matching vLLM platform/recipe command above or the [managed Ollama build instructions](inference.md#run-managed-ollama).
Load the rebuilt image on the execution daemon and update `spec.services.<name>.image` to the newly printed digest.
Keep the deployment state and reapply; existing model and credential storage remain subject to their ordinary retention and identity checks.
Destroy omits image compatibility gates so a mismatched image alone does not prevent cleanup.
The runtime also reports its expected specification version and declared field location for invalid input, without echoing configuration values or user-defined map keys.

Developers must increment `nemoclaw_runtime::SPEC_VERSION` when serialized fields or validation changes make the runtime contract incompatible.
The image builder, SDK requirements, and provider check share that constant; the label does not identify an exact source revision.
