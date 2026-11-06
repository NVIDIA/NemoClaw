<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build Local Artifacts

Build from the repository root with Rust 1.99.1, pinned in [rust-toolchain.toml](../../rust-toolchain.toml).
Native bundles also require Protocol Buffers compiler 36.2.
Native builds also require a C toolchain for TLS dependencies.
Run `cargo ci tools` to install the pinned compiler in `.tools/protoc-36.2`; `cargo ci` finds it there.
Other Cargo commands, including the bundle builder's `cargo run`, find only a compiler on `PATH`; otherwise set `PROTOC` to `.tools/protoc-36.2/bin/protoc` or another protoc 36.2.
[versions.json](../../versions.json) records tool versions, download checksums, and the SDK's image pins: the default agent image, which `image.ref` replaces, and the gateway, sandbox runtime, and supervisor images, which documents do not name.
The SDK generates its artifact constants from that manifest at build time.
A Docker or Podman deployment keeps the gateway image pin of the bundle that created it; see [the change path](usage.md#choose-the-change-path) before operating it with a bundle built from a different pin.

## Build a Native Bundle

Use a separate `target` directory in each worktree; do not symlink it to another checkout or share `CARGO_TARGET_DIR` between revisions.
The bundle builder uses the current worktree's `target` directory.
Share downloaded dependencies through Cargo's cache instead of sharing compiled workspace artifacts.

Run the bundle builder:

```sh
cargo run -p nemoclaw-build -- bundle
```

The builder downloads and verifies the pinned OpenTofu, Docker provider, and Helm provider archives, builds the CLI and the NemoClaw, OpenShell, and Fabric providers with the lockfile, and writes `dist/<platform>`.
The manifest records each shipped file's hash, including the unchanged upstream licenses.
The SDK verifies the bundle before use.
A `Deployment` hashes the bundle on its first operation and again only when the manifest or a file it lists is written, replaced, or removed.
Managed Kubernetes deployment uses the bundled Helm provider and requires no host Helm CLI.

Each bundle includes `schemas/nemoclaw-v1alpha1.schema.json`, generated from its SDK contract and covered by the manifest hash.
Use that file for [editor assistance](usage.md#editor-schema-assistance) with the bundled CLI.
The API version alone does not identify a source revision.

The builder records its source fingerprint at compilation and rejects changed inputs before bundle assembly.
If it reports `build tool source inputs changed`, rebuild and run it with the `cargo run` command above.
The builder also rejects source changes during assembly.
Bundles created before schema packaging must be rebuilt; the SDK rejects a manifest that omits the schema or a schema file that fails its recorded hash.
It also rejects bundles missing the pinned Helm provider or its license, or whose recorded hashes fail verification.

A source-derived provider version prevents reuse of a stale OpenTofu provider installation.

To select a target, pass `bundle --platform PLATFORM`.
The target names are `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64`.
Building another target requires its Rust standard library, linker, and native SDK.
Target selection alone does not qualify a runtime on that platform.

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
If retiring a deployment too, follow [destroy and retention](usage.md#destroy) first, then [Remove Retained Resources](usage.md#remove-retained-resources), keeping its state for anything that procedure does not cover ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
Then remove that dedicated bundle directory using your host's file manager and remove only its `bin` entry from your shell's `PATH` configuration.
Open a new terminal and check `command -v nemoclaw` on a POSIX shell, or `Get-Command nemoclaw` in PowerShell, to identify any remaining installation.

Do not delete deployment state, model volumes, unrelated tool installations, or shared caches as part of removing the local bundle.
Rebuild a bundle from the recorded source revision if the removed tools are needed again; compatibility with another revision is not implied.

## Build Agent Images

Use Docker with Buildx on a native host that matches the selected image target.
Pass `--platform linux/arm64` or `--platform linux/amd64` to the agent image builder.
Direct Bake builds and checks use the host's platform unless the `AGENT_PLATFORM` environment variable selects the other one.
Both platforms build every harness in the Bake file's `HARNESSES` map.
Agent images share a Python 3.14.10 base without pip.
Only OpenClaw, Hermes, Pi, and Deep Agents Code add Node.js 24.22.2 LTS: OpenClaw's CLI and the Pi and Deep Agents Code adapters run on it, and Hermes's browser tool and `npx`-launched MCP servers require it.
The Deep Agents Code image also installs `dcode` in its own Python 3.14 environment, `/opt/deepagents-code`, from [its lock](https://github.com/NVIDIA/NemoClaw/blob/86b8d94273a76a696e06b300dc29f7035b163667/image/fabric/deepagents-code/uv.lock).
Image qualification checks that interpreter against every Python adapter’s declared version range in the pinned Fabric source.
Build stages use pinned Rust, Node, Python, and uv images, so the host needs no language toolchains for image assembly.
Initial builds need network access to fetch the pinned base images, source archives, and package dependencies.
Digest-based sandbox use requires a Docker image store that retains repository digests for local builds, such as the tested containerd store.

On a native Linux ARM64 host, run from the repository root:

```sh
cargo images build --platform linux/arm64 openclaw
docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes.<name>.image.ref`.
Examples that omit `image` use the generic default agent image pin from `versions.json`.
Select an explicit image containing the chosen Fabric adapter; a harness identifier does not select a different image.
The selected image must still exist on the compute daemon.
The sandbox compute daemon must have access to that exact image.
The builder first builds the image's `catalog` stage, which reads the installed Fabric discovery metadata with networking disabled, then builds the image's `labeled` stage with that metadata as its label; the build checks the label against the installed metadata.
Both builds reuse the same cached layers, and neither starts an adapter or requests model responses.
A direct `docker buildx bake` build of an agent target omits the label, so plan cannot select it.
The commands build and load local images; they do not publish images or launch a deployment.

Installed discovery also requires the image-owned runtime manifest and resolves descriptor-required executables inside the image.
If catalog generation reports a missing runtime manifest, required path, or executable, correct the image recipe before retrying.
See the [image metadata contract](../../internal-docs/design/fabric-management.md#image-metadata) before changing the image layout.

Plan requires the selected image's runtime metadata to supply its `fabric-agent-ctl` command, environment, default policy, and executable grants.
For an external gateway, also set `spec.gateway.engine` to the engine containing that same immutable sandbox image; NemoClaw does not assume the client host's Docker socket.
This engine is used only for image inspection and does not authorize managing the external gateway.
A missing image, missing metadata, or omitted external engine stops planning with a diagnostic; load a matching image or rebuild it, then retry.

On a native Linux AMD64 host, build the general-purpose Deep Agents runtime with the platform selector:

```sh
cargo images build --platform linux/amd64 deepagents
docker image inspect nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes.<name>.image.ref`.
Replace `deepagents` with another harness name, or use `agents` to build them all.
The AMD64 builds and image tests do not establish successful gateway provisioning or an end-to-end agent response.

On ARM64, select `hermes`, `pi`, or another name from the [harness matrix](../references/fabric-harnesses.md), or build every agent with `cargo images build --platform linux/arm64 agents`.
`AGENT_PLATFORM=linux/arm64 docker buildx bake ollama-proxy --load` builds the separate proxy image as `nc-fabric:ollama-proxy`; select `linux/amd64` on an AMD64 host.
The proxy and its `proxy-tests` target use the same explicit platform selector.
The proxy image holds only the statically linked `nemoclaw-ollama-proxy` binary from [its crate](../../crates/nemoclaw-ollama-proxy) and its license, with no shell or interpreter.
Set `IMAGE_PREFIX=nc-my-build` before the builder to use your own local repository name without replacing another build's tags.

A Kubernetes or OpenShift sandbox names a metadata bundle in `image.metadata`, since no local engine can be inspected there.
Write one for a local image with `cargo images export-metadata IMAGE --output PATH`, where `PATH` is a new file.
The bundle holds the image's index, each Linux platform's manifest and configuration, and no layers; the SDK checks it against the digest in `image.ref`.
The platforms of an index must declare the same catalog, because the cluster chooses the platform each node runs.
Run it before pushing the image, and use the same digest in `image.ref`.
For an image already in a registry, pass `--registry` and its `HOST/REPOSITORY@sha256:DIGEST` reference instead; `NEMOCLAW_REGISTRY_USERNAME` and `NEMOCLAW_REGISTRY_PASSWORD`, when set, answer the registry's token challenge.

[The Bake file](../../docker-bake.hcl) selects the target platform, qualified harnesses and named stages in the [shared agent Dockerfile](../../image/fabric/Dockerfile).
Common Fabric wheels and base layers are shared; images other than Hermes export dependencies from Fabric's frozen root lock, selecting the Python adapter's extra when present.
Hermes retains a separate native dependency supplement, described in the [source notice](../../image/NOTICE.md).
The exact Python base-image pins remain image-build inputs; uv validates installed adapter `Requires-Python` constraints.
The builder verifies archive and wheel hashes, retains upstream archives and local build sources under `/opt/nemoclaw/source/`, and records local source hashes in `/opt/nemoclaw/provenance.json`.
The [source notice](../../image/NOTICE.md) describes retained sources and licenses.
Pinned archives and wheels do not make the whole image bit-reproducible: Debian packages still come from the configured repositories.

To extend an agent image with your own skills and tools, refer to [derived agent images](derived-images.md).

## Build a Runtime Image

Runtime images build with Docker Buildx Bake on a Linux ARM64 or AMD64 host, always for that host's platform, so the supervisor compiles natively rather than under emulation.
They require a Docker daemon using the containerd image store, which keeps each local image's digest.
Run `docker info --format '{{json .DriverStatus}}'` against the selected daemon and check for `["driver-type","io.containerd.snapshotter.v1"]`; Docker's classic image store is unsupported.
Build stages use pinned Rust and upstream images, so the host needs no Rust toolchain.
Initial builds need network access for the base images and the supervisor's dependency sources.
A build does not launch inference or publish an image.

For ordinary safetensors models, on a build host matching the model host:

```sh
docker buildx bake vllm
docker image inspect nc-prototype-vllm:rust-v1 --format '{{index .RepoDigests 0}}'
```

The image contains the shared supervisor and the pinned multi-platform vLLM base for the build host's architecture, without model-specific patches or preparation tools; the [Nemotron example](../agents-inference/models.md#configure-nemotron-on-an-amd64-gpu-host) uses the AMD64 build.
Select the model through [model configuration](../agents-inference/models.md).
Selecting this artifact does not qualify GPU inference on the host.

A model that needs preparation tools or patches uses an image its recipe's authors build; see [inline recipes](../agents-inference/recipes.md).

`docker buildx bake ollama` builds the [managed Ollama](../agents-inference/inference.md#run-managed-ollama) image, and `docker buildx bake runtimes` builds both.
Use the `NAME@sha256:DIGEST` reference that `docker image inspect` prints for `spec.services.<name>.image`.
Builds use fixed timestamps, so rebuilding the same sources keeps the same digest.
Do not substitute a mutable tag or a digest copied from another build.
If deployment uses a different Docker daemon, transfer the image there before apply, for example with `docker save` and `docker load`; images are not transferred automatically.

## Retained Sources and Compatibility

The supervisor build, `image/supervisor/Dockerfile`, packages the runtime crate with Cargo, vendors its locked dependency sources, and compiles the supervisor offline from that archive.
The archive contains the runtime crate, its standalone workspace manifest and pruned lockfile, Cargo-vendored dependencies with their licenses, and runtime policy attribution.
It excludes the SDK, provider, OpenShell, Fabric, onboarding, and agent images.
Each runtime image retains the archive, the license, its own Dockerfile and notice, and the supervisor's Dockerfile under `/opt/nemoclaw/source/`.

The [vLLM notice](../../image/vllm/NOTICE.md) and [Ollama notice](../../image/ollama/NOTICE.md) identify retained sources and licenses.

Generated bundles, build inputs, and images are ignored by Git.
Model snapshots and prepared data belong to the deployment’s persistent volume, outside the build context.

The image contains `nemoclaw-runtime`.
The inline recipe supplies preparation and verification tools; `kind: vllm` selects the service installer and serving behavior.
Managed containers use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.

The SDK checks a managed vLLM or Ollama image's required backend/recipe/authentication labels and platform with `host_image` before creating runtime resources.
Bearer vLLM also requires `org.nemoclaw.inference.routes=openai-v2`, which identifies a supervisor that serves the published port and forwards only authenticated inference requests and public `GET /health` to vLLM on loopback.
Rebuild earlier bearer images that lack this label; do not add the label to an image whose supervisor was built from an earlier revision.
An already loaded image with a missing or incompatible required label fails plan and apply, naming the label.
When the image must be acquired, plan reports compatibility as deferred; apply may pull the image, then checks it before creating storage, networks, or containers.
Matching labels establish the declared backend, recipe, and authentication, not successful model loading or inference.

An image built by a different NemoClaw revision may carry the right labels yet reject the runtime contract when its runtime starts, after the deployment has created the service's storage and network.
In either case, rebuild the selected image from the bundle's source revision with `docker buildx bake vllm` or `docker buildx bake ollama`, as above.
Load the rebuilt image on the execution daemon and update `spec.services.<name>.image` to its new digest.
Keep the deployment state and reapply; existing model and credential storage remain subject to their retention and identity checks.
Destroy omits image compatibility gates so a mismatched image alone does not prevent cleanup.
The runtime also reports its expected specification version and declared field location for invalid input, without echoing configuration values or user-defined map keys.
