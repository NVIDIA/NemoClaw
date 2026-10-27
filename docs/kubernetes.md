<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The managed gateway authenticates users through a development issuer it runs, or through [an existing OIDC issuer](#authenticate-through-an-existing-oidc-issuer).
CI runs the managed lifecycle on kind (Kubernetes 1.37, Agent Sandbox 0.5.0).
OpenShift was qualified by hand on one OpenShift Local 4.22.14 node (linux/arm64) at revision `62f994bf88` ([#12733](https://github.com/NVIDIA/NemoClaw/issues/12733)): the gateway and issuer ran under `restricted-v2`, and agents replied through a managed gateway, one authenticating through OIDC, and an existing gateway.
No automated run covers OpenShift, and other clusters are untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces.
  The pinned OpenShell chart also creates [two cluster-wide objects](#cluster-wide-objects), so the context must be able to create a ClusterRole and a ClusterRoleBinding.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, such as a [model server you run in the cluster](#use-a-model-server-in-the-cluster).
  Managed model services under `spec.services` are not supported on Kubernetes ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

NemoClaw never selects a context for you.

### Cluster-Wide Objects

Besides the namespace, a managed gateway adds two cluster-wide objects: the chart's ClusterRole and ClusterRoleBinding, both named `<release>-node-reader-<namespace>`.
`<release>` is the gateway's Helm release, which also names its StatefulSet in the namespace, such as `nc-0123456789abcdef-gateway`.
They let the gateway read nodes, namespaces, RuntimeClasses and PriorityClasses, and review ServiceAccount tokens.
Destroy removes both with the gateway release.

## Prepare Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there.

For a published release, take both from the release: use an agent image's index reference from its notes in `image.ref`, and download the matching `<image>.metadata.json` it attaches.
One bundle covers every Linux platform the index lists, so it serves ARM64 and AMD64 nodes.

For an image you build, from the repository root, build it, then write its bundle to a new file:

```sh
cargo images build --platform linux/amd64 openclaw
cargo images export-metadata nc-fabric:openclaw --output openclaw.metadata.json
```

Push the image, then use the digest of the pushed index in `image.ref`.
The bundle is checked against that digest, so it must come from the same build.
It covers every Linux platform the index lists, so one bundle serves ARM64 and AMD64 nodes.
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

### Authenticate Through an Existing OIDC Issuer

The `development` profile runs a token issuer for this deployment, which is not an identity service.
Only NemoClaw can get its tokens, so it gives you no access of your own: to invoke agents or run `openshell` commands against the gateway, use the `oidc` profile and [reach the gateway from the OpenShell CLI](#reach-the-gateway-from-the-openshell-cli).
To have the gateway authenticate users through your identity provider instead, use the `oidc` profile:

```yaml
spec:
  gateway:
    kubernetes:
      authentication:
        profile: oidc
        caConfigMap: issuer-ca
        token:
          env: NEMOCLAW_GATEWAY_TOKEN
    config:
      openshell.gateway.oidc:
        issuer: https://login.example.com/realms/openshell
        audience: openshell
        roles_claim: groups
        admin_role: openshell-admins
        user_role: openshell-users
```

- `openshell.gateway.oidc` in [`spec.gateway.config`](usage.md#configure-a-managed-gateway) holds OpenShell's OIDC settings in OpenShell's names, as its [gateway authentication guide](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/docs/how-it-works/gateways/authentication.mdx#oidc) describes for Helm deployments. OpenShell validates every request's bearer token against the issuer and audience, and maps the token's roles to administrator and user access; omitted settings take OpenShell's defaults. The `oidc` profile requires the table; under `development`, NemoClaw writes it for its own issuer.
- `caConfigMap` names a ConfigMap in the deployment's namespace whose `ca.crt` verifies the issuer's certificate. Omit it for a publicly trusted issuer. Like registry Secrets, create it after NemoClaw creates the namespace, then rerun apply with the same state directory.
- `token.env` names the variable holding the bearer token NemoClaw sends to the gateway.

NemoClaw runs no sign-in flow and stores no token.
Before each plan, apply or destroy, get an access token for the audience from your identity provider, for example with its command-line tool, and put it in the variable `token.env` names:

```sh
export NEMOCLAW_GATEWAY_TOKEN="$(your-identity-provider-cli token --audience openshell)"
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

When the token expires, get a new one and rerun.
OpenShell accepts a token for up to 60 seconds after its `exp`, the default leeway of the JWT library it uses, so a revoked token can keep working for that long.
The gateway still requires its client certificate; the token adds user identity on top.
With this profile, the namespace holds no development issuer, and the state directory holds no issuer keys.

### Reach the Gateway from the OpenShell CLI

With the `oidc` profile, the OpenShell CLI can reach the gateway with your own token, to [invoke agents](interfaces.md#invoke-an-agent) and run other `openshell` commands.
It needs three things: a port forward to the gateway pod, the gateway's client certificate, and an OpenShell gateway entry that signs in through your identity provider.
These steps have not been run on a cluster.

In one terminal, forward the port in `gateway.endpoint` to the gateway, which listens on port 8080 in the pod named after its release with `-0` appended; find the release among the namespace's StatefulSets.
Leave the forward running:

```sh
deployment_context=my-cluster
deployment_namespace=nemoclaw-development
kubectl --context "$deployment_context" --namespace "$deployment_namespace" get statefulsets
deployment_release=REPLACE_WITH_STATEFULSET_NAME
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  port-forward "pod/$deployment_release-0" 17671:8080
```

In another terminal, with the same variables set, copy the client certificate from the Secret `<release>-client-tls` to where the OpenShell CLI looks for a gateway's certificates.
The gateway's certificate names `127.0.0.1`, so keep that address:

```sh
gateway_name=nemoclaw-development
mtls="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateways/$gateway_name/mtls"
(umask 077 && mkdir -p "$mtls")
for file in ca.crt tls.crt tls.key; do
  kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
    get secret "$deployment_release-client-tls" -o "go-template={{index .data \"$file\"}}" \
    | base64 -d > "$mtls/$file"
done
chmod 600 "$mtls/tls.key"
```

Then add the gateway with the issuer and audience from `openshell.gateway.oidc`, and the client ID your identity provider registered for the OpenShell CLI with a localhost redirect.
The CLI opens a browser to sign in, and presents the client certificate together with your token:

```sh
openshell gateway add https://127.0.0.1:17671 \
  --name "$gateway_name" \
  --oidc-issuer https://login.example.com/realms/openshell \
  --oidc-client-id REPLACE_WITH_CLI_CLIENT_ID \
  --oidc-audience openshell
openshell status
```

`openshell status` reports the gateway as connected and authenticated.
Then [select the gateway and workspace](interfaces.md#select-the-gateway-and-workspace) with `OPENSHELL_GATEWAY=$gateway_name`.
The client certificate's key grants transport access to the gateway; keep it private and delete the `mtls` directory when you no longer need access.
See [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/docs/how-it-works/gateways/authentication.mdx#oidc) for token refresh and sign-out.

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

## Use a Model Server in the Cluster

Sandboxes can use a model server that you run in the gateway's cluster.
NemoClaw creates nothing for it: you deploy the server with your platform's own tools, and the sandboxes reach it through its Service.
This has been tried on one kind cluster; [current limits](limits.md#platforms-models-and-placement) lists what is untested.
Name the Service by its cluster DNS name and port:

```yaml
spec:
  inferenceProviders:
    qwen:
      provider: openai
      api: openai-completions
      endpoint: http://qwen.models.svc.cluster.local:8000/v1
      credential: {env: QWEN_INFERENCE_KEY}
```

- **Destination:** OpenShell decides which address the name may reach when sandboxes connect; NemoClaw grants no address.
  OpenShell refuses the Kubernetes control-plane ports 2379, 2380, 6443, 10250 and 10255, so serve the model on another port.
- **Key:** `credential` is optional.
  It names the variable that holds the server's key where you run `nemoclaw`; OpenShell stores the key and adds it to sandbox requests.
  Give the server the same key from a Secret, as [Supply the Key on Other Platforms](inference.md#supply-the-key-on-other-platforms) shows.
  The key crosses the cluster network over plain HTTP unless your network plugin or a service mesh encrypts Pod traffic.
- **Model IDs:** the machine running `nemoclaw` usually can't resolve cluster names, so onboarding can't list the server's models; write the route's model ID yourself.
- **The server:** NemoClaw's vLLM and Ollama runtime images can run it; `vllm_runtime` and `ollama_runtime` describe the launch and requirements a platform needs ([Direct OpenTofu Usage](provider.md#direct-opentofu-usage)). Readiness is the platform's: point its probe at the server's health endpoint.
- **Ollama:** its health endpoint answers before it has a model, and it does not pull one when a request names it. Pull the route's model into the server before the first agent request.

Start from [the in-cluster vLLM example](../examples/kubernetes/in-cluster-vllm.yaml), or from [the in-cluster Ollama example](../examples/kubernetes/in-cluster-ollama.yaml) for a server without a key.

## Destroy a Deployment

**Destroy deletes every sandbox, its in-memory conversation history, and its workspace claim.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, the gateway release and the development issuer.
Each sandbox's workspace claim goes with it, and the claim's StorageClass decides whether the workspace files go too.
With the `Delete` reclaim policy, the cluster removes the volume and its data.
With `Retain`, such as OpenShift Local's default StorageClass, the volume stays `Released` with the workspace files on it until you remove it.
OpenShell creates workspace claims in the cluster's default StorageClass; to choose another, set `workspace_storage_class` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configure-a-managed-gateway).

Destroy keeps the namespace, the credential key Secret and the gateway's persistent volumes, as described in [deletion and retention](state.md#deletion-and-retention).
To remove them and any released workspace volumes, follow [Remove Retained Resources](usage.md#remove-retained-resources).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).

### If Destroy Refuses

Destroy refuses when an object it recorded is missing or was replaced, and the message names the object.
NemoClaw deletes only objects it can show it created, so it leaves everything in place.
Find out who changed the object first: a replacement can hold someone else's work.

To remove the deployment anyway, use the cluster's own tools.
Find the gateway's release among the namespace's StatefulSets, then delete its [cluster-wide objects](#cluster-wide-objects):

```sh
deployment_context=my-cluster
deployment_namespace=nemoclaw-development
kubectl --context "$deployment_context" --namespace "$deployment_namespace" get statefulsets
deployment_release=REPLACE_WITH_STATEFULSET_NAME
kubectl --context "$deployment_context" delete clusterrolebinding,clusterrole \
  "$deployment_release-node-reader-$deployment_namespace"
```

Then follow [Remove Retained Resources](usage.md#remove-retained-resources) on Kubernetes without its destroy check.
Its pod list still shows this deployment's gateway, issuer and sandboxes; deleting the namespace stops them, so continue if nothing else uses the namespace.
Keep the state directory until the namespace, the volumes and both cluster-wide objects are gone.
This procedure has not been run on a cluster.
