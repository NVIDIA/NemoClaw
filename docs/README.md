<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

These guides describe the experimental Rust `v1` branch.
Use the [validation matrix](validation/README.md) to distinguish tested configurations from remaining qualification gates.

## Build and Deploy

| Task | Guide |
|---|---|
| Build the CLI bundle and runtime images | [Build local artifacts](build.md) |
| Configure, apply, export, recover, and destroy a deployment | [Use desired state](usage.md) |
| Choose an agent and access its native runtime | [Agent runtimes](agents.md) |
| Choose a public model for managed vLLM | [Select a managed model](models.md) |
| Package model-specific preparation | [Inline model recipes](recipes.md) |
| Place inference on an SSH-selected Docker engine | [Configure an SSH model service](remote-service.md) |
| Call deployment operations from Rust | [Use the SDK](sdk.md) |

## Develop and Validate

| Task | Guide |
|---|---|
| Run workspace checks and collect coverage | [Tests](testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Run fixture qualification](testing/fixtures.md) |
| Qualify explicitly owned live resources | [Run live qualification](testing/live.md) |
| Inspect retained results and their limits | [Validation evidence](validation/README.md) |
| Write or reorganize documentation | [Contribute documentation](CONTRIBUTING.md) |

## Understand the Design

| Topic | Owner |
|---|---|
| Accepted scope, implementation boundaries, and invariants | [Design decision](../DESIGN.md) |
| SDK and OpenTofu architecture | [Architecture](design/architecture.md) |
| Runtime, model, and agent design findings | [Runtime design](design/runtime.md) |
| Engine identity, Podman, and SSH experiments | [Execution targets](design/execution-targets.md) |
| Inline recipe design findings | [Recipe design](design/recipes.md) |
| Current engine constraints and source locations | [Execution-engine assumptions](engine-assumptions.md) |

## Sources and Fixtures

- [Agent runtime source notices](../image/NOTICE.md).
- [Generic vLLM source notices](../runtimes/vllm/NOTICE.md).
- [Qwen3.8 source notices](../runtimes/qwen38/NOTICE.md).
- [Configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md).
- [Managed runtime fixture provenance](../crates/nemoclaw-sdk/src/managed/REFERENCE.md).

The [former RFC location](../RFC-desired-state.md) preserves links to the design topics.
