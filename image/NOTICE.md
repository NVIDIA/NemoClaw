<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

[The shared Dockerfile](fabric/Dockerfile) pins Fabric source and base images.
Fabric owns the adapter implementations, native schemas, and configuration mapping installed by these recipes.
NemoClaw preserves the upstream descriptors.
The pinned OpenClaw adapter has a [documented configuration-reconciliation patch](fabric/OPENCLAW-NOTICE.md); other adapter implementations are unchanged.
The Fabric runtime wheel has a [documented error-code patch](fabric/FABRIC-ERROR-NOTICE.md) that preserves structured native codes through its Python SDK.
Upstream notices remain in installed wheels and the retained source archive under `/opt/nemoclaw/source/`.
See [Fabric's license](fabric/FABRIC-LICENSE) and the notices beside its adapter sources.

Except Hermes, image dependency installation exports Fabric's pinned root `uv.lock` with `uv export --frozen --no-default-groups --no-emit-local`, selecting the Python adapter's extra when present.
These images install Fabric's locally built wheels alongside the export without independently resolving dependency versions.
Hermes retains `fabric/hermes-dependencies.lock` because Fabric's Hermes extra excludes the native checkout and its build dependencies.
Its image applies Fabric's exact upstream patch; [the Hermes source notice](fabric/HERMES-NOTICE.md) records the revisions and modification.

OpenClaw installs the pinned search plugin archives through its native installer; the image packages them in OpenClaw’s bundled-plugin directory.
Examples select plugin IDs without filesystem paths.
Hermes plugin placement remains in the Dockerfile because the pinned Fabric supplies its Tavily assets and placement instructions without an installation command.
Pi's builder follows Fabric's focused installation recipe and packs its adapter, common, and contract packages; those pinned packages are not published on npm.
The runtime contains their packed code and npm's locked dependencies, including Pi's declared peers, without the Fabric source tests.
Fabric owns those source tests.
The image workflow qualifies the installed native adapters against owned local inference.

`fabric/fabric.py` retains the deployment host: the pinned Fabric SDK has no process host for configure, unchanged apply, and invocation across OpenShell exec calls.
The host delegates configuration and runtime operations to Fabric; its `check` command reports unsupported because the pinned SDK has no health API.
The [provider caller](../crates/nemoclaw-provider/src/openshell/protocol.rs) uses the retained image command and interpreter for bridge calls and temporary input files.

`cargo images build` ([source](../crates/nemoclaw-build/src/images.rs)) builds local images, runs Fabric discovery in each installed environment without starting an adapter, and attaches the returned snapshot as `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric provenance and preserves the descriptor contents.
Installed image catalogs also declare the bridge interface version, commands, and supported health levels; the bundled descriptor catalog makes no claim about an installed bridge.
The Dockerfile records each adapter’s additional runtime directories in `/opt/nemoclaw/runtime-files.json`; the image catalog includes them as `runtime_files`.
Image tests verify that these directories exist and are readable by the runtime user.
The SDK checks explicit filesystem grants against those image-owned paths without adding requirements to Fabric descriptors.
It does not publish images.
Direct Docker Bake builds do not attach discovery metadata.

[`fabric/runtime.json`](fabric/runtime.json) declares the image-owned bridge command, environment, required read paths, and default filesystem and process policy.
Installed catalog generation requires this manifest and records it under `runtime` with `schema_version: 1`.
[`fabric/runtime_metadata.py`](fabric/runtime_metadata.py) resolves each descriptor's `requirements.binaries` through the declared `PATH` and records canonical executable paths beside the unchanged descriptor.
Each adapter also receives the actual `ADAPTER_PYTHON` interpreter path because the host runs Python adapters in-process.
Missing executables, required paths, or the installed-image manifest fail catalog generation.
The SDK preserves and validates this metadata during image discovery.
The SDK compiles image discovery into each sandbox's launch and policy, retaining the binding in state and OpenShell annotations for refresh and teardown.
Provider profiles use the selected adapter's nonempty executable list; inference and search registrations are scoped by immutable image and adapter identity so different images do not combine executable permissions.
An explicit sandbox policy replaces the image's filesystem and process defaults while preserving deployment-managed endpoint grants.
The [ARM64 metadata qualification](../docs/validation/image-runtime-metadata-linux-arm64.md) records the earlier publication-only checks; the [consumer qualification](../docs/validation/image-runtime-consumers-linux-arm64.md) covers the subsequent deployment integration.

`fabric/catalog.json` is an offline snapshot produced by Fabric discovery at the revision and checksum recorded in that file and pinned in the Dockerfile.
2026-09-24: serialize canonical descriptor records and provenance without local adapter additions or native schema patches.
The bundled snapshot offers provisional authoring choices; it does not establish installation, health, credentials, or inference readiness on a target.
Regenerate it using the matching Fabric interpreter and `fabric/catalog.py --revision REVISION --source-sha256 CHECKSUM --output image/fabric/catalog.json`.

[`qualify_native.py`](qualify_native.py) and [`hermes_security.py`](hermes_security.py) run in built images from the image workflow.
Both came from NeMo Fabric's `tests/native/` at the pinned revision; their headers record the source and the 2026-09-28 move.
They use only owned local processes and a simulated inference endpoint, so they do not establish external provider compatibility.
