<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Live Tests

Live tests require explicit configuration and must touch only resources owned by the test.
Use a dedicated deployment UID, state directory, and immutable bundle.
Read each test’s lifecycle effects before running it.

Do not run all ignored tests against a shared deployment.

## Kubernetes Gateway Without the Helm CLI

On native Linux with Docker Buildx and the [containerd image store](../../docs/build-deploy/build.md#build-agent-images), run the live tests with a fresh kind cluster:

```sh
cargo ci build
cargo ci bundle
cargo ci live-kind
```

The runner builds OpenClaw, exports its metadata bundle, loads it by digest, and installs the pinned Agent Sandbox prerequisite.
It then runs two [HCL E2E scenarios](#hcl-e2e-scenarios), one after the other, each in new namespaces.

The `kind-kubernetes-development` scenario deploys one agent with the defaults: the `kubernetes` runtime profile and the `development` authentication profile, whose tokens the SDK issues.
Its CLI runs with an empty `PATH`, so no Helm executable can stand in for the bundled Helm provider.
The agent must answer from its recorded runtime with the stub's reply.
Its sandbox has an explicit policy, as the [GTC DC Kubernetes example](../../examples/kubernetes/hosted-nvidia.yaml) has, with one entry that gives `python3` the stub's `/health`; the managed inference grant gives the image's executables only the stub's `/v1/**` paths.
The `tests/e2e/hcl/command` module then runs `python3` twice in the sandbox: a request to the stub's `/health` must get the stub's 404, where OpenShell's proxy would answer 403 without the entry, and a connection to the API server's Service at `10.96.0.1`, the first address of kind's Service network, must fail with `EACCES`, OpenShell's refusal, because no entry names it.
The address is literal, so DNS can't cause the refusal.
Destroy must then keep only the gateway's storage.
Next, a `ValidatingAdmissionPolicy` that the `hcl_live::admission` probe creates refuses StatefulSets in the deployment's namespace, so an apply fails after Helm stored the gateway release.
That apply must fail with the refusal, and once the probe removes the policy, no record of the release may remain and the state must not bind it (#14155).
Another apply must then reuse that storage, refreshing rather than creating it again, so the namespace, encryption key, and claims kept their identity, and the agent must answer again.
The runner deletes the cluster with the redeployed deployment.
That a gateway trusts only the deployment's own issuer is a [contract check](integration-tests.md#openshell-provider-contract) of the rendered chart.

The `kind-kubernetes-oidc` scenario deploys two agents, `assistant` and `researcher`, in a namespace that carries OpenShift's UID range, each sandbox granting one endpoint named for it so that no two have the same policy.
It deploys with `kubernetes`, because kind can't run a managed `openshift` gateway: that gateway leaves its `fsGroup` for OpenShift to assign, and without one it can't read its signing key.
The `openshift-oidc` scenario deploys the same agents with `openshift` on [OpenShift](#openshift-gateway).
Before the scenario, `cargo ci live-kind` starts a pinned registry that requires a login on the run's kind network and pushes the agent image there under a new image-index digest.
The node may pull from that registry over HTTP, and its configuration for it holds no credentials, so a pod can pull the image only with a pull Secret.
The new digest makes the node fetch the index from the registry, although the node already has the image's layers.
Before its first apply, the `tests/e2e/hcl/kind` module releases a chart twice with the bundled Helm provider, as a platform and an operator would prepare the cluster: once for the namespaces, the pull Secret, and the CA, and once for the stub model and the issuer, whose release waits until both are ready:

- The deployment's namespace, which holds the registry's image pull Secret. For `kind-kubernetes-oidc`, it also has the UID-range annotations its test file supplies, as OpenShift prepares a project, and holds the CA of the existing issuer.
- A stub model server in its own namespace: the pinned `nginx-unprivileged` image that the development issuer runs, behind a Service named `model` on port 8000. It answers every `POST /v1/chat/completions` with the same streamed chat completion. The inference profile names that Service by its cluster DNS name, without a key, as [Use a Model Server in the Cluster](../../docs/build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) describes.
- For `kind-kubernetes-oidc`, an existing OIDC issuer in its own namespace: the SDK's development issuer objects, without the NetworkPolicy that admits only a gateway in the issuer's namespace.

`hcl_live::issuer` creates the issuer's key material and one token for the case's audience, which is the deployment UID; OpenTofu cannot sign a token.
The token stays in a private credentials file in the run's `work` directory, which the `cli` and `verifier` modules export as the case's `token.env` variable.
The gateway uses the `oidc` authentication profile, so the apply and the replies show that it accepts the issuer's tokens and that each sandbox pulled its image with the pull Secret.
Each agent must answer from its recorded runtime with the stub's reply, a plan must report no changes, and destroy must keep only the gateway's storage.
The test runner then uninstalls both releases, which deletes their namespaces; it does not wait for Kubernetes to finish deleting them.
`cargo ci live-kind` binds each case in `cases/` to the cluster's context, a fresh UID, gateway port, and namespace, and the image in the registry.
It passes the kubeconfig as `TF_VAR_kubeconfig` and the registry's fixture login as `TF_VAR_pull_credentials`.
The scenario does not check pod UIDs; kind does not enforce OpenShift security context constraints, and OpenShell runs each sandbox as the range's first UID.
The scenario annotates the namespace itself; don't run it on a cluster that serves the `security.openshift.io` API group, where that would replace the range the cluster assigns.
These live tests run no model and need no GPU or user registry credentials; the stub's fixed reply does not establish inference or model compatibility.

The runner deletes its cluster and registry and removes its built image tag after success or failure; pulled images and build caches remain.
Set `NEMOCLAW_KEEP_KIND_CLUSTER` to any value to retain the cluster and registry on either outcome, then delete the cluster with the printed kind command and the registry container with `docker rm --force --volumes` after inspection.

The `chart` [contract module](integration-tests.md#openshell-provider-contract) renders the pinned gateway chart with the SDK's values; it needs no cluster.

## OpenShift Gateway

No CI job has an OpenShift cluster, and kind can't stand in for one: a managed `openshift` gateway gets its `fsGroup` only from OpenShift.
The `openshift-oidc` scenario deploys the agents of `kind-kubernetes-oidc` with the `openshift` runtime profile, and runs by hand, for example on OpenShift Local.
OpenShift writes the namespace's UID range, so its test file supplies none, and `restricted-v2` admits the gateway as the range's first UID and group.
The gateway can read its signing key only with that group, so the apply and the replies show that OpenShift assigned it.

Prepare the cluster as its operator would:

- Agent Sandbox 1.0.3, from the manifest that `cargo ci live-kind` installs, and a default StorageClass.
- The agent image in a registry the nodes pull from, by digest, and its metadata bundle from `cargo images export-metadata`.
  For OpenShift's internal registry, copy the image through the registry's route into a namespace of its own, for example with `oc image mirror`, which keeps its digest, and bind `image-registry.openshift-image-registry.svc:5000/<namespace>/agent@<digest>`.
- A login that can pull the image, for `TF_VAR_pull_credentials`: for the internal registry, a cluster administrator's name and a token from `oc whoami -t`.

Bind a copy of `cases/openshift-oidc.yaml` to the run: a fresh `uid`, which is also the token audience; a free endpoint port; a new namespace, which also names the stub model's and the issuer's; the cluster's context; and the image.
Then run from `crates/nemoclaw-e2e`:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
NEMOCLAW_HCL_CASE=openshift-oidc \
NEMOCLAW_HCL_DOCUMENT=/absolute/path/to/bound.yaml \
NEMOCLAW_HCL_RUN=/absolute/path/to/new-run \
NEMOCLAW_TEST_KUBECONFIG=/absolute/path/to/kubeconfig \
NEMOCLAW_TEST_KUBE_CONTEXT=the-bound-context \
NEMOCLAW_TEST_AGENT_METADATA=/absolute/path/to/agent.metadata.json \
TF_VAR_kubeconfig=/absolute/path/to/kubeconfig \
TF_VAR_pull_credentials='{ username = "...", password = "..." }' \
  cargo test -p nemoclaw-e2e --test e2e hcl_live::case -- --exact --ignored --nocapture
```

Afterward, run `nemoclaw destroy --state-dir /absolute/path/to/new-run/deployment` with the same bundle, whether or not the scenario passed.
Destroy keeps the gateway's volume; with a `Retain` StorageClass, such as OpenShift Local's, delete its `Released` PersistentVolumes afterward.

## HCL E2E Scenarios

Each HCL E2E scenario deploys one document from `crates/nemoclaw-e2e/cases` and runs the matching `tests/e2e/hcl/tests/<case>.tftest.hcl` under the bundled OpenTofu `tofu test`.
`hcl_live::case` sets the run's context and starts `tofu test`; the run blocks own the sequence and the assertions.
When `tofu test` ends, `hcl_live::case` prints how long each run block took, and the cleanup that destroys their state, with the total; with `GITHUB_STEP_SUMMARY` set, it also appends the table to the job summary.
It reads the times from OpenTofu's debug log, which can hold deployment values: the test creates it owner-only in the run's `work` directory, never prints it, and deletes it once read, and reports run names and seconds only.
Run blocks call these modules:

| Module | What it does |
|---|---|
| `tests/e2e/hcl/cli` | Runs one bundled `nemoclaw` command, `plan`, `apply`, or `destroy`, and reports its exit status, error, and JSON result. |
| `tests/e2e/hcl/verifier` | Invokes agents through `hcl_live::probe` and reports targets without a reply, without an expected one-word answer, or from an unexpected runtime. |
| `tests/e2e/hcl/volume` | Before a Docker case's first apply, creates each named volume that its sandboxes mount, with the bundled Docker provider, as a platform provides one: with OpenShell's default approval labels for the deployment's workspace and its root owned by the given sandbox identity. NemoClaw's destroy leaves the volumes, and the test removes them when the case ends. |
| `tests/e2e/hcl/command` | Runs one fixed command per target in a named sandbox through `hcl_live::command`, with the pinned OpenShell CLI's `openshell sandbox exec`, or on a managed Kubernetes gateway with the gateway's exec through the SDK's port-forward, and reports targets whose command exits nonzero, or whose output lacks the expected text or contains the forbidden text. Reports hold only the exit status and whether the output matched; the output stays in the run's private `work` directory. |

| Case | Runner | Checks |
|---|---|---|
| `docker-openclaw-nvidia` | Live / HCL | OpenClaw on NVIDIA hosted inference; any reply. |
| `docker-openclaw-v0-parity` | Live / HCL and Live / Brev | The [hosted parity](#hosted-nvidia-parity) OpenClaw document; `FOUR`. |
| `docker-hermes-v0-parity` | Live / HCL | The hosted parity Hermes document; `FOUR`. |
| `docker-openclaw-vllm` | Live / HCL, NVIDIA GPU runner | OpenClaw on a [vLLM model](#generic-models) the deployment serves; any reply. |
| `docker-openclaw-vllm-shared` | Live / HCL, NVIDIA GPU runner | Two OpenClaw agents sharing one vLLM model with bearer authentication; any reply from each. |
| `docker-openclaw-hermes-ollama` | Live / HCL, NVIDIA GPU runner | OpenClaw on NVIDIA hosted inference, `FOUR`; Hermes on a managed Ollama model, any reply. |
| `docker-openclaw-hermes-interfaces` | `cargo ci live-docker` | OpenClaw's Control UI and Hermes's API server and dashboard through the reported forward and token, and OpenClaw's terminal UI through `openshell sandbox exec --tty`, on a stub model that requires the run's key; in each sandbox, a writable workspace and no model key in the environment; in Hermes's sandbox, a pseudo-terminal; in OpenClaw's sandbox, a granted endpoint reached and an undeclared host refused ([Agent Interfaces](#agent-interfaces)). |
| `docker-dummy` | `cargo ci live-docker` | The [dummy agent](#dummy-agent-lifecycle); its configured reply before and after a redeploy that reuses the gateway's storage, and a workspace file on a named volume that survives the destroy and redeploy. |
| `kind-kubernetes-development` | `cargo ci live-kind` | One agent with the default [kubernetes runtime and development authentication profiles on kind](#kubernetes-gateway-without-the-helm-cli), applied with no `PATH`; it answers with the stub's reply before and after a redeploy that reuses the gateway's storage, and its sandbox's explicit policy lets `python3` reach the stub's `/health` and refuses an undeclared in-cluster address. |
| `kind-kubernetes-oidc` | `cargo ci live-kind` | Two agents [on kind](#kubernetes-gateway-without-the-helm-cli) in a namespace with OpenShift's UID range, from a private registry's image, behind a gateway that accepts an existing OIDC issuer's tokens; each answers with the stub's reply. |
| `openshift-oidc` | By hand on OpenShift | The same two agents with the `openshift` runtime profile [on OpenShift](#openshift-gateway), whose `restricted-v2` constraint assigns the gateway its UID and `fsGroup`; each answers with the stub's reply. |

Every scenario checks the same successful path:

1. The bundled CLI applies the case.
2. After the apply process exits, the agent replies from its recorded runtime, with the expected answer when the case names one.
3. A second plan reports no changes.
4. Destroy succeeds and retains only the case's persistent storage.

Failure, recovery, drift, export, and reapply behavior belong to the [HCL integration tests](integration-tests.md), which run against fixtures.
The hosted cases make real hosted inference requests, which may incur charges.

The workflows destroy each deployment in a separate step after success, failure, or cancellation and upload outcome reports with the destroy receipt.
Requests, replies, command output, and credentials stay in the run's private `work` directory.
CI / Bundle runs the selected hosted cases from Linux AMD64's test archive, bundle, and live images, except on a fork's pull request, and adds the GPU cases through Live / HCL on `v1` pushes and manual runs; each case's document decides [where it runs](testing.md#live-suites), and the plan [selects the cases](testing.md#live-suites) a pull request affects. To run either set alone against a candidate, such as an OpenShell, Fabric, or agent image upgrade, dispatch Live / HCL, or run a case by hand as below.

To run a case by hand on Linux with Docker, load the candidate images, bind the case's image templates and `uid` as the `Live / HCL` workflow does, and run from `crates/nemoclaw-e2e`:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
NEMOCLAW_HCL_CASE=docker-openclaw-v0-parity \
NEMOCLAW_HCL_RUN=/absolute/path/to/new-run \
NVIDIA_INFERENCE_API_KEY=... \
  cargo test -p nemoclaw-e2e --test e2e hcl_live::case -- --exact --ignored --nocapture
```

Afterward, run `nemoclaw destroy --state-dir /absolute/path/to/new-run/deployment` with the same bundle, whether or not the scenario passed.

## Spark and Fabric

The `docker-openclaw-vllm-shared` [HCL E2E scenario](#hcl-e2e-scenarios) covers several sandboxes served by one local model on the `Live / HCL` NVIDIA GPU runner.
Spark hardware has no CI runner yet.

The SDK's `runtime_compile::an_image_pin_or_gateway_port_change_reaches_only_replaceable_processes` test owns what changing only a model's image pin reaches: its container and image, not its storage.
Storage retention and watchdog recovery have separate tests under [runtime boundaries](integration-tests.md#runtime-boundaries) and [generic models](#generic-models).

Use an immutable bundle copy for a long live run.
Rebuilding `dist` replaces development artifacts; keep the selected bundle unchanged until the operation ends.

## Bare Brev

The `Live / Brev` workflow provisions an ordinary Brev CPU VM rather than a NemoClaw Launchable.
Three jobs build the Linux AMD64 bundle and the `nemoclaw-e2e` `e2e` test executable, build the matching OpenClaw image, and provision the VM in parallel.
Image transfer starts as soon as the image and VM are ready, overlapping any remaining bundle build.
The image-loading job verifies the archive checksum and source revision, and requires Docker to retain the built image digest after loading.
The lifecycle job waits for the bundle and loaded image, then transfers the bundle and runs the `docker-openclaw-v0-parity` [HCL E2E scenario](#hcl-e2e-scenarios) on the fresh VM.
Image compilation happens on the CI runner.
A separate cleanup job runs after success, failure, or cancellation and requires two confirmed observations that its owned VM is absent.
The check list shows bundle build, image build, preparation, image loading, lifecycle, and deletion times separately; VM deletion remains part of successful qualification.
The workflow requires repository secrets named `BREV_API_KEY` and `NVIDIA_API_KEY`.
While `v1` is not the repository's default branch, run it by pushing the candidate to an intentionally named `run-brev-v1-e2e/*` branch in `NVIDIA/NemoClaw`.
After the workflow file reaches the default branch, select `v1` with `workflow_dispatch` instead.

The reviewed Brev startup script installs the required host packages, enables Docker, and waits on a readiness sentinel before candidate transfer.
The VM must be AMD64, expose a working Docker daemon with Buildx and a Landlock kernel ABI, and have at least 80 GiB free during the initial fresh-host check.
The preparation refuses a host with a detected NemoClaw or OpenShell deployment.
The lifecycle binds the case to the candidate image digest and a fresh deployment UID, runs the scenario, and then runs `nemoclaw destroy` whether or not the scenario passed.
The workflow uploads the scenario's outcome reports, the destroy receipt, and the fresh-host checks, and verifies that the Brev VM is absent before completing.
Failures still request VM deletion; no keep-alive option is provided.
If cleanup fails, rerun the original `Delete VM` job until deletion is verified.
After successful cleanup, rerun all jobs for fresh qualification; rerunning only lifecycle qualification cannot reuse the deleted VM.
Artifact and VM identities come from their producing jobs, including the original attempt when dependent jobs are retried.
Intermediate artifacts contain the candidate bundle, test executable, and image archive with its revision and digest manifest; no credentials are included.
These artifacts expire after one day; images are not published to a registry.
Qualification transfers the inference credential through a private temporary file; the runner copy is removed after transfer, and the VM copy disappears with verified VM deletion.

## Generic Models

The `docker-openclaw-vllm` [HCL E2E scenario](#hcl-e2e-scenarios) deploys a vLLM model service on the `Live / HCL` NVIDIA GPU runner.
The agent must reply from the local model, and destroy must retain only gateway storage and the model cache volume.
The vLLM runtime's supervisor, memory guard, and storage reuse have their own tests; see [Run integration tests](integration-tests.md).

Retained gateway storage includes its network, so a different deployment on the same host needs a different subnet.
After intentional destroy, apply the retained configuration first.
A read-only plan cannot observe workspace resources until apply has restored the gateway.

## Hosted NVIDIA Parity

The hosted parity tests compare a reviewed, redacted v0 configuration export with separately authored v1 YAML, which the `docker-openclaw-v0-parity` and `docker-hermes-v0-parity` [HCL E2E scenarios](#hcl-e2e-scenarios) deploy with NVIDIA hosted inference.
They implement [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810) for OpenClaw and [issue #12019](https://github.com/NVIDIA/NemoClaw/issues/12019) for Hermes.
They do not run, patch, adopt, or migrate a v0 deployment, its workspace, conversations, credentials, or runtime state, and the SDK has no v0 translator.
The Hermes scenario does not qualify Relay, Switchyard, messaging, local inference, or custom images.

Each fixture under `crates/nemoclaw-e2e/fixtures/` holds the raw export (`v0-export.yaml`) and a `NOTICE.md` recording the producer revision and handling; the reauthored current document is the matching case in `crates/nemoclaw-e2e/cases`.
The historical exports use an `agents` list; current v1 accepts one `agent` per sandbox.
Only inside the test, the comparison replaces the single-entry list with `agent` and requires the result to equal the ordinarily parsed v1 document; any change to identity, inference, policy, or other portable intent fails.
The export records no agent image; the comparison supplies the case's image template, which CI binds to its candidate image.
Only the authored v1 document drives deployment.
To refresh a fixture, run the public v0 `nemoclaw config export` against a representative deployment, check the output for credential values, copy the redacted bytes without reshaping them, and update the case in the same change.

Run the comparisons without Docker or a credential:

```sh
cargo test -p nemoclaw-e2e --test e2e hosted_parity::
```

The scenarios install `NVIDIA_INFERENCE_API_KEY` in OpenShell and do not revoke the upstream key; never put its value in YAML, arguments, state, or repository files.
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

## Docker Live Suite

`cargo ci live-docker` builds the images and writes the owned inputs for the dummy agent, agent interface, and Docker gateway tests below, then runs them; see [Run each layer](testing.md#run-each-layer).
To run one of them by hand, supply its inputs as its section describes.

## Dummy Agent Lifecycle

The `docker-dummy` [HCL E2E scenario](#hcl-e2e-scenarios) deploys an image derived from the [reference dummy image](agent-image-maintenance.md#qualify-the-reference-contract-image) through a managed Docker gateway.
The dummy runs Fabric's real `fabric-agent-ctl` with NemoClaw's test adapter, so it needs no model or credentials.
Its gateway allows driver configuration, and its sandbox mounts a named volume on `/sandbox/workspace`, as [Keep Agent Files on Mounted Volumes](../../docs/build-deploy/state.md#keep-agent-files-on-mounted-volumes) describes; the `tests/e2e/hcl/volume` module creates the volume before the first apply and gives it to the agent image's user, UID 10001.
The agent must reply with the configured `reply` setting, the `tests/e2e/hcl/command` module must write a marker file in the workspace as that user, a plan must report no changes, and destroy must keep only the gateway's storage.
A second apply must then reuse that storage, refreshing rather than creating it again, and run the gateway in a new container; the new sandbox must read the marker from the kept volume, and the agent must reply again before a final destroy.
It requests no inference and does not qualify a production adapter.

`cargo ci live-docker` binds `cases/docker-dummy.yaml` to a fresh UID, free gateway port and subnet, a volume name with the UID, and the derived image by digest, then runs `hcl_live::case` with `NEMOCLAW_HCL_DOCUMENT` naming the bound copy.
After the suite, it removes every resource labeled with the document's UID, which includes the volume, and the gateway's sandbox objects; when the tests pass, it fails if OpenShell left a sandbox object.
To run the scenario by hand, bind the template the same way and follow [HCL E2E Scenarios](#hcl-e2e-scenarios) with `NEMOCLAW_HCL_CASE=docker-dummy` and `NEMOCLAW_HCL_DOCUMENT=/absolute/path/to/bound.yaml`.

## Agent Interfaces

The `docker-openclaw-hermes-interfaces` [HCL E2E scenario](#hcl-e2e-scenarios) deploys OpenClaw's Control UI and Hermes's API server and dashboard through one managed Docker gateway, and reaches them as [Reach an Agent Interface](../../docs/agents-inference/interfaces.md#reach-an-agent-interface) describes.
`cargo ci live-docker` runs it: it installs the pinned OpenShell CLI by checksum, binds the case to a fresh UID, gateway port and subnet, stub address, and the run's OpenClaw and Hermes images, and passes a fresh model key as `NEMOCLAW_TEST_INTERFACES_MODEL_KEY` and `TF_VAR_model_key`.
Before apply, the `tests/e2e/hcl/model` module runs a stub model with the bundled Docker provider: the pinned `nginx-unprivileged` image that the development issuer runs, on the host network at the port the case's `model` provider names.
It lists one model and answers every chat completion with the same reply, streamed when the request asks, and refuses any request without that key.
The `tests/e2e/hcl/volume` module also creates each sandbox's two skills volumes, named for the run's UID, and writes their skills, owned by the agent image's user.
Each agent's `skills.paths` lists a folder of skills on one volume and a folder that is one skill on a read-only volume, as [Skills on a Mounted Volume](../../docs/agents-inference/agents.md#skills-on-a-mounted-volume) describes; OpenClaw's folder holds two skills and a file that isn't one, and Hermes's folder is empty.
Apply must start both agents with them, and report each interface's port, sign-in, and token file.
Whether the agent uses a skill is not checked live; Fabric's tests check what each harness loads.
The `tests/e2e/hcl/interface` module then runs `hcl_live::interface` once per request: it reads the reported token with `openshell sandbox exec`, forwards the port with `openshell forward service`, and sends one request with the token as a Bearer credential.
OpenClaw's Control UI page must load and its configuration endpoint must accept the token; Hermes's API server must list its models and answer a chat completion with the stub's reply, which also shows that NemoClaw sent the configured key; Hermes's dashboard page must load with its session token.
Reports hold status codes; tokens and response bodies stay in the run's private `work` directory.
The `tests/e2e/hcl/terminal` module then runs `hcl_live::terminal`, which opens OpenClaw's terminal UI as [OpenClaw's Terminal UI](../../docs/agents-inference/interfaces.md#openclaws-terminal-ui) describes: it reads the dashboard's token with `openshell sandbox exec`, runs `openshell sandbox exec --tty -- openclaw tui --url ws://127.0.0.1:18789 --token TOKEN` in a pseudo-terminal, waits for the `connected | idle` status, and types a prompt, then Enter on its own, because a terminal UI reads a prompt and Enter that arrive together as a paste.
The stub's reply must appear, and the command must exit 0 after Ctrl-D.
The report holds those results and the exit status; the screen output and the token stay in `work`.
Then the `tests/e2e/hcl/command` module runs two commands in each sandbox: one writes a marker file in `/sandbox/workspace`, the workspace that the SDK's Fabric configuration sets, and reads it back as the agent image's user, UID 10001; the other lists the environment, which must include the variable that the sandbox reads the model registration's key from, `NEMOCLAW_INFERENCE_MODEL_..._KEY`, but not the run's model key.
Two more commands in OpenClaw's sandbox check its network policy with `python3`, which the images have instead of curl.
Each sandbox's managed inference grant already gives the image's executables, `python3` among them, the model's `/v1/**` paths, so only OpenClaw's document also grants `python3` the stub's `/health`.
A request there must get the stub's 401, which shows that it reached the stub; without the grant, OpenShell's proxy answers 403.
A connection to the managed gateway, at the gateway network's second address and its endpoint's port, must fail with `EACCES`, OpenShell's refusal: no grant names that host, and the sandbox's OpenShell proxy, which runs on the host network, can reach it.
The stub's reply does not establish inference; `docker-openclaw-nvidia` covers hosted inference.

Hermes's browser chat runs its terminal UI in a pseudo-terminal, so one more command in Hermes's sandbox opens one with `python3`'s `os.openpty()`; that needs the read-write `/dev/pts` the Hermes image's default policy grants.
The chat itself, behind the dashboard's `/api/pty` WebSocket, is not checked live.
Rejected interfaces, refused tokens, a killed dashboard process, and tokens kept out of output and state are integration checks ([#14060](https://github.com/NVIDIA/NemoClaw/issues/14060)).

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
After a successful run, remove each document's `gateway storage` objects with [Remove Retained Resources](../../docs/build-deploy/usage.md#remove-retained-resources), using its UID; the test has no state directory, so skip the steps that use one.

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
The [`docker-dummy` scenario](#dummy-agent-lifecycle) qualifies the bundled OpenTofu path, including a redeploy on retained storage.
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
After a successful run, remove the document's `gateway storage` objects with [Remove Retained Resources](../../docs/build-deploy/usage.md#remove-retained-resources), using its UID; the test has no state directory, so skip the steps that use one.

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
