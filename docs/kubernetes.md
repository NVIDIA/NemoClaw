<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The pinned Fabric reports agent health as unsupported, so apply stops at the agent's health check after creating every resource ([#12443](https://github.com/NVIDIA/NemoClaw/issues/12443)).
The managed gateway's authentication is a development fixture, not a production identity service ([#12692](https://github.com/NVIDIA/NemoClaw/issues/12692)).
OpenShift's security policy admitting these pods is untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes.
  Managed model services under `spec.services` are not supported on Kubernetes ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

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

## Deploy to OpenShift

Set `gateway.runtime.provider: openshift`; everything else matches the managed Kubernetes deployment above.
Start from [the OpenShift example](../examples/openshift/managed-development.yaml).

OpenShift assigns each namespace a UID and group range and admits only those identities.
After creating the namespace, the SDK waits up to 30 seconds for OpenShift to record that range, then runs the gateway as its first UID and group.
OpenShell runs each sandbox as the same UID.
If the range never appears, apply stops before installing the gateway with `OpenShift did not assign the namespace a UID range`; check that the context points at an OpenShift cluster.

The SDK records the range in its receipt, and a later apply refuses a namespace whose range has changed.
The agent images need no OpenShift variant: any UID can read their workspace seed.

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

Destroy removes the sandboxes, the gateway release and the development issuer.
It keeps the namespace, the credential key Secret and the gateway's persistent volumes, as described in [deletion and retention](state.md#deletion-and-retention).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
Deployments made before the Helm provider graph keep their original bundle and state; see [the migration policy](migration.md#move-from-the-combined-kubernetes-gateway-resource).
