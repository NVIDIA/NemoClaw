<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

Use the [validation matrix](validation/README.md) to distinguish tested configurations from remaining qualification gates.

## Build and Deploy

| Task | Guide |
|---|---|
| Build the CLI bundle and runtime images | [Build local artifacts](build.md) |
| Configure, apply, export, recover, and destroy a deployment | [Use desired state](usage.md) |
| Declare sandbox filesystem, process, egress, and proxy settings | [Sandbox policy and proxy](sandbox-network.md) |
| Look up YAML fields, defaults, and constraints | [Configuration reference](reference/configuration.md) |
| Select inference APIs, OpenClaw limits, and Hermes authentication | [Inference configuration](inference.md) |
| Configure and access native dashboards | [Agent interfaces](interfaces.md) |
| Choose an agent and access its native runtime | [Agent runtimes](agents.md) |
| Choose a public model for managed vLLM | [Select a managed model](models.md) |
| Package model-specific preparation | [Inline model recipes](recipes.md) |
| Place inference on an SSH-selected Docker engine | [Configure an SSH model service](remote-service.md) |
| Call deployment operations programmatically | [Use the SDK](sdk.md) |

## Develop and Validate

| Task | Guide |
|---|---|
| Run workspace checks and collect coverage | [Tests](testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Run fixture qualification](testing/fixtures.md) |
| Qualify explicitly owned live resources | [Run live qualification](testing/live.md) |
| Inspect retained results and their limits | [Validation evidence](validation/README.md) |
| Write or reorganize documentation | [Contribute documentation](CONTRIBUTING.md) |
| Update the generated schema and field reference | [Schema maintenance](configuration-schema.md) |

## Understand the Design

Start with the architecture page to follow one deployment through the SDK, OpenTofu, and backend APIs.
Then use the runtime, execution-target, and recipe pages to understand decisions inside that lifecycle.
Each explanation includes diagrams and links to the commits that established its boundaries; historical findings retain their original qualification limits.

| Topic | Owner |
|---|---|
| Accepted scope, implementation boundaries, and invariants | [Design decision](design/scope.md) |
| SDK ownership, durable state, staged apply, and retained storage | [Architecture](design/architecture.md) |
| Process lifetime, watchdog recovery, and agent ownership | [Runtime design](design/runtime.md) |
| Connections, engine identity, inference traffic, and host capacity | [Execution targets](design/execution-targets.md) |
| Artifact ownership, preparation verification, and receipt publication | [Recipe design](design/recipes.md) |
| Current engine constraints and source locations | [Execution-engine assumptions](engine-assumptions.md) |
| Proposed migration of previous user guides, public routes, and release documentation | [Documentation migration plan](design/documentation-migration.md) |

## Sources and Fixtures

- [Agent runtime source notices](../image/NOTICE.md).
- [Generic vLLM source notices](../runtimes/vllm/NOTICE.md).
- [Qwen3.8 source notices](../runtimes/qwen38/NOTICE.md).
- [Configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md).
- [Managed runtime fixture provenance](../crates/nemoclaw-sdk/src/managed/REFERENCE.md).
