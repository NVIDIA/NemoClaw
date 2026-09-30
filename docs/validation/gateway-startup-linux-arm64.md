<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Gateway Exit on Linux ARM64

The [issue #12457](https://github.com/NVIDIA/NemoClaw/issues/12457) readiness regression passed at implementation commit `299df9d367cd2bc0f3b338d06d4c8f9e60b656c7`, using bundle `0.1.0-dev.2bcddfbfca0dda54`.
The bundle was built with Rust 1.98.1 and OpenTofu 1.12.6 on Linux ARM64 on 2026-09-29 (America/Vancouver).
The provider now reports an owned Docker gateway's confirmed stopped state while waiting for its API, including when an API request is already pending.
The [provider reference](../provider.md#gateway-capabilities) describes the inputs, identity checks, timeout, and diagnostic limits.

## Regression and Fixture Results

Before implementation, the [provider regression](../../crates/nemoclaw-provider/src/gateway_tests.rs) exceeded its two-second deadline despite the engine reporting an exited gateway.
The runtime graph regression also failed because readiness had no bound container ID.
Both passed after implementation.
Process tests cover exit during a pending request, recovery across a restart race, running-but-unreachable behavior, substituted identities, incomplete observations, and engine authentication, permission, transport, and absence results.

The [OpenTofu readiness fixture](../../crates/nemoclaw-e2e/tests/gateway_readiness.rs) passed in 2.19 seconds against the bundled provider.
It checks deferred readiness after bootstrap, an exited process with exit code 42, safe diagnostics, retained bootstrap state, corrected retry, unchanged-apply failure, and teardown with readiness omitted.
It uses a built-in OpenTofu resource as the bootstrap identity and local engine and OpenShell fixtures; it creates no live container.
All 23 separately selected OpenTofu/OpenShell fixtures passed against the same provider.
See [fixture instructions](../testing/fixtures.md#opentofu-and-bundle-lifecycle) for explicit executable selection.

Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (939 passed, zero failed, 132 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
Documentation validation passed with zero errors and one existing Fern warning.

## Manual Docker and OpenShell Test

The manual run used Docker Engine 29.2.1, the [pinned gateway, supervisor, and sandbox runtime images](managed-docker-openshell-v012-linux-arm64.md#pinned-images), and the Nooa image `nc-explore@sha256:689b0e29623919cfdcb99be6d0a9ee2bec8170ee8ba73fa7d483b528e91fbd1d`.
It used a fresh deployment UUID, state directory, loopback port, and subnet, with a checksum-verified immutable bundle copy.
The inference endpoint was a reserved example domain; no inference or agent requests were sent.

Occupying the chosen gateway port caused Docker to reject container startup in 5.20 seconds.
That failure came from Docker before capability readiness and does not qualify the new exit diagnostic.
After the port was released, explicit reapply replaced failed gateway compute and completed deployment in 15.14 seconds.

A separate OpenTofu configuration then read the same gateway through the new data-source inputs, using its exact container ID and owned specification.
It had no resources to mutate and requested a 90-second readiness timeout.
The running check passed in 0.39 seconds.
After the test deliberately stopped its gateway, the check failed in 0.51 seconds with the container name, `is exited`, exit code 0, a `docker logs` command, and `resources retained`.
After the test restarted the same container, the check passed in 0.55 seconds.
These results qualify real Docker inspection of a deliberately stopped process, not a spontaneous startup crash.

| Operation | Observed result |
|---|---|
| Initial plan | Passed in 2.62 seconds without creating containers |
| Apply after gateway restart | Passed in 9.81 seconds; updated agent configuration with identical managed resource IDs |
| Export | Passed in 2.42 seconds |
| Reapply exported YAML | Passed in 6.26 seconds with no changes and identical managed resource IDs |
| Destroy preview | Passed in 2.40 seconds |
| Final destroy | Passed in 4.33 seconds; retained only workspace and gateway-storage bindings |

Successful applies reported `fabric_health_unsupported`; they do not establish positive agent health.
After teardown, the test's stopped initializer, retained gateway volume, and empty bridge were removed following UID-label checks.
All pre-existing container IDs remained present.
Local input documents, outputs, timings, and historical state were retained; that state cannot be reused after storage cleanup.

## Qualification Limits

The fixture covers exit during readiness and recovery or teardown with retained bootstrap state.
The manual run covers real Docker state inspection, recovery from a port-binding startup failure, and the named Linux ARM64 deployment lifecycle.
It does not reproduce the original incompatible-image startup crash; the current schema rejects older gateway image pins before mutation.
Podman and external gateways retain API-only readiness, and this run does not qualify them, other platforms, model responses, or arbitrary gateway failures.
