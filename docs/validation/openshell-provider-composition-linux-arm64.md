<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Independent OpenShell Resource Composition

Ordinary HCL now composes workspace, provider profile, provider registration, and sandbox resources without SDK graph generation or deployment coordination.
The provider rejects unsafe OpenShell lifecycle changes during planning.
The SDK retains deployment intent checks and staged bootstrap because these serve boundaries the standalone resources do not replace.

## Environment and Scope

Tested on 2026-09-20 on Linux ARM64 with OpenTofu 1.12.6 and the production NemoClaw provider.
The fixture revision is `9e39060260`; the verified Linux ARM64 bundle is `0.1.0-dev.27d742d98da1b0aa`.
The implementation commits are `395dc5067d` (independent inference JSON) and `29e34789e2` (provider planning guards).
The [HCL fixture](../../crates/nemoclaw-e2e/tests/fixtures/openshell_resources.tf) uses native attribute references to order its resources.
The [test driver](../../crates/nemoclaw-e2e/tests/fixtures/standalone_openshell.rs) invokes OpenTofu directly against an isolated, in-memory OpenShell gRPC fixture.
It does not invoke the SDK compiler, plan checker, deployment record, or stage coordinator.
The driver uses an SDK helper to select the executable filename on each platform.

The gateway fixture is synthetic; this result does not qualify a live OpenShell gateway, GPU execution, model responses, or agent readiness.
The sandbox settings select a provider and model but do not prove successful inference routing.
Existing application-readiness ownership remains with the runtime; Docker process startup is not application readiness.

## Results

| Case | Observed behavior |
|---|---|
| Valid HCL `jsonencode` input | Sandbox creation succeeds without SDK JSON key ordering; unknown fields, invalid settings, and malformed JSON remain rejected. |
| Initial plan | No remote mutations. |
| Create and unchanged plan | Four resources are created in dependency order, then every planned action is `no-op`. |
| Missing bound sandbox | Ordinary planning fails and preserves prior state; explicit teardown accounts for confirmed absence. |
| Changed immutable sandbox image | Planning fails before replacement. |
| Removed resources without teardown mode | Planning fails before deletion. |
| Changed live ID, owner, or generation | Planning fails without changing state or mutating the gateway. |
| Unavailable or unauthenticated observation | Planning fails, retains state, and does not expose the fixture's secret sentinel. |
| Failed readback after sandbox creation | OpenTofu saves the established ID and taints the resource; refresh and explicit untaint allow recovery without another creation. |
| Lost provider deletion reply | The failed operation retains its provider binding; a later teardown confirms absence and finishes without repeating sandbox deletion. |
| Teardown | Sandbox, provider registration, and provider profile are removed; workspace remains. |
| Endpoint unknown until bootstrap apply | Initial planning fails at provider configuration without mutation; applying bootstrap first lets the same graph apply and reach no-op. |

Workspace tests, `cargo fmt --check`, and `cargo clippy --workspace --all-targets -- -D warnings` passed.
Provider unit tests additionally cover missing bindings, immutable changes, and teardown permissions for all four OpenShell resource kinds.
Workspaces remain protected even when teardown mode is enabled.

## Responsibility Decisions

The provider now enforces missing-binding, replacement, and teardown-mode rules directly.
Its existing reads and mutations check live ownership, generation, and physical identity against OpenTofu state.
OpenTofu owns resource ordering, resource state, and taint handling.
A failed create that establishes an ID still requires explicit recovery from taint; retrying apply alone is not automatic recovery.

The SDK's [plan checks](../../crates/nemoclaw-sdk/src/deployment/plan.rs) compare that state with a separate retained deployment record.
The provider can detect resources removed from configuration when OpenTofu still records them in state.
It cannot compare the supplied state and graph with the SDK's separately retained deployment intent.
Keep the SDK checks for retained intent, saved IDs, resource accounting, and allowed deployment actions.
No SDK checks were removed in this qualification.

The bootstrap experiment uses `terraform_data.bootstrap.output` as the provider endpoint.
The [current provider configuration](../../crates/nemoclaw-provider/src/provider.rs) requires a known endpoint before it can plan OpenShell resources.
This establishes a limitation of the current implementation, not an inherent inability of OpenTofu to express the dependency.
Keep runtime and OpenShell stages until deferred provider configuration and observation against a newly started gateway are implemented and tested together.
The targeted bootstrap apply is an experiment, not a recommended deployment workflow.

The next deletion candidate is SDK sequencing after that bootstrap boundary is resolved.
Retain application readiness as a runtime-owned contract and consume its observations before reporting deployment readiness.
Creating another provider binary alone would not resolve these gaps.

## Reproduce

From the repository root, build the production provider and a verified native bundle using the [native fixture instructions](../testing/fixtures.md).
Use absolute paths for the two test inputs below.
The tests create only temporary local state and isolated loopback gateway fixtures; they do not access a user's gateway or Docker resources.

```sh
NEMOCLAW_TEST_TOFU="$PWD/dist/linux_arm64/libexec/tofu" \
NEMOCLAW_TEST_PROVIDER="$PWD/target/debug/terraform-provider-nemoclaw" \
cargo test -p nemoclaw-e2e --test opentofu_openshell standalone_hcl -- --ignored
```

Expect seven standalone tests to pass.
Their temporary state and gateway fixtures are removed when each test ends.
The existing native lifecycle CI selection includes these tests on its configured platforms; this local record establishes Linux ARM64 results only.
