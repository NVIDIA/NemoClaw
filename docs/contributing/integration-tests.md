<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

This page covers the [contract and system layers](testing.md#test-layers): tests that run pinned OpenTofu from a bundle against local fixtures and temporary state.
They create no Docker, OpenShell, Kubernetes, or inference resources; tests that use a real Docker engine are [live tests](live-tests.md#docker-live-suite).
Complete the [build prerequisites](../build.md) first.

## OpenTofu and Bundle Lifecycle

The contract and system tests take one input: `NEMOCLAW_TEST_BUNDLE`, the absolute path of a bundle such as the `dist/PLATFORM` directory that `cargo ci bundle` writes.
The bundle supplies the OpenTofu version pinned in `versions.json`, the CLI, and the providers.
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

Nextest builds every workspace target, including the fixture executables; after `cargo ci tools`, put `.tools/nextest-0.9.150` on `PATH` and narrow the `lifecycle` profile with a filter:

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

Its modules run the `nemoclaw` types against fake Docker engines, SSH hosts, and model servers:

| Module | Checks |
|---|---|
| `provider_protocol` | The fixture provider from `nemoclaw-fixture-provider`, and on Unix the provider against a fake Docker API: network and image planning, including prerequisite changes before saved-plan application |
| `service_capacity` | `vllm_capacity` through an isolated SSH simulator (shared-host overcommit, deferred reads, state kept after failed observations, and cleanup without capacity checks), and Ollama readiness and capacity rejecting a vLLM contract |
| `service_readiness` | Standalone service readiness; see [below](#standalone-service-readiness) |
| `service_storage` | Retained service storage |
| `host_image`, `vllm_runtime` | Authored image compatibility through `data.host_image` and, on Unix, the vLLM runtime contract |
| `host_container_health` | Authored application health reads: an owned healthy container passes and an unhealthy one fails the plan |
| `discovery` | Discovery plans that read target metadata without mutations |

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
On Unix, the `gateway_storage` test checks Docker gateway storage against a fake engine.
The `gateway_readiness` test checks managed-gateway exit diagnostics, bootstrap state kept after failure, corrected retry, unchanged-apply rechecks, and teardown without the readiness data source.
The `kubernetes_hcl` test plans the managed Kubernetes resources, and the `kubernetes_lifecycle` tests apply, refresh, and tear them down against the in-memory API in `crates/test-support/kube_api.rs`; they write and delete the objects Helm would, and the live Kind suite runs the chart itself.
`every_fixture_runs_and_every_type_is_covered` requires a test for every fixture and a fixture for every OpenShell type.

### Fabric Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p fabric-provider --test contract -- --ignored
```

The tests in `tests/contract/main.rs` apply a `fabric_agent` that starts a Pi agent from `tests/contract/fixtures` in a sandbox: an invalid configuration fails validation at its field without repeating the value, a changed configuration replaces the sandbox, a lost start reply is not retried and recovers in a replaced sandbox, and removing the agent stops it and keeps its sandbox.
On Unix, the `capabilities` test reads `fabric_harnesses` from a fake Docker engine's image metadata: a compatible image reports its runtime binaries; another platform, or a read policy without the runtime's paths, is unsupported; a missing image is unknown.
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
| `kubernetes_agents` | The three-agent `external-gateway.yaml` examples for Kubernetes and OpenShift, one test each, against the fixture gateway reporting OpenShell's Kubernetes driver, with a metadata bundle describing the images and inference at a cluster Service URL without a key: a plan without effects; three sandboxes, each with a policy rule for the Service's name and no address grant; each agent's Fabric configuration with its own name and the Service URL; an unchanged apply without changes or gateway effects; export and reapply; and destroy. It does not check that a cluster resolves or reaches the Service |
| `multi_agent` | Three OpenClaw agents in separate sandboxes, each with its own model, sharing one provider registration: one agent's rejected start, its removal, or another owner's label on its sandbox changes no agent that the document leaves unchanged |
| `multiple_providers` | Two deployments' provider attachments, export and reapply, drift, and destroy, each scoped to its sandbox |
| `fabric_bridge` | The provider's `fabric-agent-ctl` client: the image's own command and environment, input on stdin, and uncertain invocations never replayed. These tests are not ignored and run with the unit tests |
| `remote_service` | Services on simulated SSH hosts; see [SSH service fixtures](#ssh-service-fixtures) |
| `travel_example` | `examples/hcl/travel` applied unchanged as plain HCL from the bundle's provider mirror: Ollama placed from its runtime launch on a simulated SSH engine, endpoint readiness against a fake model server, OpenShell objects and the Pi agent on the fixture gateway, agent readiness, and an unchanged second plan |
| `travel_team_example` | `examples/hcl/travel-team` applied the same way: six Hermes agents in `for_each` sandboxes with per-role providers, grants, toolsets, and models; an unchanged second plan; a hosted-model change replacing only the scheduler's and buyer's sandboxes; and teardown that fails without `destroy = true` and removes everything with it. It reports each OpenTofu command's duration |
| `helm_recovery` | On Unix, destroy and its recovery against an in-memory Kubernetes API, after failures and cancellation; see [below](#helm-release-recovery) |
| `hcl_integration` | On Unix, each scenario in `crates/nemoclaw-e2e/hcl/integration/tests`, compiled by the SDK from `hcl/cases` and run under `tofu test` with the Docker provider mocked; see [`tofu test` cases](#tofu-test-cases) |

In `deployment`, `cli_terminal_outputs_preserve_lifecycle_and_json_contract` checks text plans, JSON apply, unchanged text apply, JSON plan completeness, text destroy, and repeated JSON destroy against one fixture state.
`gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` changes the gateway driver after planning to check OpenTofu's apply-time check, recovery, and teardown.
`rejected_policy_fails_promptly_with_context_and_allows_recovery_or_destroy` checks a simulated gateway admission rejection with sandbox context in text and JSON output, retained bindings, recovery, and destroy.
`separate_agent_sandboxes_cli_export_reapply_and_policy_drift` and `tool_disclosure_cli_export_reapply_and_configuration_on_stdin` check OpenClaw tool policies, whose changes replace the sandbox, with observation failures that change nothing.

In `multi_agent`:

- `one_failed_agent_is_reported_alone_and_its_retry_replaces_only_it` replaces two sandboxes in an update, and Fabric rejects one agent's start.
  The CLI names only the failed sandbox and leaves out Fabric's message, which `diagnostics/fabric-SANDBOX.json` keeps.
  The other replacement finishes, the unchanged agent is neither replaced, stopped, nor restarted, and the retry replaces only the failed agent's sandbox.
- `removing_one_agent_stops_only_its_runtime_and_keeps_shared_registrations` removes one sandbox from the document.
  The plan deletes only that sandbox, its agent, and its agent configuration, and apply stops only that agent.
  The other agents, the provider registration and profile, and the workspace stay as they were.
- `a_foreign_owner_on_one_agent_stops_planning_without_touching_the_others` gives one sandbox a different owner label on the gateway.
  Plan, `plan_destroy`, export, apply, and destroy each fail on the ownership change without changing `terraform.tfstate`, `intent.json`, the gateway, or any sandbox.
  After the label is restored, destroy finishes.

The first two tests end with export, unchanged reapply, and destroy.

### `tofu test` Cases

`hcl_integration` runs each scenario in `crates/nemoclaw-e2e/hcl/integration/tests` against the fixtures, with one shared runner:

```sh
cargo build -p nemoclaw-test-fixtures
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- --ignored --test-threads=1 hcl_integration::
```

A scenario is a document in `hcl/cases`, shared with the live E2E scenarios that `hcl_live::case` runs from `hcl/tests`, and an integration test file with the same name:

| File | Contents |
|---|---|
| `hcl/cases/<scenario>.yaml` | The NemoClaw document. The runner compiles it with the SDK into `cases/<scenario>/nemoclaw.tf.json` in a work copy of the integration root, beside a copy of `integration/harness/main.tf`. It points the gateway, any engine the document names, and inference endpoints at the fixtures. An external gateway loses its credential and TLS, because the fixture gateway serves plaintext gRPC. A sandbox described by image metadata runs the fixture image, which the runner's metadata bundle describes. |
| `hcl/integration/tests/<scenario>.tftest.hcl` | Provider mocks and run blocks whose `module` is `./cases/<scenario>`, with assertions. |

The harness declares the fixtures through the `fixture` provider's one data source, `fixture_state`, named `setup`, and reads what they recorded through the `observed` module:

| Module | Purpose |
|---|---|
| `integration/modules/fixtures` | From the document, the gateway's compute driver and, with a managed Docker gateway, what a mocked Docker provider would leave on the engine: images, each service image with the architecture its document requires, the gateway container, and each service's ready container with its generated key. The harness variable `compute_driver` overrides the driver. Outputs the owner, the engine object prefix, and each service's container. |
| `integration/modules/observed` | Outputs registrations by name and `agents` by sandbox, each with its Fabric `start` command and decoded configuration, plus OpenShell, engine, and upstream records. Credential values appear only by source: `env:NAME` or `file:CONTAINER:PATH`. |

A test file runs four steps:

1. `fixtures` targets `data.fixture_state.setup`, so the fixtures exist before the deployment's first plan.
2. `deploy` applies.
3. `verify` applies again, without changes, and asserts against what deploy produced.
4. `teardown` sets `permit_destroy = true`. The runner sets the `openshell` and `fabric` providers' `destroy` from that variable, as the SDK's teardown graph does, and OpenTofu's cleanup uses the last applying run's variables.

Docker scenarios mock the Docker provider by its generated alias and give mocked resources the IDs the `fixtures` module declares. One fixed engine socket, `/tmp/nemoclaw-integration/engine.sock`, gives every scenario the same alias and image addresses.
A run that is expected to fail lists the checkable object in `expect_failures`. A targeted plan does not evaluate locals or module outputs.

The runner deals the scenarios round-robin across four tests, `scenarios_in_shard_1` to `scenarios_in_shard_4`, so each stays within the lifecycle per-test budget. They share the fixed engine socket, so nextest's `hcl-integration` test group runs one at a time on a runner, and `cargo test` needs `--test-threads=1`.
Each shard runs `tofu init` once and then `tofu test -filter=tests/<scenario>.tftest.hcl` for each scenario, resetting the fixtures between scenarios.
After each scenario it checks that at least one run passed and that teardown failed only on storage NemoClaw retains. It also checks that the gateway holds no objects or Fabric runtimes, that the engine deleted no storage and received no unrecognized request, and that no fixture credential appears in output or diagnostics.
When a scenario fails, the runner keeps its work directory and writes redacted OpenTofu output and observations to `evidence/<scenario>`, or under `NEMOCLAW_INTEGRATION_EVIDENCE` when it is set.
In CI / Bundle, each `Lifecycle` job sets `NEMOCLAW_INTEGRATION_EVIDENCE`. The runner records each scenario's result there, and the job summary lists the results. A failed job uploads that directory as `hcl-integration-evidence-PLATFORM-SHARD-ATTEMPT`, kept for 7 days.
An upstream operation the fixtures cannot simulate needs fixture support once, in `tests/hcl_integration/fixtures.rs`.

Each scenario runs the real OpenShell, Fabric, and host providers, plus the vLLM or Ollama provider where it applies:

| Scenario | Checks |
|---|---|
| `docker-openclaw-nvidia` | The live hosted document: two OpenClaw agents on NVIDIA hosted inference. Covers gateway storage on the fake engine, the mocked gateway container and sandbox image read by ID, and the shared registration with the fixture credential. Also checks each sandbox's binding and policy, and each agent started through `ExecSandbox` with its compiled configuration. |
| `docker-openclaw-vllm` | The live local document: an unauthenticated vLLM service with an isolated OpenClaw sandbox. There is only a data volume and no credential storage, and readiness reads the status file and no key. The registration has no credential, and the agent has its model and address. |
| `docker-openclaw-vllm-bearer` | A vLLM service with bearer authentication. The credential storage is created on the engine and mounted by the container, and readiness reads the status file and the generated key. The registration holds that key under the sandbox's name for it, and the agent gets its model, address, and key name. |
| `docker-openclaw-ollama` | A managed Ollama service. The container's Docker inputs come from the Ollama runtime launch, the runtime image is found on the engine, and readiness comes from the container's status file. The registration is at the service address without a credential, the sandbox's policy allows that address, and the agent gets its model and address. |
| `docker-hosted-ollama-two-agents` | An OpenClaw agent on hosted inference and a Hermes agent on Ollama. There are two registrations, and each sandbox is bound to and may reach only its own provider. Each agent starts once in its own sandbox with its own harness and configuration. |
| `docker-vllm-shared-two-agents` | One authenticated vLLM service shared by OpenClaw and Hermes agents. Each harness has its own registration holding the generated key under its own sandbox name. Each sandbox names only its own registration, and each agent starts with that key name. |
| `openshift-external-two-providers` | An OpenShift gateway with an Anthropic Messages provider and an NVIDIA provider. Each registration has its own API, base URL, and credential. The OpenClaw agent has both routes, the Hermes agent has one, and their sandboxes share no binding. |
| `kubernetes-gateway-driver-mismatch` | A Kubernetes document against a gateway that reports Docker. The workspace precondition rejects the plan, and the gateway's incompatibility names the Kubernetes driver. Nothing reaches OpenShell, Fabric, or the upstream. |

In every scenario, the inference upstream receives no request.
The scenarios do not invoke agents or perform inference; the live E2E suites do.
The vLLM and Ollama runtimes are represented by declared containers and files, not run.
The OpenShift scenario does not exercise gateway TLS or bearer credentials.
External Kubernetes deployments through the SDK are covered by `kubernetes_agents`.

### Helm Release Recovery

The `helm_recovery` tests run the bundle's OpenTofu and Helm provider against the in-memory Kubernetes API in `crates/test-support/kube_api.rs`, then call the SDK's public `destroy`, `plan_destroy`, `export`, and `apply`.
Installing a release through `apply` would pull the pinned chart, so each test starts from an interrupted runtime apply with a fixture release, which the Helm provider imports.
The SDK's test-only `test-scenarios` feature builds that starting state; `nemoclaw-e2e` enables it in its dev-dependencies, so the tests need no extra flag.
On Unix, run them with:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- --ignored --test-threads=4 helm_recovery::
```

`cargo test` runs the tests as threads of one process, and on Linux a child that one thread forks can briefly hold the deployment lock of another test, which then fails with "another operation holds the deployment lock"; `--test-threads=4` keeps that rare.
Nextest, which CI uses, runs each test in its own process.

Each test that makes destroy fail or stop ends by removing the cause, if any, and running destroy again, which must finish: a failed destroy must leave the deployment recoverable, not only unchanged.
Every test also starts with objects that belong to someone else: a second deployment's namespace, key-encryption key, and gateway claim, and, in the fixture deployment's namespace, another release's Helm record and a ConfigMap the second deployment owns.
No request in the test may write to any of them, and the final destroy must leave each of them as it was.

| Module | Checks |
|---|---|
| `helm_recovery` | An outage or a permission failure before planning keeps the Helm release binding, and after the saved plan the binding is restored; cancellation after the release is deleted keeps a resumable checkpoint; a preview leaves an interrupted destroy unchanged and a retry recovers it |
| `helm_recovery::destroy_faults` | An authentication failure (HTTP 401) before planning, after the saved plan, or after it on the issuer's ConfigMap reads alone stops destroy, keeps the issuer, and lets a retry finish; cancelling at the first refresh returns promptly while the API is unreachable and changes nothing |

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

Native adapter protocol and configuration tests belong to [Fabric](https://github.com/NVIDIA/NeMo-Fabric/tree/88099b37c1e146faa6f70e8c8df1f6b5a288ff56/tests), alongside the implementation.
The [image source checks](testing.md#image-source-checks) cover NemoClaw packaging separately.


### Hermes Relay Tracing Fixture

Hermes Relay tracing is configured and tested by Fabric's Hermes adapter.
Its trace files do not establish a native API listener or a fresh runtime health observation.
Live Relay and OpenShell behavior need separate qualification at the selected Fabric revision.
