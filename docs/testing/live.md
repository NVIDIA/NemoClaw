<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Live Qualification

Live tests require explicit configuration and must touch only resources owned by the test.
Use a dedicated deployment UID, state directory, and immutable bundle.
Read each test’s lifecycle effects before running it.

Do not run all ignored tests against a shared deployment.

## Dependency Upgrade Gate

Before qualifying an OpenShell or Fabric/image upgrade, use the small `dependency_upgrade_survives_apply_process_exit` test.
It requires one OpenClaw agent and one already-running external inference provider; it rejects managed inference services, Ollama, and proxies.
Run from the checkout that built the candidate bundle: the initial apply uses the bundled CLI, and subsequent checks use the checkout's SDK.
Provide a dedicated deployment UID, an unused state directory whose parent exists, and an immutable candidate bundle.
Use either an external gateway at the candidate SDK's pinned OpenShell version or a managed gateway with a free port and subnet.
The compute daemon must have the selected agent image, and the inference endpoint must already serve the selected model.
Supply any referenced credentials to the test process.
The test makes real inference requests, which may incur charges for hosted providers.

From the repository root, with absolute paths:

```sh
NEMOCLAW_UPGRADE_CONFIG=/absolute/path/to/owned-deployment.yaml \
NEMOCLAW_UPGRADE_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/candidate-bundle \
  cargo test --workspace --test fabric_live \
    dependency_upgrade_survives_apply_process_exit -- --ignored --test-threads=1
```

The test waits for the real apply CLI to exit, then requires a reply from the hosted agent through OpenShell.
It checks export/reapply and stable resource/runtime identities before destroying its owned workloads and registrations.
It retains the workspace and persistent storage; failures retain state and resources for diagnosis and explicit cleanup.
CLI failures appear in the test output.
It never starts inference or substitutes another agent process through exec.

The gate passed with OpenShell `1fe79f539` on Linux ARM64; see the [upgrade qualification and limits](../validation/rust-managed-podman-linux-arm64.md#docker-regression-checks).
The [earlier main-process failure](../validation/rust-native-inference-linux-arm64.md#live-attempt-and-blocker) remains specific to its recorded revision.
A failed gate must not be recorded as compatibility success because lower-level fixtures passed.
Run it explicitly for candidate dependency upgrades, outside the default build; ordinary CI retains the fast descriptor, reference, and protocol tests.

## Retained Storage Observations

Read-only live storage qualification requires an explicit OpenTofu runtime state file containing the test deployment's retained inference volume binding:

```sh
NEMOCLAW_TEST_RUNTIME_STATE=/absolute/path/to/runtime/terraform.tfstate \
  cargo test -p nemoclaw-sdk --test managed_live \
  retained_inference_volume_preserves_its_reference_binding -- --ignored
```

The separate `existing_spark_runtime_bindings_are_observed_without_mutations` test requires both gateway and inference container bindings to exist.
Neither read-only test creates resources or establishes live agent inference.
Refer to [retained volume evidence](../validation/rust-storage-linux-arm64.json).

## Spark and Fabric

The Spark test reads a copy of `examples/spark/spark-inline.yaml` and asserts the public plan and apply results.
Use an available GB10 host, build the runtime and agent images, and set their immutable image references in the YAML.
Choose a fresh deployment UID, available gateway port and subnet, and a new state-directory path whose parent exists.
Keep the example's provider name `qwen`, sandbox name `assistant`, and agent name `assistant`; these identify the expected resources.

From the repository root, with absolute paths:

```sh
NEMOCLAW_LIVE_SPARK_CONFIG=/absolute/path/to/spark-inline.yaml \
NEMOCLAW_LIVE_SPARK_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test -p nemoclaw-e2e --test spark spark_yaml_plans_and_applies_expected_resources -- --ignored
```

The first plan must create four runtime resources and defer OpenShell registration until the gateway exists.
Apply must create those resources plus the provider profile, provider registration, sandbox, and workspace.
A second plan and apply must report no changes.
The test checks readiness without requesting a model response and leaves workloads running.
It writes no separate test report.
After failure, retain state for [explicit recovery](../usage.md#updates-and-recovery); use [destroy](../usage.md#destroy) when finished.

Run `spark_image_change_plans_and_applies_replacement` separately with the same three variables and an established, running deployment.
Change only the inference image pin in the YAML.
The test compares the input with exported configuration, then requires plan and apply to replace only `nemoclaw_inference_service.inference_qwen`.
Storage retention and watchdog recovery have separate tests under [runtime boundaries](fixtures.md#runtime-boundaries) and [generic models](#generic-models).

Use an immutable bundle copy for a long live run.
Rebuilding `dist` replaces development artifacts; keep the selected bundle unchanged until the operation ends.

The optional `fabric_live` test accepts absolute `NEMOCLAW_LIVE_FABRIC_CONFIG`, `NEMOCLAW_LIVE_FABRIC_STATE`, and `NEMOCLAW_TEST_BUNDLE` paths.
Use a dedicated UID and state directory with an external gateway and inference endpoint.
It applies the deployment, checks unchanged apply and export/reapply, exercises the native agent/Fabric SDK, and destroys its owned registrations and sandbox.
The hosted Fabric runtime must keep its identity throughout native access and reconciliation.
This test makes a real model request and reports assertion failures through the test runner.
The workspace remains after destroy.

## Generic Models

The generic model lifecycle has a separate opt-in live test.
Supply a fresh, owned OpenClaw or Hermes deployment configuration with a free gateway port and subnet, its state directory, and an immutable bundle:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_LIVE_MODEL_CONFIG=/absolute/path/to/vllm.yaml \
NEMOCLAW_LIVE_MODEL_STATE=/absolute/path/to/state \
  cargo test -p nemoclaw-e2e --test model_live \
    selected_model_apply_export_and_watchdog_recovery -- --ignored --nocapture
```

It checks initial apply, a separately requested agent reply, unchanged apply, export and reapply, absence of PLE preparation, and an operator-triggered watchdog stop.
Explicit recovery must preserve resource identities and the model manifest.
Successful completion destroys workloads and retains storage.
Assertions report failures through the test runner; the test writes no separate report.

Failures retain resources for diagnosis; reconcile that state before starting another run.
Retained gateway storage includes its network, so a different deployment needs a different subnet.

For an established deployment whose gateway is running, select `selected_model_continues_from_retained_state` with the same environment variables.
It runs the same lifecycle assertions without the fresh-plan assertion.
Run only one of these live tests against a given deployment at a time.

After intentional destroy, apply the retained configuration first.
A read-only plan cannot observe workspace resources through a stopped gateway and will ask for that explicit reconciliation.

## Hosted NVIDIA OpenClaw Parity

The [hosted OpenClaw test](../validation/scenarios/openclaw-nvidia-hosted-linux-docker.md) compares a redacted v0 export with separately authored v1 YAML, then checks expected plan, apply, export/reapply, and destroy results.
It requires an owned Linux Docker deployment, a new state-directory path, a verified bundle, and the declared NVIDIA credential.
It checks configuration and readiness without requesting a model response.
Select it explicitly; do not run live tests as an ignored-test aggregate.

## SSH Engine Transport

The SDK's `ssh_live` tests are opt-in.
Set `NEMOCLAW_TEST_SSH_ENGINE` to an explicit SSH URL and `NEMOCLAW_TEST_ENGINE_ID` to an independently observed daemon ID, then run `cargo test -p nemoclaw-sdk --test ssh_live ssh_observes -- --ignored`.
Run `ssh_failure` separately against rejected authentication, an untrusted host key, or an unavailable endpoint; it must report observation failure, not absence.

The `ssh_upload` test additionally requires `NEMOCLAW_TEST_SSH_CONTAINER`, the full ID of a stopped container labeled `nemoclaw.experiment=ssh-transport`.
It writes `/tmp/ssh-transfer-test` and checks the streamed archive and unchanged identity.
The caller owns fixture setup and cleanup; never target an unrelated container.

The SDK `ssh_capacity` live test exercises the fixed collector on an explicitly selected Linux ARM64 NVIDIA host without provisioning resources.

The existing `fabric_live` test also accepts an external gateway with a managed SSH inference service.
The live test requests an agent reply separately from apply.
The test checks managed runtime bindings as well as the hosted agent identity across export/reapply and destroys only the supplied deployment.

The [two-daemon evidence](../validation/rust-dual-daemon-linux-arm64.json) records its live rootless Podman run, controlled download interruption, protection trip, engine retarget rejection, and retained model data.
