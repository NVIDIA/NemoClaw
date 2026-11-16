<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Maintain Agent Image Pins and Catalogs

Use these procedures when changing the Fabric or agent image source pins. They are maintainer tasks; readers building matched artifacts from a pinned revision can use the [public image build guide](../../docs/build-deploy/build.md#build-agent-images) instead. The pin and catalog contract below is based on inspected `origin/v1` at `86b8d94273a76a696e06b300dc29f7035b163667`: `image/fabric/Dockerfile`, `image/fabric/catalog.py`, and `crates/nemoclaw-sdk/build.rs`.

## Update the OpenClaw Pin

OpenClaw's npm package has no lockfile, so the agent image copies `/app` from OpenClaw's published image, pinned by digest in `OPENCLAW_IMAGE` in [the Dockerfile](../../image/fabric/Dockerfile).
When an agent starts, Fabric's OpenClaw adapter refuses versions outside `SUPPORTED_OPENCLAW_VERSIONS` in the pinned Fabric source.
When you change the Fabric pin, check that set; if it changed, pin the digest of OpenClaw's published image for a supported version, then rebuild and qualify the OpenClaw image.

## Update the Hermes Pin

The agent image installs Hermes Agent from the release source archive that `hermes.tar.gz` pins under `imageSources.fabric` in [`versions.json`](../../versions.json), by URL and SHA-256.
Hermes's dashboard and browser chat need its web assets and TUI bundle built, so the image copies them from Hermes's published image, pinned by digest in `HERMES_IMAGE`.
The build stops if any file that image shares with the pinned release source differs, apart from the `README.md` its build empties.
When you move that pin, pin the digest of Hermes's published image for the same release, then rebuild and qualify the Hermes image.

## Regenerate the Bundled Catalog

The SDK build fails with `stale Fabric catalog` when `image/fabric/catalog.json` no longer matches the Fabric source that `fabric.tar.gz` pins under `imageSources.fabric` in [`versions.json`](../../versions.json).
Run `image/fabric/catalog.py` with a Python environment that has the pinned Fabric wheels installed, such as a freshly built agent image's `/opt/fabric/bin/python`. Pass that revision and checksum, and `--adapter` once for each adapter ID the current catalog lists:

```sh
python image/fabric/catalog.py --revision REVISION --source-sha256 CHECKSUM \
  --adapter nvidia.fabric.claude --adapter nvidia.fabric.codex ... \
  --output image/fabric/catalog.json
```

Use the revision at the end of that pin's URL and its SHA-256.
The snapshot holds canonical descriptors and provenance only; it does not change any image.

## Qualify the Reference Contract Image

Use the dummy image to exercise the provisioning interface with Fabric's runtime and `fabric-agent-ctl`, but no native agent, credentials, or model.
It installs NemoClaw's test-only Fabric adapter and a deterministic agent, the way production images install Fabric's adapters.
It is a test fixture, excluded from the production `agents` target and the bundled catalog.
Its image catalog lists the adapter's [descriptor](../../image/fabric/test-adapter/dummy.fabric-adapter.json), so a deployment can run it by setting `harness.kind: org.nemoclaw.dummy` and the image's immutable reference; the [Docker live suite](live-tests.md#dummy-agent-lifecycle) deploys it that way.
On Linux ARM64, run from the repository root:

```sh
IMAGE_PREFIX=nc-contract cargo images build --platform linux/arm64 dummy
cargo images qualify nc-contract:dummy
```

Use `linux/amd64` on a native AMD64 host.
The qualifier uses the inspected image ID and an owned disposable container with networking disabled, a read-only root filesystem, and temporary writable sandbox storage.
It removes that container on success, failure, or timeout; the built image remains local.
The suite starts, invokes, and stops one runtime through `fabric-agent-ctl` with NemoClaw's test adapter, under the conditions an OpenShell sandbox imposes.
The [contract description](../design/fabric-management.md#image-contract-and-reference-implementation) defines the dummy's settings.

To build every production adapter image on a native Linux ARM64 host, run:

```sh
IMAGE_PREFIX=nc-contract cargo images build --platform linux/arm64 agents
```

Use `linux/amd64` on a native AMD64 host.
The build adds the `io.nemoclaw.fabric.catalog` label to every image.
NemoClaw checks how each image is assembled, not whether Fabric's adapters work: `cargo images qualify IMAGE...` checks every image offline, and runs one runtime's lifecycle only in the reference image, with NemoClaw's test adapter.
Fabric's runtime and adapters are Fabric's to test.
A passing reference lifecycle does not establish that a runtime stays healthy.
Refer to [upstream ownership](../design/fabric-management.md#upstream-ownership) for the remaining Fabric and OpenShell work.
