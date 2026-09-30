<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Adapter Modification

Upstream source: NVIDIA/NeMo-Fabric, revision `24f068c895e5cbc30286bc743498be4e5014d658`, `adapters/python/openclaw/src/nemo_fabric_adapters/openclaw/adapter.py`.
The upstream file and its Apache-2.0 notices remain in the retained Fabric source archive.

2026-09-29: apply `openclaw-reconfigure.patch` before building the OpenClaw adapter wheel.
The patch calls the original NemoClaw helper `openclaw_configuration.py`, installed beside the adapter as `configuration.py`, while holding the adapter's existing exclusive state lock.
The helper records hashes of adapter-owned native sections, permits explicit updates to those sections, preserves unrelated bookkeeping, and refuses conflicting edits or symlinked ownership files.
It writes native settings and the ownership record atomically as separate files; reapplying the proposed settings can finish an interrupted ownership-record write.
When the sandbox rejects process-group signals, the patch signals the adapter-owned subprocess directly for shutdown and RPC cleanup.
It retains the graceful-stop timeout and forced-stop fallback; it does not relax the sandbox signal policy.
The patch does not change native configuration mapping, model requests, or adapter descriptors.

The image retains this notice, the patch and helper under `/opt/nemoclaw/source/local/`, with hashes in `/opt/nemoclaw/provenance.json`.
The wheel requirement hash binds installation to the modified wheel bytes.
See the adjacent `FABRIC-LICENSE` for the upstream license.
