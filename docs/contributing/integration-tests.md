<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

This page covers the [contract and system layers](testing.md#test-layers): tests that run pinned OpenTofu from a bundle against local fixtures and temporary state.
They create no Docker, OpenShell, Kubernetes, or inference resources; tests that use a real Docker engine are [live tests](live-tests.md#docker-live-suite).
Complete the [build prerequisites](../build.md) first.

## OpenTofu and Bundle Lifecycle

The contract and system tests take one input: `NEMOCLAW_TEST_BUNDLE`, the absolute path of a bundle such as the `dist/PLATFORM` directory that `cargo ci bundle` writes.
The bundle supplies OpenTofu 1.12.6, the CLI, and the providers.
Each provider's contract tests run instead the provider Cargo built with them, so they test the checkout without a new bundle; the other providers they need come from the bundle.
System tests run the bundle's CLI and providers, so rebuild the bundle after changing either.

To run the whole layer pair as CI does, four tests at a time, run from the repository root:

```sh
cargo ci bundle
cargo ci lifecycle
```

To run one binary or module with Cargo, build the fixture executables first; tests find them beside the test executables:

```sh
cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-provider --test contract provider_protocol:: -- --ignored
```

Nextest builds every workspace target, including the fixture executables; after `cargo ci tools`, put `.tools/nextest-0.9.144` on `PATH` and narrow the `lifecycle` profile with a filter:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo nextest run --workspace --all-targets --profile lifecycle --run-ignored only \
  -E 'binary_id(=openshell-provider::contract)'
```

`nemoclaw-test-fixtures` holds what these tests share: `Bundle` reads `NEMOCLAW_TEST_BUNDLE`, `TofuWorkspace` creates an owned OpenTofu workspace with chosen providers, `openshell` serves a fake OpenShell gateway, and `ssh` holds the fake `ssh` relay and the SSH simulator.
The fake HTTP, engine, and Kubernetes servers in `crates/test-support` are shared with the unit tests.
On failure, read the OpenTofu diagnostic in the test output and check that the bundle matches the checkout before rerunning.

## Contract Tests

Each production provider's `contract` binary, under `tests/contract`, applies its types through OpenTofu against fakes.
Its coverage test is not ignored and runs with the unit tests; the remaining tests are ignored and run in the `lifecycle` step.

### vLLM, Ollama, and Host Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-provider --test contract -- --ignored
```

Its modules run the `nemoclaw` types against fake Docker engines, gateways, model servers, and Kubernetes APIs:

| Module | Checks |
|---|---|
| `provider_protocol` | The fixture provider from `nemoclaw-fixture-provider`, and on Unix the provider against a fake Docker API: network and image planning, including prerequisite changes before saved-plan application |
| `service_capacity` | `vllm_capacity` through an isolated SSH simulator (shared-host overcommit, deferred reads, state kept after failed observations, and cleanup without capacity checks), and Ollama readiness and capacity rejecting a vLLM contract |
| `service_readiness` | Standalone service readiness; see [below](#standalone-service-readiness) |
| `service_storage`, `gateway_storage` | Retained service storage and, on Unix, Docker gateway storage against a fake engine |
| `gateway_readiness` | Managed-gateway exit diagnostics, bootstrap state kept after failure, corrected retry, unchanged-apply rechecks, and teardown without the readiness data source |
| `runtime_image`, `vllm_runtime` | Runtime image compatibility and, on Unix, the vLLM runtime contract |
| `host_container_health` | Authored application health reads: an owned healthy container passes and an unhealthy one fails the plan |
| `discovery` | Discovery plans that read target metadata without mutations |
| `kubernetes_hcl`, `kubernetes_lifecycle` | Kubernetes planning, and apply, refresh, and teardown against the in-memory API in `crates/test-support/kube_api.rs`; the test writes and deletes the objects Helm would, and the live Kind suite runs the chart itself |

`every_type_has_a_contract_test` requires a contract test for every type the provider serves, or an `ELSEWHERE` entry naming where it is tested instead.

#### Standalone Service Readiness

On Unix, run `cargo test -p nemoclaw-provider --test contract service_readiness:: -- --ignored` with the bundle set as above.
The fixture uses an isolated SSH and Docker simulator and a built-in OpenTofu consumer, without SDK orchestration or an OpenShell gateway.
It checks offline validation, apply-time reads, saved-plan failure, unchanged-service rechecks, bounded timeout, recovery, and teardown without readiness.
The proxy case also uses an HTTP model-metadata fixture and checks delayed initial credentials, container identity, credential permissions, and upstream model drift.

### OpenShell Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p openshell-provider --test contract -- --ignored
```

Each fixture in `crates/openshell-provider/tests/contract/fixtures` is applied against a fake OpenShell gateway; it must plan no managed changes after apply, and teardown must remove every sandbox, provider registration, and profile while the gateway keeps the workspace.
The fixtures are the OpenShell resources the SDK compiles for each example with an external gateway, excluding examples whose credentials are read from a managed service's container.
`nemoclaw-e2e`'s `openshell_contract_fixtures` test fails when they differ from what the SDK compiles; regenerate them with `NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-e2e --test integration openshell_contract_fixtures`.

The `capabilities` tests check gateway preconditions, saved-plan rechecks, and capability reads deferred until bootstrap inputs are known.
The `standalone` tests apply the authored resources in `tests/contract/standalone` through lost create and delete replies, foreign or missing objects, failed observations, deferred bootstrap endpoints, and registration replacement and rotation.
The fake gateway refuses to delete a referenced profile or an attached provider, as the pinned API does.
`every_fixture_runs_and_every_type_is_covered` requires a test for every fixture and a fixture for every OpenShell type.

### Fabric Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p fabric-provider --test contract -- --ignored
```

`fabric_agent` starts a Pi agent from `tests/contract/fixtures` in a sandbox: an invalid configuration fails validation at its field without repeating the value, a changed configuration replaces the sandbox, a lost start reply is not retried and recovers in a replaced sandbox, and removing the agent stops it and keeps its sandbox.
On Unix, `fabric_harnesses` reads a fake Docker engine's image metadata: a compatible image reports its runtime binaries; another platform, or a read policy without the runtime's paths, is unsupported; a missing image is unknown.
`every_fabric_type_has_a_contract_test` requires a contract test for every Fabric type.

## System Tests

The system tests are ignored tests in `nemoclaw-e2e`'s `integration` binary, which the `lifecycle` profile selects by module.
They use the local gRPC OpenShell fixture and simulated SSH and Docker hosts:

```sh
cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- deployment:: export_observations:: fabric_deployment:: multiple_providers:: --ignored
```

Append a test name to run one scenario, or `--test-threads=4` to match CI's concurrency.
The fixtures return protocol responses; they do not establish agent inference, native file drift detection, or tool enforcement, which Fabric tests.

| Module | Checks |
|---|---|
| `deployment` | Configuration lifecycles through the SDK and CLI: shared state, interrupted creation, unchanged apply, startup failure recovered in a new sandbox, failed observation without state loss, export and reapply, policy and tool drift, web search, credential redaction, startup failure messages, and destroy |
| `export_observations` | Export through provider refresh without applying, without inference or search credentials, rejection of observed drift without changes to saved state, and a Pi model changed inside the sandbox, which export ignores |
| `fabric_deployment` | One harness test each for OpenClaw and Pi, where a changed configuration replaces the agent with its sandbox, and missing or failed runtime declarations |
| `multiple_providers` | Two deployments' provider attachments, export and reapply, drift, and destroy, each scoped to its sandbox |
| `inference_discovery` | Optional catalog failures that keep complete unchanged plans and report uncertainty |
| `fabric_bridge` | The provider's `fabric-agent-ctl` client: the image's own command and environment, input on stdin, and uncertain invocations never replayed |
| `remote_service` | Services on simulated SSH hosts; see [SSH service fixtures](#ssh-service-fixtures) |
| `travel_example` | `examples/hcl/travel` applied unchanged as plain HCL from the bundle's provider mirror: Ollama placed from its runtime launch on a simulated SSH engine, endpoint readiness against a fake model server, OpenShell objects and the Pi agent on the fixture gateway, agent readiness, and an unchanged second plan |
| `travel_team_example` | `examples/hcl/travel-team` applied the same way: six Hermes agents in `for_each` sandboxes with per-role providers, grants, toolsets, and models; an unchanged second plan; a hosted-model change replacing only the scheduler's and buyer's sandboxes; and teardown that fails without `destroy = true` and removes everything with it. It reports each OpenTofu command's duration |
| `helm_recovery` | On Unix, destroy and its recovery against an in-memory Kubernetes API, after failures, a second destroy, and cancellation; see [below](#helm-release-recovery) |

In `deployment`, `cli_terminal_outputs_preserve_lifecycle_and_json_contract` checks text plans, JSON apply, unchanged text apply, JSON plan completeness, text destroy, and repeated JSON destroy against one fixture state.
`gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` changes the gateway driver after planning to check OpenTofu's apply-time check, recovery, and teardown.
`rejected_policy_fails_promptly_with_context_and_allows_recovery_or_destroy` checks a simulated gateway admission rejection with sandbox context in text and JSON output, retained bindings, recovery, and destroy.
`separate_agent_sandboxes_cli_export_reapply_and_policy_drift` and `tool_disclosure_cli_export_reapply_and_configuration_on_stdin` check OpenClaw tool policies, whose changes replace the sandbox, with observation failures that change nothing.

### Helm Release Recovery

The `helm_recovery` tests run the bundle's OpenTofu and Helm provider against the in-memory Kubernetes API in `crates/test-support/kube_api.rs`, then call the SDK's public `destroy`, `plan_destroy`, `export`, and `apply`.
Installing a release through `apply` would pull the pinned chart, so each test starts from an interrupted runtime apply with a fixture release: the Helm provider imports the release, except in `release_record`, where Kubernetes holds only its record.
The SDK's test-only `test-scenarios` feature builds that starting state; `nemoclaw-e2e` enables it in its dev-dependencies, so the tests need no extra flag.
On Unix, run them with:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- --ignored --test-threads=4 helm_recovery::
```

`cargo test` runs the tests as threads of one process, and on Linux a child that one thread forks can briefly hold the deployment lock of another test, which then fails with "another operation holds the deployment lock"; `--test-threads=4` keeps that rare.
Nextest, which CI uses, runs each test in its own process.

Each test that makes destroy fail or stop ends by removing the cause, if any, and running destroy again, which must finish: a failed destroy must leave the deployment recoverable, not only unchanged.

| Module | Checks |
|---|---|
| `helm_recovery` | An outage or a permission failure before planning keeps the Helm release binding, and after the saved plan the binding is restored; cancellation after the release is deleted keeps a resumable checkpoint; a preview leaves an interrupted destroy unchanged and a retry recovers it |
| `helm_recovery::receipt` | A deleted or truncated receipt stops destroy and its preview while OpenTofu plans, without changing state, bindings, objects, or the receipt; the restored receipt lets destroy finish |
| `helm_recovery::release_record` | A Helm release record with no binding stops destroy before it deletes any issuer object, and apply and export stay refused; destroy finishes once the record is gone |
| `helm_recovery::destroy_faults` | A second destroy launches no plan or apply; an authentication failure (HTTP 401) before planning, after the saved plan, or after it on the issuer's ConfigMap reads alone stops destroy, keeps the issuer, and lets a retry finish; cancelling at the first refresh returns promptly while the API is unreachable and changes nothing |

### SSH Service Fixtures

Run `cargo test -p nemoclaw-e2e --test integration remote_service:: -- --ignored` with the bundle set as above.
The tests exercise the bundled CLI and providers with an isolated Docker-over-SSH simulator and the OpenShell fixture, for remote models and Ollama, managed Pi, and bearer credentials.
They check recovery after failed startup, export and unchanged reapply, failed observation without lost bindings, and replacement of credentials outside state.
Destroy removes disposable containers and service networks while retaining storage; the partial-runtime tests tear down after failed creation without first creating the missing compute.
The two `unverified_*_images_are_checked_after_pull_before_storage` tests check that images are rejected after pull without creating storage or compute, and that the recorded image binding is cleaned up.
The `managed_bearer` tests check that apply sends no generation probes; Fabric owns native service startup, authentication, configuration, and protocol checks.
Runtime status and Docker responses are simulated; the tests do not download or serve a model.

## Other Fixture Tests

These unit and image tests use local fixtures for the same features.

### Ollama and Platform Fixtures

Managed Ollama's runtime, provider, and SDK tests use local registry, capacity, configuration, and runtime-plan fixtures, not live containers or model downloads.
They cover immutable model resolution, bounded readiness, retained storage, service references, independent installer resources, and provider connection resolution:

```sh
cargo test -p nemoclaw-runtime ollama
cargo test -p nemoclaw-provider --lib
cargo test -p nemoclaw-sdk --test integration -- service_references:: multiple_providers::
```

The [Docker-provider lifecycle fixture](live-tests.md#docker-provider-lifecycle) checks the managed proxy through the SDK and its production provider graph.

The OpenShell and Fabric backends' tests against the fake gateway, in each provider's `src/fake_gateway_tests.rs`, run in the default workspace suite; they include bound exec identity and a deadline for an exec stream that never finishes.
Launch compatibility runs there too.
`agent_compatibility` checks that the launch serves Fabric's bridge without naming an agent, harness selection, and default policy restrictions without frozen launch snapshots.
The separately scheduled Fabric lifecycle cases and installed-adapter image tests exercise the supported harnesses.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The `CI / Bundle` matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64, and Windows x64.
CI's protocol and lifecycle fixtures do not establish local Docker, Podman, GPU, or real model availability on those platforms.
Report build results separately from runtime test results.


### Runtime Boundaries

Runtime separation has focused checks:

```sh
cargo test -p nemoclaw-runtime
cargo test -p nemoclaw-sdk --test integration -- runtime_boundaries::
```

The supervisor tests use an ordinary owned process and validated memory thresholds, without a DGX Spark document.
They exercise readiness, pressure, failed observations, cancellation, and the loading deadline.
Cancellation must leave a neighboring process alive.

The backend HTTP fixture rejects unavailable, unauthorized, and redirect responses before accepting readiness.
The executable test rejects invalid `NEMOCLAW_RUNTIME_SPEC` input and the removed environment alias without starting model work.
Runtime contract tests check field/version diagnostics without configuration values or user-defined map keys; provider fixtures check read-only image compatibility and distinguish absence from authentication or transport failure.

The recipe test checks declared serving arguments and capacity, and rejects model/backend/hardware combinations outside the declared compatibility requirements.
The [live image-change test](live-tests.md#spark-and-fabric) requires plan and apply to replace only the inference process.
Managed-resource fixtures check storage identity and explicit recovery; the recipe tests verify prepared data before reuse.
The fixture checks that the supervisor runs independently of the CLI; it does not test another real serving backend.


### Fabric Discovery and Execution

The image's [reference tests](../../image/fabric/test_reference.py) run NemoClaw's test adapter through Fabric's real `fabric-agent-ctl`.
The SDK's [compatibility tests](../../crates/nemoclaw-sdk/tests/fabric_compatibility.rs) check an image catalog's adapters, revision and filesystem requirements; NemoClaw doesn't plan adapter settings.


### Inference API Fixtures

Native adapter protocol and configuration tests belong to [Fabric](https://github.com/NVIDIA/NeMo-Fabric/tree/5574117feb4be948c1b03f4c36a2fe9a11af910d/tests), alongside the implementation.
The [image source checks](testing.md#image-source-checks) cover NemoClaw packaging separately.


### Hermes Relay Tracing Fixture

Hermes Relay tracing is configured and tested by Fabric's Hermes adapter.
Its trace files do not establish a native API listener or a fresh runtime health observation.
Live Relay and OpenShell behavior need separate qualification at the selected Fabric revision.
