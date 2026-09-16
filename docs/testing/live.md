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
It retains the workspace, persistent storage, apply output, and `upgrade-proof.json`; failures retain state and resources for diagnosis and explicit cleanup.
It never starts inference or substitutes another agent process through exec.

The current OpenShell pin has a [known main-process startup blocker](../validation/rust-native-inference-linux-arm64.md#live-attempt-and-blocker); this gate is not yet live-qualified with that pin.
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

For complete DGX Spark qualification, use the concrete `examples/spark-inline.yaml` on an available GB10 host.
Change its deployment UID, gateway port, and network only when creating a separate deployment.
Build the pinned local runtime artifact first, check capacity, and preserve the same state directory throughout:

```sh
nemoclaw plan --state-dir .local/spark examples/spark-inline.yaml
nemoclaw apply --state-dir .local/spark examples/spark-inline.yaml
nemoclaw export --state-dir .local/spark --output .local/spark-export.yaml
nemoclaw apply --state-dir .local/spark .local/spark-export.yaml
```

A successful DGX Spark apply includes an actual agent response through OpenShell.
Unchanged apply must have no resource changes and retain process/storage IDs and artifact receipts.
The download and preparation fixtures cover deterministic interruption boundaries; live evidence also records an interrupted download and explicit recovery.

Test capacity rejection with synthetic capacity observations, not deliberate host exhaustion.
Test the resident supervisor's SIGUSR1 operator trip only on an explicitly owned test deployment, then confirm that it remains stopped until explicit apply.
Do not confuse that controlled trip with a naturally occurring host-pressure event.

The lifecycle test stops and recovers inference, then leaves workloads running.
It writes `spark-validation.json` in the supplied state directory.
After failure, retain state for [explicit recovery](../usage.md#updates-and-recovery).
Use [the destroy procedure](../usage.md#destroy) when finished.

Run the maintained lifecycle test with absolute paths, separately from the image upgrade test:

```sh
NEMOCLAW_LIVE_SPARK_CONFIG=/absolute/path/to/spark-inline.yaml \
NEMOCLAW_LIVE_SPARK_STATE=/absolute/path/to/state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test -p nemoclaw-e2e --test spark spark_apply_export_capacity -- --ignored
```

Use a dedicated immutable bundle copy for a long live run.
Rebuilding `dist` replaces development artifacts and is not safe while an operation still uses that directory.
[Agent fixture instructions](../agents.md#runtime-lifecycle) cover Fabric's offline harness qualification.

The optional `fabric_live` test accepts absolute `NEMOCLAW_LIVE_FABRIC_CONFIG`, `NEMOCLAW_LIVE_FABRIC_STATE`, and `NEMOCLAW_TEST_BUNDLE` paths.
Use a dedicated UID and state directory with an external gateway and inference endpoint.
It applies the deployment, checks unchanged apply and export/reapply, exercises the native agent/Fabric SDK, and destroys its owned registrations and sandbox.

It retains JSON evidence and the workspace.
The hosted Fabric runtime must keep its identity throughout native access and reconciliation.
This test makes a real model request.

Managed vLLM service apply also checks an actual agent reply, including unchanged apply.

Use the separate `spark_image_change` test filter with the same three DGX Spark paths to qualify an explicit runtime image upgrade.
The new YAML may differ from retained intent only by its inference image pin.
The test requires complete artifact receipts, allows an established stopped service, and verifies that plan is read-only and apply replaces only that process while preserving all other bindings and prepared data.

It retains `spark-artifact-validation.json`.

## Generic Models

The generic model lifecycle has a separate opt-in live test.
Supply a fresh, owned deployment configuration with a free gateway port and subnet, its state directory, and an immutable bundle:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_LIVE_MODEL_CONFIG=/absolute/path/to/vllm.yaml \
NEMOCLAW_LIVE_MODEL_STATE=/absolute/path/to/state \
  cargo test -p nemoclaw-e2e --test model_live \
    selected_model_apply_export_and_watchdog_recovery -- --ignored --nocapture
```

It checks initial apply and an actual agent reply, unchanged apply, export and reapply, absence of PLE preparation, and an operator-triggered watchdog stop.
Explicit recovery must preserve resource identities and the snapshot receipt.
Successful completion destroys workloads, retains storage, and writes `model-proof.json` in the supplied state directory.

Failures retain resources for diagnosis; reconcile that state before starting another run.
Retained gateway storage includes its network, so a different deployment needs a different subnet.

For an established deployment whose gateway is running, select `selected_model_continues_from_retained_state` with the same environment variables.
It runs the same lifecycle assertions without the fresh-plan assertion.
Run only one of these live tests against a given deployment at a time.

After intentional destroy, apply the retained configuration first.
A read-only plan cannot observe workspace resources through a stopped gateway and will ask for that explicit reconciliation.

## Hosted NVIDIA OpenClaw Parity

The [issue #11810 Linux/Docker scenario](../validation/scenarios/openclaw-nvidia-hosted-linux-docker.md) strictly translates a redacted, exact-hash v0 export artifact into a new v1 desired state and compares the v1 export with that translation.
It requires a dedicated NVIDIA credential, an owned Docker daemon and deployment identity, a verified immutable v1 bundle, explicit v1-only runtime bindings, and an ownership marker.

The ignored test accepts the `issue-11810-local-feedback` acknowledgement for non-qualifying Docker Desktop feedback.
Docker Desktop feedback may require an explicitly recorded operator-owned forwarding layer for the managed gateway and sandbox callback paths; native Linux qualification must not use it.
Docker Desktop socket-source canonicalization remains unsupported and fails closed.
The `issue-11810` gate, a clean v1 checkout, and fresh owned state produce a qualification candidate.
The test also requires an explicit v0-to-v1 process-principal mapping and decision reference; retained evidence records both sides.
The runner records `qualified: false`; qualification requires external artifact-provenance and evidence review.
It makes a paid or quota-consuming hosted inference request and destroys only the deployment bound to that state.
Do not run it as part of an ignored-test aggregate.

## SSH Engine Transport

The SDK's `ssh_live` tests are opt-in.
Set `NEMOCLAW_TEST_SSH_ENGINE` to an explicit SSH URL and `NEMOCLAW_TEST_ENGINE_ID` to an independently observed daemon ID, then run `cargo test -p nemoclaw-sdk --test ssh_live ssh_observes -- --ignored`.
Run `ssh_failure` separately against rejected authentication, an untrusted host key, or an unavailable endpoint; it must report observation failure, not absence.

The `ssh_upload` test additionally requires `NEMOCLAW_TEST_SSH_CONTAINER`, the full ID of a stopped container labeled `nemoclaw.experiment=ssh-transport`.
It writes `/tmp/ssh-proof` and checks the streamed archive and unchanged identity.
The caller owns fixture setup and cleanup; never target an unrelated container.

The SDK `ssh_capacity` live test exercises the fixed collector on an explicitly selected Linux ARM64 NVIDIA host without provisioning resources.

The existing `fabric_live` test also accepts an external gateway with a managed SSH inference service.
Managed applies retain their active agent-reply check, including applies with no resource changes.
The test checks managed runtime bindings as well as the hosted agent identity across export/reapply and destroys only the supplied deployment.

The [two-daemon evidence](../validation/rust-dual-daemon-linux-arm64.json) records its live rootless Podman run, controlled download interruption, protection trip, engine retarget rejection, and retained model data.
