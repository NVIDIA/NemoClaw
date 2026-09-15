<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inline Recipe Design

These findings record the Rust experiment, including intermediate results and limits.
The [accepted scope](../../DESIGN.md) governs implementation changes.
For current procedures, use the [documentation index](../README.md).

## Inline Recipe Contract Experiment

Recipe authors own model-specific preparation, semantic verification and patched runtime code.
NemoClaw owns the versioned execution contract, pinned-artifact checks, staging and receipt lifecycle, typed backend settings, host observations, and supervision.
The complete recipe declaration is inline in `service.recipe`; a future reference or file form can resolve into that same structure.

The new path uses `backend: vllm` for both ordinary models and models needing preparation.
The Qwen adapters run inside its pinned image using structured JSON stdin/stdout.
No dynamic Rust library or shell command interpolation is involved.

Image labels declare required capabilities and protocol support; executable hashes bind the declaration to packaged code.
Licenses and source notices stay in the artifact.
New recipe identities do not require a Rust enum variant.

The built-in Qwen backend, recipe enum, old receipt reader, and runtime aliases have been removed.
Backwards compatibility is not a requirement for this experimental branch.
Model-specific sources and their build manifest belong to the artifact directory.

The builder takes that manifest explicitly, so ordinary vLLM builds do not read Qwen pins.
Cache import still offers old packed bytes as candidates to the artifact’s verifier, without a legacy receipt reader in Rust.

The first declaration also carries resource requirements and typed vLLM settings; otherwise those model-specific assumptions would remain hidden in Rust.
Hardware requirements are evaluated against observations from the selected execution host.
This contract does not imply that all models or hardware combinations are qualified.

See [inline recipe execution](../recipes.md) for its protocol and limits, and the validation records for tested combinations.

The slice keeps one inference-service resource and independent retained storage.
Preparation is a resumable runtime stage with its own durable receipt; it does not need another OpenTofu resource or a long-running preparation controller.
OpenShell refresh/export still use the existing typed OpenShell API adapter.

Recipe receipts and image capabilities use the existing engine-scoped Docker observation boundary; a new collector would duplicate that boundary without moving the observation to a new host.
Execution, downloads and active readiness probes stay direct.

On the DGX Spark, both the inline Qwen recipe and ordinary Qwen3-4B returned an actual Fabric OpenClaw response through OpenShell.
The Qwen cache import needed verification but no download or repack; unchanged apply and export/reapply kept its runtime identities, start time and cache metadata.
This supports keeping preparation inside the shared runtime lifecycle rather than adding another resource.

The experiment does not qualify other GPUs or native-agent state migration.
See [the retained evidence](../validation/rust-inline-recipes-linux-arm64.json).
