<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Build Local Artifacts

Build from the repository root with Rust 1.98.1, pinned in [rust-toolchain.toml](../rust-toolchain.toml).
Native bundles also require Protocol Buffers compiler 36.1.
Native builds also require a C toolchain for TLS dependencies.
Run `cargo ci tools` to install the pinned compiler in `.tools/protoc-36.1`; the bundle builder and `cargo ci` find it there.
Otherwise, set `PROTOC` to the compiler’s path if it is outside `PATH`.
[versions.json](../versions.json) records tool versions, download checksums, and the SDK's image pins: the default agent image, which `image.ref` replaces, and the gateway, sandbox runtime, and supervisor images, which documents do not name.
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
ARM64 selects all ten harnesses; AMD64 selects Deep Agents and OpenClaw.
The remaining harnesses are ARM64-only until their pinned native dependencies have matching AMD64 artifacts and qualification.
Agent images share a Python 3.13.15 base without pip.
Only OpenClaw, Hermes, and Pi add Node.js 24.21.0 LTS: OpenClaw's CLI and Pi's adapter run on it, and Hermes's browser tool and `npx`-launched MCP servers require it.
Image qualification checks that interpreter against every Python adapter’s declared version range in the pinned Fabric source.
Build stages use pinned Rust, Node, Python, and uv images, so the host needs no language toolchains for image assembly.
Initial builds need network access to fetch the pinned base images, source archives, and package dependencies.
Digest-based sandbox use requires a Docker image store that retains repository digests for local builds, such as the tested containerd store.

On a native Linux ARM64 host, run from the repository root:

```sh
cargo images build --platform linux/arm64 openclaw
docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Examples that omit `image` use the generic default agent image pin from `versions.json`.
Select an explicit image containing the chosen Fabric adapter; a harness identifier does not select a different image.
The selected image must still exist on the compute daemon.
The sandbox compute daemon must have access to that exact image.
The builder starts a temporary process with networking disabled to read installed Fabric discovery metadata, then labels the final local image.
It removes its temporary image tag after completion; it does not start an adapter or request model responses.
Direct `docker buildx bake` builds omit these labels, so plan cannot select them.
The commands build and load local images; they do not publish images or launch a deployment.

Installed discovery also requires the image-owned runtime manifest and resolves descriptor-required executables inside the image.
If catalog generation reports a missing runtime manifest, required path, or executable, correct the image recipe before retrying.
See the [image metadata contract](design/fabric-management.md#image-metadata) before changing the image layout.

Plan requires the selected image's runtime metadata to supply its `fabric-agent-ctl` command, environment, default policy, and executable grants.
For an external gateway, also set `spec.gateway.engine` to the engine containing that same immutable sandbox image; NemoClaw does not assume the client host's Docker socket.
This engine is used only for image inspection and does not authorize managing the external gateway.
A missing image, missing metadata, or omitted external engine stops planning with a diagnostic; load a matching image or rebuild it, then retry.

On a native Linux AMD64 host, build the general-purpose Deep Agents runtime with the platform selector:

```sh
cargo images build --platform linux/amd64 deepagents
docker image inspect nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

Use the printed immutable reference in `sandboxes[].image.ref`.
Replace `deepagents` with `openclaw` to build the other qualified AMD64 harness.
Run `cargo images build --platform linux/amd64 agents` to build both.
The AMD64 builds and image tests do not establish successful gateway provisioning or an end-to-end agent response.

On ARM64, select `hermes`, `pi`, or another name from the [harness matrix](reference/fabric-harnesses.md), or build every agent with `cargo images build --platform linux/arm64 agents`.
`AGENT_PLATFORM=linux/arm64 docker buildx bake ollama-proxy --load` builds the separate proxy image as `nc-fabric:ollama-proxy`; select `linux/amd64` on an AMD64 host.
The proxy and its `proxy-tests` target use the same explicit platform selector.
The proxy image holds only the statically linked `nemoclaw-ollama-proxy` binary from [its crate](../crates/nemoclaw-ollama-proxy) and its license, with no shell or interpreter.
Set `IMAGE_PREFIX=nc-my-build` before the builder to use your own local repository name without replacing another build's tags.

A Kubernetes or OpenShift sandbox names a metadata bundle in `image.metadata`, since no local engine can be inspected there.
Write one for a local image with `cargo images export-metadata IMAGE --platform linux/arm64 --output PATH`, where `PATH` is a new file.
The bundle holds the image's index, the manifest for that platform and its configuration, and no layers; the SDK checks it against the digest in `image.ref`.
Run it before pushing the image, and use the same digest in `image.ref`.

[The Bake file](../docker-bake.hcl) selects the target platform, qualified harnesses and named stages in the [shared agent Dockerfile](../image/fabric/Dockerfile).
Common Fabric wheels and base layers are shared; images other than Hermes export dependencies from Fabric's frozen root lock, selecting the Python adapter's extra when present.
Hermes retains a separate native dependency supplement, described in the [source notice](../image/NOTICE.md).
The exact Python base-image pins remain image-build inputs; uv validates installed adapter `Requires-Python` constraints.
The builder verifies archive and wheel hashes, retains upstream archives and local build sources under `/opt/nemoclaw/source/`, and records local source hashes in `/opt/nemoclaw/provenance.json`.
The [source notice](../image/NOTICE.md) describes retained sources and licenses.
Pinned archives and wheels do not make the whole image bit-reproducible: Debian packages still come from the configured repositories.

Run [image checks](contributing/testing.md#image-source-checks) before changing or using an image recipe, and follow the [native fixture procedures](contributing/integration-tests.md#inference-api-fixtures) for behavior qualification.

### Update the OpenClaw Pin

OpenClaw's npm package has no lockfile, so the agent image copies `/app` from OpenClaw's published image, pinned by digest in `OPENCLAW_IMAGE` in [the Dockerfile](../image/fabric/Dockerfile).
When an agent starts, Fabric's OpenClaw adapter refuses versions outside `SUPPORTED_OPENCLAW_VERSIONS` in the pinned Fabric source.
When you change the Fabric pin, check that set; if it changed, pin the digest of OpenClaw's published image for a supported version, then rebuild and qualify the OpenClaw image.

### Regenerate the Bundled Catalog

The SDK build fails with `stale Fabric catalog` when `image/fabric/catalog.json` no longer matches the Fabric pin in the Dockerfile.
Run `image/fabric/catalog.py` with a Python environment that has the pinned Fabric wheels installed, and pass that revision and checksum:

```sh
python image/fabric/catalog.py --revision REVISION --source-sha256 CHECKSUM --output image/fabric/catalog.json
```

Use the values of `FABRIC_REVISION` and `FABRIC_SHA256` from the [shared agent Dockerfile](../image/fabric/Dockerfile).
The snapshot holds canonical descriptors and provenance only; it does not change any image.

### Reference Contract Image

Build the dummy image to exercise the provisioning interface with Fabric's real runtime and `fabric-agent-ctl`, but no native agent, credentials, or model.
It installs NemoClaw's test-only Fabric adapter, a deterministic agent, the way the production images install Fabric's adapters.
It is a test fixture, excluded from the production `agents` target and the bundled catalog.
Its image catalog lists the adapter's [descriptor](../image/fabric/test-adapter/dummy.fabric-adapter.json), so a deployment can run it by setting `harness.kind: org.nemoclaw.dummy` and the image's immutable reference; the [Docker live suite](contributing/live-tests.md#dummy-agent-lifecycle) deploys it that way.
On Linux ARM64, run from the repository root:

```sh
IMAGE_PREFIX=nc-contract cargo images build --platform linux/arm64 dummy
cargo images qualify nc-contract:dummy --lifecycle dummy
```

Use `linux/amd64` on a native AMD64 host.
The qualifier uses the inspected image ID and an owned disposable container with networking disabled, a read-only root filesystem, and temporary writable sandbox storage.
It removes that container on success, failure, or timeout; the built image remains local.
The suite starts, invokes, and stops one runtime through `fabric-agent-ctl`, and checks that the image refuses a second runtime.
The [contract description](design/fabric-management.md#image-contract-and-reference-implementation) defines the dummy's settings.

To roll the same interface into all ten production adapter images on a native Linux ARM64 host, run:

```sh
IMAGE_PREFIX=nc-contract cargo images build --platform linux/arm64 agents
cargo images qualify nc-contract:openclaw --lifecycle openclaw
cargo images qualify nc-contract:hermes --lifecycle hermes
cargo images qualify nc-contract:pi --lifecycle pi
```

Pass each remaining built image to the same qualifier; CI runs it for every selected target.
On a native Linux AMD64 host, build and qualify its two production targets instead:

```sh
IMAGE_PREFIX=nc-contract cargo images build --platform linux/amd64 agents
cargo images qualify nc-contract:deepagents
cargo images qualify nc-contract:openclaw --lifecycle openclaw
```

The build adds the `io.nemoclaw.fabric.catalog` label to every image.
The `--lifecycle` profile selects adapter configuration and invocation input; the lifecycle assertions are shared with the dummy.
OpenClaw, Hermes, and Pi run their installed native adapters against an owned loopback inference server inside the network-isolated container.
The suite starts one runtime through `fabric-agent-ctl`, checks a native reply, stops it, and checks that the image refuses a second runtime.
Other production images report the unselected lifecycle scenario as skipped.
The dummy selects its lifecycle profile automatically; an explicit profile makes the intended coverage visible in CI.
A passing lifecycle does not establish that a runtime stays healthy: Fabric reports no runtime status.
See [upstream ownership](design/fabric-management.md#upstream-ownership) for the remaining Fabric and OpenShell work.

To extend an agent image with your own skills and tools, see [derived agent images](derived-images.md).

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

The image contains the shared supervisor and the pinned multi-platform vLLM base for the build host's architecture, without model-specific patches or preparation tools; the [Nemotron example](models.md#configure-nemotron-on-an-amd64-gpu-host) uses the AMD64 build.
Select the model through [model configuration](models.md).
Selecting this artifact does not qualify GPU inference on the host.

A model that needs preparation tools or patches uses an image its recipe's authors build; see [inline recipes](recipes.md).

`docker buildx bake ollama` builds the [managed Ollama](inference.md#run-managed-ollama) image, and `docker buildx bake runtimes` builds both.
Use the `NAME@sha256:DIGEST` reference that `docker image inspect` prints for `spec.services.<name>.image`.
Builds use fixed timestamps, so rebuilding the same sources keeps the same digest.
Do not substitute a mutable tag or a digest copied from another build.
If deployment uses a different Docker daemon, transfer the image there before apply, for example with `docker save` and `docker load`; images are not transferred automatically.

## Retained Sources and Compatibility

The supervisor build, `image/supervisor/Dockerfile`, packages the runtime crate with Cargo, vendors its locked dependency sources, and compiles the supervisor offline from that archive.
The archive contains the runtime crate, its standalone workspace manifest and pruned lockfile, Cargo-vendored dependencies with their licenses, and runtime policy attribution.
It excludes the SDK, provider, OpenShell, Fabric, onboarding, and agent images.
Each runtime image retains the archive, the license, its own Dockerfile and notice, and the supervisor's Dockerfile under `/opt/nemoclaw/source/`.

The [vLLM notice](../image/vllm/NOTICE.md) and [Ollama notice](../image/ollama/NOTICE.md) identify retained sources and licenses.

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

Developers must increment `nemoclaw_runtime::SPEC_VERSION` when serialized fields or validation changes make the runtime contract incompatible.
The supervisor, SDK requirements, and provider check share that constant; the label does not identify an exact source revision.
