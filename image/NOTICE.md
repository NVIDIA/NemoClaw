<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtime Sources

These Fabric recipes and their OpenClaw adapter retain the implementation from the Go prototype at `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.
They remain runtime Python and JavaScript because they integrate with the agents' native APIs; the desired-state SDK, CLI, provider, and DGX Spark supervisor are Rust.

`fabric/build.py` pins the Fabric source archive, harness versions, dependency hashes, and base images.
Installed wheels retain package license metadata.
The local OpenClaw adapter is part of this Apache-2.0 repository.

It is not an adapter supplied by upstream Fabric.
Original source headers are retained.

The native messaging fixture uses fake Telegram and inference endpoints inside a container with networking disabled.
It sends no external messages.
Its configuration and recreation phases exercise real native OpenClaw processes.

The other harness fixtures also use local protocol servers with networking disabled.
Fixture evidence does not establish model quality or live inference.

The Pi recipe applies the local `fabric/patch_pi.py` correction to the verified Fabric source.
It retains upstream headers and adds model resolution from the NemoClaw configuration, opaque native model configuration, and a matching inference probe.
The image retains the patched TypeScript source and records the local source hashes in `/opt/nemoclaw/provenance.json`.

These changes are not part of the pinned upstream Fabric release.
