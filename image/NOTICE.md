<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

[The shared Dockerfile](fabric/Dockerfile) pins Fabric source and base images.
Fabric owns the adapter implementations, native schemas, and configuration mapping installed by these recipes.
NemoClaw does not patch those descriptors or adapter implementations.
Upstream notices remain in installed wheels and the retained source archive under `/opt/nemoclaw/source/`.
See [Fabric's license](fabric/FABRIC-LICENSE) and the notices beside its adapter sources.

Except Hermes, image dependency installation exports Fabric's pinned root `uv.lock` with `uv export --frozen --no-default-groups --no-emit-local`, selecting the Python adapter's extra when present.
These images install Fabric's locally built wheels alongside the export without independently resolving dependency versions.
Hermes retains `fabric/hermes-dependencies.lock` because Fabric's Hermes extra excludes the native checkout and its build dependencies.
Its image applies Fabric's exact upstream patch; [the Hermes source notice](fabric/HERMES-NOTICE.md) records the revisions and modification.

Plugin placement remains in the Dockerfile because the pinned Fabric supplies plugin assets and placement instructions without an installation command.
Pi's builder follows Fabric's focused installation recipe and packs its adapter, common, and contract packages; those pinned packages are not published on npm.
The runtime contains their packed code and npm's locked dependencies, including Pi's declared peers, without the Fabric source tests.
Fabric owns those source tests.
The image workflow qualifies the installed native adapters against owned local inference.

`fabric/fabric.py` retains the deployment host: the pinned Fabric SDK has no process host for configure, unchanged apply, and invocation across OpenShell exec calls.
The host delegates configuration and runtime operations to Fabric; its health command reports unsupported because the pinned SDK has no health API.
The [provider command helper](../crates/nemoclaw-provider/src/openshell/agent.rs) retains the fixed launch interface for this packaged bridge.

[`build_fabric.py`](build_fabric.py) builds local images, runs Fabric discovery in each installed environment without starting an adapter, and attaches the returned snapshot as `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric provenance and preserves the descriptor contents.
It does not publish images.
Direct Docker Bake builds do not attach discovery metadata.

`fabric/catalog.json` is an offline snapshot produced by Fabric discovery at the revision and checksum recorded in that file and pinned in the Dockerfile.
2026-09-24: serialize canonical descriptor records and provenance without local adapter additions or native schema patches.
The bundled snapshot offers provisional authoring choices; it does not establish installation, health, credentials, or inference readiness on a target.
Regenerate it using the matching Fabric interpreter and `fabric/catalog.py --revision REVISION --source-sha256 CHECKSUM --output image/fabric/catalog.json`.

[`qualify_native.py`](qualify_native.py) and [`hermes_security.py`](hermes_security.py) run in built images from the image workflow.
Both came from NeMo Fabric's `tests/native/` at the pinned revision; their headers record the source and the 2026-09-28 move.
They use only owned local processes and a simulated inference endpoint, so they do not establish external provider compatibility.
