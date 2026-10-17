<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

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

The SDK creates the namespace and a credential key, starts a development token issuer, and installs the pinned OpenShell chart.
The `openshell` and `fabric` providers reach the gateway through port forwards they open on free loopback ports while OpenTofu runs.
Start from [the Kubernetes example](../examples/kubernetes/managed-development.yaml) and set:

- `metadata.uid` to a new UUID.
- `gateway.kubernetes.kubeconfig` to the environment variable holding the kubeconfig path, and `context` to the exact context.
- `gateway.kubernetes.namespace` to a namespace that does not exist yet; NemoClaw does not take over an existing one.
- `gateway.endpoint` to `https://127.0.0.1:` and an explicit port. Providers forward on free ports of their own, so this port is not bound.
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

Apply creates the gateway and every sandbox, and starts each agent.
Keep the state directory: it holds the cluster ownership receipt and the development issuer's keys, and destroy needs both.
[Managed Kubernetes ownership](design/architecture.md#managed-kubernetes-ownership) describes which component owns each resource.

### Reference Registry Credentials

For a managed gateway, `gateway.kubernetes.imagePullSecrets` names Kubernetes Secrets in the deployment's namespace.
The pinned chart attaches these references to gateway and helper pods and configures OpenShell to attach them to sandbox pods.
Credential values stay in Kubernetes; NemoClaw does not read, create, rotate, or remove these Secrets.

Add the names to the managed gateway settings:

```yaml
spec:
  gateway:
    kubernetes:
      imagePullSecrets:
        - registry-credentials
```

The namespace must be created by NemoClaw, so arrange for your platform to provision the Secrets after namespace creation.
If a Secret is missing or its credentials are wrong, image acquisition can fail and apply stops; keep the deployment state and UID.
After the namespace exists, provision or repair the Secret there, then rerun apply with the same configuration and state directory.
Do not create the namespace yourself or substitute another namespace to bypass ownership checks.

For the following example, install `kubectl` and prepare a protected Docker configuration file containing registry `auths` entries, as described in [Kubernetes registry authentication](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).
Entries that only name a `credsStore` or `credHelpers` helper cannot supply credentials to the kubelet; it cannot run your client machine's helper.
From the directory holding `deployment.yaml`, create the registry Secret:

```sh
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/private/registry/config.json
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Use the deployment's context and namespace, and keep that credential file out of source control and shared diagnostics.
Check the pod events if a pull still fails; a configured reference does not establish registry access.
Retire upstream registry credentials separately; destroy retains the namespace and caller-managed Secrets.
Docker/Podman credential delivery and private-registry qualification across all runtimes remain tracked in [#12709](https://github.com/NVIDIA/NemoClaw/issues/12709).

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
Removing them is not covered yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
