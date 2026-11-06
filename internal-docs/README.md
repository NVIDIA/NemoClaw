<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Maintainer Documentation

Use the [public guide](../docs/README.md) for deployment tasks. The pages here record maintainer procedures and design decisions; they are not published in the v1 reader navigation.

## Contribute and Validate

| Task | Guide |
|---|---|
| Run workspace checks and collect coverage | [Tests](contributing/testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Integration tests](contributing/integration-tests.md) |
| Test explicitly owned live resources | [Live tests](contributing/live-tests.md) |
| Stage a private v1 release | [Release staging](contributing/releases.md) |
| Write and reorganize guides | [Documentation contribution](contributing/documentation.md) |
| Validate, preview, or publish the site | [Documentation build](contributing/documentation-build.md) |
| Maintain generated schema and field reference | [Schema maintenance](contributing/configuration-schema.md) |
| Maintain agent image pins, catalogs, and test fixtures | [Agent image maintenance](contributing/agent-image-maintenance.md) |
| Assess image changes | [Image assessment](contributing/image-assessment.md) |

## Design Decisions

| Topic | Record |
|---|---|
| Scope and upstream boundaries | [Accepted scope](design/scope.md) |
| Authoring, ownership, and validation | [Authoring domain](design/authoring-domain.md) |
| Partial-document onboarding | [Onboarding journeys](design/onboarding-journeys.md) |
| SDK, OpenTofu, and retained state | [Architecture](design/architecture.md) and [apply flow](design/apply-flow.md) |
| Process lifetime and Fabric ownership | [Runtime](design/runtime.md) and [Fabric management](design/fabric-management.md) |
| Engine, network, and model placement | [Execution targets](design/execution-targets.md) |
| Recipe artifacts | [Recipes](design/recipes.md) |
| Generic container design | [Container contract](design/container-contract.md) |

## Source Notices and Fixtures

Keep notices and fixture provenance next to their artifacts: [agent runtime notices](../image/NOTICE.md), [vLLM notices](../image/vllm/NOTICE.md), [configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md), and [provider fixture provenance](../crates/nemoclaw-provider/src/managed/REFERENCE.md).
