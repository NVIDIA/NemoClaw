<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime and Model Design

These findings record the Rust experiment, including intermediate results and limits.
The [accepted scope](../../DESIGN.md) governs implementation changes.
These stages predate [removal of built-in recipes and runtime aliases](recipes.md).
For current procedures, use the [documentation index](../README.md).

## Runtime Boundaries

The runtime crate follows process lifetime, not hardware identity.
It builds one `nemoclaw-runtime` executable.
Within the existing crates:

| Concern | Owner |
|---|---|
| Process lifetime, cancellation, status, readiness deadline | Shared runtime supervisor |
| Memory measurements, GPU detection, capacity and protection rules | Hardware modules and validated profiles |
| Snapshot pins, preparation identity, PLE tools, patches and model tuning | Versioned recipe artifacts and their typed adapter |
| Launch arguments and readiness probe | Backend modules |

The recipe selects a qualified backend/hardware combination.
The existing YAML backend identifier remains unchanged for compatibility; this refactor does not add supported combinations or an arbitrary launch-argument mechanism.
A new hardware profile or backend normally adds a module and qualification evidence.

A crate is justified by a dependency or deployment boundary, not a new GPU name.

Acceptance uses a real fixture process with no DGX Spark configuration to exercise supervisor deadlines, cancellation, readiness, pressure and failed observations.
A separate HTTP fixture exercises backend readiness.
Reference preparation keys, capacity decisions and the observed pre-refactor vLLM argument vector protect compatibility.

The live image-upgrade gate must preserve storage receipts and all independent resource identities, then return an actual agent response and an unchanged export/reapply.
These tests establish separation for this recipe; a second real backend remains the next test of how well the modules generalize.

The [refactor acceptance run](../validation/rust-runtime-boundaries-linux-arm64.json) passed the live image upgrade in 646 seconds.
Only the inference process identity changed; cached artifact receipts and every independent binding were preserved.
The agent replied `FOUR`, followed by unchanged apply and export/reapply.

An independent offline rebuild produced the same runtime executable hash.
This qualifies the separation against the existing recipe, not another backend.

## One OpenClaw Deployment Path

OpenClaw uses Fabric (`harness: openclaw`) for both external and managed dependencies.
The standalone Node bootstrap and its image recipe are removed.
Gateway and inference ownership do not require a different agent launcher.

Fabric owns the native OpenClaw gateway; native commands and channel settings remain available through sandbox access.
Other harnesses retain their external-service qualification boundary.

Missing or unsupported runtime labels are failed observations, never absence.
Old standalone state is not silently converted; its previous bundle remains necessary for export or teardown.
Sandbox identities and agent data are not migrated by changing the agent type in YAML.

The agent schema has only `name`, `harness`, and `inference`.
A constant `type: fabric` added no selection, so it is removed.
The harness still determines the same `fabric-<harness>` runtime identity and OpenTofu resource graph.

Configuration digests change because the serialized document changes; old retained intent is not automatically migrated.

## Model Choice Is Data, Not a Compiled Recipe Constant

The generic `vllm` backend accepts a public Hugging Face repository and immutable commit without a model allowlist.
Runtime image compatibility is bound to the backend, not to a model revision label.
The served model name follows the repository, and model storage identity includes both repository and revision.

The model resolver discovers a checksummed inference snapshot.
Plan may read remote metadata but cannot download weights into runtime storage or prepare a model.
Apply retains the manifest and resumable downloads; subsequent observation uses that retained manifest and completion receipts.

Authentication, transport, partial inventories and changed artifacts are errors, never resource absence.

The experiment keeps the PLE recipe for Qwen3.8 separate from ordinary safetensors loading.
A different model must not inherit its memory estimate, MTP, parser, cache dtype or preparation tools.
Generic serving declares a total GPU budget and optional native parsers; the existing hardware profile and resident memory protection remain shared.

Compatibility still depends on the selected image, model architecture and available capacity.
Supporting arbitrary repository names does not establish support for remote model code or every checkpoint format.

Live model selection exposed two independent compatibility boundaries.
Qwen3-0.6B loaded and answered the first agent probe, but failed the repeated reply contract.
Qwen3-4B required 4.5 GiB of KV cache for a 32K context, so the initial 4 GiB setting failed startup safely; declaring 6 GiB allowed it to load from the retained snapshot.

Weight size alone cannot prove that serving settings or agent behavior will work.
Keep those failures explicit rather than treating a downloadable model as a qualified agent backend or weakening the agent probe.

With the corrected settings, Qwen3-4B passed actual Fabric OpenClaw replies, unchanged apply, export/reapply, and watchdog stop with explicit recovery.
Resource identities and snapshot receipts stayed stable during recovery; intentional destroy retained storage, and a later apply reused it.
The same generic runtime image served both tested models.

See the [retained evidence](../validation/rust-selected-model-linux-arm64.json).
