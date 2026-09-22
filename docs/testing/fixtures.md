<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

Most tests here use local protocol fixtures and temporary state.
The Docker-provider tests explicitly identified below also create isolated local containers, networks, and volumes.
Complete the [build prerequisites](../build.md) first.

## OpenTofu and Bundle Lifecycle

The private `nemoclaw-e2e` crate runs the actual provider protocol through OpenTofu 1.12.6.
Build the production provider and supply absolute executable paths explicitly:

```sh
cargo build -p nemoclaw-provider --bin terraform-provider-nemoclaw
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test provider_protocol -- --ignored
```

These tests launch a fixture provider built by that crate and use temporary files.
On Unix, they also run the production provider against a local Docker API fixture to check network and image planning, including prerequisite changes before saved-plan application.
They create no Docker, OpenShell, or inference resources.
The fixture provider is not a production bundle component.

On Unix with `python3` on `PATH`, run from the repository root to test combined service capacity through the production provider and an isolated SSH simulator:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test service_capacity -- --ignored
```

This fixture checks shared-host overcommit, deferred reads, preserved state after failed observations, and cleanup without capacity checks.
It uses a built-in OpenTofu resource to exercise the generated precondition and does not create model processes or download artifacts.

Test the runtime bundle and live serving backend separately.

Test the production provider's full OpenShell resource graph against the local gRPC fixture:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test opentofu_openshell -- --ignored
```

These tests also check gateway version and driver preconditions, failed observations without resource changes, and data-source reads deferred until bootstrap inputs become known.
Standalone HCL cases exercise provider/profile replacement and removal without sandbox teardown mode, recreation after confirmed absence, credential-reference updates, and recovery after a lost creation response.
They also commit absence with refresh-only before a later creation plan, and verify that substituted creation readback preserves the original binding with an error.
A lost creation response followed by removing its declaration demonstrates why pending creation intent must be retained: OpenTofu cannot remove an object whose binding it never received.
The fixture enforces the pinned API's refusal to delete a referenced profile or an attached provider; sandbox and workspace protection remain covered separately.

The SDK/CLI lifecycle tests require a verified native bundle (manifest plus CLI, OpenTofu, and both production providers).
They use only the local gRPC fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment --test export_observations --test fabric_deployment --test multiple_providers -- --ignored
```

CI uses the [nextest lifecycle profile](../testing.md#test-runner) with four concurrent tests.
Each Fabric harness is an independent ignored test with its own temporary state and gRPC fixture.
To test one harness, append its test name, for example `-- --ignored harness_codex`; to run all harnesses with the same concurrency bound under Cargo, use `-- --ignored --test-threads=4`.

These tests cover shared SDK/CLI state, interrupted creation, unchanged apply, readiness failure without replacement, failed observation without state loss, export/reapply, interrupted destroy, and retained workspace recovery.
The registration lifecycle case recreates a missing selected registration while preserving its sandbox and profile, and the interrupted-create case permits unrelated intent edits while retaining pending resource configuration.
The `independent_sandboxes_reconcile_concurrently_and_retain_shared_dependencies` fixture checks overlapping sandbox creates, unchanged reapply, and teardown with a retained shared workspace.
The `gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` fixture changes the gateway driver after planning to verify OpenTofu's fresh apply-time check, recovery, and teardown after capability drift.
The direct provider fixture checks saved plans with both unchanged and newly created resources; incompatible or unavailable gateways stop dependent mutations without losing managed-resource bindings.
The Pi lifecycle fixture verifies that this gate also blocks model configuration writes, and that unchanged apply performs no configuration writes.
The multiple-provider fixture also verifies two independent deployments, each sandbox’s selected provider attachments, export/reapply, and drift in one deployment without changes to the other.
The fixture returns protocol responses; it does not establish live agent inference.
The export fixture checks provider refresh failures through OpenTofu, unchanged deployment state and configuration, and export without inference credentials or Fabric health requests.

## Standalone Sandbox Completion

On Unix, build the production provider and supply the explicit OpenTofu and provider paths as above.
Run from the repository root:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test sandbox_readiness -- --ignored
```

The fixture runs the sandbox completion data source through OpenTofu against a local gRPC server, without SDK deployment orchestration.
It checks deferred health reads, failed postconditions with retained observations and bindings, unchanged-apply rechecks, and teardown without readiness.
It creates temporary state and simulated OpenShell resources; it does not start containers or invoke a model.
On failure, inspect the OpenTofu diagnostic and verify that the selected provider matches the checkout before rerunning.

## Standalone Service Readiness

On Unix with `python3` on `PATH`, build the production provider as above and run from the repository root:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test service_readiness -- --ignored
```

The fixture uses an isolated SSH/Docker simulator and a builtin OpenTofu consumer, without SDK deployment orchestration or a reachable OpenShell gateway.
It checks offline validation, apply-time reads, saved-plan failure, unchanged-service rechecks, bounded timeout, recovery, and teardown without readiness.
The proxy case also uses an isolated HTTP model-metadata fixture and checks delayed initial credentials, container identity, credential permissions, and upstream model drift.
It uses temporary files and loopback listeners; it does not create containers or execute a model.
A failed assertion reports the OpenTofu diagnostic; rerun after correcting the matching provider or fixture inputs.

## Ollama and Platform Fixtures

Managed Ollama's deterministic SDK tests use local registry, capacity, configuration, and runtime-plan fixtures, not live containers or model downloads.
They cover immutable model resolution, bounded readiness, retained storage, service references, independent installer resources, and provider connection resolution:

```sh
cargo test -p nemoclaw-sdk services::installers::ollama
cargo test -p nemoclaw-sdk --test service_references --test multiple_providers
```

The [Docker-provider lifecycle fixture](#docker-provider-lifecycle) checks the managed proxy through the SDK and its production provider graph.

Authenticated OpenShell, stalled exec streams, and launch compatibility run in the default workspace suite.
`agent_compatibility` checks passive launch mode, caller identity, harness selection, and default policy restrictions without frozen launch snapshots.
The separately scheduled Fabric lifecycle cases and installed-adapter image tests exercise the supported harnesses.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The native CI matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64, and Windows x64.
CI's protocol and lifecycle fixtures do not establish local Docker, Podman, GPU, or real model availability on those platforms.
Report build results separately from runtime test results.

## Runtime Image Loading

On a native Linux host, complete the [runtime image build prerequisites](../build.md#build-a-runtime-image).
This test builds a uniquely named scratch image without downloading a base image, exports an OCI archive, loads it, and checks access by the exported digest.
It removes its image tag afterward; Docker's build cache remains.
Run from the repository root:

```sh
NEMOCLAW_TEST_RUNTIME_IMAGE=1 cargo test -p nemoclaw-build --bin nemoclaw-build runtime_archive_loads_with_its_exported_digest -- --ignored
```

A failure reports the build, load, or identity check that failed; correct the Docker configuration and rerun.
It does not start containers, run inference, or publish an image.

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

The recipe test checks declared serving arguments and capacity, and rejects model/backend/hardware combinations outside the declared compatibility requirements.
The [live image-change test](live.md#spark-and-fabric) requires plan and apply to replace only the inference process.
Managed-resource fixtures check storage identity and explicit recovery; the recipe tests verify prepared data before reuse.
The fixture checks that the supervisor runs independently of the CLI; it does not test another real serving backend.

## SSH Service Fixtures

The `remote_service` E2E fixture exercises the bundled CLI/provider boundary with an isolated Docker-over-SSH simulator and OpenShell fixture.
Run `cargo test -p nemoclaw-e2e --test remote_service -- --ignored` with `NEMOCLAW_TEST_BUNDLE` set.
It checks read-only planning without host-capacity collection, failed startup recovery, missing-container replacement, no-op, export/reapply, cache reconstruction with unchanged credentials, and failed observation or credential-daemon retargeting without lost bindings.
Destroy removes disposable containers and service networks while retaining storage.
The partial-runtime fixtures verify teardown after failed creation without first creating the missing compute; failed readiness also permits corrected intent while retaining bindings.

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
  cargo test -p nemoclaw-e2e --test docker_provider_proxy -- --ignored
```

This test creates uniquely named local containers and credential volumes and removes only those owned resources afterward.
It checks SDK apply, export/reapply, failed readiness, image changes and container replacement with the same key, destroy retention, and rejection of missing, foreign, or substituted retained volumes.
OpenShell and the upstream Ollama inventory are local protocol fixtures; no model executes.

The SDK's ignored `cpu_runtime_provider_reconciles_compute_and_retains_data` test exercises the production Ollama and vLLM resource graphs through real Docker and OpenTofu.
It requires `NEMOCLAW_TEST_BUNDLE` and explicit `NEMOCLAW_TEST_RUNTIME_IMAGE_OLLAMA` and `NEMOCLAW_TEST_RUNTIME_IMAGE_VLLM` digest references to loaded CPU fixture images.
Those images must provide Python 3 and `/usr/local/bin/nemoclaw-runtime`, which writes a fresh ready status to `/data/status.json` and stays running until stopped.
Run it with `cargo test -p nemoclaw-sdk cpu_runtime_provider_reconciles_compute_and_retains_data -- --ignored`.
It adapts host placement and GPU-sized limits for CPU execution and checks replacement, network recreation, and a retained data sentinel.
It does not qualify GPU execution, model preparation, inference, or the runtime's hardware checks.

## Standalone Cache and Credential Resources

On Linux with Docker, select a verified bundle, an explicit local engine socket, and an already loaded digest-pinned image containing Python 3.
From the repository root:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_CACHE_ENGINE=unix:///var/run/docker.sock \
NEMOCLAW_TEST_CACHE_IMAGE=repository@sha256:YOUR_IMAGE_DIGEST \
  cargo test -p nemoclaw-e2e --test cache_provider -- --ignored
```

The [hand-written HCL](../../crates/nemoclaw-e2e/tests/fixtures/cache_provider.tf) composes `docker_volume`, `docker_container`, and `nemoclaw_inference_storage`; no SDK compiler or deployment coordinator runs.
The fixture creates fresh owned resources, checks no-op, replacement, failed-start recovery, retained teardown/reapply, and cache reconstruction with the same credential.
Missing or substituted credential volumes must stop apply before compute creation and preserve state.
Teardown sets the container count to zero while keeping both volume declarations; ordinary `tofu destroy` is deliberately blocked by their retention rules.
The runner removes only its labelled resources afterward and retains logs and state under its printed temporary path for diagnosis.
Its Python process simulates model reconstruction and a credential; it does not qualify the vLLM supervisor, GPU execution, model preparation, inference, or OpenShell deployment.

## Inference API Fixtures

From the repository root, use Docker, OpenSSL, Python 3, and a freshly built Fabric image on a Linux ARM64 host.
See [image prerequisites](../inference.md#build-an-image-with-the-configuration-interface).
The fixture starts disposable containers with networking disabled and local TLS protocol servers; it uses no live credentials or model endpoints.
OpenClaw's fixture adds an address to the container's loopback interface with `NET_ADMIN`, then runs the agent as UID 1000.

```sh
python3 tools/fabric-adapter-experiment.py --harness openclaw --image nc-fabric:openclaw --inference-api openai-responses
python3 tools/fabric-adapter-experiment.py --harness hermes --image nc-fabric:hermes --inference-api anthropic-messages
```

Repeat with `openai-completions`, `openai-responses`, and `anthropic-messages` to exercise all three APIs for each harness.
OpenClaw also receives explicit token limits and reasoning settings; Hermes receives an API-key auth reference with a fixture key.
The fixture checks configuration readiness without additional inference requests, rejects an incorrect agent identity, invokes the real adapter twice, and checks the inference request paths.
Hermes may make model-metadata requests during startup; these are separate from inference requests.

The command exits successfully when the assertions pass and prints failures and subprocess output to the terminal.
It removes its named container and temporary certificates, including after failure.
Read the assertion failure and rerun after correcting the fixture or image.
These tests do not evaluate model quality or test live upstream authentication or inference through a real OpenShell gateway.

## OpenClaw Agent Tool Policies

Build the updated OpenClaw image using the [agent runtime procedure](../agents.md#runtime-lifecycle).
From the repository root, run the adapter tests and the pinned native tool factory in disposable containers:

```sh
docker run --rm --network none --pull=never \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /opt/fabric/bin/python nc-fabric:openclaw \
  -m unittest test_openclaw_adapter test_inference

docker run --rm --network none --pull=never -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /usr/local/bin/node nc-fabric:openclaw \
  /work/test_openclaw_tools.mts

docker run --rm --network none --pull=never -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /usr/local/bin/node nc-fabric:openclaw \
  /work/test_openclaw_disclosure.mts

docker run --rm --network none --pull=never \
  -e NEMOCLAW_TEST_NATIVE_TOOLS=1 -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /opt/fabric/bin/python nc-fabric:openclaw \
  -m unittest test_openclaw_tools_gateway
```

The adapter tests cover named sessions and rejection of changed native permissions.
The gateway test starts and restarts the pinned native gateway, then verifies that broadened permissions fail its configuration check.
The native factory test executes a file read and checks that restricted agents receive no write, exec, or delegation tools, while the unrestricted agent retains coding tools.
The disclosure test checks direct exposure and executes progressive search and read calls; attempts to dispatch exec, write, edit, or delegation through search are rejected.
These tests do not invoke a model or establish filesystem isolation between agents.
The read fixture exists only in the disposable container.

With a freshly built native bundle, run the SDK/CLI lifecycle fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment multiple_agents_cli_export_reapply_and_policy_drift -- --ignored
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment tool_disclosure_cli_export_reapply_and_drift -- --ignored
```

These fixtures check four-agent and disclosure-mode export/reapply and failed observation without mutation or lost state.
The local OpenShell fixture simulates the runtime observation result; native enforcement is covered separately by the tool factory test.

## OpenClaw Interface Lifecycle

With a freshly built OpenClaw image and the prerequisites above, run:

```sh
python3 tools/fabric-adapter-experiment.py --harness openclaw --image nc-fabric:openclaw --interfaces
```

This offline test uses the nondefault port 18800, lists native pairing requests with the authenticated helper, rejects an incorrect token and weakened native device-auth settings, restores the original settings, and verifies that a runtime restart retains the token.
The bundle fixture is `openclaw_interfaces_sdk_lifecycle_preserves_intent_and_rejects_drift` in the `deployment` test binary.
[Recorded Linux ARM64 results](../validation/rust-openclaw-interfaces-linux-arm64.json) distinguish native gateway checks from simulated OpenShell lifecycle behavior.

## Hermes Native API Lifecycle

This section tests the default local Hermes adapter, with Relay tracing omitted.

Build a fresh Hermes image using the [runtime procedure](../agents.md#runtime-lifecycle).
From the repository root, test native authentication and shutdown without networking:

```sh
docker run --rm --network none --pull=never \
  -e HERMES_HOME=/tmp/hermes-contract \
  -v "$PWD/test/hermes_native.py:/test.py:ro" \
  --entrypoint /opt/fabric/bin/python nc-fabric:hermes /test.py
```

The contract rejects missing and incorrect API credentials, verifies authenticated model discovery, and checks that disconnect closes the listener.
The inference API fixtures above exercise the Fabric-owned native server, two ordered turns, and a separate probe through the hosted runtime.
They use local protocol responses, not a live model.

With a freshly verified bundle, run the managed Hermes lifecycle fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test remote_service managed_hermes -- --ignored
```

It simulates SSH/Docker and OpenShell configuration/readiness while exercising apply, export/reapply, observation failures, and retained data through the bundled CLI/provider.
Generation is configured to fail, and the test asserts that apply sends no generation probes.

### Hermes Interface Modes

After rebuilding the Hermes image, exercise the three native interface modes:

```sh
python3 tools/fabric-adapter-experiment.py --harness hermes --interfaces --inference-api openai-completions
python3 tools/fabric-adapter-experiment.py --harness hermes --interfaces --hermes-tui disabled --inference-api openai-responses
python3 tools/fabric-adapter-experiment.py --harness hermes --interfaces --hermes-dashboard disabled --inference-api anthropic-messages
```

These offline containers check nondefault API/dashboard ports, authenticated native readiness, HTML delivery, browser WebSocket session creation or rejection, and the absence of a disabled dashboard listener.
They also reject changed credentials and native route configuration without overwriting drift, then verify restored readiness and credential retention across restart.
The fixture invokes the hosted probe and two Fabric turns against local model responses.
It does not test browser rendering, interactive terminal behavior, or live OpenShell forwarding.

Run `hermes_interfaces_sdk_export_reapply_and_drift` in the `deployment` test binary with a verified bundle to check retained interface intent through SDK apply, CLI export, reapply, drift rejection, and destroy.

[Recorded Hermes results](../validation/rust-hermes-native-interfaces-linux-arm64.json) identify the pinned sources, tested local image, and separate bundle-fixture limits.

## Hermes Relay Tracing Fixture

Use the [inference fixture prerequisites](#inference-api-fixtures) and a Hermes image built from the current recipe.
From the repository root, replace the image placeholder with that local image:

```sh
python3 tools/fabric-adapter-experiment.py --harness hermes --hermes-relay --inference-api openai-completions --image YOUR_BUILT_IMAGE
```

The parser requires an explicit API with `--hermes-relay`; do not add `--interfaces`, which conflicts with this adapter mode.
The test runs disposable containers with networking disabled and a local model-protocol fixture.
It invokes the real adapter twice and checks nonempty ATOF events and ATIF trajectories plus absence of the fixture credential string.
That narrow credential assertion does not establish general redaction or production privacy.

Expect exit status zero when the Relay assertions pass.
The test checks traces inside its disposable container and removes that container afterward.
On failure, read the assertion and subprocess output, correct the fixture/image mismatch, and rerun with an owned test image.
This test checks tracing offline; live Hermes/Relay and OpenShell behavior need separate tests.
