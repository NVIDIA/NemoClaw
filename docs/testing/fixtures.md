<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Fixture Qualification

These tests use local protocol fixtures and temporary state.
They do not provision live deployments.
Complete the [build prerequisites](../build.md) first.

## OpenTofu and Bundle Lifecycle

The private `nemoclaw-e2e` crate runs the actual provider protocol through OpenTofu 1.12.6.
Supply an absolute executable path explicitly:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
  cargo test -p nemoclaw-e2e --test provider_protocol -- --ignored
```

These tests launch a fixture provider built by that crate and use temporary files.
They create no Docker, OpenShell, or inference resources.
The fixture provider is not a production bundle component.

Runtime bundle and live backend qualification remain separate acceptance gates.

Build the production provider and qualify its full OpenShell graph against the local gRPC fixture:

```sh
cargo build -p nemoclaw-provider --bin terraform-provider-nemoclaw
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test opentofu_openshell -- --ignored
```

The SDK/CLI lifecycle tests require a verified native bundle (manifest plus CLI, OpenTofu, and production provider).
They use only the local gRPC fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment --test fabric_deployment -- --ignored
```

CI runs the fixture lifecycle tests with `--test-threads=2`.
Each Fabric harness is an independent ignored test with its own temporary state and gRPC fixture.
To qualify one harness, append its test name, for example `-- --ignored harness_codex`; to run all harnesses with CI's concurrency bound, use `-- --ignored --test-threads=2`.

These tests cover shared SDK/CLI state, interrupted creation, unchanged apply, readiness failure without replacement, failed observation without state loss, export/reapply, interrupted destroy, and retained workspace recovery.
The fixture returns protocol responses; it does not establish live agent inference.

## Ollama and Platform Fixtures

Managed Ollama's deterministic bundle test uses local Docker and model HTTP fixtures, not live containers or model downloads.
It covers stopped-service recovery, failed startup, legacy storage-binding upgrade, failed observation, volume replacement, lost deletion responses, and destroy/reapply without another model pull:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test ollama -- --ignored
```

Authenticated OpenShell, stalled exec streams, and launch compatibility run in the default workspace suite.
`agent_compatibility` uses fixtures generated from the pinned Go reference, covering the ten retained Fabric launch contracts.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The native CI matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64/x64, and Windows x64.
CI's protocol and lifecycle fixtures do not establish local Docker, Podman, GPU, or real model availability on those platforms.
Build logs and runtime evidence must be reported separately.

## Runtime Boundaries

Runtime separation has focused checks:

```sh
cargo test -p nemoclaw-runtime
cargo test -p nemoclaw-sdk --test runtime_boundaries
```

The supervisor tests use an ordinary owned process and validated memory thresholds, without a DGX Spark document.
They exercise readiness, pressure, failed observations, cancellation, and the loading deadline.
Cancellation must leave a neighboring process alive.

The backend HTTP fixture rejects unavailable, unauthorized, and redirect responses before accepting readiness.
The executable test rejects invalid `NEMOCLAW_RUNTIME_SPEC` input and the removed environment alias without starting model work.

The recipe test checks declared serving arguments and capacity, and rejects unqualified model/backend/hardware combinations.
The [live image-change test](live.md#spark-and-fabric) is the deployment acceptance gate: the new image must preserve cached artifacts and independent bindings, return an agent response, and produce no changes on subsequent apply and export/reapply.
A fixture process proves supervisor independence; it does not qualify another real serving backend.

## SSH Service Fixtures

The `remote_service` E2E fixture exercises the bundled CLI/provider boundary with an isolated Docker-over-SSH simulator and OpenShell fixture.
Run `cargo test -p nemoclaw-e2e --test remote_service -- --ignored` with `NEMOCLAW_TEST_BUNDLE` set.
It checks read-only planning, missing/low capacity, failed startup recovery, no-op, export/reapply, failed observation and daemon retargeting without recreation, and retained storage on destroy.

Its readiness and artifact receipts are simulated; it does not download or serve a model.
