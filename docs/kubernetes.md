<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes and managed vLLM or Ollama services on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The pinned Fabric reports agent health as unsupported, so apply stops at the agent's health check after creating every resource ([#12443](https://github.com/NVIDIA/NemoClaw/issues/12443)).
The managed gateway's authentication is a development fixture, not a production identity service ([#12692](https://github.com/NVIDIA/NemoClaw/issues/12692)).
OpenShift's security policy admitting these pods is untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  Managed inference also needs Pods, pod execution, and PersistentVolumeClaims in that namespace.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces, plus RuntimeClasses when `runtimeClassName` is set.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, or a [managed model service](#run-a-managed-model-service) in the managed gateway's namespace.
  Managed services require a GPU node, a compatible runtime image, and persistent storage; real-cluster inference remains unqualified ([#12732](https://github.com/NVIDIA/NemoClaw/issues/12732)).

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

Apply creates the gateway and every sandbox, then fails at the agent health check with `data.nemoclaw_sandbox_readiness`; that is the expected result at this Fabric pin.
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
  Managed Ollama has no native bearer authentication; its access boundary depends on the cluster network policy.
- Runtime and agent images the selected nodes can pull by digest.
  Build the hosted runtime from this checkout using [the runtime image procedure](build.md#build-a-runtime-image); bare upstream vLLM and Ollama images lack the required supervisor.
  The hosted runtime must run as UID/GID 1000 on Kubernetes or the namespace-assigned identity on OpenShift, and the storage driver must make its mounted directories writable by that identity.
  Export its metadata with `cargo images export-metadata IMAGE --platform linux/amd64 --output model.metadata.json`, selecting the service's architecture, and set `NEMOCLAW_MODEL_IMAGE_METADATA` to that file's absolute path.
  The SDK verifies its image digest, platform, and runtime labels before provisioning; every service requires `kubernetes.imageMetadata` naming that environment reference.

The same [vLLM model](models.md) and [managed Ollama](inference.md#run-managed-ollama) contracts apply to Docker and cluster services.
vLLM takes a public Hugging Face repository and exact commit; Ollama takes a public library model name and manifest digest.
Models, image digests, hardware profiles, serving budgets, and storage sizes remain deployment settings.
There is no cluster-specific model allowlist.

The cluster settings below reserve CPU and memory and limit their use for one service:

```yaml
# Under spec.services.<name>:
kubernetes:
  imageMetadata: {env: NEMOCLAW_MODEL_IMAGE_METADATA}
  cpuRequestMillis: 1000
  cpuLimitMillis: 4000
  memoryRequestGiB: 32
  memoryLimitGiB: 64
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
CPU and memory requests must not exceed their limits.
The required `storageGiB` field sizes the model PVC; optional `storageClass`, `runtimeClassName`, `nodeSelector`, and `tolerations` select the cluster resources.
The [generated field reference](reference/configuration.md) defines accepted values.
Pod memory limits include memory-backed shared memory; size them for the model's loading and serving needs as well as `container.sharedMemoryGiB`.
The runtime's hardware, capacity, and resident memory checks still apply.
Its resident monitor observes host memory through `/proc`; it does not measure cgroup memory pressure.
A Pod can therefore reach its Kubernetes memory limit and be OOM-killed before the host-memory watchdog stops inference.

Each service has its own retained model PVC mounted at `/data`.
For vLLM with `authentication: bearer`, a separate retained 1 GiB credential PVC mounts at `/credentials`; the runtime creates the key and the deployment registers it through the existing credential path.
The key is not stored in the service ConfigMap or authored YAML.
Keep the deployment state and both PVCs together for recovery; deleting a bound credential PVC or substituting another PVC does not authorize generating a replacement identity.
PVC resize, storage-class changes, changes to vLLM authentication mode, existing-volume adoption, and transfer between clusters are not supported.

Use `serviceRef` to connect providers to the service, and `provider: openai` with `api: openai-completions` for the examples' OpenClaw adapter.
The SDK derives an internal cluster DNS endpoint; do not set a provider endpoint or credential alongside `serviceRef`.
Multiple agents and providers may share a service.
The provider creates a ClusterIP Service and a NetworkPolicy; no host port, NodePort, or LoadBalancer is published.
The NetworkPolicy allows inference connections from Pods in the gateway's namespace; workloads in that namespace share this access boundary.
The imported inference profile grants only the verified Service's assigned IP addresses; general authored HTTP DNS endpoints remain rejected.
Model, image, and resource changes preserve the Service and its addresses while replacing compute.
Changing `serving.port` requires explicit destroy and reapply with the retained PVCs; ordinary apply rejects a port change before mutation.
Docker `placement` and `publication`, host IPC, `ollamaProxy`, CPU-only serving, CPU offload in Ollama, and distributed or multi-GPU serving are outside this cluster path.

Use the same plan and apply commands as [the managed gateway procedure](#deploy-with-a-managed-gateway).
Plan validates intent and observes bound resources without starting a model or changing cluster resources.
Apply creates retained storage and disposable service resources, starts the hosted runtime, and checks its bounded readiness before configuring dependent agents.
The Pod does not automatically restart a stopped inference process.
On failed model startup or protective shutdown, preserve the state and PVCs, correct the resource or runtime condition, and use [explicit recovery](usage.md#recover-an-interrupted-operation).
Recovery can recreate compute only after verifying retained storage and ownership.

A ready model service does not establish a real agent reply.
The current Fabric pin still reports agent health as unsupported, so apply stops at agent readiness even when model startup succeeds.
Use [inference verification](inference.md#verify-the-result) to distinguish service readiness, adapter health, and an explicit model request.
The [compatibility baseline](design/cluster-inference-compatibility.md) records exact inputs and the remaining Fabric, authentication, and qualification gaps.

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
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
Deployments made before the Helm provider graph keep their original bundle and state; see [the migration policy](migration.md#move-from-the-combined-kubernetes-gateway-resource).
