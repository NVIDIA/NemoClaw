---
name: add-fabric-harness
description: Add a NeMo Fabric agent harness to NemoClaw when Fabric ships a new adapter. Covers the agent image, the example, the tests, the docs, and release packaging. Use when asked to support a new Fabric harness or adapter ID in NemoClaw.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Add a Fabric Harness

Fabric owns each adapter: its descriptor, its behavior, and its tests.
NemoClaw, for now, builds and publishes the agent images ([scope](../../../docs/design/scope.md#upstream-boundaries)), so adding a harness means installing Fabric's adapter in an image, labeling the image with its catalog, and showing how to deploy it.
Don't add tests of the adapter's behavior; Fabric tests its own adapters.

Deliver one pull request, titled like `feat: add the OpenCode agent image`.

## 1. Gather the Inputs

- **Adapter ID** from Fabric, such as `nvidia.fabric.opencode`, and a short **harness name** for the image and example, lowercase and hyphenated, such as `opencode`.
- **Fabric revision.** NemoClaw pins one Fabric revision for every image. If the pin predates the adapter, bump it first, in its own pull request: `FABRIC_REVISION` and `FABRIC_SHA256` in [the agent Dockerfile](../../../image/fabric/Dockerfile), then [regenerate the bundled catalog](../../../docs/build.md#regenerate-the-bundled-catalog). The SDK learns adapter IDs and descriptors from that catalog; it needs no code change.
- **The adapter's descriptor** (`*.fabric-adapter.json` in Fabric's source at that revision): its runner command and `requirements.binaries` name the runtime the image must carry.
- **Its packaging:** a Python adapter with a Fabric extra, or anything else, such as a TypeScript adapter or a native agent.

## 2. Build the Image

The [Bake file](../../../docker-bake.hcl)'s `HARNESSES` map names every harness, and both platforms build all of them.

**A Python adapter with no other runtime** needs only an entry there: `stage = "generic"`, its directory under Fabric's `adapters/python` as `adapter`, its `adapter_id`, and its Fabric extra as `extra`.

**Anything else** gets its own stage in [the agent Dockerfile](../../../image/fabric/Dockerfile), and its entry names that stage.
Use the existing stages as patterns: `generic` for Python, `pi` for a TypeScript adapter, and `openclaw` and `hermes` for native agents.
The stage:

- installs the adapter and what it drives from Fabric's source and lockfiles at the pinned revision, or from an upstream release pinned by digest, or by revision and checksum;
- copies any runtime the descriptor requires from an image pinned by digest, never a mutable tag;
- links only the descriptor into `/opt/fabric/share/nemo-fabric/adapters/<name>/`, because Fabric's discovery skips symlinked directories;
- writes `/opt/nemoclaw/adapters.json`, the declaration the catalog label publishes: `{"<adapter_id>": {"files": [directories the adapter reads], "binaries": [runtimes it runs]}}`;
- keeps sources and notices for third-party code, as the [image notice](../../../image/NOTICE.md) describes;
- ends with `USER node`, the 10001 user OpenShell runs sandboxes as.

## 3. Add the Example and Tests

- **Example:** `examples/fabric-<name>.yaml`, copied from a sibling example, with `harness.kind` set to the adapter ID.
- **Lists of harnesses:** [the Bake tests](../../../crates/nemoclaw-build/tests/bake.rs) and both lists in [the SDK's configuration tests](../../../crates/nemoclaw-sdk/tests/config.rs).
- **Contract fixture:** add `fabric_<name> => "fabric-<name>"` to [the OpenShell contract fixtures](../../../crates/openshell-provider/tests/contract/main.rs), then write it from the example with `NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-e2e --test integration openshell_contract_fixtures`.

## 4. Document It

- A row in [the harness reference](../../../docs/reference/fabric-harnesses.md).
- A row in [the agent state table](../../../docs/state.md) for what the adapter keeps in `/sandbox/artifacts`, from the adapter's source at the pinned revision.
- The adapter's display name in [the onboarding text](../../../crates/nemoclaw-onboarding/src/tui/text.json), if it isn't there.
- The image in [the release package list](../../../docs/contributing/releases.md#provision-the-packages).

## 5. Validate

- Build and qualify the image on each platform you can reach natively: `cargo images build --platform linux/arm64 <name>`, then `cargo images qualify nc-fabric:<name>`.
- Run `docker buildx bake check` and `cargo ci`. Tests that walk every example also count them, such as the [deployment journey](../../../crates/nemoclaw-authoring/tests/deployment_journey.rs); update their counts.
- CI's image jobs build and qualify every harness on both platforms.
- Deploying the example is optional; it exercises Fabric's adapter rather than NemoClaw.

## 6. Hand Over Release Packaging

Before the next release candidate, a maintainer must create `ghcr.io/nvidia/nemoclaw/v1/<name>` as an internal package and grant this repository's Actions write access, as [releases](../../../docs/contributing/releases.md#provision-the-packages) describes.
The staging workflow refuses to run until every release package exists, so say so in the pull request.
