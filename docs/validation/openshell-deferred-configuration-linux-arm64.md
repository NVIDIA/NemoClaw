<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deferred OpenShell Provider Configuration

A fresh OpenShell graph can now use a provider endpoint produced by another resource in the same saved plan.
OpenTofu creates the upstream resource, resolves the endpoint, and then applies workspace, provider profile, provider registration, and sandbox resources.
The [earlier qualification](openshell-provider-composition-linux-arm64.md) required a targeted bootstrap apply at its recorded revision.

This removes the known-endpoint requirement for fresh-resource planning.
It does not remove the SDK's runtime stage: refreshing existing OpenShell bindings still requires a reachable gateway before OpenTofu can apply upstream recovery changes.

## Tested Behavior

Tested implementation `eb649bb7f2` on 2026-09-20 on Linux ARM64 with OpenTofu 1.12.6 and the production NemoClaw provider.
The verified native bundle is `0.1.0-dev.5b14d4cfa9f49ad0`.
The [direct HCL driver](../../crates/nemoclaw-e2e/tests/fixtures/standalone_openshell.rs) changes the provider endpoint to `terraform_data.bootstrap.output`.
It invokes OpenTofu directly against an isolated loopback OpenShell gRPC fixture, without SDK graph generation or deployment coordination.

| Case | Observed result |
|---|---|
| Fresh graph with an unknown endpoint | Planning succeeds without remote mutation; applying that saved plan creates bootstrap and OpenShell resources, then an unchanged plan reports no changes. |
| Foreign resources appear after planning | Apply rejects their ownership without mutating them. |
| Observation fails after the endpoint resolves | Apply fails without remote mutation; after observation recovers, apply succeeds and reaches no-op. |
| Bootstrap endpoint changes with established bindings | Planning fails and preserves state; neither gateway is mutated. |
| Bound gateway is unavailable while bootstrap replacement is requested | Apply fails during refresh, before bootstrap replacement; state and remote resources remain unchanged. |

Provider unit tests cover unknown endpoint, bearer reference, each TLS reference, and teardown mode.
Reconfiguration clears any previous client and teardown permission before deferring.
An unresolved connection permits only fresh OpenShell planning; it does not permit reads, mutations, deletion, or planning against prior bindings.
When all configuration inputs are known, null or invalid endpoints fail configuration rather than deferring.

These tests use a synthetic gateway and a `terraform_data` bootstrap resource.
They do not start a real gateway container or establish gateway startup, model readiness, agent readiness, or inference compatibility.
No new provider binary or runtime readiness policy was introduced.

## Remaining Boundary

The provider now handles configuration values that OpenTofu resolves during apply.
It still rechecks ownership once it can observe the target gateway; a saved plan does not authorize adopting foreign resources.
Read failures preserve existing bindings instead of treating unobserved resources as absent.

The unavailable-gateway experiment demonstrates why a dependency edge alone cannot replace recovery staging: OpenTofu refreshes bound resources before applying the bootstrap replacement.
The SDK currently restores runtime resources before planning the OpenShell stage.
Keep that ordering until a tested provider or OpenTofu mechanism can restore access while preserving observation, ownership, and retained-state guarantees.
Do not skip refresh or convert transport failures into confirmed absence to make the graph proceed.

A real gateway startup experiment with a provider-owned readiness dependency remains the next qualification step.
Application readiness stays with the runtime; orchestrators consume its observations.
SDK checks against separately retained deployment intent remain unchanged.

## Reproduce

From the repository root, build the production provider and a verified native bundle using the [native fixture instructions](../testing/fixtures.md).
The following command requires absolute executable paths and touches only temporary state and isolated loopback gateway fixtures.

```sh
NEMOCLAW_TEST_TOFU="$PWD/dist/linux_arm64/libexec/tofu" \
NEMOCLAW_TEST_PROVIDER="$PWD/target/debug/terraform-provider-nemoclaw" \
cargo test -p nemoclaw-e2e --test opentofu_openshell standalone:: -- --ignored
```

Expect eleven standalone tests to pass, including the earlier lifecycle guards and recovery cases.
Temporary state and gateway fixtures are removed after each test.
