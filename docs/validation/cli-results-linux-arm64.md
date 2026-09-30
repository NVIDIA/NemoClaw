<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# CLI Results on Linux ARM64

The [issue #12474](https://github.com/NVIDIA/NemoClaw/issues/12474) qualification covers failure-state reporting, resource identities, discovery counts, stopped-runtime guidance, and incomplete previews.
Tests ran on Linux ARM64 on 2026-09-29–30 (America/Vancouver), with Rust 1.98.1 and OpenTofu 1.12.6.

| Change | Implementation | Qualified bundle |
|---|---|---|
| Failure-state boundary | `8888639ed5` | `0.1.0-dev.05db8e159ed804ab` |
| Resource identity and preview output | `65f8a06e484cf1738afdd4ec52ffa29d8d64dd94` | `0.1.0-dev.9e43e9d5064880d5` |

## Checked Behavior

The initial [CLI process regression](../../crates/nemoclaw-cli/tests/commands.rs) failed because a missing input file reported that resources might already have changed.
Apply and destroy now distinguish failure before a mutating subprocess launches from possible partial mutation.
Checks cover disabled progress, missing inputs and credentials, invalid bundles, failed process launch, cancellation before and after launch, short-secret redaction, and failures in later stages.
Four manual packaged-CLI checks covered apply with a missing input and destroy with a missing bundle, each in text and JSON.
They returned exit code 1, reported no runtime changes, and created no state directory.
The real OpenTofu Pi-start failure fixture retained the post-mutation warning and allowed direct destroy in both formats.

[Result-rendering regressions](../../crates/nemoclaw-cli/src/formatting.rs) failed before the new labels, counts, restart guidance, and deferred-resource output.
Scoped and route-inline provider registrations retain their authored names and paths without exposing credentials.
Default result text names known runtime, search, proxy, model, and credential-storage resources; verbose text retains native identities, and JSON retains their structured facts.
Deferred image bindings are grouped in normal text output.
Established resources are partitioned into unchanged plans and planned changes, with new resources counted separately.
OpenTofu refresh differences remain a separate fact and can include computed metadata with no planned action.

The final bundle passed two [real OpenTofu lifecycle fixtures](../../crates/nemoclaw-e2e/tests/deployment.rs) using isolated gateway servers.
The scoped-provider fixture checked authored labels, observed a stopped Fabric host in read-only text and JSON plans, reapplied its configuration without recreating the sandbox, and destroyed the fixture deployment.
The CLI lifecycle fixture covered plan, apply, unchanged apply, and destroy with separate result and progress streams.

[Provider regressions](../../crates/nemoclaw-provider/tests/refresh.rs) first failed because replacement refusals omitted identity and changed fields, and external Ollama failures omitted upstream context.
The corrected diagnostics name the resource and safe fields without echoing changed values or URL credentials.
Manual text and JSON plans against the host Docker engine listed all three previously omitted Ollama proxy resources as awaiting a complete plan.
They did not assign actions to those resources or mark the preview complete.
A separate real-provider OpenTofu plan against an explicitly closed loopback upstream named `services.local.upstream` and its endpoint.
These manual checks created no runtime resources and preserved all 111 pre-existing Docker containers.

Final workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (958 passed, zero failed, 135 ignored).
The explicitly selected lifecycle fixtures passed separately; ignored tests are not counted as workspace passes.

## Qualification Limits

The proxy preview used a schema-valid placeholder image and stopped before the deferred deployment stage.
It does not qualify that image, a working Ollama proxy, or successful model inference.
The stopped-runtime and Pi-failure checks used gateway fixtures, not native agent processes.
No system packages, agent images, or live deployments were changed for these checks.

The SDK's `drifted` field continues to reflect OpenTofu refresh differences; these changes clarify its meaning rather than suppressing computed-metadata differences.
An incomplete preview lists known resources without claiming that their actions were checked.
See the [CLI result contract](../reference/cli.md#output-and-failure) and [SDK inventory contract](../sdk.md#read-plan-discovery-and-resource-inventory) before interpreting these fields as readiness or a complete plan.
