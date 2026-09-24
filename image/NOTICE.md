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
Fixture results do not establish model quality or live inference.

The Pi recipe applies the local `fabric/patch_pi.py` correction to the verified Fabric source.
It retains upstream headers and adds model resolution from the NemoClaw configuration, opaque native model configuration, and a matching inference probe.
The image retains the patched TypeScript source and records the local source hashes in `/opt/nemoclaw/provenance.json`.

These changes are not part of the pinned upstream Fabric release.

The Hermes recipe applies `fabric/patch_hermes.py` to Fabric revision `6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421` (Apache-2.0).
The 2026-09-15 modification adds an explicit API-mode setting and forwards it to the pinned Hermes `AIAgent` constructor.
The patch preserves upstream notices; image provenance records the patch and launcher hashes.

`fabric/catalog.json` and `../docker-bake.override.json` contain descriptor metadata derived from Fabric revision `6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421`, licensed under Apache-2.0 (see `fabric/FABRIC-LICENSE`).
The 2026-09-23 transformation preserves upstream descriptor contents, records their paths and archive checksum, and adds the local adapter descriptors.
Image catalogs select the descriptors installed by each recipe and apply the existing Pi and upstream Hermes descriptor extensions.
Hermes retains both its local adapter and its patched upstream adapter; Nooa recipes retain both descriptors installed by their shared package.
They advertise packaged metadata, not successful runtime or inference checks.
Regenerate with `python3 image/fabric/catalog.py PATH_TO_FABRIC_TAR_GZ`; append `--check` to verify generated files against the archive pinned in the Dockerfile.
Docker Bake automatically loads the generated override file and attaches each catalog as the `io.nemoclaw.fabric.catalog` image label.
