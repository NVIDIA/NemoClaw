<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

[The shared Dockerfile](fabric/Dockerfile) pins Fabric source and base images.
Fabric owns the adapter implementations, native schemas, and configuration mapping installed by these recipes.
NemoClaw does not patch those descriptors or adapter implementations.
Upstream notices remain in installed wheels and the retained source archive under `/opt/nemoclaw/source/`.
See [Fabric's license](fabric/FABRIC-LICENSE) and the notices beside its adapter sources.

[`build_fabric.py`](build_fabric.py) builds local images, runs Fabric discovery in each installed environment without starting an adapter, and attaches the returned snapshot as `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric provenance and preserves the descriptor contents.
It does not publish images.
Direct Docker Bake builds do not attach discovery metadata.

`fabric/catalog.json` is an offline snapshot produced by Fabric discovery at the revision and checksum recorded in that file and pinned in the Dockerfile.
2026-09-24: serialize canonical descriptor records and provenance without local adapter additions or native schema patches.
The bundled snapshot offers provisional authoring choices; it does not establish installation, health, credentials, or inference readiness on a target.
Regenerate it using the matching Fabric interpreter and `fabric/catalog.py --revision REVISION --source-sha256 CHECKSUM --output image/fabric/catalog.json`.
