<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes and managed vLLM or Ollama services on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The pinned Fabric reports agent health as unsupported, so apply stops at the agent's health check after creating every resource ([#13031](https://github.com/NVIDIA/NemoClaw/issues/13031)).
The managed gateway's authentication is a development fixture, not a production identity service ([#12692](https://github.com/NVIDIA/NemoClaw/issues/12692)).
OpenShift's security policy admitting these pods is untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  Managed inference also needs Pods, pod execution, and PersistentVolumeClaims in that namespace.
  It lists `discovery.k8s.io/v1` EndpointSlices to verify that ready Service backends belong to the recorded model Pod.
  The caller must be permitted to create SelfSubjectAccessReviews for model-resource permission preflight.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces, plus RuntimeClasses when `runtimeClassName` is set.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, or a [managed model service](#run-a-managed-model-service) in the managed gateway's namespace.
  Managed services require a GPU node, a compatible runtime image, and persistent storage; real-cluster inference qualification remains open ([#12732](https://github.com/NVIDIA/NemoClaw/issues/12732)).
  The [kind GB300 operator report](design/cluster-inference-compatibility.md#openclaw-context-budget) informs example context budgets; it is not deployment qualification.

NemoClaw installs nothing cluster-wide and never selects a context for you.

## Prepare Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there.
From the repository root, build the image, then write its bundle to a new file:

```sh
cargo images build --platform linux/amd64 openclaw
cargo images export-metadata nc-fabric:openclaw --platform linux/amd64 --output openclaw.metadata.json
```

Push the image, then use the digest of the pushed index in `image.ref`.
The bundle is checked against that digest, so it must come from the same build.
Set the environment variable named in `image.metadata` to the bundle's path before each command.
See [Build agent images](build.md#build-agent-images) for the harnesses each platform builds.

## Deploy with a Managed Gateway

The SDK creates the namespace and a credential key, starts a development token issuer, installs the pinned OpenShell chart, and reaches the gateway through a port forward that lasts only for each command.
Start from [the Kubernetes example](../examples/kubernetes/managed-development.yaml) and set:

- `metadata.uid` to a new UUID.
- `gateway.kubernetes.kubeconfig` to the environment variable holding the kubeconfig path, and `context` to the exact context.
- `gateway.kubernetes.namespace` to a namespace that does not exist yet; NemoClaw does not take over an existing one.
- `gateway.endpoint` to `https://127.0.0.1:` and a free local port for the port forward.
- Each sandbox's `image.ref` and `image.metadata`.

```yaml
spec:
  gateway:
    management: managed
    runtime:
      provider: kubernetes
    endpoint: https://127.0.0.1:17671
    kubernetes:
      kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
      context: my-cluster
      namespace: nemoclaw-development
      authentication:
        profile: development
```

From the directory holding `deployment.yaml`, preview the deployment, then apply it:

```sh
export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/openclaw.metadata.json"
nemoclaw plan --state-dir .local/kubernetes deployment.yaml
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Apply creates the gateway and every sandbox, then fails at the agent health check with `data.fabric_sandbox_readiness`; that is the expected result at this Fabric pin.
The resources stay in place, and a later apply with the same state checks them again.
Keep the state directory: it holds the cluster ownership receipt and the development issuer's keys, and destroy needs both.
[Managed Kubernetes ownership](design/architecture.md#managed-kubernetes-ownership) describes which component owns each resource.

## Run a Managed Model Service

With a managed Kubernetes or OpenShift gateway, declare `kind: vllm` or `kind: ollama` under `spec.services` and add the service's `kubernetes` resource settings.
The service inherits the gateway's cluster, context, and namespace.
An external gateway cannot provision a managed model service.
Start from [local vLLM](../examples/kubernetes/local-vllm.yaml) or [local Ollama](../examples/kubernetes/local-ollama.yaml).
These examples are configuration templates; neither establishes a qualified GPU, model, storage driver, or OpenShift security profile.

Before applying, the platform operator must provide:

- A Linux GPU node whose CPU architecture, NVIDIA driver, GPU family, and memory meet the service's [hardware contract](models.md#choose-a-hardware-profile).
  Each service requests one `nvidia.com/gpu` device; the runtime must observe exactly one GPU inside its Pod.
  Multiple services need sufficient independently allocatable GPU capacity.
- A device plugin and container runtime that make that device available to the Pod.
  Set `runtimeClassName` if the cluster requires a GPU runtime class; NemoClaw does not install drivers, device plugins, or runtime classes.
- A CSI provisioner with a usable `ReadWriteOnce` StorageClass and enough storage for model files and prepared data.
  Set `storageClass` to select it, or omit the field to use the cluster's default class.
- A network plugin that enforces NetworkPolicies, working cluster DNS, and permitted outbound access for the selected public model registry.
  The current cluster path requires the `cluster.local` DNS domain.
  Every managed model service depends on this policy, including vLLM with `authentication: bearer`.
  Hosted bearer-vLLM images require the `org.nemoclaw.inference.routes=openai-v2` image label and pass only the [listed inference requests](inference.md#authenticate-a-managed-vllm-service), which require the key, and public `GET /health`.
  They return 404 for `/invocations`, `OPTIONS`, WebSocket upgrades, and every other request before inference; vLLM without bearer authentication retains its upstream route behavior.
  Managed Ollama has no native bearer authentication.
  Without policy enforcement, other Pods can reach model endpoints, including Ollama's model-management API; the Kubernetes API cannot prove that the network plugin enforces the policy.
  Plan and apply warn about this dependency for each cluster model service; JSON results include `warnings`, including when the operation fails.
- Runtime and agent images the selected nodes can pull by digest.
  Build the hosted runtime from this checkout using [the runtime image procedure](build.md#build-a-runtime-image); bare upstream vLLM and Ollama images lack the required supervisor.
  The hosted runtime must run as UID/GID 1000 on Kubernetes or the namespace-assigned identity on OpenShift, and the storage driver must make its mounted directories writable by that identity.
  Export its metadata with `cargo images export-metadata IMAGE --platform linux/amd64 --output model.metadata.json`, selecting the service's architecture, and set `NEMOCLAW_MODEL_IMAGE_METADATA` to that file's absolute path.
  The SDK verifies its image digest, platform, and runtime labels before provisioning; every service requires `kubernetes.imageMetadata` naming that environment reference.

The same [vLLM model](models.md) and [managed Ollama](inference.md#run-managed-ollama) contracts apply to Docker and cluster services.
vLLM takes a public Hugging Face repository and exact commit; Ollama takes a public library model name and manifest digest.
Models, image digests, hardware profiles, serving budgets, and storage sizes remain deployment settings.
There is no cluster-specific model allowlist.

Both examples set `serving.contextTokens` and the route's `settings.model_metadata.contextWindow` to `32768` to leave room for OpenClaw's initial prompt and a reply.
These limits and models do not suit Hermes, which requires at least `64000` context tokens; see [Hermes context sizing](inference.md#size-the-context-for-hermes).
Follow [OpenClaw context budgeting](inference.md#tune-openclaws-primary-route) to keep those limits aligned, size memory, and interpret the advisory emitted by plan and apply.

The settings below reserve CPU and memory and limit their use for one service.
The `container` limits and service-level `updatePolicy` are common to managed vLLM and Ollama on Docker, Kubernetes, and OpenShift; see [container limits and updates](inference.md#set-container-limits-and-update-policy).
The `kubernetes` mapping applies only to managed Kubernetes and OpenShift gateways.
Docker and Podman configurations reject it rather than silently ignoring cluster settings.

```yaml
# Under spec.services.<name>:
container:
  cpuLimitMillis: 4000
  memoryLimitGiB: 64
updatePolicy: Preserve
kubernetes:
  imageMetadata: {env: NEMOCLAW_MODEL_IMAGE_METADATA}
  cpuRequestMillis: 1000
  memoryRequestGiB: 32
  storageGiB: 100
  nodeSelector:
    inference.example.com/pool: gpu
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
```

Replace or omit the example's pool selector to match labels the platform operator assigned.
The Pod always selects Linux and the service hardware's CPU architecture; authored selectors must agree.
Cluster services require explicit `container.cpuLimitMillis` and `container.memoryLimitGiB`; CPU and memory requests must not exceed those limits.
The required `storageGiB` field sizes the model PVC; optional `storageClass`, `runtimeClassName`, `nodeSelector`, and `tolerations` select the cluster resources.
The [generated field reference](reference/configuration.md) defines accepted values.
Pod memory limits include memory-backed shared memory; size them for the model's loading and serving needs as well as `container.sharedMemoryGiB`.
Validation rejects a shared-memory size or recipe preparation-memory requirement larger than `container.memoryLimitGiB`.
These are minimum checks; fitting each declared allocation does not establish that their combined peak fits the limit.
The runtime's hardware and resident host/GPU memory checks still apply.
Its resident monitor observes host memory through `/proc`; it does not measure cgroup memory pressure.
A Pod can therefore reach its Kubernetes memory limit and be OOM-killed before the host-memory watchdog stops inference.

Choose `storageGiB` for the pinned model download, recipe `preparedBytes` when present, a 16 GiB working reserve, and any earlier snapshots retained on the PVC.
Validation requires at least 16 GiB and checks declared prepared data plus that reserve before mutation.
The cluster path does not resolve the full model manifest or measure remaining PVC space before provisioning.
Check the model registry's artifact sizes and the storage driver's usable capacity before the first apply.
An undersized retained PVC cannot be resized through NemoClaw or replaced under the same binding.
Preserve its state and data; provision a separately identified deployment with adequately sized storage instead of editing the receipt or deleting a bound claim.

Each service has its own retained model PVC mounted at `/data`.
For vLLM with `authentication: bearer`, a separate retained 1 GiB credential PVC mounts at `/credentials`; the runtime creates the key and the deployment registers it through the existing credential path.
The key is not stored in the service ConfigMap or authored YAML.
Principals with `pods/exec` or Pod creation in the namespace, and node, kubelet, and storage administrators, can read the key; see [credential access](security.md#credentials-and-authentication).
Keep the deployment state and both PVCs together for recovery; deleting a bound credential PVC or substituting another PVC does not authorize generating a replacement identity.
PVC resize, storage-class changes, changes to vLLM authentication mode, existing-volume adoption, and transfer between clusters are not supported.

Use `serviceRef` to connect providers to the service, and `provider: openai` with `api: openai-completions` for the examples' OpenClaw adapter.
The SDK derives the fully qualified internal host `<service>.<namespace>.svc.cluster.local`; do not set a provider endpoint or credential alongside `serviceRef`.
Multiple agents and providers may share a service.
The provider creates a ClusterIP Service and a NetworkPolicy; no host port, NodePort, or LoadBalancer is published.
The NetworkPolicy admits only OpenShell supervisor Pods in the gateway's namespace on the model port.
The supervisor proxy's inference grant limits sandbox traffic to `/v1/**`.
The hosted bearer-vLLM runtime also returns 404 for every direct request except the [listed inference requests](inference.md#authenticate-a-managed-vllm-service), which require the key, and public `GET /health`.
Admitted peers can still reach Ollama's full native API directly.
Principals allowed to create or relabel Pods in that namespace remain inside the trust boundary.
The imported inference profile and each sandbox's matching network rule grant only the verified Service's assigned IP addresses; refresh compares both with the live Service, and a sandbox created against other addresses must be replaced.
General authored HTTP DNS endpoints remain rejected.
Model, image, and workload-resource changes preserve the Service and its addresses while replacing compute.
Renaming only the local image-metadata environment reference leaves compute unchanged.
Changing `serving.port` requires whole-deployment destroy and reapply with the retained PVCs; apply rejects a bound port change before mutation.
Destroy deletes every sandbox's files and conversation history while retaining model and credential PVCs; review [destroy consequences](usage.md#destroy) before choosing that path.
Docker `placement` and `publication`, host IPC, `ollamaProxy`, CPU-only serving, CPU offload in Ollama, and distributed or multi-GPU serving are outside this cluster path.

Use the same plan and apply commands as [the managed gateway procedure](#deploy-with-a-managed-gateway).
Plan validates intent and observes bound resources without starting a model or changing cluster resources.
Preflight checks the selected classes and API permissions and uses [server-side dry runs](https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run) to check admission before creating new resources.
The first plan cannot dry-run namespace-scoped workloads when the managed namespace does not exist yet; apply repeats those checks before workload creation.
The default service-level `updatePolicy: Preserve` refuses changes that would replace a Pod that may be serving: a running Pod, a scheduled Pod whose runtime container is starting or has started, or a Pod that is terminating, `Unknown`, or incompletely reported.
The current Pod, configuration, and saved receipt remain unchanged; static checks cannot guarantee that its replacement will obtain the occupied GPU, storage placement, or scheduler approval.
To permit sequential replacement, set `spec.services.<name>.updatePolicy: Recreate` and review the plan.
This is an ongoing opt-in to downtime for future updates until you remove it or set `Preserve`; changing only the policy does not restart the Pod.
Initial creation, unchanged apply, and replacement of a Pod that never served do not require `Recreate`.
A Pod never served when it is missing or terminal (`Failed` or `Succeeded`), when the scheduler never placed it on a Node, or when its runtime container never started because its image or container configuration was unavailable (`ErrImagePull`, `ImagePullBackOff`, `ErrImageNeverPull`, `InvalidImageName`, or `CreateContainerConfigError`).
For a changed existing workload, preflight checks the replacement Pod and ConfigMap under temporary names without persisting them, before stopping the current Pod.
Rejection preserves the current Pod, configuration, and saved service receipt.
Before `Recreate` replaces a Pod that may be serving, preflight also checks the cluster's Nodes.
When the update changes the node selector, tolerations, RuntimeClass, architecture, or CPU/memory requests, this check requires permission to list Nodes (cluster scope); without it, plan and apply name that permission and keep the current Pod.
For other updates, such as a new image, the check runs when Nodes can be listed and refuses only Node state that blocks the unchanged Pod, such as cordoned matching Nodes or a new untolerated taint.
It checks the admitted replacement Pod against node labels, required taints, and each Node's allocatable CPU, memory, and GPU capacity before deleting the current Pod.
An impossible constraint leaves the current workload and receipt intact.
The check uses the admission response so RuntimeClass additions and Pod overhead participate.
Admitted init containers and Pod-level resource declarations require accounting this check does not implement; preflight rejects updates that change scheduling inputs for such a Pod while preserving the current Pod.
It does not subtract the old Pod's allocation or require a spare GPU for a sequential update.
The check can reject a replacement at full namespace quota because the existing Pod still counts toward usage.
Use the [quota recovery procedure](#recover-a-quota-rejection-during-a-model-update) to obtain temporary admission headroom while preserving the running workload.
Temporary names and existing referenced objects can affect admission; a successful check does not reserve quota or capacity, and admission can change before the real create.
Competing workloads, PVC topology, and scheduler plugins can still prevent scheduling; the preflight is not a scheduler simulation.
With `Recreate`, replacement stops the old Pod after preflight passes; a later admission, scheduling, or startup failure can leave the service down until a corrected apply completes recovery from the saved state.
Apply creates retained storage and disposable service resources, starts the hosted runtime, and checks its bounded readiness before configuring dependent agents.
If Kubernetes reports `PodScheduled=False` with reason `Unschedulable`, apply keeps waiting while the scheduler retries, for example while a cluster autoscaler adds a Node, a volume claim binds, or a GPU device plugin registers.
Apply also keeps waiting while preemption has nominated a Node for the Pod (`status.nominatedNodeName`).
When the rejection persists for 15 minutes, apply stops and reports the bounded, redacted scheduler message and owned Pod name.
The pending Pod, PVCs, and receipt remain available for inspection.
After adding capacity, apply again with the same state directory to resume waiting; after correcting the constraints, apply replaces the Pod without `Recreate` because it never ran.
The Pod does not automatically restart a stopped inference process.
On failed model startup or protective shutdown, [diagnose the stopped Pod](#diagnose-a-stopped-model-pod), preserve the state and PVCs, correct the resource or runtime condition, then reapply with the retained state; see [recovery](usage.md#recover-an-interrupted-operation).
An unfinished cluster runtime apply permits corrections limited to model workloads, including restoring the preceding model digest.
Gateway prerequisites, retained service storage, and the compiled OpenShell deployment must remain unchanged; this does not authorize renaming a sandbox or changing its policy.
Recovery can recreate compute only after verifying retained storage and ownership.
If a create reply is lost after the API server accepts an object, recovery reports the unrecorded resource's kind, namespace, and name instead of adopting it or reporting successful cleanup.
Preserve the pending receipt. An operator must inspect that exact object and verify its deployment owner and generation before deciding whether to remove it; a subsequent apply or destroy rechecks the pending address.
Do not delete a PVC without accounting for its model data or credential identity, and do not erase the receipt to bypass the refusal.

Refresh rejects changes to an owned Service or NetworkPolicy's expected specification.
Endpoint grants also reject ready EndpointSlice members that do not identify the recorded model Pod.
For a deployment from an earlier experimental build, inspect the retained object UID, owner, and generation before an operator repairs its policy to the current supervisor-only form.
Replacing the object gives it a new UID that NemoClaw will not adopt; whole-deployment destroy is not a data-preserving policy migration.
Older short-DNS endpoints and sandbox policies require the existing sandbox change procedure; revised policy bytes also cannot replace an unresolved pending creation's recorded intent.
Keep the original bundle and entire state directory for such records.
Automatic cleanup after a definitive rejected sandbox creation remains follow-up work; do not edit intent records or reuse their resources with a fresh state directory.
Records accepted by earlier capacity rules require their original bundle for observation or teardown if storage is below 16 GiB or the Pod memory limit is smaller than declared preparation or shared memory; the new validation also applies when reading retained state.

A ready model service does not establish a real agent reply.
The current Fabric pin still reports agent health as unsupported, so apply stops at agent readiness even when model startup succeeds.
Use [inference verification](inference.md#verify-the-result) to distinguish service readiness, adapter health, and an explicit model request.
The [compatibility baseline](design/cluster-inference-compatibility.md) records exact inputs and the remaining Fabric, authentication, and qualification gaps.

### Recover a Quota Rejection During a Model Update

A replacement dry run can exceed namespace quota even when the new workload would fit after the old Pod is removed.
The rejection leaves the current workload and saved service receipt intact.
Keep the deployment YAML, matching bundle, state directory, and owned resources while the platform operator inspects the reported quota.
Ask the operator to temporarily raise each exhausted quota enough to admit the replacement Pod or ConfigMap alongside current usage.
The dry run does not create or schedule an extra Pod, but its admission check still counts the requested resources against quota.

After the operator provides that headroom, run the preview from the directory containing `deployment.yaml`, using the existing state path:

```sh
nemoclaw plan --state-dir .local/kubernetes deployment.yaml
```

If quota admission now passes, review the planned workload replacement and request the update:

```sh
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Keep the quota headroom through apply; afterward, the operator must check actual usage before restoring a previous quota.
If apply fails after stopping the old Pod, preserve state, correct the reported cause, and resume with the same YAML and state directory.
If the operator cannot provide headroom, defer the update; NemoClaw has no option to skip this admission check.
Whole-deployment [destroy](#destroy-a-deployment) is a separate decision that deletes every sandbox's files and history, not a data-preserving quota workaround.

### Diagnose a Stopped Model Pod

When apply reports `Kubernetes model Pod NAMESPACE/NAME stopped` or `cannot start`, inspect that Pod with the deployment's kubeconfig and context.
These commands read cluster state and write local diagnostic files; replace the placeholders with the context from the YAML and the namespace and Pod name from the error:

```sh
model_context=REPLACE_WITH_CONTEXT
model_namespace=REPLACE_WITH_NAMESPACE
model_pod=REPLACE_WITH_POD_NAME
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context "$model_context" -n "$model_namespace" get pod "$model_pod" -o jsonpath='{.metadata.labels.nemoclaw\.nvidia\.com/uid}{"\n"}'
```

Confirm that the printed label matches the YAML's `metadata.uid` before collecting diagnostics.
Without the error, list the deployment's Pods in that namespace with `get pods -l nemoclaw.nvidia.com/uid=UID`; model Pod names contain `-model-`.

```sh
diagnostic_dir=$(mktemp -d)
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context "$model_context" -n "$model_namespace" describe pod "$model_pod" > "$diagnostic_dir/pod.txt"
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context "$model_context" -n "$model_namespace" logs "$model_pod" -c runtime --tail 100 > "$diagnostic_dir/runtime.log" 2>&1
printf 'Diagnostics: %s\n' "$diagnostic_dir"
```

The `describe` output shows the Pod's phase, the runtime container's termination reason, exit code, and message, and scheduling and image events.
A Pod that cannot start has no runtime logs; check the image events.
The model Pod's restart policy is `Never`, so a stopped runtime is not restarted and cannot be reached with `kubectl exec`.
Its container logs and termination message remain readable while the Pod exists; `/data/status.json` stays on the retained `-data` PVC, and NemoClaw provides no command to read it from a stopped Pod.
Logs and messages can contain credentials or agent content; inspect them privately and redact them before sharing.
Use the [stop details](models.md#diagnose-and-recover-a-stopped-runtime) to choose a correction.

After correcting the cause, reapply with the same YAML, bundle, and state directory.
Apply recreates a stopped (`Failed` or `Succeeded`) Pod, and replaces a Pod that never started when its configuration changed; neither requires `Recreate`.

## Deploy to OpenShift

Set `gateway.runtime.provider: openshift`; everything else matches the managed Kubernetes deployment above.
Start from [the OpenShift example](../examples/openshift/managed-development.yaml).

OpenShift assigns each namespace a UID and group range and admits only those identities.
After creating the namespace, the SDK waits up to 30 seconds for OpenShift to record that range, then runs the gateway as its first UID and group.
OpenShell runs each sandbox as the same UID.
If the range never appears, apply stops before installing the gateway with `OpenShift did not assign the namespace a UID range`; check that the context points at an OpenShift cluster.

The SDK records the range in its receipt, and a later apply refuses a namespace whose range has changed.
The agent images need no OpenShift variant: any UID can read their workspace seed.
Managed model Pods use the recorded namespace UID and group, private IPC, dropped capabilities, and the runtime's default seccomp profile.
The selected runtime image and storage driver must support that assigned identity; OpenShift admitting and running these workloads remains unqualified.

## Use an Existing Gateway

To use an OpenShell gateway someone else runs on the cluster, set `gateway.management: external` with `runtime.provider` set to `kubernetes` or `openshift`.
Give its endpoint, credential and TLS material as environment references, as in [the external gateway example](../examples/kubernetes/external-gateway.yaml).
NemoClaw then manages only the sandboxes; it neither installs nor removes the gateway.
Sandboxes still need `image.metadata`.

## Destroy a Deployment

**Destroy deletes every sandbox's files and conversation history.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, managed model Pods and their disposable service resources, the gateway release, and the development issuer.
It keeps the namespace, the credential key Secret, the gateway's persistent volumes, and each model and credential PVC, as described in [deletion and retention](state.md#deletion-and-retention).
Removing them is not covered yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
