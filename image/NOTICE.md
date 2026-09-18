<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

These Fabric recipes, adapters, and fixtures use Python and TypeScript to integrate with the agents' native APIs.

[The shared Dockerfile](fabric/Dockerfile) pins source archives and base images.
[Docker Bake](../docker-bake.hcl) selects the target platform, harness, and matching dependency lock.
Images retain upstream source archives and local build inputs under `/opt/nemoclaw/source/`.
Installed wheels retain package license metadata.
The local OpenClaw adapter is part of this Apache-2.0 repository.

It is not an adapter supplied by upstream Fabric.
Original source headers are retained.

The harness fixtures use local protocol servers with networking disabled.
Fixture evidence does not establish model quality or live inference.

The Pi recipe applies the local `fabric/patch_pi.py` correction to the verified Fabric source.
It retains upstream headers and adds model resolution from the NemoClaw configuration, opaque native model configuration, and a matching inference probe.
The image retains the patched TypeScript source and records the local source hashes in `/opt/nemoclaw/provenance.json`.

These changes are not part of the pinned upstream Fabric release.

The Hermes recipe applies `fabric/patch_hermes.py` to Fabric revision `6e155bfbe9e740fb8ce1e1fda900d96f1435a23c` (Apache-2.0).
The 2026-09-15 modification adds an explicit API-mode setting and forwards it to the pinned Hermes `AIAgent` constructor.
The patch preserves upstream notices; image provenance records the patch and launcher hashes.
