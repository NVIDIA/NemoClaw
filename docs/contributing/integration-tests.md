<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

Most tests here use local protocol fixtures and temporary state.
The Docker-provider tests explicitly identified below also create isolated local containers, networks, and volumes.
Complete the [build prerequisites](../build.md) first.

## OpenTofu and Bundle Lifecycle

The private `nemoclaw-e2e` crate runs the actual provider protocol through OpenTofu 1.12.6.
Build the production providers and supply absolute executable paths explicitly.
Tests install `terraform-provider-openshell` and `terraform-provider-fabric` from the directory that holds `NEMOCLAW_TEST_PROVIDER`:

```sh
cargo build -p nemoclaw-provider -p openshell-provider -p fabric-provider
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-provider --test contract provider_protocol:: -- --ignored
```

These tests launch a fixture provider built by that crate and use temporary files.
On Unix, they also run the production provider against a local Docker API fixture to check network and image planning, including prerequisite changes before saved-plan application.
They create no Docker, OpenShell, or inference resources.
The fixture provider is not a production bundle component.

On Unix, run from the repository root to test combined service capacity through the production provider and an isolated SSH simulator:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-provider --test contract service_capacity:: -- --ignored
```

This fixture checks shared-host overcommit, deferred reads, preserved state after failed observations, and cleanup without capacity checks.
It uses a built-in OpenTofu resource to exercise the generated precondition and does not create model processes or download artifacts.

Test the runtime bundle and live serving backend separately.

The [OpenShell provider contract](#openshell-provider-contract) tests also check gateway version and driver preconditions, failed observations without resource changes, and data-source reads deferred until bootstrap inputs become known.
The `gateway_readiness::` tests use the same explicit OpenTofu/provider paths with local engine and OpenShell fixtures.
It checks prompt managed-gateway exit diagnostics, bootstrap state retained after failure, corrected retry, unchanged-apply rechecks, and teardown with the readiness data source omitted.
Its bootstrap identity is a built-in OpenTofu resource; it creates no live container.
Standalone HCL cases exercise provider/profile replacement and removal without sandbox teardown mode, recreation after confirmed absence, credential-reference updates, and recovery after a lost creation response.
They also commit absence with refresh-only before a later creation plan, and verify that substituted creation readback preserves the original binding with an error.
A lost creation response followed by removing its declaration demonstrates why pending creation intent must be retained: OpenTofu cannot remove an object whose binding it never received.
The fixture enforces the pinned API's refusal to delete a referenced profile or an attached provider; sandbox and workspace protection remain covered separately.

The SDK/CLI lifecycle tests require a verified native bundle (manifest plus CLI, OpenTofu, and both production providers).
They use only the local gRPC fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- deployment:: export_observations:: fabric_deployment:: multiple_providers:: --ignored
```

CI uses the [nextest lifecycle profile](testing.md#test-runner) with four concurrent tests.
Each Fabric harness is an independent ignored test with its own temporary state and gRPC fixture.
To test one harness, append its test name, for example `-- --ignored harness_codex`; to run all harnesses with the same concurrency bound under Cargo, use `-- --ignored --test-threads=4`.

These tests cover shared SDK/CLI state, interrupted creation, unchanged apply, readiness failure without replacement, failed observation without state loss, export/reapply, interrupted destroy, and retained workspace recovery.
The `cli_terminal_outputs_preserve_lifecycle_and_json_contract` case checks text plans, JSON apply, unchanged text apply, JSON plan completeness, text destroy, and repeated JSON destroy against the same fixture state.
The registration lifecycle case recreates a missing selected registration while preserving its sandbox and profile, and the interrupted-create case permits unrelated intent edits while retaining pending resource configuration.
The `independent_sandboxes_reconcile_concurrently_and_retain_shared_dependencies` fixture checks overlapping sandbox creates, unchanged reapply, and teardown with a retained shared workspace.
The `gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` fixture changes the gateway driver after planning to verify OpenTofu's fresh apply-time check, recovery, and teardown after capability drift.
The direct provider fixture checks saved plans with both unchanged and newly created resources; incompatible or unavailable gateways stop dependent mutations without losing managed-resource bindings.
The Pi lifecycle fixture verifies that this gate also blocks model configuration writes, and that unchanged apply performs no configuration writes.
The multiple-provider fixture also verifies two independent deployments, each sandbox’s selected provider attachments, export/reapply, and drift in one deployment without changes to the other.
The `rejected_policy_fails_promptly_with_context_and_allows_recovery_or_destroy` fixture uses the explicit-policy example and a simulated gateway admission rejection.
It checks prompt CLI failure with sandbox context in text and JSON output, retained bindings, recovery after simulated acceptance, export/reapply, and direct destroy after rejection.
The fixture returns protocol responses; it does not establish live agent inference.
The export fixture checks provider refresh failures through OpenTofu, unchanged deployment state and configuration, and export without inference credentials or Fabric health requests.
The web-search lifecycle case covers Brave and Tavily at deployment, sandbox, and agent scope, including profile and sandbox-grant drift.
The mixed-search export case checks shared registrations, unused definitions, export without search keys, unchanged reapply, and rejected provider-type or credential-reference drift without changes to saved state.

## NemoClaw Provider Contract

The `nemoclaw-provider` crate's `contract` tests run its types through OpenTofu against fake Docker engines, gateways, and model servers:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-provider --test contract -- --ignored
```

They cover service storage, Kubernetes planning, runtime images and runtime contracts, gateway readiness, and engine and hardware discovery.
`every_type_has_a_contract_test` requires a contract test for every type the provider serves.
Its `ELSEWHERE` list names the types still tested only in `nemoclaw-e2e` and why: the managed gateway, service capacity, and service readiness tests need that crate's fixture binaries, gateway storage needs Docker, and inference capabilities are read only through SDK deployments.

## OpenShell Provider Contract

The `openshell-provider` crate's `contract` tests apply each fixture in `crates/openshell-provider/tests/contract/fixtures` through OpenTofu against a fake OpenShell gateway from `nemoclaw-test-fixtures`.
Each fixture must plan no managed changes after it is applied, and teardown must remove every sandbox, provider registration, and profile while the gateway keeps the workspace:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p openshell-provider --test contract -- --ignored
```

Its `capabilities` tests check gateway preconditions and saved-plan rechecks, and its `standalone` tests apply authored OpenShell resources from `tests/contract/standalone` through lost replies, foreign or missing objects, bootstrap endpoints, and registration rotation.
The fixtures are the OpenShell resources the SDK compiles for each example with an external gateway, excluding examples whose credentials are read from a managed service's container.
`nemoclaw-e2e`'s `openshell_contract_fixtures` test fails when they differ from what the SDK compiles; regenerate them with `NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-e2e --test integration openshell_contract_fixtures`.

## Fabric Provider Contract

The `fabric-provider` crate's `contract` tests run each Fabric type through OpenTofu with the same paths:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p fabric-provider --test contract -- --ignored
```

`fabric_agent_configuration` applies a Pi configuration to a sandbox from `tests/contract/fixtures`. An invalid configuration fails validation at its field without repeating the value. The configuration updates without replacing the sandbox, a stopped host is reconfigured, and a lost reply is not retried.
`fabric_sandbox_readiness` reports the configured agent ready, and not ready while its health fails, without writing to the sandbox.
`fabric_capabilities` reads a fake Docker engine's image metadata. A compatible image reports its runtime binaries, while another platform, or a read policy without the runtime's paths, is unsupported, and a missing image is unknown.
A coverage test requires a contract test for every Fabric type.

## Standalone Sandbox Completion

On Unix, build the production provider and supply the explicit OpenTofu and provider paths as above.
Run from the repository root:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test integration sandbox_readiness:: -- --ignored
```

The fixture runs the sandbox completion data source through OpenTofu against a local gRPC server, without SDK deployment orchestration.
It checks deferred health reads, failed postconditions with retained observations and bindings, unchanged-apply rechecks, prompt configuration-admission rejection with safe sandbox context, and teardown without readiness.
It creates temporary state and simulated OpenShell resources; it does not start containers or invoke a model.
On failure, inspect the OpenTofu diagnostic and verify that the selected provider matches the checkout before rerunning.

## Standalone Service Readiness

On Unix, build the production provider as above and run from the repository root:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-provider --test contract service_readiness:: -- --ignored
```

The fixture uses an isolated SSH/Docker simulator and a builtin OpenTofu consumer, without SDK deployment orchestration or a reachable OpenShell gateway.
It checks offline validation, apply-time reads, saved-plan failure, unchanged-service rechecks, bounded timeout, recovery, and teardown without readiness.
The proxy case also uses an isolated HTTP model-metadata fixture and checks delayed initial credentials, container identity, credential permissions, and upstream model drift.
It uses temporary files and loopback listeners; it does not create containers or execute a model.
A failed assertion reports the OpenTofu diagnostic; rerun after correcting the matching provider or fixture inputs.

## Ollama and Platform Fixtures

Managed Ollama's runtime, provider, and SDK tests use local registry, capacity, configuration, and runtime-plan fixtures, not live containers or model downloads.
They cover immutable model resolution, bounded readiness, retained storage, service references, independent installer resources, and provider connection resolution:

```sh
cargo test -p nemoclaw-runtime ollama
cargo test -p nemoclaw-provider --lib
cargo test -p nemoclaw-sdk --test integration -- service_references:: multiple_providers::
```

The [Docker-provider lifecycle fixture](#docker-provider-lifecycle) checks the managed proxy through the SDK and its production provider graph.

Authenticated OpenShell, stalled exec streams, and launch compatibility run in the default workspace suite.
`agent_compatibility` checks passive launch mode, caller identity, harness selection, and default policy restrictions without frozen launch snapshots.
The separately scheduled Fabric lifecycle cases and installed-adapter image tests exercise the supported harnesses.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The native CI matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64, and Windows x64.
CI's protocol and lifecycle fixtures do not establish local Docker, Podman, GPU, or real model availability on those platforms.
Report build results separately from runtime test results.

## Model Cache Compatibility

On native Linux with local Docker, pull the Ollama base image pinned in this checkout before selecting the opt-in cache test.
The test creates a temporary cache and one container, exposes its inventory API on an ephemeral loopback port, and removes both afterward.
It resumes complete synthetic files through NemoClaw's verifier, then checks the actual Ollama inventory and version.
It downloads no model and exposes no GPU.
From the repository root:

```sh
ollama_base=$(awk '$1 == "FROM" { print $2; exit }' runtimes/ollama/Dockerfile)
docker pull "$ollama_base"
NEMOCLAW_TEST_OLLAMA_CACHE=1 cargo test -p nemoclaw-runtime --test integration ollama_cache:: -- --ignored --nocapture
```

A failure identifies either the cache contract or a mismatch between the runtime image and `versions.json`.
Correct the runtime pin or adapter before rerunning; never point the fixture at a deployment's cache.
If the test process is forcibly killed, inspect containers with label `org.nemoclaw.test=ollama-cache` and remove only the container created by that run.

Evaluate the Hugging Face client shipped in the vLLM base image with a private loopback server:

```sh
vllm_base=$(awk '$1 == "FROM" { print $2; exit }' runtimes/vllm/Dockerfile)
docker pull "$vllm_base"
docker run --rm --runtime=runc --network none --env HF_HUB_DISABLE_PROGRESS_BARS=1 \
  --volume "$PWD/runtimes/vllm/test_download.py:/test_download.py:ro" \
  --entrypoint python3 "$vllm_base" /test_download.py
```

This test documents why post-download verification cannot preserve bounded writes with the evaluated client.
It expects the client to write an oversized fixture before raising a size error; if that behavior changes, reevaluate whether the owner client can replace NemoClaw's downloader.

## Runtime Image Loading

On a native Linux host, complete the [runtime image build prerequisites](../build.md#build-a-runtime-image).
This test builds a uniquely named scratch image without downloading a base image, exports an OCI archive, loads it, and checks access by the exported digest.
It removes its image tag afterward; Docker's build cache remains.
Run from the repository root:

```sh
NEMOCLAW_TEST_RUNTIME_IMAGE=1 cargo test -p nemoclaw-build --no-default-features --bin nemoclaw-build runtime_archive_loads_with_its_exported_digest -- --ignored
```

A failure reports the build, load, or identity check that failed; correct the Docker configuration and rerun.
It does not start containers, run inference, or publish an image.

## Runtime Boundaries

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

## SSH Service Fixtures

The `remote_service` E2E fixture exercises the bundled CLI/provider boundary with an isolated Docker-over-SSH simulator and OpenShell fixture.
Run `cargo test -p nemoclaw-e2e --test integration remote_service:: -- --ignored` with `NEMOCLAW_TEST_BUNDLE` set.
It checks read-only planning without host-capacity collection, failed startup recovery, missing-container replacement, no-op, export/reapply, cache reconstruction with unchanged credentials, and failed observation or credential-daemon retargeting without lost bindings.
Destroy removes disposable containers and service networks while retaining storage.
The partial-runtime fixtures verify teardown after failed creation without first creating the missing compute; failed readiness also permits corrected intent while retaining bindings.
After export and unchanged reapply, the service fixture checks a complete resource plan with readiness reported separately as unverified, unchanged bindings, failed apply when readiness fails, and explicit recovery.
It also rejects present images with absent or incompatible runtime-spec labels before mutations, preserves established bindings after incompatibility, and permits teardown without a compatible image.
The two `unverified_*_images_are_checked_after_pull_before_storage` cases check deferred planning, rejection after image acquisition without creating storage or compute, and cleanup of the recorded image binding.

Native CI runs these isolated fixtures on Unix, including managed OpenClaw, Hermes, Pi, and bearer-credential lifecycles.
Its runtime status and Docker responses are simulated; it does not download or serve a model.
Runtime readiness reports startup failures; the SDK does not inspect model artifacts or registry manifests.
Export checks configuration without repeating credential readiness checks.

## Docker Provider Lifecycle

On Linux with local Docker, provide a verified bundle and two different, already loaded digest-pinned images containing the Ollama proxy executable.
Run from the repository root:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE=repository@sha256:YOUR_IMAGE_DIGEST \
NEMOCLAW_TEST_OLLAMA_PROXY_REPLACEMENT_IMAGE=repository@sha256:YOUR_REPLACEMENT_DIGEST \
  cargo test -p nemoclaw-e2e --test integration docker_provider_proxy:: -- --ignored
```

This test creates uniquely named local containers and credential volumes and removes only those owned resources afterward.
It checks SDK apply, export/reapply, failed readiness, image changes and container replacement with the same key, destroy retention, and rejection of missing, foreign, or substituted retained volumes.
OpenShell and the upstream Ollama inventory are local protocol fixtures; no model executes.

## Standalone Cache and Credential Resources

On Linux with Docker, select a verified bundle, an explicit local engine socket, and an already loaded digest-pinned image containing `python3` and `sha256sum`, such as an agent image.
The fixture container runs as root, so the image's own user does not matter.
From the repository root:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_CACHE_ENGINE=unix:///var/run/docker.sock \
NEMOCLAW_TEST_CACHE_IMAGE=repository@sha256:YOUR_IMAGE_DIGEST \
  cargo test -p nemoclaw-e2e --test integration cache_provider:: -- --ignored
```

The [hand-written HCL](../../crates/nemoclaw-e2e/tests/fixtures/cache_provider.tf) composes `docker_volume`, `docker_container`, and `nemoclaw_inference_storage`; no SDK compiler or deployment coordinator runs.
The fixture creates fresh owned resources, checks no-op, replacement, failed-start recovery, retained teardown/reapply, and cache reconstruction with the same credential.
Missing or substituted credential volumes must stop apply before compute creation and preserve state.
Teardown sets the container count to zero while keeping both volume declarations; `tofu destroy` is deliberately blocked by their retention rules.
The test removes only its labelled resources afterward and retains logs and state under its printed temporary path for diagnosis.
The container's Python process simulates model reconstruction and a credential; it does not qualify the vLLM supervisor, GPU execution, model preparation, inference, or OpenShell deployment.

## Fabric Discovery and Execution

The image `unit-tests` stage installs Fabric's `tests/fixtures/discovery` adapter beside the pinned Fabric runtime.
Its tests package that adapter's installed discovery output and deliver its settings to Fabric's installed runner through the bridge host.
The SDK's [planner tests](../../crates/nemoclaw-sdk/tests/fabric_planner.rs) plan the same unknown adapter's settings from an image catalog.

## Inference API Fixtures

Native adapter protocol and configuration tests belong to [Fabric](https://github.com/NVIDIA/NeMo-Fabric/tree/24f068c895e5cbc30286bc743498be4e5014d658/tests/native), alongside the implementation.
Build the selected image using the [agent image procedure](../build.md#build-agent-images), then run its retained Fabric tests in a disposable container:

```sh
docker run --rm --runtime=runc --network none --entrypoint /bin/sh nc-fabric:openclaw -ec '
  fixture=$(mktemp -d)
  tar -xzf /opt/nemoclaw/source/fabric.tar.gz -C "$fixture" --strip-components=1
  /opt/fabric/bin/python "$fixture/tests/native/qualify.py" nvidia.fabric.openclaw --settings "{\"cli\":\"/app/openclaw.mjs\"}"
'
```

For Hermes, select `nc-fabric:hermes`, adapter ID `nvidia.fabric.hermes`, and settings `{"mode":"service"}`.
The script starts the installed native runtime, sends two turns to an isolated local inference fixture, and stops the runtime.
Expect a JSON result with `result: passed`; the container is removed on exit.
These checks use no live credentials or external model endpoints and do not qualify external search APIs.
The [image source checks](testing.md#image-source-checks) cover NemoClaw packaging and the generic host separately.

## OpenClaw Agent Tool Policies

With a freshly built native bundle, run the SDK/CLI lifecycle fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration deployment::separate_agent_sandboxes_cli_export_reapply_and_policy_drift -- --ignored
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration deployment::tool_disclosure_cli_export_reapply_and_drift -- --ignored
```

These fixtures check export/reapply, security policy and configuration observation failures without mutation or lost state.
The local OpenShell fixture simulates runtime responses; it does not establish native file drift detection or tool enforcement.
Fabric owns native tool configuration and enforcement tests.

## OpenClaw Interface Lifecycle

Run `deployment::openclaw_interfaces_sdk_lifecycle_preserves_intent_and_rejects_drift` with the verified bundle environment above.
It checks retained authored intent and deployment observation failures.
Native listener and authentication tests belong to Fabric's OpenClaw adapter.

## Hermes Native API Lifecycle

With a verified bundle, run:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration remote_service::managed_bearer -- --ignored
```

The fixture simulates SSH/Docker and OpenShell while exercising apply, export/reapply, observation failures and retained data through the bundled CLI/provider.
It asserts that apply sends no generation probes.
Fabric owns native service startup, authentication, configuration and protocol checks.

### Hermes Interface Modes

Run `deployment::hermes_interfaces_sdk_export_reapply_and_drift` with the verified bundle environment above.
It checks retained public configuration and deployment observation failures; it does not establish native service health.

## Hermes Relay Tracing Fixture

Hermes Relay tracing is configured and tested by Fabric's Hermes adapter.
Its trace files do not establish a native API listener or a fresh runtime health observation.
Live Relay and OpenShell behavior need separate qualification at the selected Fabric revision.
