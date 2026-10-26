<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The managed gateway authenticates users through a development issuer it runs, or through [an existing OIDC issuer](#authenticate-through-an-existing-oidc-issuer).
No CI job runs on OpenShift: CI tests Kubernetes on kind, which runs the OpenShift profile without enforcing OpenShift's security constraints.
OpenShift's evidence is one hand run on OpenShift Local, one linux/arm64 node with OpenShift 4.22.14, at revision `62f994bf88` ([#12733](https://github.com/NVIDIA/NemoClaw/issues/12733#issuecomment-6420162298)); [current limits](limits.md#platforms-models-and-placement) lists what it did not cover.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces.
  The pinned gateway chart also creates a ClusterRole and a ClusterRoleBinding, both named `GATEWAY-node-reader-NAMESPACE`, where `GATEWAY` is the gateway's release name; the context must be allowed to create and delete them.
  The role lets the gateway get namespaces, RuntimeClasses and PriorityClasses; get, list and watch nodes; and create TokenReviews.
  Kubernetes refuses to create a role that grants permissions its creator lacks, so the context also needs those permissions, or the `escalate` and `bind` verbs.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, such as a [model server you run in the cluster](#use-a-model-server-in-the-cluster).
  Managed model services under `spec.services` are not supported on Kubernetes ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

Apart from the gateway chart's ClusterRole and ClusterRoleBinding, NemoClaw installs nothing cluster-wide, and it never selects a context for you.

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

- `openshell.gateway.oidc` in [`spec.gateway.config`](usage.md#configure-a-managed-gateway) holds OpenShell's OIDC settings in OpenShell's names, as its [gateway authentication guide](https://github.com/NVIDIA/OpenShell/blob/5a7728c304b5528e954e9ae900cf21f84e1a12b1/docs/how-it-works/gateways/authentication.mdx#oidc) describes for Helm deployments. OpenShell validates every request's bearer token against the issuer and audience, and maps the token's roles to administrator and user access; omitted settings take OpenShell's defaults. The `oidc` profile requires the table; under `development`, NemoClaw writes it for its own issuer.
- `caConfigMap` names a ConfigMap in the deployment's namespace whose `ca.crt` verifies the issuer's certificate. Omit it for a publicly trusted issuer. Like registry Secrets, create it after NemoClaw creates the namespace, then rerun apply with the same state directory.
- `token.env` names the variable holding the bearer token NemoClaw sends to the gateway.

NemoClaw runs no sign-in flow and stores no token.
Before each plan, apply or destroy, get an access token for the audience from your identity provider, for example with its command-line tool, and put it in the variable `token.env` names:

```sh
export NEMOCLAW_GATEWAY_TOKEN="$(your-identity-provider-cli token --audience openshell)"
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

When the token expires, get a new one and rerun.
OpenShell keeps accepting a token for up to 60 seconds after its `exp` time, the default leeway of the [JWT validation it uses](https://github.com/NVIDIA/OpenShell/blob/5a7728c304b5528e954e9ae900cf21f84e1a12b1/crates/openshell-server/src/auth/oidc.rs#L843).
NemoClaw also presents the deployment's client certificate, which the gateway verifies; the token identifies the user.
With this profile, the namespace holds no development issuer, and the state directory holds no issuer keys.

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

### Reach the Agents of a Managed Gateway

The gateway listens only inside the cluster, and NemoClaw's port forwards close when its command ends.
To run OpenShell commands yourself, such as [invoking an agent](interfaces.md#invoke-an-agent), forward a port to the gateway and give the OpenShell CLI the deployment's certificates.
You need the deployment's kubeconfig context and read access to its state directory.

In a separate terminal, forward the port of `gateway.endpoint` to the gateway pod `GATEWAY-0`, where `GATEWAY` is the gateway's release name, the `name` field of `kubernetes/receipt.json` in the state directory, and keep the command running:

```sh
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development port-forward pod/GATEWAY-0 17671:8080
```

The deployment's CA signed the gateway's certificate, so the CLI needs that CA to trust the gateway; the gateway checks a client certificate only when one is presented.
NemoClaw keeps the CA, and the client certificate and key it presents, in the state directory as `kubernetes/client/ca.crt`, `tls.crt` and `tls.key`.
Copy them into `~/.config/openshell/gateways/PROFILE/mtls/`, where `PROFILE` is the name you give the gateway in the OpenShell CLI, as [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/5a7728c304b5528e954e9ae900cf21f84e1a12b1/docs/how-it-works/gateways/authentication.mdx#mtls) describes, and keep the copies private.
How the CLI authenticates depends on the profile:

- With `oidc`, register the forwarded endpoint under that name as an OIDC gateway, with the issuer and audience from `openshell.gateway.oidc`:

  ```sh
  openshell gateway add https://127.0.0.1:17671 --name PROFILE \
    --oidc-issuer https://login.example.com/realms/openshell --oidc-audience openshell
  ```

  The CLI signs in through your identity provider with a client registered there, `openshell-cli` unless you pass `--oidc-client-id`, as OpenShell's guide describes.
  Then [select the gateway and workspace](interfaces.md#select-the-gateway-and-workspace); `openshell sandbox list` lists the deployment's sandboxes.
  This sign-in has not been run against a NemoClaw gateway ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
- With `development`, NemoClaw gives the CLI no way to sign in: it signs short tokens with the issuer key in the state directory for its own operations only.
  Deploy with the `oidc` profile for CLI access, or run agent commands through Kubernetes as below.

With permission to exec into pods in the namespace, you can run a command in a sandbox's `agent` container without the OpenShell CLI.
In [the Kubernetes example](../examples/kubernetes/managed-development.yaml), the sandbox `assistant` runs the agent `primary`.
From the directory holding `deployment.yaml`, read the agent's runtime ID from the state directory, find the pod whose name ends with `--assistant`, and send it [one request](agents.md#run-one-deep-agents-or-pi-request):

```sh
RUNTIME_ID=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "primary") | .runtime_id' .local/kubernetes/terraform.tfstate)
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development get pods
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development exec -i REPLACE_WITH_POD -c agent -- \
  fabric-agent-ctl invoke --agent primary --runtime-id "$RUNTIME_ID" --input - <<'JSON'
"Reply with exactly READY."
JSON
```

OpenShell neither authorizes nor confines a process started this way: its filesystem policy does not apply, though OpenShell's NetworkPolicy still blocks the pod's own connections.

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
This has been tried on one kind cluster and on OpenShift Local; [current limits](limits.md#platforms-models-and-placement) lists what is untested.
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

Start from [the in-cluster vLLM example](../examples/kubernetes/in-cluster-vllm.yaml), or from [the in-cluster Ollama example](../examples/kubernetes/in-cluster-ollama.yaml) for a server without a key.

## Destroy a Deployment

**Destroy deletes every sandbox, its in-memory conversation history, and its workspace claim.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, the gateway release with its ClusterRole and ClusterRoleBinding, and the development issuer.
Each sandbox's workspace claim goes with it, and the claim's StorageClass decides whether the workspace files go too.
With the `Delete` reclaim policy, the cluster removes the volume and its data.
With `Retain`, such as OpenShift Local's default StorageClass, the volume stays `Released` with the workspace files on it until you remove it.
OpenShell creates workspace claims in the cluster's default StorageClass; to choose another, set `workspace_storage_class` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configure-a-managed-gateway).

Destroy keeps the namespace, the credential key Secret and the gateway's persistent volumes, as described in [deletion and retention](state.md#deletion-and-retention).
To remove them and any released workspace volumes, follow [Remove Retained Resources](usage.md#remove-retained-resources).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
If destroy refuses because an object it recorded was changed or replaced, follow [Remove a Deployment Whose Destroy Refuses](usage.md#remove-a-deployment-whose-destroy-refuses).
