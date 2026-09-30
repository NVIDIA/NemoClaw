<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Image Runtime Consumers on Linux ARM64

The runtime consumers for [#12425](https://github.com/NVIDIA/NemoClaw/issues/12425) and [#12439](https://github.com/NVIDIA/NemoClaw/issues/12439) passed an owned Docker/OpenShell lifecycle on 2026-09-30 with bundle `0.1.0-dev.8889d851fa951928`.
This extends the [earlier metadata-only checks](image-runtime-metadata-linux-arm64.md) to sandbox launch, provider grants, refresh, export, and teardown.

## Live Deployment

Two temporary images derived from the existing Nooa image `nc-explore@sha256:689b0e29623919cfdcb99be6d0a9ee2bec8170ee8ba73fa7d483b528e91fbd1d` relocated the Fabric environment to `/srv/runtime` and the bridge to `/srv/bridge`.
Both advertised the three-part command prefix `/srv/runtime/bin/python -B /srv/bridge/fabric.py`.
Installed discovery regenerated each image's catalog before labeling it.

| Image | Resolved Python executable | Advertised UID/GID |
|---|---|---|
| `nc-consumers-47c4-83efe2693d@sha256:fb85b988a5fee54116513c87fba1e0022b642eba1325d9179b06943dd529d931` | `/usr/local/bin/python3.13` | `1000:1000` |
| `nc-consumers-47c4-4a501c0eef@sha256:fdf8e5357090e3dcc50281e06d0310536a9558b9dd51e04a100160161078a269` | `/srv/interpreter/python3.13` | `1001:1001` |

The test used a fresh deployment UUID, an unused bridge subnet, a managed gateway, and an owned HTTP model-list fixture.
Initial plan and apply created the first Nooa sandbox.
Adding the second sandbox preserved all existing managed resource IDs and created a separate inference registration and profile for its image.
Provider readback retained one executable per profile, with no union between images.
Sandbox bindings retained each advertised command and process policy.

Unchanged apply, export, reapply of the exported YAML, and destroy passed.
The unchanged operations preserved every managed resource ID.
After destroy, ownership-checked cleanup removed the initialization container, retained gateway volume and bridge, and temporary image tags.
All 111 pre-existing containers remained present.

The local evidence directory was `/tmp/nemoclaw-image-consumers-47c4-j2t31vis`.
It retained image catalogs, authored inputs, command results, state snapshots, identity assertions, and cleanup results.
The initial OpenTofu plan exposed an incorrect serialized discovery-map length and failed before creating resources; the corrected bundle passed the lifecycle above.

## Automated Checks

Behavioral tests first reproduced the shared-registration count and missing runtime-binding implementation.
The image bridge's new status test first returned a failure exit code for a valid idle runtime; the implementation now returns the status without configuring or invoking it.
Focused tests cover relocated commands, default and explicit policy, resolved executable grants, missing metadata, profile drift, shared-definition credential conflicts, and image-specific registration stability.

Verification passed:

- 959 workspace tests, with 135 opt-in tests ignored.
- `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- 32 image contract tests against the private build of pinned Fabric revision `24f068c895e5cbc30286bc743498be4e5014d658`.
- Ruff checks and formatting for the changed Python sources.

## Limits

The live test did not request an agent response or qualify model generation, TLS credential injection, or a new executable such as Bun inside a real sandbox.
Synthetic layout and profile tests cover arbitrary absolute executable paths, including Bun; installed-image discovery resolves the actual files.
The live run used managed Docker on Linux ARM64; external-gateway image inspection, Podman, other hosts, and other adapters were not live-qualified by this run.
External gateways require an explicit image engine, and images without runtime metadata fail planning.
Legacy sandbox bindings without that metadata require their original bundle for recovery or teardown; no automatic migration was tested or implemented.
