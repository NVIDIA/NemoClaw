<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Live Tests

Live tests require explicit configuration and must touch only resources owned by the test.
Use a dedicated deployment UID, state directory, and immutable bundle.
Read each test’s lifecycle effects before running it.

Do not run all ignored tests against a shared deployment.

## Kubernetes Gateway Without the Helm CLI

On native Linux with Docker Buildx and the [containerd image store](../build.md#build-agent-images), run the live and chart-render tests with a fresh kind cluster:

```sh
cargo ci build
cargo ci bundle
cargo ci live-kind
```

The runner builds OpenClaw, exports its metadata bundle, loads it by digest, and installs the pinned Agent Sandbox prerequisite.
The gateway test checks authentication, forged-token rejection, repeated install/removal, and retained storage without a Helm executable on `PATH`.
The OpenShift-profile and registry tests share one flow that uses the public SDK to deploy a gateway and agent sandboxes from that image, with one inference profile for all of them as in `examples/kubernetes/managed-development.yaml`.
Each sandbox also grants one endpoint named for it, so no two sandboxes have the same policy.
Before deploying, the flow starts a stub model server in its own namespace, as a platform would: the pinned `nginx-unprivileged` image that the development issuer runs, behind a Service named `model` on port 8000.
The inference profile names that Service by its cluster DNS name, without a key, as [Use a Model Server in the Cluster](../kubernetes.md#use-a-model-server-in-the-cluster) describes.
The stub answers every `POST /v1/chat/completions` with the same streamed chat completion, which holds a value unique to the run.
The OpenShift-profile test deploys three sandboxes, `assistant`, `researcher`, and `reviewer`; the registry test deploys `assistant` alone.
The flow supplies a caller-relative kubeconfig and expects apply to complete with every agent started.
A second apply must report no changes.
Its refresh records two values the first apply leaves for later: the sandbox's loaded policy hash and the auth resource's Helm release presence.
Export must reproduce the authored configuration, and applying the export must report no changes and leave OpenTofu state as the second apply left it, apart from its serial and the order of check results.
Export refreshes each sandbox from the gateway and compares its provider registrations and policy with those NemoClaw compiles for it; this covers NemoClaw's mapping, not OpenShell's isolation.
Each sandbox must have its own ID, with its agent bound to it, and keep that ID, the binding, and the agent's Fabric runtime ID through the second apply and the export's apply.
After the second apply, and again after the export's apply, the flow sends every agent one text prompt through Fabric's bridge, all at once, addressed to the runtime ID the first apply recorded.
Each agent must answer from that runtime, as that agent, with a succeeded run whose output holds the stub's value.
Each round ends after 30 seconds and abandons a request that has not answered; Fabric keeps running that request, so the export's round skips its agent, and destroy's stop of that agent waits for the request to end.
Fabric reports no runtime status, so a runtime that stops is found at its next invocation ([NVIDIA/NeMo-Fabric#420](https://github.com/NVIDIA/NeMo-Fabric/issues/420)); the answer shows that the runtime the first apply started still runs and that the agent's request reached the stub.
Destroy must then remove every `Sandbox` object within 60 seconds and keep the namespace, encryption key, and gateway PVC with unchanged UIDs; afterward the flow deletes the stub's namespace without waiting.
If an apply fails, the flow prints each pod's phase and container states, the last 40 lines of each container's log, and the namespace's 15 most recent events; if the stub is not ready or a request fails, it prints the same for the stub's namespace and the deployment's.
CI keeps that output in the suite's JUnit report for 14 days.
The OpenShift-profile test also supplies namespace UID-range annotations on kind and checks that the gateway pod and each sandbox's agent pod use the assigned UID.
Before deploying, it refuses a cluster that serves the `security.openshift.io` API group, where its annotations would replace the range that cluster assigns; on such a cluster, run the gateway test below with `NEMOCLAW_TEST_KUBE_RUNTIME=openshift`, which checks the gateway's pods and deploys no sandbox.
Its three agents share one gateway to keep the `live-kind` suite within its 270-second budget.
The registry test starts a pinned, authenticated registry on the run's kind network and uploads only the run's agent fixture there.
It checks anonymous and wrong-credential rejection, then deploys an agent with a caller-managed image pull Secret provisioned after namespace creation.
A new image-index digest prevents cached image metadata from bypassing the pull; the agent's layers and configuration remain unchanged.
Export must preserve the authored image and Secret references; OpenTofu state must hold no registry values, and destroy must retain the caller-managed Secret.
The fixture removes its registry afterward; HTTP configuration is confined to that registry on the disposable node.

The OIDC test, `kubernetes_live::oidc`, runs the SDK's development issuer image in a fresh `nc-issuer-*` namespace as a stand-in for an existing identity provider, and deletes that namespace when the test passes or panics, but not when nextest stops it at its time limit.
It deploys a gateway and sandbox from the agent image with the `oidc` authentication profile, supplying the issuer's token through `token.env`.
Apply must complete with the agent started and no development issuer in the deployment's namespace.
A plan with a token for another audience, signed with the same key, must be refused without echoing a token, and must leave `intent.json`, the OpenTofu state, and every file under `kubernetes/` in the state directory byte-identical.
The test then supplies only a second token, issued one second after the first, as a user does after a token expires.
With it, a plan must report no changes, export must reproduce the authored configuration, and destroy must keep the gateway's storage; if that destroy fails, the test destroys with the first token before failing.
No regular file in the state directory may contain any of the three tokens in its raw bytes; the search does not follow symbolic links or open saved plans, which are zip archives.

These live tests run no model and need no GPU or user registry credentials; the stub's fixed reply does not establish inference or model compatibility.
The render tests check the Kubernetes gateway UID, observed OpenShift UID and group, and image pull references in gateway/helper pods and sandbox-driver configuration.
Kind does not enforce OpenShift security context constraints; these checks do not establish OpenShift admission or platform compatibility.

The runner deletes its cluster and removes its built image tag after success or failure; pulled images and build caches remain.
Set `NEMOCLAW_KEEP_KIND_CLUSTER` to any value to retain the cluster on either outcome, then delete it with the printed kind command after inspection.
The gateway test's private state directory remains as described below, including when the runner deletes the cluster.

To render the pinned chart through the bundled provider without cluster access:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test --locked -p nemoclaw-e2e --test integration \
    kubernetes_chart::the_pinned_chart_renders_with_the_sdk_values -- --ignored --exact
```

The render test also rejects an unavailable chart digest.

To run only the gateway test, use an owned disposable cluster with the Kubernetes guide's [cluster setup](../kubernetes.md#prerequisites): Agent Sandbox and exactly one default StorageClass.
The host pulls the pinned chart from ghcr.io, and the cluster pulls the gateway image from ghcr.io and the development issuer image from Docker Hub.
Besides the [cluster access](../kubernetes.md#prerequisites) rights, the chart creates a ClusterRole and a ClusterRoleBinding, and the test deletes its namespace and can change the reclaim policy of the volumes bound to its PVCs, so use a cluster administrator's context.
Use a kubeconfig that holds its credentials, such as a client certificate or a token: the test runs OpenTofu with an empty `PATH` and an isolated home, so an exec plugin that relies on either fails.
On OpenShift Local, write the `system:admin` kubeconfig to a private file outside the checkout with `(umask 077 && crc generate-kubeconfig > /absolute/path/to/crc-kubeconfig)` and use its `admin` context.
Its client certificate is valid for ten years from the instance's first start, and deleting the copy does not revoke it; keep the file private and delete it once any cleanup below is done.
On OpenShift, set `NEMOCLAW_TEST_KUBE_RUNTIME=openshift` to deploy the gateway with `runtime.provider: openshift`; the default is `kubernetes`, and any other value fails the test.
Supply the cluster's kubeconfig and context, and a verified immutable bundle built from the checkout:

```sh
NEMOCLAW_TEST_KUBECONFIG=/absolute/path/to/owned-kubeconfig \
NEMOCLAW_TEST_KUBE_CONTEXT=kind-owned-test \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test --locked -p nemoclaw-e2e --test integration \
    kubernetes_live::the_gateway_installs_authenticates_and_is_removed_keeping_storage \
    -- --ignored --exact --nocapture
```

The test runs the compiled runtime and teardown graphs through the bundled OpenTofu and providers.
Each OpenTofu process has an empty `PATH` and an isolated home, so a host Helm executable cannot satisfy the test.
The test creates a fresh namespace, installs the gateway, requires an unchanged plan, verifies authenticated `GetGatewayInfo`, and rejects a forged token.
It removes and reinstalls the Helm release, then removes it again, checking that the namespace, encryption key, and PVC identities survive both removals.
With `NEMOCLAW_TEST_KUBE_RUNTIME=openshift`, after each installation it also requires every pod in the namespace to be admitted under the `restricted-v2` security context constraint, to run every container as the first UID of the range OpenShift assigned to the namespace, and to use the first group of the namespace's supplemental-group range as `fsGroup`.
Finally it switches each volume bound to its PVCs whose reclaim policy is not `Delete`, such as OpenShift Local's `Retain`, to `Delete`, and stops instead if that volume was not provisioned dynamically for its PVC.
It then deletes the namespace, which removes the encryption key and the PVCs, and requires the namespace and every volume bound to its PVCs to be gone within 2 minutes; the provisioner removes each volume only after deleting its storage.
It creates no agent sandbox and requests no inference.

The test prints the path to its private temporary state directory and retains it after success or failure.
That directory contains OpenTofu state, saved plans, the authored document, generated signing and TLS material, and private diagnostic output; keep it private and outside Git.
Raw OpenTofu output is suppressed from the test log because it can contain deployment values; each command's stdout and stderr remain in `diagnostics/` with mode `0600` on Unix.
After success, images the cluster pulled remain on its nodes; remove the printed state directory when finished.

If the test fails, its namespace, the volumes bound to its PVCs, and the chart's ClusterRole and ClusterRoleBinding, both named `<release>-node-reader-<namespace>`, can remain.
In the state directory, `kubernetes/receipt.json` gives the release as `name` and the namespace in the `Namespace` entry of `objects`; without the directory, find the namespace as `nc-live-` followed by 16 hexadecimal digits.
Inspect those resources, then delete the ClusterRole and ClusterRoleBinding:

```sh
jq -r '.name, (.objects[] | select(.kind == "Namespace") | .name)' /absolute/path/to/state/kubernetes/receipt.json
kubectl --kubeconfig /absolute/path/to/owned-kubeconfig --context kind-owned-test \
  delete --ignore-not-found \
  clusterrolebinding/RELEASE-node-reader-NAMESPACE clusterrole/RELEASE-node-reader-NAMESPACE
```

Then remove the namespace with the Kubernetes steps of [Remove Retained Resources](../usage.md#remove-retained-resources).
Skip that procedure's destroy check and its requirement that no pods remain: `nemoclaw` cannot use the test's state directory, and the test's gateway can still be running.
Under `Retain`, the volumes that procedure lists remain `Released` after the namespace goes; set each one's reclaim policy to `Delete`, as the test does, so that the provisioner deletes the volume and its storage:

```sh
kubectl --kubeconfig /absolute/path/to/owned-kubeconfig --context kind-owned-test \
  patch persistentvolume VOLUME_NAME --type merge \
  --patch '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'
```

Rerun `kubectl get persistentvolume VOLUME_NAME` with the same kubeconfig and context until it reports that the volume is not found.

## Dependency Upgrade Test

Before accepting an OpenShell or Fabric/image upgrade, use the small `dependency_upgrade_survives_apply_process_exit` test.
It requires one agent and one already-running external inference provider; it rejects managed inference services.
Supply a JSON input accepted by the selected Fabric adapter through `NEMOCLAW_UPGRADE_INPUT`.
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
NEMOCLAW_UPGRADE_INPUT=/absolute/path/to/adapter-input.json \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/candidate-bundle \
  cargo test -p nemoclaw-e2e --test integration \
    fabric_live::dependency_upgrade_survives_apply_process_exit -- --ignored --test-threads=1
```

The test waits for the apply CLI to exit, then invokes the hosted Fabric runtime through OpenShell.
It requires a successful Fabric result without assuming an adapter-specific output shape or qualifying response quality.
It checks export/reapply and stable resource/runtime identities before destroying its owned workloads and registrations.
It retains the workspace and persistent storage; failures retain state and resources for diagnosis and explicit cleanup.
CLI failures appear in the test output.
It never starts inference or substitutes another agent process through exec.

If this test fails, passing lower-level fixture tests does not establish compatibility.
Run it explicitly for candidate dependency upgrades, outside the default build; `CI / Bundle` retains the fast descriptor, reference, and protocol tests.

## Retained Storage Observations

The read-only live storage test requires an explicit OpenTofu state file containing the test deployment's retained inference credential-volume binding from an authenticated vLLM service:

```sh
NEMOCLAW_TEST_RUNTIME_STATE=/absolute/path/to/deployment-state/terraform.tfstate \
  cargo test -p nemoclaw-sdk --test integration \
  managed_live::retained_inference_credentials_preserve_their_reference_binding -- --ignored
```

The separate `existing_spark_runtime_bindings_are_observed_without_mutations` test requires both gateway and inference container bindings to exist and `NEMOCLAW_TEST_RUNTIME_ENGINE` to select their Docker engine.
Neither read-only test creates resources or establishes live agent inference.

## Spark and Fabric

The Spark test reads a copy of `examples/spark/deepagents-team.yaml`, which serves Nemotron 3.5 Lightning through the generic vLLM image to two Deep Agents sandboxes, and asserts the public plan and apply results.
Use an available GB10 host, build the runtime and agent images, and set their immutable image references in the YAML.
Choose a fresh deployment UID, available gateway port and subnet, and a new state-directory path whose parent exists.
The test derives the expected resources from the YAML's provider and sandbox names.

From the repository root, with absolute paths:

```sh
NEMOCLAW_LIVE_SPARK_CONFIG=/absolute/path/to/deepagents-team.yaml \
NEMOCLAW_LIVE_SPARK_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test -p nemoclaw-e2e --test integration spark::spark_yaml_plans_and_applies_expected_resources -- --ignored
```

The first plan must create gateway and inference compute, retained storage, and the service image resource, deferring OpenShell registration until the gateway exists.
Apply must create those resources plus the provider profile, provider registration, sandbox, and workspace.
A second plan and apply must report no changes.
The test checks readiness without requesting a model response and leaves workloads running.
It writes no separate test report.
After failure, retain state for [explicit recovery](../usage.md#updates-and-recovery); use [destroy](../usage.md#destroy) when finished.

Run `spark_image_change_plans_and_applies_replacement` separately with the same three variables and an established, running deployment.
Change only the inference image pin in the YAML.
The test compares the input with exported configuration, then requires plan and apply to replace the service's `docker_container.inference_service_inference_<service>` and reconcile its image resource while retaining storage.
Storage retention and watchdog recovery have separate tests under [runtime boundaries](integration-tests.md#runtime-boundaries) and [generic models](#generic-models).

Use an immutable bundle copy for a long live run.
Rebuilding `dist` replaces development artifacts; keep the selected bundle unchanged until the operation ends.

The optional `fabric_live` test accepts absolute `NEMOCLAW_LIVE_FABRIC_CONFIG`, `NEMOCLAW_LIVE_FABRIC_STATE`, `NEMOCLAW_LIVE_FABRIC_INPUT`, and `NEMOCLAW_TEST_BUNDLE` paths.
The input file contains JSON accepted by the selected Fabric adapter.
Use a dedicated UID and state directory with an external gateway and inference endpoint.
It applies the deployment, checks unchanged apply and export/reapply, explicitly invokes the hosted Fabric runtime, and destroys its owned registrations and sandbox.
The hosted Fabric runtime must keep its identity throughout invocation and reapply.
This test makes a real model request and reports assertion failures through the test runner.
The workspace remains after destroy.

## Bare Brev

The `Live / Brev` workflow provisions an ordinary Brev CPU VM rather than a NemoClaw Launchable.
Three jobs build the Linux AMD64 bundle and test binary, build the matching OpenClaw image, and provision the VM in parallel.
Image transfer starts as soon as the image and VM are ready, overlapping any remaining bundle build.
The image-loading job verifies the archive checksum and source revision, and requires Docker to retain the built image digest after loading.
The lifecycle job waits for the bundle and loaded image, then transfers the bundle and runs the real inference and deployment checks on the fresh VM.
Image compilation happens on the CI runner.
A separate cleanup job runs after success, failure, or cancellation and requires two confirmed observations that its owned VM is absent.
The check list shows bundle build, image build, preparation, image loading, lifecycle, and deletion times separately; VM deletion remains part of successful qualification.
The workflow requires repository secrets named `BREV_API_KEY` and `NVIDIA_API_KEY`.
While `v1` is not the repository's default branch, run it by pushing the candidate to an intentionally named `run-brev-v1-e2e/*` branch in `NVIDIA/NemoClaw`.
After the workflow file reaches the default branch, select `v1` with `workflow_dispatch` instead.

The reviewed Brev startup script installs the required host packages, enables Docker, and waits on a readiness sentinel before candidate transfer.
The VM must be AMD64, expose a working Docker daemon with Buildx and a Landlock kernel ABI, and have at least 80 GiB free during the initial fresh-host check.
The test refuses a host with a detected NemoClaw or OpenShell deployment.
It uses the hosted NVIDIA OpenClaw fixture as the initial v1 configuration, replacing only its deployment UID and agent-image digest for the owned run.

The test proves that plan leaves the Docker inventory unchanged, waits for the apply CLI process to exit, and then requires an exact agent reply through the hosted runtime.
It checks unchanged apply, export/reapply, stable resource and Fabric runtime identities, denied undeclared egress, and preservation of an owned workspace file.
Destroy must remove the provider, profile, sandbox, and managed gateway while retaining the documented workspace and gateway storage.
The workflow uploads a sanitized Boolean proof and verifies that the Brev VM is absent before completing.
Failures still request VM deletion; no keep-alive option is provided.
If cleanup fails, rerun the original `Delete VM` job until deletion is verified.
After successful cleanup, rerun all jobs for fresh qualification; rerunning only lifecycle qualification cannot reuse the deleted VM.
Artifact and VM identities come from their producing jobs, including the original attempt when dependent jobs are retried.
Intermediate artifacts contain the candidate bundle, test executable, and image archive with its revision and digest manifest; no credentials are included.
These artifacts expire after one day; images are not published to a registry.
Qualification transfers the inference credential through a private temporary file; the runner copy is removed after transfer, and the VM copy disappears with verified VM deletion.

Run the Rust test directly only on a fresh owned Linux AMD64 host with the same prerequisites:

```sh
NEMOCLAW_LIVE_BREV_CONFIG=/absolute/path/to/owned-config.yaml \
NEMOCLAW_LIVE_BREV_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/linux-amd64-bundle \
NVIDIA_INFERENCE_API_KEY=... \
  cargo test -p nemoclaw-e2e --test brev \
    bare_brev_hosted_openclaw_lifecycle -- --ignored --exact --nocapture
```

The direct command destroys NemoClaw workloads but leaves retained deployment storage and does not dispose of its host.
The workflow owns and disposes of the Brev VM around that test.

## Generic Models

The generic model lifecycle has a separate opt-in live test.
Supply a fresh, owned OpenClaw or Hermes deployment configuration with a free gateway port and subnet, its state directory, and an immutable bundle:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_LIVE_MODEL_CONFIG=/absolute/path/to/vllm.yaml \
NEMOCLAW_LIVE_MODEL_STATE=/absolute/path/to/state \
  cargo test -p nemoclaw-e2e --test integration \
    model_live::selected_model_apply_export_and_watchdog_recovery -- --ignored --nocapture
```

It checks initial apply, unchanged apply, export and reapply, absence of PLE preparation, and an operator-triggered watchdog stop.
It sends no agent requests; use the [Fabric test](#spark-and-fabric) for explicit invocation.
Explicit recovery must preserve durable storage bindings and the model manifest; the Docker provider may replace inference compute.
Successful completion destroys workloads and retains storage.
Assertions report failures through the test runner; the test writes no separate report.

Failures retain resources for diagnosis; recover the deployment using the same configuration and state directory before starting another run.
Retained gateway storage includes its network, so a different deployment needs a different subnet.

For an established deployment whose gateway is running, select `selected_model_continues_from_retained_state` with the same environment variables.
It runs the same lifecycle assertions without the fresh-plan assertion.
Run only one of these live tests against a given deployment at a time.

After intentional destroy, apply the retained configuration first.
A read-only plan cannot observe workspace resources until apply has restored the gateway.

## Hosted NVIDIA Parity

The hosted parity tests compare a reviewed, redacted v0 configuration export with separately authored v1 YAML, then run a new v1 deployment with NVIDIA hosted inference.
They implement [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810) for OpenClaw and [issue #12019](https://github.com/NVIDIA/NemoClaw/issues/12019) for Hermes.
They do not run, patch, adopt, or migrate a v0 deployment, its workspace, conversations, credentials, or runtime state, and the SDK has no v0 translator.
The Hermes test does not qualify Relay, Switchyard, messaging, local inference, or custom images.

Each fixture under `crates/nemoclaw-e2e/fixtures/` holds the raw export (`v0-export.yaml`), the reauthored current document (`v1.yaml`), and a `NOTICE.md` recording the producer revision and handling.
The historical exports use an `agents` list; current v1 accepts one `agent` per sandbox.
Only inside the test, the comparison replaces the single-entry list with `agent` and requires the result to equal the ordinarily parsed v1 document; any change to identity, inference, policy, or other portable intent fails.
Only the authored v1 document drives deployment.
To refresh a fixture, run the public v0 `nemoclaw config export` against a representative deployment, check the output for credential values, copy the redacted bytes without reshaping them, and update `v1.yaml` in the same change.

Run the comparisons without Docker or a credential:

```sh
cargo test -p nemoclaw-e2e --test integration hosted_parity::
```

The live tests then check the public deployment operations:

| Test | Checks |
|---|---|
| `authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle` | Plan creates gateway storage and the gateway with OpenShell registration deferred; apply adds the provider profile and registration, sandbox, and workspace; a second plan, and export/reapply, report no changes; destroy removes the workloads and retains the workspace and gateway storage. It requests no model response; use the [native agent procedure](../agents.md#run-one-headless-openclaw-request) to verify a reply. |
| `authored_v1_intent_preserves_v0_export_through_hosted_hermes_lifecycle` | Apply reaches readiness; a real Hermes request through NVIDIA hosted inference must return `FOUR`; unchanged plan, apply, and export/reapply keep resource identities; destroy retains the workspace and gateway storage. |

Use an owned native Linux Docker daemon, a fresh deployment UID, an available gateway port and subnet, and an unused state-directory path whose parent exists.
Supply `NVIDIA_INFERENCE_API_KEY` through the process environment; never put its value in YAML, arguments, state, or repository files.
The test installs that credential in OpenShell and does not revoke the upstream key.
Keep the fixture's provider, sandbox, and agent names; the expected results name those resources.
Build a matching bundle and load the gateway image pinned in [versions.json](../../versions.json) and the YAML's immutable agent images, including the Hermes image for the Hermes test, into the selected daemon.
A GPU is not required.

From the repository root, with absolute paths and one test selected:

```sh
NEMOCLAW_LIVE_V0_EXPORT=/absolute/private/path/v0-export.yaml \
NEMOCLAW_LIVE_V1_CONFIG=/absolute/private/path/authored-v1.yaml \
NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle \
  cargo test -p nemoclaw-e2e --test integration \
  hosted_parity::live::authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle \
  -- --ignored
```

The test creates the state directory and rejects an existing path; assertion failures appear in the test output.
Do not run live tests as an ignored-test aggregate.
After a failed apply, keep both inputs, the bundle, and the state directory, and follow [interrupted-operation recovery](../usage.md#recover-an-interrupted-operation) with the same YAML and state; do not create another state directory for the same UID.
Use [destroy](../usage.md#destroy) to remove a failed run's workloads; a successful run destroys them itself.
Retire the upstream NVIDIA key separately when it is no longer needed.

## SSH Engine Transport

The SDK's `ssh_live` tests are opt-in.
Set `NEMOCLAW_TEST_SSH_ENGINE` to an explicit SSH URL and `NEMOCLAW_TEST_ENGINE_ID` to an independently observed daemon ID, then run `cargo test -p nemoclaw-sdk --test integration ssh_live::ssh_observes -- --ignored`.
Run `ssh_failure` separately against rejected authentication, an untrusted host key, or an unavailable endpoint; it must report observation failure, not absence.

The `ssh_upload` test additionally requires `NEMOCLAW_TEST_SSH_CONTAINER`, the full ID of a stopped container labeled `nemoclaw.experiment=ssh-transport`.
It writes `/tmp/ssh-transfer-test` and checks the streamed archive and unchanged identity.
The caller owns fixture setup and cleanup; never target an unrelated container.

The SDK `ssh_capacity` live test exercises the fixed collector on an explicitly selected Linux ARM64 or AMD64 NVIDIA host without provisioning resources.
It checks that the collected architecture matches the selected Docker daemon's reported architecture.

The `fabric_live` test requires external inference and does not install managed SSH inference services.
It invokes the hosted runtime separately from apply with caller-supplied input.
The test checks managed runtime bindings as well as the hosted agent identity across export/reapply and destroys only the supplied deployment.


## Docker Live Suite

`cargo ci live-docker` builds the images and writes the owned inputs for the Docker provider, standalone cache, dummy agent, and Docker gateway tests below, then runs them; see [Run each layer](testing.md#run-each-layer).
To run one of them by hand, supply its inputs as its section describes.

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

The [hand-written HCL](../../crates/nemoclaw-e2e/tests/fixtures/cache_provider.tf) composes `docker_volume`, `docker_container`, and `vllm_credential_storage`; no SDK compiler or deployment coordinator runs.
The fixture creates fresh owned resources, checks no-op, replacement, failed-start recovery, retained teardown/reapply, and cache reconstruction with the same credential.
Missing or substituted credential volumes must stop apply before compute creation and preserve state.
Teardown sets the container count to zero while keeping both volume declarations; `tofu destroy` is deliberately blocked by their retention rules.
The test removes only its labelled resources afterward and retains logs and state under its printed temporary path for diagnosis.
The container's Python process simulates model reconstruction and a credential; it does not qualify the vLLM supervisor, GPU execution, model preparation, inference, or OpenShell deployment.


## Dummy Agent Lifecycle

nemoclaw-e2e's `dummy_agent::the_dummy_agent_completes_a_managed_docker_lifecycle` test deploys the [reference dummy image](../build.md#reference-contract-image) through a managed Docker gateway.
The dummy runs Fabric's real `fabric-agent-ctl` with NemoClaw's test adapter, so it needs no model or credentials.
The test checks plan, a successful bundled-CLI apply, an invocation that returns the configured `reply` setting, unchanged apply that keeps the same runtime, export/reapply, and destroy, after which Docker holds no sandbox containers or volumes but still holds the gateway's storage.
It requests no inference and does not qualify a production adapter.

Supply a verified bundle and an owned document like the gateway tests', with a fresh UID, free gateway port and subnet, the local dummy image by digest, `harness.kind: org.nemoclaw.dummy`, and a `harness.settings.reply` string:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_DUMMY_DOCUMENT=/absolute/path/to/dummy.yaml \
cargo test -p nemoclaw-e2e --test integration \
  dummy_agent::the_dummy_agent_completes_a_managed_docker_lifecycle -- --ignored --exact
```

A successful run deletes its temporary state directory and retains the gateway's storage, initializer, and bridge.
A failed run keeps the state directory and prints its path, because the gateway and sandbox may still be running; remove them with the bundle's `nemoclaw destroy --state-dir PATH`.
`cargo ci live-docker` removes every resource labeled with the document's UID, and the gateway's sandbox objects, after the suite.
To remove the retained storage after a manual run, follow [Remove Retained Resources](../usage.md#remove-retained-resources); after a successful run there is no state directory, so skip that procedure's destroy check.

## Docker Gateway Recovery

nemoclaw-e2e's `managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu` test exercises only the managed gateway's runtime resources with a real gateway, Docker, both providers, and OpenTofu.
It plans and applies them through the SDK's `test-scenarios` setup, which only nemoclaw-e2e enables, then destroys through the public API.
Supply a verified bundle and an owned configuration with a fresh UID, free gateway port/subnet, Docker sandboxes, external inference, and no managed services.
The test does not create sandboxes or request inference.
It removes its gateway process on completion but retains the database, keys, initializer, bridge, and state.
Remove them with [Remove Retained Resources](../usage.md#remove-retained-resources), using the test bundle's `nemoclaw` and `NEMOCLAW_TEST_GATEWAY_STATE` as the state directory.

From the repository root:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_GATEWAY_DOCUMENT=/absolute/path/to/gateway.yaml \
NEMOCLAW_TEST_GATEWAY_STATE=/absolute/path/to/new-state \
cargo test -p nemoclaw-e2e --test integration \
  managed_gateway::managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu \
  -- --ignored --exact
```

The test checks read-only planning, unchanged apply, stopped/deleted process recovery, retained credential identity, and destroy/reapply.
It also replaces the listen port inside the runtime-stage test and temporarily substitutes the owned encryption key to verify rejection without state changes, then restores the original key.
That internal replacement test does not authorize retargeting an established public deployment endpoint; the SDK still rejects that operation.
The gateway image remains pinned by the SDK.

## Docker Gateway Isolation

The provider's `pinned_docker_gateways_reach_ready_without_interfering_with_other_sandboxes` test runs two managed Docker gateways against the SDK's pinned OpenShell images on a native Linux host.
Prepare two owned deployment documents with distinct fresh UUIDs, unused loopback ports, and unused private `/24` subnets on the same local Docker engine.
Both documents must select managed gateways, Docker sandboxes, external inference, and no managed services.
The test refuses existing gateway containers, initializers, volumes, or networks at either identity.

The engine must already contain the gateway, supervisor, and sandbox runtime images from [versions.json](../../versions.json), plus the immutable sandbox image selected below.
That sandbox image must provide `/bin/sh`, `/bin/sleep`, and `/bin/cat`, and permit a file under `/tmp` through OpenShell's default policy.
The test uses the documents' gateway settings and creates its own `isolation-check` sandbox in each gateway's default workspace.
It attaches no inference providers and requests no model response.

Successful completion removes both owned sandboxes and gateway processes, but retains gateway storage, including signing and encryption keys, plus its initializer and bridge.
The test calls the provider and SDK directly and creates no OpenTofu state directory.
Keep the input documents to identify the retained resources.
Another run requires fresh deployment UUIDs, ports, and subnets; the test refuses the previous run's retained resources.
After a successful run, remove each document's `gateway storage` objects with [Remove Retained Resources](../usage.md#remove-retained-resources), using its UID; the test has no state directory, so skip the steps that use one.

From the repository root, with absolute document paths and the local sandbox image's actual digest:

```sh
NEMOCLAW_TEST_GATEWAY_DOCUMENT=/absolute/path/to/first-owned-deployment.yaml \
NEMOCLAW_TEST_SECOND_GATEWAY_DOCUMENT=/absolute/path/to/second-owned-deployment.yaml \
NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE=repository@sha256:REPLACE_WITH_LOCAL_IMAGE_DIGEST \
  cargo test -p nemoclaw-provider --test integration \
    managed_gateway_live::pinned_docker_gateways_reach_ready_without_interfering_with_other_sandboxes -- --ignored --exact --nocapture
```

Both sandboxes must reach Ready and execute commands through the real supervisor callback.
Starting and restarting the second gateway must preserve the first sandbox's identity, readiness, and test file.
Failures also retain resources for diagnosis; the test prints the owned gateway names and endpoints.
Inspect those resources with the original documents before choosing cleanup or a separate fresh run; rerunning the same inputs is refused.
Use the separate [gateway recovery test](#docker-gateway-recovery) to qualify the bundled OpenTofu path.
This test does not qualify imported provider profiles, Fabric readiness, or agent replies.

## Provider Profile Revisions

The provider's `profile_revision::imported_profile_revisions_survive_repeated_reads_and_gateway_restart` test requires one fresh owned managed Docker deployment document and the pinned local images described under [gateway isolation](#docker-gateway-isolation).
Use a sandbox image that also provides `/usr/local/bin/python3` and `/usr/local/bin/node`, which the imported inference profiles authorize.
The test creates its own workspace, five provider profiles and registrations, and a `/bin/sleep` sandbox.
It covers authenticated OpenAI and Anthropic profiles, an unauthenticated OpenAI profile, and Brave and Tavily search profiles.

The test uses synthetic credentials held in memory and registered with its gateway; it makes no inference or search requests.
To read the sandbox-only provider environment RPC, it reads that sandbox's issued token from its own gateway container into memory without logging or writing a copy.
A successful run deletes the sandbox, provider registrations, profiles, and gateway process, retaining the workspace, gateway storage, initializer, and bridge.
Retained gateway storage contains signing and encryption keys.
The test creates no OpenTofu state; keep the input document to identify its resources, and use fresh inputs for another run.
Failures retain resources for diagnosis; inspect only the printed owned gateway and its sandbox before cleanup.
After a successful run, remove the document's `gateway storage` objects with [Remove Retained Resources](../usage.md#remove-retained-resources), using its UID; the test has no state directory, so skip the steps that use one.

From the repository root, with an absolute document path and the local sandbox image's actual digest:

```sh
NEMOCLAW_TEST_GATEWAY_DOCUMENT=/absolute/path/to/owned-deployment.yaml \
NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE=repository@sha256:REPLACE_WITH_LOCAL_IMAGE_DIGEST \
  cargo test -p nemoclaw-provider --test integration \
    managed_gateway_live::profile_revision::imported_profile_revisions_survive_repeated_reads_and_gateway_restart -- --ignored --exact --nocapture
```

The sandbox must reach Ready with all five providers attached.
All 64 environment reads before restart and all 64 afterward must return the same revision.
Unchanged profile reconciliation must preserve identities, and the sandbox must retain its identity and Ready phase after the gateway restarts.
This test qualifies profile stability and observation against the pinned gateway; it does not run a Fabric adapter or request an agent reply.
