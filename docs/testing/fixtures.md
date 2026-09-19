<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

These tests use local protocol fixtures and temporary state.
They do not provision live deployments.
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

Test the runtime bundle and live serving backend separately.

Test the production provider's full OpenShell resource graph against the local gRPC fixture:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test opentofu_openshell -- --ignored
```

These tests also check gateway version and driver preconditions, failed observations without resource changes, and data-source reads deferred until bootstrap inputs become known.

The SDK/CLI lifecycle tests require a verified native bundle (manifest plus CLI, OpenTofu, and production provider).
They use only the local gRPC fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment --test fabric_deployment --test multiple_providers -- --ignored
```

CI runs the fixture lifecycle tests with `--test-threads=2`.
Each Fabric harness is an independent ignored test with its own temporary state and gRPC fixture.
To test one harness, append its test name, for example `-- --ignored harness_codex`; to run all harnesses with CI's concurrency bound, use `-- --ignored --test-threads=2`.

These tests cover shared SDK/CLI state, interrupted creation, unchanged apply, readiness failure without replacement, failed observation without state loss, export/reapply, interrupted destroy, and retained workspace recovery.
The `gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` fixture changes the gateway driver after planning to verify the SDK's fresh pre-apply check, recovery, and teardown after capability drift.
The multiple-provider fixture also verifies two independent deployments, each sandbox’s selected provider attachments, export/reapply, and drift in one deployment without changes to the other.
The fixture returns protocol responses; it does not establish live agent inference.

## Ollama and Platform Fixtures

Managed Ollama's deterministic SDK tests use local registry, capacity, configuration, and runtime-plan fixtures, not live containers or model downloads.
They cover immutable model resolution, bounded readiness, retained storage, service references, independent installer resources, and provider connection resolution:

```sh
cargo test -p nemoclaw-sdk services::installers::ollama
cargo test -p nemoclaw-sdk --test service_references --test multiple_providers
```

Authenticated OpenShell, stalled exec streams, and launch compatibility run in the default workspace suite.
`agent_compatibility` checks the ten Fabric launch contracts against retained fixtures.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The native CI matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64/x64, and Windows x64.
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
It checks read-only planning, missing/low capacity, failed startup recovery, no-op, export/reapply, failed observation and daemon retargeting without recreation, and retained storage on destroy.

Native CI runs these isolated fixtures on Unix, including managed OpenClaw, Hermes, Pi, and bearer-credential lifecycles.
Its readiness and artifact manifests are simulated; it does not download or serve a model.
Plan and apply reject missing or changed model artifacts; export checks configuration without repeating artifact or credential readiness checks.

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
