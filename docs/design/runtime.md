<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime and Model Design

The inference runtime owns preparation, startup, readiness, and protective shutdown inside its container.
The [accepted scope](scope.md) defines its requirements.

## Separate What Changes Independently

Model artifacts, hardware capacity, and process lifetime change independently.
Keeping their owners separate lets fixture processes exercise supervision without a model or GPU.
The `nemoclaw-runtime` crate owns the serving contract and builds one supervisor executable.
Its library defines model and recipe settings, hardware requirements, defaults, validation, and schema fragments.
The SDK consumes that contract with execution disabled and adds deployment fields such as image, container, placement, and publication.
Those deployment fields are excluded from runtime JSON; the supervisor validates the serving contract before starting work.
The runtime does not depend on the SDK, provider, OpenShell, Fabric, or Docker transport.

The executable has these boundaries:

| Concern | Owner |
|---|---|
| Process lifetime, cancellation, status, readiness deadline | Shared supervisor |
| Memory and GPU observations, capacity and protection rules | Hardware modules and validated profiles |
| Model identity and snapshot resolution | Hugging Face module |
| Model-specific tools, patches, preparation, and tuning | Versioned recipe artifacts |
| Launch arguments and readiness probe | Backend modules |

Ordinary models and inline recipes use one vLLM argument builder.
Hardware requirements come from the recipe or an explicit service hardware contract.
Named profiles check GPU family and compute capability separately from memory capacity; failed or incomplete observations stop the operation.
Collectors preserve unsupported framebuffer counters without inferring a memory architecture.
Hardware identity does not select device placement or parallelism.
See [hardware profiles](../models.md#choose-a-hardware-profile) for memory accounting, supported configurations, and qualification limits.

A new backend or hardware profile normally adds a module and tests for its configuration.
A new crate requires a dependency or deployment boundary and a consumer.

## Why the Watchdog Lives with Inference

Loading and serving continue after the CLI exits, so memory protection runs beside inference and can stop its owned process group.

```mermaid
stateDiagram-v2
    [*] --> Prepare
    Prepare --> Loading: Preparation and startup capacity checks pass
    Prepare --> Stopped: Preparation or capacity check fails
    Loading --> Ready: Backend readiness succeeds
    Loading --> Stopped: Deadline, pressure, observation failure, or child exit
    Ready --> Stopped: Pressure, observation failure, operator stop, or child exit
    Stopped --> Prepare: Explicit apply verifies bindings and capacity
```

The loading deadline is separate from download and preparation limits.
The [supervisor](../../crates/nemoclaw-runtime/src/execution/supervisor.rs) distinguishes pressure, observation failures, closed sample streams, and operator trips so recovery addresses the cause.
A protective stop retains data and bindings and must not trigger an automatic restart loop that repeats the same memory demand.
Explicit apply may restart or replace disposable compute; the runtime rechecks capacity before serving.
See [runtime recovery](../models.md#diagnose-and-recover-a-stopped-runtime) for operator steps.

## Why Fabric Owns the Agent Process

Fabric owns the agent runtime inside the OpenShell sandbox; OpenShell supplies isolation and inference routing.
Managed and external dependencies use the same Fabric launch path.
NemoClaw supplies deployment settings such as model IDs and endpoints, while native agent configuration remains the agent's responsibility where no deployment invariant applies.
This avoids maintaining a second agent schema or launcher.
See [agent runtimes](../agents.md) for harness configuration and native access.

Missing or unsupported runtime labels are failed observations, never absence.
Changing a harness does not migrate sandbox identity or agent data.
Old standalone OpenClaw state requires its original bundle for export or teardown; retained intent is not automatically migrated.

## Model Choice and Retained Data

The generic vLLM backend accepts a public Hugging Face repository and immutable revision without a model allowlist.
Image compatibility follows the backend; model storage identity includes the repository and revision.
Parser acceptance does not establish image, checkpoint, capacity, or agent compatibility.

The default service plan neither reads model metadata nor downloads or prepares a model.
At startup, the runtime resolves a checksummed snapshot and retains resumable downloads and a manifest of expected files and verification metadata.
Orchestration consumes runtime status instead of repeating artifact verification.
Authentication or transport failures, incomplete inventories, and changed artifacts are errors, never absence.
See [retained model files](../models.md#retained-model-files) for format compatibility.

The shared downloader remains in `nemoclaw-runtime` because the evaluated owner clients do not preserve all of these guarantees.
The [pinned ARM64 vLLM image](../../runtimes/vllm/Dockerfile) contains `huggingface_hub` 1.28.0.
Its [download API](https://github.com/huggingface/huggingface_hub/blob/v1.28.0/src/huggingface_hub/file_download.py) accepts a commit revision and resumes transfers, but its HTTP path checks the expected size after writing and resolves local cache paths through symlinks.
Verification after that download would not preserve NemoClaw's bounded writes and cache-path checks.
The retained implementation also bounds metadata reads, verifies checksums, preserves partial transfers, and treats authentication failures as errors.

The [Ollama 0.17.7 pull implementation](https://github.com/ollama/ollama/blob/9b0c7cc7b90562b370ce6a30efdc667326799223/server/images.go) fetches a tag without accepting an expected manifest digest.
The retained downloader targets the private cache layout described by that revision.
Before loading, its [inventory check](../../crates/nemoclaw-runtime/src/ollama/runtime/observation.rs) requires the running Ollama to report the authored model name and digest.
A missing model or mismatched digest stops startup; the runtime does not repair the cache by pulling a mutable tag.
Custom images must satisfy this same behavioral contract; a version string alone does not establish compatibility.
**TBD:** synthetic-cache qualification against the actual pinned Ollama image; the inventory fixtures do not establish that compatibility or successful inference.

Model-specific preparation belongs in an [inline recipe](recipes.md).
Ordinary models must not inherit another model's memory estimates, parsers, tuning, or preparation tools.
Weight size alone cannot establish that serving settings or agent behavior will work.

## Validation

[Runtime fixtures](../testing/fixtures.md#runtime-boundaries) test supervision, readiness, preparation identity, capacity, retained data, and recovery without a GPU.
[Recorded runtime](../validation/rust-runtime-boundaries-linux-arm64.json) and [model-selection results](../validation/rust-selected-model-linux-arm64.json) cover their named images and hardware, including inference responses and export/reapply.
They do not qualify another backend or arbitrary model.
