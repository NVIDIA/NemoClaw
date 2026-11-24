<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Building NemoClaw From Source

This guide builds NemoClaw from a checkout of this repository.
It produces the native bundle, which holds the `nemoclaw` CLI with the OpenTofu, providers, and schema that the CLI runs, and the agent and runtime images that deployments run.
Every deployment needs a bundle and an agent image built from the same source revision.

## Choosing This Guide

For v0.1.0 on an archive target, [install the CLI bundle](../get-started/install.md) and use the images listed by digest in that release.
Build from source instead in the following situations:

| Situation | What to Build |
|---|---|
| You develop, test, or maintain NemoClaw | The bundle and images from your working revision |
| You need a revision that has no release | The bundle and images from that revision, following that revision's copy of this guide |
| Your client is a Mac with an Intel processor | The `darwin_amd64` bundle; [release archives](../get-started/install.md#choosing-the-archive) cover the other four platforms only |
| Your deployment runs the `claude` harness | Its agent image from the release's source revision, because releases do not include it |
| You want to compile and inspect the binaries yourself | Any artifact in this guide |

## Planning the Build

The following table lists what this guide builds and which deployments need each artifact:

| Artifact | Build Host | Result | Needed By |
|---|---|---|---|
| [Native bundle](#building-a-native-bundle) | The client's platform, or another target with its toolchain | `dist/PLATFORM`, with the CLI in `dist/PLATFORM/bin` | Every deployment, through the CLI or the [Rust SDK](../references/sdk.md) |
| [Agent image](#building-agent-images) | Native Linux ARM64 or AMD64, matching the sandbox host | A local image such as `nc-fabric:openclaw`, selected by digest in `sandboxes.<name>.image.ref` | Every sandbox |
| [Runtime image](#building-a-runtime-image) | Native Linux ARM64 or AMD64, matching the model host | A local image such as `nc-prototype-vllm:rust-v1`, selected by digest in `spec.services.<name>.image` | Deployments with a managed vLLM, Ollama, or llama.cpp service |

Build the artifacts in the following order:

1. [Prepare the build host](#preparing-the-build-host).
2. [Build the native bundle](#building-a-native-bundle) and check its CLI.
3. [Build an agent image](#building-agent-images) for each harness that the deployment runs.
4. If the deployment runs a managed model service, [build its runtime image](#building-a-runtime-image).
5. Continue with the [next steps](#next-steps).

## Preparing the Build Host

Run every command in this guide from the repository root.

| Artifact | Requirements |
|---|---|
| Native bundle | Rust 1.100.0, pinned in [rust-toolchain.toml](../../rust-toolchain.toml); Protocol Buffers compiler (`protoc`) 36.2; a C toolchain for the TLS dependencies |
| Agent images | Docker with Buildx on a native Linux ARM64 or AMD64 host; a Docker image store that retains repository digests for local builds, such as the tested containerd store; Rust, which runs the image builder and source downloader |
| Runtime images | Docker with Buildx on a Linux ARM64 or AMD64 host; a Docker daemon that uses the containerd image store; Rust for the Ollama and llama.cpp images, which fetch their pinned sources |

Initial builds need network access.
The bundle builder downloads pinned tool and provider archives, and image builds fetch pinned base images, source archives, and package dependencies.
Image build stages supply their own pinned toolchains.

[versions.json](../../versions.json) records tool versions, download checksums, and the SDK's image pins: the gateway, sandbox runtime, and supervisor images, which documents do not name.
The SDK generates its artifact constants from that manifest at build time.

### Installing the Pinned Protocol Buffers Compiler

To install `protoc` 36.2 in `.tools/protoc-36.2`, run:

```sh
cargo ci tools
```

The command also installs the test runner that `cargo ci` uses.
`cargo ci` finds the installed compiler.
Other Cargo commands, including the bundle builder, find only the compiler that `PROTOC` names or a `protoc` on `PATH`.
If no `protoc` 36.2 is on `PATH`, set `PROTOC` to the installed compiler's absolute path:

```sh
export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
```

In PowerShell, set `$env:PROTOC = "$PWD\.tools\protoc-36.2\bin\protoc.exe"` instead.
Cargo runs build scripts in their package directories, so a relative path does not resolve.
Another `protoc` 36.2 also works.

### Checking the Docker Image Store

To check that a Docker daemon uses the containerd image store, run the following command against that daemon:

```sh
docker info --format '{{json .DriverStatus}}'
```

The output includes `["driver-type","io.containerd.snapshotter.v1"]` when the daemon uses the containerd store.
Runtime images require the containerd image store.
Agent images require a store that retains repository digests for local builds, and containerd is the tested store.

## Building a Native Bundle

The bundle builder compiles the CLI and providers for one platform, then assembles them with their verified dependencies in `dist/PLATFORM`.

Before you build a bundle, check the following:

- The build host has the [native bundle requirements](#preparing-the-build-host), including `protoc` 36.2.
- This worktree has its own `target` directory.
  The builder uses the current worktree's `target` directory, so do not symlink it to another checkout or share `CARGO_TARGET_DIR` between revisions.
  To share downloaded dependencies, use Cargo's cache instead of compiled workspace artifacts.

To build a bundle for the host's platform and check its CLI, perform the following steps:

1. Build the bundle:

   ```sh
   cargo run --locked -p nemoclaw-build -- bundle
   ```

   The builder downloads and verifies the pinned OpenTofu, Docker provider, and Helm provider archives.
   It builds the CLI and the NemoClaw, NVIDIA OpenShell, and NVIDIA NeMo Fabric providers with the lockfile, then writes `dist/PLATFORM`.

   _Example Output_

   ```output
   Verified inputs assembled at dist/linux_arm64 (VERSION)
   ```

   Local builds report a development version derived from the source, such as `0.1.0-dev.5db7cd2995277923`. The release CI run for the tag supplies the release version.

2. Optional: Copy `dist/PLATFORM` to a dedicated directory, and use the copy in the following steps.

   Each build replaces `dist/PLATFORM`, and an operation needs its bundle to stay unchanged.
   Copy the bundle before a long live run.

3. Put the bundle's `bin` directory on `PATH` for this shell, replacing `PLATFORM` with the platform from the output.
   If you copied the bundle, use the copy's `bin` directory instead:

   ```sh
   export PATH="$PWD/dist/PLATFORM/bin:$PATH"
   ```

   In PowerShell, run `$env:Path = "$PWD\dist\windows_amd64\bin;$env:Path"` instead.

4. Check the CLI:

   ```sh
   nemoclaw --version
   nemoclaw --help
   ```

   `nemoclaw --version` prints the version from step 1, and `nemoclaw --help` lists `plan`, `apply`, and `destroy`.

Next, [build an agent image](#building-agent-images).

### Selecting Another Target Platform

The builder targets the host's platform unless `--platform` selects another one:

```sh
cargo run --locked -p nemoclaw-build -- bundle --platform linux_amd64
```

| `PLATFORM` | Client |
|---|---|
| `linux_arm64` | Linux on ARM64 |
| `linux_amd64` | Linux on AMD64 |
| `darwin_arm64` | macOS on Apple silicon |
| `darwin_amd64` | macOS on an Intel processor |
| `windows_amd64` | Windows on AMD64 |

Building another target requires its Rust standard library, linker, and native SDK.
Target selection alone does not qualify a runtime on that platform.
For the platforms that CI builds and tests, and the glibc requirement for Linux bundles, refer to [client and build tools](../get-started/prerequisites.md#client-and-build-tools).

### Bundle Contents and Verification

The bundle's `manifest.json` records the hash of each shipped file, including the unchanged upstream licenses.
The SDK verifies the bundle before use.
A `Deployment` hashes the bundle on its first operation, and again only when the manifest or a file that it lists is written, replaced, or removed.
Managed Kubernetes deployment uses the bundled Helm provider and requires no host Helm CLI.

Each bundle includes `schemas/nemoclaw-v1alpha1.schema.json`, generated from its SDK contract and covered by the manifest hash.
Use that file for [editor assistance](usage.md#editor-schema-assistance) with the bundled CLI.
The API version alone does not identify a source revision.

A source-derived provider version prevents reuse of a stale OpenTofu provider installation.
Repository text uses LF on every platform, so checkout newline conversion does not change source-derived provider versions.

Keep the bundle unchanged while an operation uses it.
A Docker or Podman deployment keeps the gateway image pin of the bundle that created it.
Before you operate it with a bundle built from a different pin, refer to [the change path](usage.md#choosing-the-change-path).

### Fixing Bundle Errors

| Message or Symptom | Cause | Action |
|---|---|---|
| `build tool source inputs changed; rebuild with cargo run --locked -p nemoclaw-build -- bundle` | The builder records its source fingerprint at compilation and rejects changed inputs before bundle assembly | Run the bundle command again; `cargo run` rebuilds the builder first |
| `source inputs changed during the build; no artifact published` | A source file changed while the builder assembled the bundle | Finish editing, then run the bundle command again |
| The SDK rejects a manifest that omits the schema | The bundle was created before schema packaging | Rebuild the bundle |
| The SDK rejects a schema or other file that fails its recorded hash, or a bundle without the pinned Helm provider or its license | A bundle file changed or is missing | Rebuild the bundle, and keep it unchanged during operations |

## Building Agent Images

Every sandbox requires `image.ref`: an agent image pinned by its immutable digest.
When building from source, build an image for each harness that the deployment runs.

Before you build an agent image, check the following:

- The build host has the [agent image requirements](#preparing-the-build-host): a native Linux host whose architecture, ARM64 or AMD64, matches the image you build.
- The Docker image store retains repository digests for local builds; [check the store](#checking-the-docker-image-store).

To build an agent image and select it, perform the following steps:

1. Choose a harness name from the [harness matrix](../references/fabric-harnesses.md), such as `openclaw`, `hermes`, `pi`, or `deepagents`, or choose `agents` to build every harness.

   Both platforms build every harness in the Bake file's `HARNESSES` map.
   Releases do not include a `claude` image: it bundles Anthropic's proprietary Claude Code CLI, which NVIDIA cannot redistribute.
   Build it on your host with `cargo images build --platform linux/arm64 claude`, or `linux/amd64` on an AMD64 host.

2. Build the image for the host's platform.
   On a native Linux ARM64 host, for example, build OpenClaw:

   ```sh
   cargo images build --platform linux/arm64 openclaw
   ```

   On a native Linux AMD64 host, for example, build the general-purpose Deep Agents runtime:

   ```sh
   cargo images build --platform linux/amd64 deepagents
   ```

   The AMD64 builds and image tests do not establish successful gateway provisioning or an end-to-end agent response.

3. Print the image's immutable reference.
   The image is `nc-fabric:HARNESS`; after building `agents`, inspect the image of each harness that the deployment runs:

   ```sh
   docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
   ```

   For the AMD64 example, inspect `nc-fabric:deepagents`.

4. Use the printed reference in `sandboxes.<name>.image.ref`.

   `nemoclaw onboard` suggests such a reference when the gateway's engine holds an image whose label installs the chosen harness.

The commands build and load local images.
They do not publish images or launch a deployment.
To use your own local repository name without replacing another build's tags, set `IMAGE_PREFIX=nc-my-build` before the builder; the image is then `nc-my-build:HARNESS`.

If the deployment runs a managed model service, [build its runtime image](#building-a-runtime-image) next.
Otherwise, continue with the [next steps](#next-steps).

### Image Selection Requirements

`image.ref` names the exact image to deploy. A harness identifier does not select an image. The named image must contain the selected Fabric adapter and runtime metadata for its `fabric-agent-ctl` command, environment, default policy, and executable grants.

- **Docker or Podman with an inspection engine:** If the image isn't on the selected engine, plan defers the Fabric compatibility check instead of pulling the image. On this path, apply [acquires and checks the image](usage.md#pulling-from-private-registries) before creating the gateway or configuring the deployment. For an external gateway, set the target's `engine` to the engine used for sandbox images. NemoClaw doesn't assume the client host's Docker socket, and the engine setting doesn't make NemoClaw manage the external gateway.
- **Missing inspection prerequisites:** A missing inspection engine on an external Docker or Podman target is not the same as an absent image on a configured engine. Fix the engine setting before retrying plan. If an image is present but lacks the required runtime metadata, use a compatible image or rebuild it with its catalog label.
- **Kubernetes or OpenShift:** Supply the [metadata bundle that matches the image digest](kubernetes.md). Missing or invalid metadata blocks planning. The cluster pulls the image; NemoClaw doesn't use the Docker or Podman pull path for these targets.

### Image Labels and Discovery

The builder first builds the image's `catalog` stage, which reads the installed Fabric discovery metadata with networking disabled.
It then builds the image's `labeled` stage with that metadata as its label, and checks the label against the installed metadata.
Both builds reuse the same cached layers, and neither starts an adapter or requests model responses.
A direct `docker buildx bake` build of an agent target omits the label, so plan cannot select it.

Installed discovery also requires the image-owned runtime manifest and resolves descriptor-required executables inside the image.
If catalog generation reports a missing runtime manifest, required path, or executable, correct the image recipe before retrying.
Before changing the image layout, refer to the [image metadata contract](../../internal-docs/design/fabric-management.md#image-metadata).

### Fetching Image Sources for Direct Bake Builds

`cargo images build` downloads the remote files that image builds copy, such as the Fabric and Hermes source archives, as `versions.json` pins them under `imageSources`.
It checks each file's SHA-256, keeps it in `.build/downloads`, and places it in `.build/image-sources`, where the Bake file reads it.
When a server rate-limits a download or answers with a server error, the download is retried up to three times, waiting as long as `Retry-After` asks, for at most a minute.
If the server asks for a longer wait, the download stops without retrying early.

Before you build or check an agent or Ollama image with `docker buildx bake` directly, place the same files:

```sh
cargo images fetch
```

Without them, Bake stops with `failed to get build context sources`.
Run the command again after changing a pin or checking out another revision.
Bake copies whatever `.build/image-sources` holds without comparing it to `versions.json`, while `cargo images build` places the pinned files every time.
Direct Bake builds and checks use the host's platform unless the `AGENT_PLATFORM` environment variable selects the other one.

### Building the Ollama Proxy Image

Build the proxy image when a deployment uses [external Ollama through a managed proxy](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy).
On an ARM64 host, run:

```sh
AGENT_PLATFORM=linux/arm64 docker buildx bake ollama-proxy --load
```

The command builds the image as `nc-fabric:ollama-proxy`.
Select `linux/amd64` on an AMD64 host.
The proxy and its `proxy-tests` target use the same explicit platform selector.
The proxy image holds only the statically linked `nemoclaw-ollama-proxy` binary from [its crate](../../crates/nemoclaw-ollama-proxy) and its license, with no shell or interpreter.

### Writing Image Metadata for Kubernetes or OpenShift

A Kubernetes or OpenShift sandbox names a metadata bundle in `image.metadata`, because no local engine can be inspected there.
The metadata bundle holds the image's index, each Linux platform's manifest and configuration, and no layers.
The SDK checks it against the digest in `image.ref`.
The platforms of an index must declare the same catalog, because the cluster chooses the platform that each node runs.

Before pushing a local image, write its metadata bundle to `FILE`, which must be a new file:

```sh
cargo images export-metadata IMAGE --output FILE
```

Use the same digest in `image.ref`.
For an image already in a registry, pass `--registry` and its `HOST/REPOSITORY@sha256:DIGEST` reference in place of `IMAGE`.
`NEMOCLAW_REGISTRY_USERNAME` and `NEMOCLAW_REGISTRY_PASSWORD`, when set, answer the registry's token challenge.
For the rest of the cluster procedure, refer to [cluster deployment](kubernetes.md).

### Agent Image Contents

Agent images share a Python 3.14.10 base without pip.
Only OpenClaw, Hermes, and Pi add Node.js 26.13.1 LTS: OpenClaw's CLI and the Pi adapter run on it, and Hermes's browser tool and `npx`-launched MCP servers require it.
Image qualification checks that interpreter against every Python adapter's declared version range in the pinned Fabric source.

[The Bake file](../../docker-bake.hcl) selects the target platform, qualified harnesses, and named stages in the [shared agent Dockerfile](../../image/fabric/Dockerfile).
Common Fabric wheels and base layers are shared.
Images other than Hermes export dependencies from Fabric's frozen root lock, selecting the Python adapter's extra when present.
Hermes retains a separate native dependency supplement, described in the [source notice](../../image/NOTICE.md).
The exact Python base-image pins remain image-build inputs.
The uv tool validates installed adapter `Requires-Python` constraints.

The builder verifies archive and wheel hashes, retains upstream archives and local build sources under `/opt/nemoclaw/source/`, and records local source hashes in `/opt/nemoclaw/provenance.json`.
The [source notice](../../image/NOTICE.md) describes retained sources and licenses.
Pinned archives and wheels do not make the whole image bit-reproducible, because Debian packages still come from the configured repositories.

To extend an agent image with your own skills and tools, refer to [derived agent images](derived-images.md).

## Building a Runtime Image

Build a runtime image when a deployment runs a managed vLLM, Ollama, or llama.cpp service.
Each image adds NemoClaw's shared supervisor to the service's pinned upstream image.

Before you build a runtime image, check the following:

- The build host has the [runtime image requirements](#preparing-the-build-host).
  Runtime images always build for the build host's platform, so the supervisor compiles natively rather than under emulation.
  Build on a host whose platform matches the model host.
- The Docker daemon uses the containerd image store, which keeps each local image's digest; [check the store](#checking-the-docker-image-store).
- For the Ollama and llama.cpp images, Rust is installed, because `cargo images fetch` places their pinned sources.
  The vLLM build needs no host Rust toolchain.

The following table lists the build command and local image for each service:

| Service | Command | Local Image | Guide |
|---|---|---|---|
| vLLM, for safetensors models without a recipe | `docker buildx bake vllm` | `nc-prototype-vllm:rust-v1` | [Model configuration](../agents-inference/models.md) |
| Ollama | `docker buildx bake ollama` | `nc-prototype-ollama:rust-v1` | [Managed Ollama](../agents-inference/inference.md#running-managed-ollama) |
| llama.cpp | `docker buildx bake llama-cpp` | `nc-prototype-llama-cpp:rust-v1` | [Managed llama.cpp](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) |
| All three | `docker buildx bake runtimes` | All of the preceding | Not applicable |

To build a runtime image and select it, perform the following steps:

1. For the Ollama or llama.cpp image, or for all three, place the licenses that those images retain, as `versions.json` pins them:

   ```sh
   cargo images fetch
   ```

2. Build the image with the service's command from the table.
   For example, for vLLM:

   ```sh
   docker buildx bake vllm
   ```

3. Print the image's `NAME@sha256:DIGEST` reference, using the service's local image from the table.
   For example, for vLLM:

   ```sh
   docker image inspect nc-prototype-vllm:rust-v1 --format '{{index .RepoDigests 0}}'
   ```

4. Use the printed reference in `spec.services.<name>.image`.

   Do not substitute a mutable tag or a digest copied from another build.
   Builds use fixed timestamps, so rebuilding the same sources keeps the same digest.

5. If the deployment uses a different Docker daemon, transfer the image there before apply, for example with `docker save` and `docker load`.

   Images are not transferred automatically.

A build does not launch inference or publish an image.
Continue with the [next steps](#next-steps).

### Runtime Image Contents

The vLLM image contains the shared supervisor and the pinned multi-platform vLLM base for the build host's architecture, without model-specific patches or preparation tools.
The [Nemotron example](../agents-inference/models.md#configuring-nemotron-on-an-amd64-gpu-host) uses the AMD64 build.
Select the model through [model configuration](../agents-inference/models.md).
Selecting this artifact does not qualify GPU inference on the host.

A model that needs preparation tools or patches uses an image that its recipe's authors build.
Refer to [inline recipes](../agents-inference/recipes.md).

The llama.cpp image is llama.cpp's CUDA 13.5 server image with the supervisor added.
Its CUDA 13.5, like the vLLM image's CUDA 13.0, needs NVIDIA driver 580 or newer.

## Retained Sources and Compatibility

This section describes what runtime images retain and how NemoClaw checks a runtime image before using it.

### Retained Sources

The supervisor build, `image/supervisor/Dockerfile`, packages the runtime crate with Cargo, vendors its locked dependency sources, and compiles the supervisor offline from that archive.
The archive contains the runtime crate, its standalone workspace manifest and pruned lockfile, Cargo-vendored dependencies with their licenses, and runtime policy attribution.
It excludes the SDK, provider, OpenShell, Fabric, onboarding, and agent images.
Each runtime image retains the archive, the license, its own Dockerfile and notice, and the supervisor's Dockerfile under `/opt/nemoclaw/source/`.

The [vLLM notice](../../image/vllm/NOTICE.md), [Ollama notice](../../image/ollama/NOTICE.md), and [llama.cpp notice](../../image/llama-cpp/NOTICE.md) identify retained sources and licenses.

Git ignores generated bundles, build inputs, and images.
Model snapshots and prepared data belong to the deployment's persistent volume, outside the build context.

### Runtime Image Checks

The image contains `nemoclaw-runtime`.
Managed containers use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
The inline recipe supplies preparation and verification tools, and `kind: vllm` selects the service installer and serving behavior.

Before creating runtime resources, the SDK checks a managed vLLM or Ollama image's required backend, recipe, and authentication labels and its platform with `host_image`.
Bearer vLLM also requires `org.nemoclaw.inference.routes=openai-v2`, which identifies a supervisor that serves the published port and forwards only authenticated inference requests and public `GET /health` to vLLM on loopback.
Rebuild earlier bearer images that lack this label.
Do not add the label to an image whose supervisor was built from an earlier revision.

| Image State | Result |
|---|---|
| Already loaded, with a missing or incompatible required label | Plan and apply fail, naming the label |
| Not yet acquired | Plan reports compatibility as deferred; apply can pull the image, then checks it before creating storage, networks, or containers |
| Built by a different NemoClaw revision, with the right labels | The runtime can reject the runtime contract when it starts, after the deployment has created the service's storage and network |

Matching labels establish the declared backend, recipe, and authentication, not successful model loading or inference.
For invalid input, the runtime reports its expected specification version and the declared field location, without echoing configuration values or user-defined map keys.

### Rebuilding a Mismatched Runtime Image

To replace an image that fails these checks, perform the following steps:

1. Rebuild the selected image from the bundle's source revision with its command from [building a runtime image](#building-a-runtime-image), such as `docker buildx bake vllm`, or `cargo images fetch` and then `docker buildx bake ollama`.
2. Load the rebuilt image on the execution daemon.
3. Update `spec.services.<name>.image` to the rebuilt image's digest.
4. Keep the deployment state, and reapply.

Existing model and credential storage remain subject to their retention and identity checks.
Destroy omits image compatibility gates, so a mismatched image alone does not prevent cleanup.

## Removing a Source-Built Bundle

Removing a source-built bundle removes only local tools.
It does not stop deployments, remove images, or revoke credentials.
NemoClaw Agent Configs has no `uninstall` command. A source-built bundle has no package-manager installation to reverse.

To remove a bundle, perform the following steps:

1. Identify every deployment that uses the bundle.
   Keep a verified copy of the bundle wherever its original tooling is still needed for recovery or teardown.
2. Finish any operation that uses the bundle.
3. If you are also retiring a deployment, follow [destroy and retention](usage.md#destroying), then [removing retained resources](usage.md#removing-retained-resources).
   Keep the deployment's state for anything that procedure does not cover.
4. Remove the dedicated bundle directory with your host's file manager.
5. Remove only that bundle's `bin` entry from your shell's `PATH` configuration.
6. Open a new terminal, and check for any remaining installation with `command -v nemoclaw` on a POSIX shell or `Get-Command nemoclaw` in PowerShell.

Do not delete deployment state, model volumes, unrelated tool installations, or shared caches as part of removing the bundle.
If you need the removed tools again, rebuild a bundle from the recorded source revision.
Compatibility with another revision is not implied.

## Next Steps

- Configure, plan, and apply a deployment with the bundle and images: [deployment usage](usage.md).
- Deploy on Kubernetes or OpenShift: [cluster deployment](kubernetes.md).
- Extend an agent image with your own skills and tools: [derived agent images](derived-images.md).
- Follow the [first-deployment tutorial](../get-started/first-deployment.md) with its own pinned revision and that revision's copy of this guide, not the artifacts from this checkout.
