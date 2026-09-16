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
`agent_compatibility` checks the ten Fabric launch contracts against retained fixtures.
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

## Inference API Fixtures

From the repository root, use Docker, OpenSSL, Python 3, and a freshly built Fabric image on the qualified Linux ARM64 host.
See [image prerequisites](../inference.md#build-an-image-with-the-configuration-interface).
The fixture starts disposable containers with networking disabled and local TLS protocol servers; it uses no live credentials or model endpoints.
OpenClaw's fixture adds an address to the container's loopback interface with `NET_ADMIN`, then runs the agent as UID 1000.

```sh
python3 tools/fabric-adapter-experiment.py --harness openclaw --image nc-prototype-fabric:openclaw --inference-api openai-responses
python3 tools/fabric-adapter-experiment.py --harness hermes --image nc-prototype-fabric:hermes --inference-api anthropic-messages
```

Repeat with `openai-completions`, `openai-responses`, and `anthropic-messages` to exercise all three APIs for each harness.
OpenClaw also receives explicit token limits and reasoning settings; Hermes receives an API-key auth reference with a fixture key.
The fixture checks configuration readiness without additional inference requests, rejects an incorrect agent identity, invokes the real adapter twice, and checks the inference request paths.
Hermes may make model-metadata requests during startup; these are separate from inference requests.

The command prints an evidence directory under `.local/fabric-<harness>-<uuid>` and exits successfully when the assertions pass.
It retains logs, request bodies, and `proof.json`; it removes only its named container, including after failure.
Inspect that directory on failure and rerun after correcting the fixture or image.
These tests do not qualify model quality, live upstream authentication, or inference through a real OpenShell gateway.

## OpenClaw Agent Tool Policies

Build the updated OpenClaw image using the [agent runtime procedure](../agents.md#runtime-lifecycle).
From the repository root, run the adapter tests and the pinned native tool factory in disposable containers:

```sh
docker run --rm --network none --pull=never \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /opt/fabric/bin/python nc-prototype-fabric:openclaw \
  -m unittest test_openclaw_adapter test_inference

docker run --rm --network none --pull=never -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /usr/local/bin/node nc-prototype-fabric:openclaw \
  /work/test_openclaw_tools.mjs

docker run --rm --network none --pull=never -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /usr/local/bin/node nc-prototype-fabric:openclaw \
  /work/test_openclaw_disclosure.mjs

docker run --rm --network none --pull=never \
  -e NEMOCLAW_TEST_NATIVE_TOOLS=1 -e PYTHONPATH=/work \
  -v "$PWD/image/fabric:/work:ro" -w /work \
  --entrypoint /opt/fabric/bin/python nc-prototype-fabric:openclaw \
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
python3 tools/fabric-adapter-experiment.py --harness openclaw --image nc-prototype-fabric:openclaw --interfaces
```

This offline test uses the nondefault port 18800, lists native pairing requests with the authenticated helper, rejects an incorrect token and weakened native device-auth settings, restores the original settings, and verifies that a runtime restart retains the token.
Its evidence includes `authenticated_interfaces_verified` in `proof.json`.
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
  --entrypoint /opt/fabric/bin/python nc-prototype-fabric:hermes /test.py
```

The contract rejects missing and incorrect API credentials, verifies authenticated model discovery, and checks that disconnect closes the listener.
The inference API fixtures above exercise the Fabric-owned native server, two ordered turns, and a separate probe through the hosted runtime.
They use local protocol responses, not a live model.

With a freshly verified bundle, run the managed Hermes lifecycle fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test remote_service managed_hermes -- --ignored
```

It simulates SSH/Docker, OpenShell, and the agent response while exercising apply, export/reapply, observation failures, and retained data through the bundled CLI/provider.

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
It does not qualify browser rendering, interactive terminal behavior, or live OpenShell forwarding.

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

Expect a successful exit and `relay` evidence in the printed directory's `proof.json`.
The host retains logs, request records, proof, and a copy of `/sandbox/artifacts` under the evidence directory's `artifacts/` folder, including Relay traces and native runtime-home data.
Inspect those retained files privately before sharing, and remove only your test's evidence directory when it is no longer needed.
On failure, inspect the retained diagnostics, correct the fixture/image mismatch, and rerun with an owned test image.
This is an offline tracing check, not live Hermes/Relay or OpenShell qualification.
