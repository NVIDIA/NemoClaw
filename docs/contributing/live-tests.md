<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Live Tests

Live tests require explicit configuration and must touch only resources owned by the test.
Use a dedicated deployment UID, state directory, and immutable bundle.
Read each test’s lifecycle effects before running it.

Do not run all ignored tests against a shared deployment.

## Kubernetes Gateway Without the Helm CLI

On native Linux with Docker Buildx and the [containerd image store](../build.md#build-agent-images), run both Kubernetes tests on a fresh kind cluster:

```sh
cargo ci build
cargo ci bundle
cargo ci live-kind
```

The runner builds Pi on ARM64 or OpenClaw on AMD64, exports its metadata bundle, loads it by digest, and installs the pinned Agent Sandbox prerequisite.
The gateway test checks authentication, forged-token rejection, repeated install/removal, and retained storage without a Helm executable on `PATH`.
The agent test uses the public SDK to deploy a gateway and sandbox from that image.
It expects apply to fail only at `data.nemoclaw_sandbox_readiness.assistant`, because the pinned Fabric reports agent health as unsupported ([#12443](https://github.com/NVIDIA/NemoClaw/issues/12443)); destroy then retains gateway storage.
Neither test requests inference or needs a GPU or credentials.

The runner deletes its cluster and removes its built image tag after success or failure; pulled images and build caches remain.
Set `NEMOCLAW_KEEP_KIND_CLUSTER=1` to retain the cluster on either outcome, then delete it with the printed kind command after inspection.
The gateway test's private state directory remains as described below, including when the runner deletes the cluster.

To render the pinned chart through the bundled provider without cluster access:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test --locked -p nemoclaw-sdk --test integration \
    kubernetes_gateway::the_pinned_chart_renders_with_the_sdk_values -- --ignored --exact
```

The render test also rejects an unavailable chart digest.

To run only the gateway test, use an owned disposable cluster with Agent Sandbox installed and exactly one default StorageClass.
Supply its explicit kubeconfig and context, and a verified immutable bundle built from the checkout:

```sh
NEMOCLAW_TEST_KUBECONFIG=/absolute/path/to/owned-kubeconfig \
NEMOCLAW_TEST_KUBE_CONTEXT=kind-owned-test \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test --locked -p nemoclaw-sdk --test integration \
    kubernetes_live::the_gateway_installs_authenticates_and_is_removed_keeping_storage \
    -- --ignored --exact --nocapture
```

The test runs the compiled runtime and teardown graphs through the bundled OpenTofu and providers.
Each OpenTofu process has an empty `PATH` and an isolated home, so a host Helm executable cannot satisfy the test.
The test creates a fresh namespace, installs the gateway, requires an unchanged plan, verifies authenticated `GetGatewayInfo`, and rejects a forged token.
It removes and reinstalls the native Helm release, then removes it again, checking that the namespace, encryption key, and PVC identities survive both removals.
It creates no agent sandbox and requests no inference.

The test prints the path to its private temporary state directory and retains it after success or failure.
That directory contains OpenTofu state, saved plans, the authored document, generated signing and TLS material, and private diagnostic output; keep it private and outside Git.
Raw OpenTofu output is suppressed from the test log because it can contain deployment values; each command's stdout and stderr remain in `diagnostics/` with mode `0600` on Unix.
Successful completion retains cluster storage; dispose of the owned test cluster and then remove the printed state directory when finished.
If the test fails, keep the same state and inspect its owned resources before cleanup.

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

The test waits for the real apply CLI to exit, then explicitly invokes the hosted Fabric runtime through OpenShell.
It requires a successful Fabric result without assuming an adapter-specific output shape or qualifying response quality.
It checks export/reapply and stable resource/runtime identities before destroying its owned workloads and registrations.
It retains the workspace and persistent storage; failures retain state and resources for diagnosis and explicit cleanup.
CLI failures appear in the test output.
It never starts inference or substitutes another agent process through exec.

If this test fails, passing lower-level fixture tests does not establish compatibility.
Run it explicitly for candidate dependency upgrades, outside the default build; ordinary CI retains the fast descriptor, reference, and protocol tests.

## Retained Storage Observations

The read-only live storage test requires an explicit OpenTofu runtime state file containing the test deployment's retained inference credential-volume binding from an authenticated vLLM service:

```sh
NEMOCLAW_TEST_RUNTIME_STATE=/absolute/path/to/runtime/terraform.tfstate \
  cargo test -p nemoclaw-sdk --test integration \
  managed_live::retained_inference_credentials_preserve_their_reference_binding -- --ignored
```

The separate `existing_spark_runtime_bindings_are_observed_without_mutations` test requires both gateway and inference container bindings to exist and `NEMOCLAW_TEST_RUNTIME_ENGINE` to select their Docker engine.
Neither read-only test creates resources or establishes live agent inference.

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
The test compares the input with exported configuration, then requires plan and apply to replace `docker_container.inference_service_inference_qwen` and reconcile its image resource while retaining storage.
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

The test proves that plan leaves the Docker inventory unchanged, waits for the real apply CLI process to exit, and then requires an exact agent reply through the hosted runtime.
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

Run the deterministic comparisons without Docker or a credential:

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
Build a matching bundle and load the YAML's immutable gateway and agent images, including the Hermes image for the Hermes test, into the selected daemon.
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


## Docker Gateway Recovery

The SDK's `managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu` test exercises only the managed runtime stage with a real gateway, Docker, both providers, and OpenTofu.
Supply a verified bundle and an owned configuration with a fresh UID, free gateway port/subnet, Docker sandboxes, external inference, and no managed services.
The test does not create sandboxes or request inference.
It removes its gateway process on completion but retains the database, keys, initializer, bridge, and state.

From the repository root:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_TEST_GATEWAY_DOCUMENT=/absolute/path/to/gateway.yaml \
NEMOCLAW_TEST_GATEWAY_STATE=/absolute/path/to/new-state \
cargo test -p nemoclaw-sdk \
  managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu \
  --lib -- --ignored
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
There is no verified cleanup procedure yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).

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
A cleanup procedure for retained storage is tracked in [#12640](https://github.com/NVIDIA/NemoClaw/issues/12640).

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
