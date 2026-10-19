<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

[The shared Dockerfile](fabric/Dockerfile) pins Fabric source and base images.
Fabric owns the adapter implementations, native schemas, and configuration mapping installed by these recipes.
NemoClaw preserves the upstream descriptors.
NemoClaw doesn't patch the Fabric runtime or its adapter implementations.
Upstream notices remain in installed wheels and the retained source archive under `/opt/nemoclaw/source/`.
See [Fabric's license](fabric/FABRIC-LICENSE) and the notices beside its adapter sources.

Image dependency installation exports Fabric's pinned root `uv.lock` with `uv export --frozen --no-default-groups --no-emit-local`, selecting the Python adapter's extra when present.
These images install Fabric's locally built wheels alongside the export without independently resolving dependency versions.
Fabric's Hermes extra doesn't install Hermes Agent, so the Hermes image then installs Hermes Agent's own `uv.lock` with its `mcp` extra, which MCP servers configured through Fabric need, and Hermes from its release source.
Hermes's lock settles the packages it shares with Fabric; [the Hermes source notice](fabric/HERMES-NOTICE.md) records the release.

OpenClaw installs the pinned search plugin archives through its native installer; the image packages them in OpenClaw’s bundled-plugin directory.
Examples select plugin IDs without filesystem paths.
Hermes plugin placement remains in the Dockerfile because the pinned Fabric supplies its Tavily assets and placement instructions without an installation command.
Pi's builder follows Fabric's focused installation recipe and packs its adapter, common, and contract packages; those pinned packages are not published on npm.
The runtime contains their packed code and npm's locked dependencies, including Pi's declared peers, without the Fabric source tests.
Fabric owns those source tests.

[`qualify_native.py`](qualify_native.py) runs in built images from the image workflow.
It came from NeMo Fabric's `tests/native/` at the pinned revision; its header records the source revision and every modification.
It uses only owned local processes and a simulated inference endpoint, so it does not establish external provider compatibility.

The [image metadata contract](../docs/design/fabric-management.md#image-metadata) describes the catalog labels and runtime manifests these recipes produce.
