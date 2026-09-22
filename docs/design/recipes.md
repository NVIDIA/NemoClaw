<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inline Recipe Design

An inline recipe declares model-specific preparation and serving requirements without adding a backend to the SDK.
The [accepted scope](scope.md) defines requirements; the [recipe guide](../recipes.md) owns declaration fields and the executable protocol.

## Why the Contract Is Data

Ordinary models and recipes share downloads, storage, supervision, and backend startup.
A versioned declaration supplies the extra tools, patches, capacity requirements, and verification a model needs, so changing a model need not change the SDK.

The pinned runtime image supplies executables; YAML identifies them and declares their requirements.
Invocation uses structured JSON without shell interpolation or dynamic libraries.
Executable hashes verify identity, not safety: recipe tools remain trusted image code.
Sources, licenses, and build inputs stay with each artifact.

The artifact's verifier checks whether prepared files are meaningful for its model.
The shared runtime checks output structure, paths, hashes, byte budget, and publication state.
Both checks matter because a matching hash cannot establish that a model transformation was correct.

## Verify Before Publishing Prepared Data

Preparation can take hours and leave partial output.
The runtime uses staging so interruption or failed verification cannot publish an incomplete result:

```mermaid
flowchart LR
    Snapshot[Pinned snapshot] --> Stage[Prepare in staging]
    Stage --> Verify[Artifact verifier and runtime checks]
    Verify --> Publish[Write manifest and atomically rename]
    Publish --> Serve[Start backend]
```

Failure or cancellation retains unpublished staging data.
An existing published preparation must pass manifest and file-metadata checks before reuse; invalid data stops startup.
The final directory and manifest are the result, with no separate completion flag.
The [preparation lifecycle](../../crates/nemoclaw-sdk/src/services/installers/vllm/recipes/preparation.rs) implements these checks.

Cache import offers old files as candidates to the current verifier; it does not inherit trust from an old manifest.
The entire declaration participates in the preparation key, so even a serving-only edit selects a new preparation identity.
This keeps one auditable identity at the cost of coupling preparation reuse to serving settings.

## Why Preparation Is a Runtime Stage

Prepared files share the inference service's retained storage and recovery lifecycle.
The runtime can resume preparation before backend startup without a separate controller or OpenTofu resource.
Orchestration consumes runtime status; recipe manifests and image capabilities use the existing engine-scoped observation boundary.
Execution and downloads remain direct operations.

## Validation

[Inline recipe results](../validation/rust-inline-recipes-linux-arm64.json) cover verified cache import, unchanged apply, export/reapply, and actual agent responses for the recorded DGX Spark images.
[Built-in recipe removal](../validation/rust-recipe-removal-linux-arm64.json) records rejection of retired compatibility paths and validation of rebuilt artifacts.
These results do not establish native-agent state migration, arbitrary recipe compatibility, or other GPUs.
