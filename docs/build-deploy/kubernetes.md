<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development NVIDIA OpenShell gateway in a namespace it binds or creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes, and OpenShift.

The managed gateway authenticates users through a development issuer it runs, or through [an existing OIDC issuer](#authenticating-through-an-existing-oidc-issuer).
CI runs the managed lifecycle on kind (Kubernetes 1.37, Agent Sandbox 1.0.3, the version the pinned OpenShell's Kubernetes tests use).
OpenShift was qualified by hand on one OpenShift Local 4.22.14 node (linux/arm64) at revision `62f994bf88` ([#12733](https://github.com/NVIDIA/NemoClaw/issues/12733)): the gateway and issuer ran under `restricted-v2`, and agents replied through a managed gateway, one authenticating through OIDC, and an existing gateway.
No automated run covers OpenShift, and other clusters are untested.
[Current limits](../resources/limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

Confirm client access, cluster permissions, image availability, and inference reachability before applying the example.
Managed model services aren't supported on Kubernetes.

- **A NemoClaw bundle:** [Build one](build.md#building-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway.
  No Helm CLI is needed.
- **Cluster access:** A kubeconfig file and an exact context, or, when NemoClaw [runs in a pod](#running-nemoclaw-in-a-pod), the pod's service account.
  Either must be able to read the deployment's namespace, or create it if it doesn't exist, and, inside it, create Secrets, ConfigMaps, ServiceAccounts, Roles, RoleBindings, Services, Deployments, StatefulSets, Jobs, and NetworkPolicies, and port-forward to its pods (`get` and `create` on `pods/portforward`).
  The SDK reads nothing else outside the namespace.
  The pinned OpenShell chart also creates [two cluster-wide objects](#cluster-wide-objects), so the context or service account must be able to create a ClusterRole and a ClusterRoleBinding.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in the gateway target's `environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
  With the pod's service account, they also receive `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`.
    CI tests version 1.0.3.
    Without its API, the chart's preflight stops the install.
  - A StorageClass for the gateway's volume: the cluster's default, or the class that the target's [`dataStorageClass`](#choosing-the-gateways-storageclass-and-resources) names.
    Without it, the volume's claim stays pending and apply fails when Helm's wait times out.
  - A network plugin that enforces ingress and egress NetworkPolicy in the deployment's namespace, as [OpenShell requires](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/kubernetes/setup.mdx#prerequisites).
    OpenShell's NetworkPolicies stop each sandbox's workload pod from reaching the network except through its supervisor, and the development issuer's policy admits only the gateway.

  NemoClaw checks none of these.
  The chart and the cluster report a missing Agent Sandbox or StorageClass, but Kubernetes accepts NetworkPolicies that no plugin enforces, so nothing reports a plugin that ignores them.
- **Agent images:** Pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** An endpoint reachable from inside the sandboxes, such as a [model server you run in the cluster](#using-a-model-server-in-the-cluster).
  Managed model services under `spec.services` aren't supported on Kubernetes ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

NemoClaw never selects a context for you.
Omitting `kubeconfig` and `context` selects the pod's service account, never `KUBECONFIG`, `~/.kube/config`, or their current context.

### Cluster-Wide Objects

Besides the namespace, a managed gateway adds two cluster-wide objects: the chart's ClusterRole and ClusterRoleBinding, both named `<release>-node-reader-<namespace>`.
`<release>` is the gateway's Helm release, which also names its StatefulSet in the namespace, such as `nc-0123456789abcdef-gateway`.
They let the gateway read nodes, namespaces, RuntimeClasses, and PriorityClasses, and review ServiceAccount tokens.
Destroy removes both with the gateway release.

## Preparing Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there.

For a published release, take both from the release: use an agent image's index reference from its notes in `image.ref`, and download the matching `<image>.metadata.json` it attaches.
One bundle covers every Linux platform the index lists, so it serves ARM64 and AMD64 nodes.

An image you build must match the architecture of the nodes that run the sandboxes.
List each node's architecture:

```sh
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\n"}{end}'
```

On a native host of that architecture, from the repository root, build the image for its platform, `linux/arm64` or `linux/amd64`, then write its bundle to a new file:

```sh
PLATFORM=linux/arm64 # or linux/amd64, to match the nodes
cargo images build --platform "$PLATFORM" openclaw
cargo images export-metadata nc-fabric:openclaw --output openclaw.metadata.json
```

Push the image, then use the digest of the pushed index in `image.ref`.
The bundle is checked against that digest, so it must come from the same build.
It covers every Linux platform the index lists, so one bundle serves ARM64 and AMD64 nodes.
When you copy the image to another registry, copy the whole index so its digest stays the same.
Besides its platform's image, an index from `cargo images build` lists an attestation manifest that Buildx adds.
With `oc image mirror`, pass `--keep-manifest-list=true --filter-by-os='.*'`.
By default, it copies only the image for the platform `oc` runs on.
If a copy changes the digest, write the bundle again from the copy with `--registry`, as [Build agent images](build.md#building-agent-images) describes.
For OpenShift's internal registry, reference the copy by the address nodes pull from, `image-registry.openshift-image-registry.svc:5000/<namespace>/<name>@<digest>`, and let the deployment's service accounts pull from that namespace, for example with the `system:image-puller` role.
Set the environment variable named in `image.metadata` to the bundle's path before each command.
See [Build agent images](build.md#building-agent-images) for the harnesses each platform builds.

### Sandbox Count and Cluster Size

A document holds up to 256 sandboxes with a `kubernetes` or `openshift` gateway.
Docker and Podman keep 32, because they run every sandbox on one host.
A document has one gateway, one namespace, and one OpenTofu state, so the cap also bounds what one gateway outage or one slow plan affects.
Split a larger fleet across documents.

Size the cluster for the sandboxes you declare:

- **Pods:** Each sandbox runs two pods, its agent and OpenShell's supervisor, so 256 sandboxes run 512 pods.
  At the kubelet's default of 110 pods per node, they need at least five nodes, plus room for the gateway, the issuer, and the cluster's own pods.
  A node allowed more than 250 pods also needs a pod range larger than a /24.
- **Node memory:** In a recorded run, each OpenClaw sandbox used about 0.85 GiB of node memory, about 210 GiB for 256 ([#14403](https://github.com/NVIDIA/NemoClaw/issues/14403)).
- **Storage:** A managed gateway gives each sandbox a 2 GiB workspace claim, so 256 sandboxes claim 512 GiB, from the cluster's default StorageClass unless `workspace_storage_class` in [`spec.gateway.config`](usage.md#configuring-a-managed-gateway) names another, as [the placement example](../../examples/kubernetes/sandbox-placement.yaml) does.
  OpenShell deletes a sandbox whose pod hasn't started within 5 minutes, so add sandboxes in steps the StorageClass provisions in that time.
  k3s's local-path provisioner made about one volume every 2 seconds.
  Steps of 64 sandboxes started within about 3 minutes, and a single apply of 256 lost 100.
- **Gateway:** The managed gateway requests 250m CPU and 256 MiB of memory and is limited to 1 CPU and 2 GiB, unless the target's [`resources`](#choosing-the-gateways-storageclass-and-resources) sets others.
  In a recorded run, 256 sandboxes used up to about 1.2 GiB of memory ([#14403](https://github.com/NVIDIA/NemoClaw/issues/14403)).
- **Open files:** The gateway holds about three connections per sandbox, 800 to 1,000 open files at 256, and a pod gets its open-file limit from the node's container runtime.
  k3s installed as a service gives pods 1,048,576, but k3d nodes on Docker gave a soft limit of 1,024, which 256 sandboxes exceed.
  Create such clusters with `k3d cluster create --runtime-ulimit "nofile=1048576:1048576"`.

Each sandbox also attaches at most 32 providers, OpenShell's limit.
See [inference](../agents-inference/inference.md).

## Deploying With a Managed Gateway

The SDK binds the namespace, creating it if it doesn't exist, adds a credential key, starts a development token issuer, and installs the pinned OpenShell chart.
NemoClaw and its `openshell` and `fabric` providers reach the gateway through port forwards they open on free local ports for each command, also when you [publish the gateway](#publishing-the-gateway-outside-the-cluster).
Unless you publish it, the document names no gateway address or port.
Start from [the Kubernetes example](../../examples/kubernetes/managed-development.yaml).
[The examples' index](../../examples/kubernetes/README.md) lists the others.
To start from a Docker or Podman document instead, make the edits in [Adapting a Document to Another Target](usage.md#adapting-a-document-to-another-target).
Replace these deployment-specific inputs under `spec.gateway.target.kubernetes` before running the commands:

- `metadata.uid` to a new UUID.
- `kubeconfig` to the environment variable holding the kubeconfig path, and `context` to the exact context.
  Omit both when [NemoClaw runs in a pod](#running-nemoclaw-in-a-pod).
- `namespace` to a namespace for this deployment alone.
  If it exists, NemoClaw records its UID and never labels, changes, or deletes it.
  Otherwise, NemoClaw creates it.
  NemoClaw refuses a namespace that another NemoClaw deployment created.
- Each sandbox's `image.ref` and `image.metadata`.

```yaml
spec:
  gateway:
    management: managed
    target:
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
Without `expose`, plan and apply report the gateway as `not published`: other clients reach it through a port forward of their own, as [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli) shows.
Keep the state directory: it holds the cluster ownership receipt and the development issuer's keys, and destroy needs both.
[Managed Kubernetes ownership](../../internal-docs/design/architecture.md#managed-kubernetes-ownership) describes which component owns each resource.

### Authenticating Through an Existing OIDC Issuer

The `development` profile runs a token issuer for this deployment, which isn't an identity service.
Only NemoClaw can get its tokens, so it gives you no access of your own: to invoke agents or run `openshell` commands against the gateway, use the `oidc` profile and [reach the gateway from the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli).
To have the gateway authenticate users through your identity provider instead, use the `oidc` profile, as [the OIDC example](../../examples/kubernetes/managed-oidc.yaml) does:

```yaml
spec:
  gateway:
    target:
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

- `openshell.gateway.oidc` in [`spec.gateway.config`](usage.md#configuring-a-managed-gateway) holds OpenShell's OIDC settings in OpenShell's names, as its [gateway authentication guide](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/authentication.mdx#oidc) describes for Helm deployments.
  OpenShell validates every request's bearer token against the issuer and audience, and maps the token's roles to administrator and user access.
  Omitted settings take OpenShell's defaults.
  The `oidc` profile requires the table.
  Under `development`, NemoClaw writes it for its own issuer.
- `caConfigMap` names a ConfigMap in the deployment's namespace whose `ca.crt` verifies the issuer's certificate.
  The gateway trusts it, alongside its own trusted CAs, only for the issuer's discovery and signing keys.
  Omit it for a publicly trusted issuer.
  Like registry Secrets, create it in the namespace before the first apply, or after NemoClaw creates the namespace and then rerun apply with the same state directory:

  ```sh
  kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
    --namespace nemoclaw-development create configmap issuer-ca \
    --from-file=ca.crt=/path/to/issuer-ca.pem
  ```

- `token.env` names the variable holding the bearer token NemoClaw sends to the gateway.
  NemoClaw reads the gateway's version and drivers, and creates and deletes its workspace, which OpenShell allows only to a Platform Admin, so the token needs the role `admin_role` names.
  Without it, plan fails with `observation permission denied`.
  If you set `scopes_claim`, the token also needs the scopes an [external gateway's token](#reaching-an-external-gateway-through-an-ingress) does.

NemoClaw runs no sign-in flow and stores no token.
Before each plan, apply, or destroy, get an access token for the audience from your identity provider, for example with its command-line tool, and put it in the variable `token.env` names:

```sh
export NEMOCLAW_GATEWAY_TOKEN="$(your-identity-provider-cli token --audience openshell)"
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

When the token expires, get a new one and rerun.
OpenShell accepts a token for up to 60 seconds after its `exp`, the default leeway of the JWT library it uses, so a revoked token can keep working for that long.
With NemoClaw's chart values, the gateway authenticates each request by its token: it accepts a client without a certificate, and refuses the client certificate from `<release>-client-tls` without a token, with `missing authorization header`.
With this profile, the namespace holds no development issuer, and the state directory holds no issuer keys.

### Publishing the Gateway Outside the Cluster

Like a Docker gateway's published port, the target's `expose` publishes the gateway at `expose.endpoint`, where other clients, such as the OpenShell CLI, dial it without a port forward.
NemoClaw's own plan, apply, and destroy still reach the gateway through port forwards, so they still need `pods/portforward`.
Issue [#14422](https://github.com/NVIDIA/NemoClaw/issues/14422) tracks letting them dial the endpoint instead.
Set `expose.endpoint` and one of `expose.service` and `expose.route`.
Either forwards to the gateway's TLS listener, so TLS and client certificates pass through unchanged, and the gateway certificate names the endpoint's host.

- **The address must be known before apply,** because plan binds the endpoint and the chart writes its host into the certificate.
- **Fixed after the first plan:** whether `expose` is set, its endpoint, whether a Service or a Route publishes the gateway, and the Service's type.
  Changing them needs a new deployment.

#### Through a NodePort Service

`expose.service` sets the OpenShell chart's own gateway Service to `NodePort` at the endpoint's port.
The Service doesn't publish the gateway's plaintext metrics port, and the gateway then serves no metrics.
CI publishes a gateway with the `oidc` profile on kind, where two agents reply to a client that dials the node's address with the issuer's token and the gateway's client certificate.
[The NodePort example](../../examples/kubernetes/published-nodeport.yaml) publishes one with the `oidc` profile.

```yaml
spec:
  gateway:
    target:
      kubernetes:
        # ...the cluster settings and authentication above...
        expose:
          endpoint: https://gateway.agents.example.com:30851
          service:
            type: NodePort
```

- **Endpoint:** `https://`, a node's address or a lowercase DNS name for the nodes, and a port in the cluster's node-port range, 30000 through 32767 by default.
  Ports 30000 through 30085 are the least likely to be taken.
  Apply fails if Kubernetes refuses the port or another Service holds it.
- **The port is open on every node.** Restrict who can reach it with your network's own controls.
  The gateway's API requires a token from its issuer, not a client certificate.
- **No `LoadBalancer` yet:** The pinned chart's Service takes no annotations or source ranges, and listens on the gateway's own port ([#14421](https://github.com/NVIDIA/NemoClaw/issues/14421)).

#### Through an OpenShift Route

On OpenShift, `expose.route` has the chart create a Route for the endpoint's host with `passthrough` TLS termination: the cluster's router forwards each encrypted connection, by the host name the client sends, to the chart's gateway Service, which stays inside the cluster.
Only the `openshift` target takes `expose.route`.
On other clusters, use `expose.service`.
[The Route example](../../examples/kubernetes/published-route.yaml) publishes one with the `oidc` profile.
No automated test runs a Route, because CI has no OpenShift cluster.
CI checks the Route that the pinned chart renders from NemoClaw's values.

```yaml
spec:
  gateway:
    target:
      openshift:
        # ...the cluster settings and authentication above...
        expose:
          endpoint: https://nemoclaw-gateway.apps.example.com:443
          route:
            annotations:
              haproxy.router.openshift.io/timeout: 1h
```

- **Endpoint:** `https://`, a lowercase DNS name that reaches the cluster's router, such as one under its apps domain, and the port the router serves, usually 443.
  NemoClaw doesn't check the port.
  Plan refuses an IP address, because the Route's host is the endpoint's and clients send no host name for an IP address, so the router can't match one.
  `expose.service` accepts one.
- **`annotations`** are optional and reach the Route unchanged, such as the router's `haproxy.router.openshift.io` settings.
  Changing them updates the Route in place.
- **Creating the Route:** Helm creates it with the identity that applies, which needs `create`, `update`, and `delete` on `routes` in the `route.openshift.io` API group, and OpenShift sets a Route's host only for an identity that can create `routes/custom-host`.
  OpenShift's `admin` and `edit` roles grant both.

Sandbox [service URLs](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) skip the gateway's sign-in, so anyone who reaches the endpoint with a service's host name reaches that service, which must authenticate its own clients.
The URLs that apply prints don't open remotely yet ([#14316](https://github.com/NVIDIA/NemoClaw/issues/14316)).

The chart writes the certificate once, when it creates the Secrets `<release>-server-tls`, `<release>-client-tls`, and `<release>-jwt-keys`, and destroy keeps them.
A new deployment with the same `metadata.uid` in the same namespace reuses the retained Secrets, whose certificate might not name its host.
Delete the three Secrets before its first apply.

### Reaching the Gateway From the OpenShell CLI

With the `oidc` profile, the OpenShell CLI can reach the gateway with your own token, to [invoke agents](../agents-inference/interfaces.md#invoking-an-agent) and run other `openshell` commands.
It needs three things: a port forward to the gateway pod, the CA certificate that verifies the gateway, and an OpenShell gateway entry that signs in through your identity provider.
A [published gateway](#publishing-the-gateway-outside-the-cluster) needs no forward: set the variables in the first step but skip its `port-forward` command, and add the gateway at `expose.endpoint` instead of `https://127.0.0.1:17671`.
No automated test covers these steps.
[#14131](https://github.com/NVIDIA/NemoClaw/issues/14131) records a manual run of the browser sign-in against a bare-metal single-node OpenShift 4.22 cluster, and [#14192](https://github.com/NVIDIA/NemoClaw/pull/14192) one of the client-credentials sign-in on kind.
Both used Keycloak as the issuer.
[#14307](https://github.com/NVIDIA/NemoClaw/issues/14307) records the client-credentials sign-in on kind and k3d with only the CA certificate, through the forward and at a published endpoint.

In one terminal, forward a free local port, 17671 below, to the gateway, which listens on port 8080 in the pod named after its release with `-0` appended.
Find the release among the namespace's StatefulSets.
Leave the forward running, and use the same port in the `openshell gateway add` commands below:

```sh
deployment_context=my-cluster
deployment_namespace=nemoclaw-development
kubectl --context "$deployment_context" --namespace "$deployment_namespace" get statefulsets
deployment_release=REPLACE_WITH_STATEFULSET_NAME
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  port-forward "pod/$deployment_release-0" 17671:8080
```

In another terminal, with the same variables set, copy the CA certificate from the Secret `<release>-client-tls` to where the OpenShell CLI looks for a gateway's certificates.
The gateway's certificate names `127.0.0.1`, so keep that address:

```sh
gateway_name=nemoclaw-development
mtls="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateways/$gateway_name/mtls"
mkdir -p "$mtls"
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  get secret "$deployment_release-client-tls" -o 'go-template={{index .data "ca.crt"}}' \
  | base64 -d > "$mtls/ca.crt"
```

Then add the gateway with the issuer and audience from `openshell.gateway.oidc`, and the client ID your identity provider registered for the OpenShell CLI.
The CLI receives the sign-in on `http://127.0.0.1` at a free port, path `/callback`, so that client must accept that redirect on any port.
The CLI checks the issuer's certificate against the client host's trusted CAs.
If the host doesn't trust the CA that signed it, such as the CA in `caConfigMap`, save that CA's certificate in a PEM file and set `SSL_CERT_FILE` to its path for every `openshell` command.
The CLI then trusts only the certificates in that file, and it contacts the issuer whenever it refreshes your token.
The browser that opens for the sign-in must trust that CA too, or it warns about the issuer's certificate.
The CLI opens a browser to sign in, then sends your token with each request:

```sh
openshell gateway add https://127.0.0.1:17671 \
  --name "$gateway_name" \
  --oidc-issuer https://login.example.com/realms/openshell \
  --oidc-client-id REPLACE_WITH_CLI_CLIENT_ID \
  --oidc-audience openshell
openshell status
```

Where no browser can open, such as in a CI job, sign in with a confidential client instead: put its secret in `OPENSHELL_OIDC_CLIENT_SECRET` and pass its ID to the same command.
The CLI then gets a token from the issuer's token endpoint, without a browser.
The client's tokens must carry the audience and a role from `openshell.gateway.oidc`:

```sh
export OPENSHELL_OIDC_CLIENT_SECRET="$(cat /private/openshell-ci-client.secret)"
openshell gateway add https://127.0.0.1:17671 \
  --name "$gateway_name" \
  --oidc-issuer https://login.example.com/realms/openshell \
  --oidc-client-id REPLACE_WITH_CONFIDENTIAL_CLIENT_ID \
  --oidc-audience openshell
openshell status
```

When the token expires, the CLI gets a new one the same way, so keep `OPENSHELL_OIDC_CLIENT_SECRET` set for as long as you run `openshell` commands.

`openshell status` reports the gateway as connected and authenticated.
Then [select the gateway and workspace](../agents-inference/interfaces.md#selecting-the-gateway-and-workspace) with `OPENSHELL_GATEWAY=$gateway_name`.
A token with the role `admin_role` names reaches the deployment's workspace.
A token with only the role `user_role` names reaches it once a platform admin adds the token's subject to the workspace.
Until then, sandbox commands fail with `not a member of workspace` and print the `openshell workspace member add` command to run.
With only that role, `openshell status` also reports `authorization denied`, because its check reads gateway details that only an admin may read.
See [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/authentication.mdx#oidc) for token refresh and sign-out.

### Referencing Registry Credentials

On a managed gateway, OpenShell's `image_pull_secrets` setting names the Kubernetes Secrets in the deployment's namespace that sandbox pods pull with.
Set it in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway), as [the OIDC example](../../examples/kubernetes/managed-oidc.yaml) does:

```yaml
spec:
  gateway:
    config:
      openshell.drivers.kubernetes:
        image_pull_secrets:
          - registry-credentials
```

The gateway and its helper pods get no pull Secrets: they pull OpenShell's public images, which matters only on a cluster that redirects those images to a mirror that requires pull Secrets ([current limits](../resources/limits.md#platforms-models-and-placement)).
Credential values stay in Kubernetes.
NemoClaw doesn't read, create, rotate, or remove these Secrets.

Create the namespace and its Secrets before the first apply, or let NemoClaw create the namespace and provision the Secrets afterwards.
If a Secret is missing or its credentials are wrong, image acquisition can fail and apply stops.
Keep the deployment state and UID.
Provision or repair the Secret in the namespace, then rerun apply with the same configuration and state directory.

For the following example, install `kubectl` and prepare a protected Docker configuration file containing registry `auths` entries, as described in [Kubernetes registry authentication](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).
Entries that only name a `credsStore` or `credHelpers` helper can't supply credentials to the kubelet.
It can't run your client machine's helper.
From the directory holding `deployment.yaml`, create the registry Secret:

```sh
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/private/registry/config.json
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Use the deployment's context and namespace, and keep that credential file out of source control and shared diagnostics.
Check the pod events if a pull still fails.
A configured reference doesn't establish registry access.
Retire upstream registry credentials separately.
Destroy retains the namespace and caller-managed Secrets.
Docker and Podman gateways pull private images with Docker logins instead.
See [Pulling From Private Registries](usage.md#pulling-from-private-registries).

### Choosing the Gateway's StorageClass and Resources

The gateway keeps its database on a 1 GiB volume, which the chart claims from the cluster's default StorageClass.
On a cluster without a default, or whose default is NFS, name another class in the target's `dataStorageClass`.
Use a block-backed class: the gateway's SQLite database runs in write-ahead-log mode, which NFS and other network filesystems don't support.

The gateway requests 250m CPU and 256 MiB of memory and is limited to 1 CPU and 2 GiB, which fit [256 sandboxes](#sandbox-count-and-cluster-size).
A LimitRange in the namespace can refuse these values, such as one whose maximum memory is below 2 GiB.
To set others, write the target's `resources` in the shape of a Kubernetes container's, with only `cpu` and `memory`:

```yaml
spec:
  gateway:
    management: managed
    target:
      kubernetes:
        # kubeconfig, context, namespace, and authentication as above
        dataStorageClass: fast-ssd
        resources:
          requests: {cpu: 500m, memory: 512Mi}
          limits: {cpu: "2", memory: 4Gi}
```

`resources` replaces all four values as written.
A quantity you leave out takes Kubernetes' default: the namespace LimitRange's, or for a request, its limit.
Write memory in whole `Mi` or `Gi`, and write CPU in quoted cores, such as `"2"`, or in millicores, such as `500m`.
Plan refuses memory such as `256m`, which Kubernetes reads as thousandths of a byte, and a request above its limit.
Changing `resources` restarts the gateway, and its sandboxes and agents keep running.

The class is fixed after the first plan, because the volume's claim keeps the class it was created with: plan refuses another with `state is bound to a different gateway StorageClass`.
NemoClaw doesn't check that the class exists.
If it doesn't, the claim stays pending, apply fails when Helm's 600-second wait times out, and the claim remains.
Create the class and apply the same document again, and the claim binds in it.
To use another class instead, destroy the deployment, [remove what it retains](usage.md#on-kubernetes-or-openshift), including that claim, and create a new deployment.

### Running NemoClaw in a Pod

When `nemoclaw` runs in a pod, such as a CI job, it can use the pod's service account instead of a kubeconfig.
Omit the target's `kubeconfig` and `context`:

```yaml
spec:
  gateway:
    target:
      kubernetes:
        namespace: nemoclaw-development
        authentication:
          profile: development
```

- NemoClaw passes OpenTofu `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`, which Kubernetes sets in the pod, and no kubeconfig.
  NemoClaw's providers then connect with the service account's token and CA from `/var/run/secrets/kubernetes.io/serviceaccount/`, and the Helm provider gets no kubeconfig path or context, so it falls back to the same account.
- They ignore `KUBECONFIG` and `~/.kube/config`: in a run from a pod on kind, with both naming an unreachable server, plan, apply, export, and destroy used only the service account.
- If either variable is unset, as outside a pod, plan stops before OpenTofu plans.
  Name a kubeconfig and context there.
- The target's `environment` serves a kubeconfig's exec plugin, so it requires `kubeconfig`.
- The `kubectl` commands on this page name a context.
  In the pod, omit `--context`.
- A deployment keeps the cluster access it was first applied with: switching between a kubeconfig and the pod's service account fails planning and leaves the resources unchanged.

The pod needs:

- **A service account** that can do what NemoClaw and the chart do, bound to the Role and ClusterRole below.
  Kubernetes mounts its token unless the pod or service account sets `automountServiceAccountToken: false`.
- **A persistent volume for `--state-dir`:** Keep it across runs, because destroy needs the receipt and issuer keys the state directory holds.
- **The bundle and inputs:** The NemoClaw bundle, `deployment.yaml`, each image's metadata bundle, and the variables its references name.

Create the deployment's namespace first, so the Role can live in it.
NemoClaw binds the existing namespace.
These rules were enough for plan, apply, export, and destroy from a pod on kind.
Kubernetes lets an account create a Role or ClusterRole only with rules it holds itself, so the rules the pinned OpenShell chart's roles grant are included.
The ClusterRole's rules:

```yaml
rules:
  - apiGroups: [""]
    resources: [namespaces]
    verbs: [get]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [clusterroles, clusterrolebindings]
    verbs: [get, create, delete]
  # Granted by the chart's ClusterRole.
  - apiGroups: [""]
    resources: [nodes]
    verbs: [get, list, watch]
  - apiGroups: [node.k8s.io]
    resources: [runtimeclasses]
    verbs: [get]
  - apiGroups: [scheduling.k8s.io]
    resources: [priorityclasses]
    verbs: [get]
  - apiGroups: [authentication.k8s.io]
    resources: [tokenreviews]
    verbs: [create]
```

The rules of the Role in the deployment's namespace:

```yaml
rules:
  - apiGroups: [""]
    resources: [configmaps, serviceaccounts, services]
    verbs: [get, create, delete]
  - apiGroups: [""]
    resources: [secrets]
    verbs: [get, list, create, update, delete]
  - apiGroups: [apps]
    resources: [deployments, statefulsets]
    verbs: [get, create, delete]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, watch, create, delete]
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies]
    verbs: [get, create, delete]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [roles, rolebindings]
    verbs: [get, create, delete]
  # The providers' port forwards; the WebSocket upgrade also needs create.
  - apiGroups: [""]
    resources: [pods/portforward]
    verbs: [get, create]
  # Granted by the chart's Roles.
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch, create, patch, delete]
  - apiGroups: [""]
    resources: [events]
    verbs: [get, list, watch]
  - apiGroups: [agents.x-k8s.io]
    resources: [sandboxes, sandboxes/status]
    verbs: [get, list, watch, create, update, patch, delete]
```

Bind the ClusterRole with a ClusterRoleBinding and the Role with a RoleBinding in the namespace, both to the pod's service account.

## Deploying to OpenShift

Use the `openshift` target, which takes the same fields as `kubernetes`.
Everything else matches the managed Kubernetes deployment above.
Start from [the OpenShift example](../../examples/openshift/managed-development.yaml).

OpenShift assigns each namespace a UID and group range and admits only those identities.
The pinned chart runs the gateway as UID 1000 with `fsGroup: 1000`, which the `restricted-v2` security context constraint rejects.
On the `openshift` target, NemoClaw sets the chart's `securityContext.runAsUser` and `podSecurityContext.fsGroup` to `null`, as [the chart's OpenShift install](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/deploy/helm/openshell/README.md#install-on-openshift) does, so `restricted-v2` runs the gateway as the range's first UID and group.
OpenShell runs each sandbox as the same UID.
The [OpenShift Local qualification](https://github.com/NVIDIA/NemoClaw/issues/12733) predates this: there, NemoClaw read the namespace's range and passed its first UID and group to the chart.
This has since run by hand on one OpenShift Local 4.22.14 node (linux/amd64): `restricted-v2` gave the gateway the range's first UID and `fsGroup`, and two agents replied through it with OIDC authentication.
[Current limits](../resources/limits.md#platforms-models-and-placement) lists what remains untested.

With `supervisor_topology = "gateway"` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway), the chart also runs a shared supervisor Deployment, which supervises all sandboxes, as UID and group 65534.
On the `openshift` target, NemoClaw also sets that supervisor's `runAsUser`, `runAsGroup`, and `fsGroup` under `supervisor.podSecurityContext` to `null`, as [the chart's OpenShift overlay](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/deploy/helm/openshell/ci/values-openshift-scc.yaml) does.
On OpenShift Local 4.22.14, `restricted-v2` refused the supervisor's pod with the chart's IDs and admitted it with the nulls, as the range's first UID and group; no deployment with a shared supervisor has run on OpenShift.

The agent images need no OpenShift variant: any UID can read their workspace seed.

## Using an Existing Gateway

To use an OpenShell gateway someone else runs on the cluster, set `gateway.management: external` and `gateway.target` to `kubernetes: {}` or `openshift: {}`.
Give its endpoint, credential, and TLS material as environment references, as in [the external gateway example](../../examples/kubernetes/external-gateway.yaml).
NemoClaw then manages only the sandboxes.
It neither installs nor removes the gateway.
Sandboxes still need `image.metadata`.

### Reaching an External Gateway Through an Ingress

NemoClaw doesn't put a managed gateway behind a Gateway API ingress, because TLS would end at the Gateway, which conflicts with NemoClaw's mTLS ([current limits](../resources/limits.md#platforms-models-and-placement)).
On OpenShift, [a pass-through Route](#through-an-openshift-route) can publish a managed gateway instead.
Instead, the platform operator installs the OpenShell chart behind a Gateway API ingress with OpenShell's [Kubernetes ingress guide](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/kubernetes/ingress.mdx), and the deployment connects to it with `management: external`.
No automated test covers this setup.
[#14307](https://github.com/NVIDIA/NemoClaw/issues/14307) records runs of these steps behind Envoy Gateway v1.8.1 with a Keycloak issuer, with OpenShell 0.1.7 on single-node kind and k3d clusters and with OpenShell 0.1.8 on kind: an agent replied through the ingress in each, and requests longer than 15 seconds failed until the request timeout below was disabled.

The operator follows the guide with these choices:

- **Version:** Replace `<version>` in its `helm` commands with the `openshell` version in [`versions.json`](../../versions.json).
  NemoClaw rejects a gateway that reports another OpenShell version.
- **TLS:** Use its [end-to-end TLS](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/kubernetes/ingress.mdx#end-to-end-tls-backendtlspolicy) setup.
  Its `server.disableTls=true` setup sends bearer tokens unencrypted from the ingress to the gateway pod.
  Its plaintext setup can't serve NemoClaw, which accepts an `http://` gateway endpoint only on a literal loopback address.
- **Authentication:** Configure an OIDC issuer, as the guide's HTTPS setups do.
  The ingress terminates TLS and forwards no client certificate, so clients authenticate with bearer tokens.
  If a private CA signed the issuer's certificate, also set the chart's `server.oidc.caConfigMapName` to a ConfigMap in the release's namespace whose `ca.crt` verifies it.
  Create the ConfigMap before the install.
- **Request timeout:** By default, Envoy Gateway ends any request longer than 15 seconds, including a whole `exec` stream.
  In the recorded runs, a 20-second `openshell sandbox exec`, the command that sends agent requests, failed at 15 seconds, and starting an agent runtime, which runs through `exec`, took 12 to 13 seconds.
  Disable the timeout with a `BackendTrafficPolicy` on the chart's `GRPCRoute`, named `openshell` in the guide's `openshell` namespace.
  For another release, find the route with `kubectl get grpcroutes`:

  ```sh
  kubectl --context my-cluster --namespace openshell apply -f - <<'EOF'
  apiVersion: gateway.envoyproxy.io/v1alpha1
  kind: BackendTrafficPolicy
  metadata:
    name: openshell-timeouts
  spec:
    targetRefs:
      - group: gateway.networking.k8s.io
        kind: GRPCRoute
        name: openshell
    timeout:
      http:
        requestTimeout: 0s
  EOF
  ```

  Other Gateway API implementations might set a different default, or none.
  Check yours before the first apply.

Then give the deployment the ingress's host name, a token, and the CA that signed the listener certificate:

```yaml
spec:
  gateway:
    management: external
    target:
      kubernetes: {}
    endpoint: https://gateway.example.com
    credential: {env: GATEWAY_TOKEN}
    tls:
      ca: {env: GATEWAY_CA}
```

- **`endpoint`:** The listener certificate must name the endpoint's host.
  Otherwise, NemoClaw reports `the gateway's TLS server certificate does not name the endpoint's host`.
  When the operator sets the chart's `grpcRoute.hostnames`, the host must be one of them.
- **`tls.ca`:** A variable holding the path of a CA certificate file, as for [any external gateway](usage.md#supplying-credential-references).
  Give the CA that signed the certificate in the Secret the listener's `certificateRefs` names, `openshell-ingress-tls` in the guide.
  This CA is the chart's own only when the listener reuses the chart's server certificate Secret.
  Omit `tls` when a publicly trusted CA signed the listener certificate.
  With the wrong CA, NemoClaw reports `the gateway's TLS server certificate is not signed by the configured certificate authority`.
  Leave out `tls.certificate` and `tls.key`: the ingress doesn't forward a client certificate.
- **`credential`:** A variable holding an access token for the gateway's OIDC audience.
  NemoClaw [reads it on every run](../security/credential-rotation.md#gateway-connections) and never refreshes it.
  When it expires, get a new one and rerun.
- **Roles:** NemoClaw reads the gateway's version and drivers on every plan, apply, and destroy, and creates and deletes its workspace.
  OpenShell allows all three only to a Platform Admin ([role model](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/workspaces.mdx#understand-the-role-model)).
  The token therefore needs the gateway's `admin_role`, by default `openshell-admin` in the `realm_access.roles` claim, unless the gateway leaves both `admin_role` and `user_role` empty ([OIDC settings](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/authentication.mdx#oidc)).
  Without it, plan fails with `observation permission denied`.
  If the gateway sets `scopes_claim`, the token also needs `config:read`, `workspace:read`, `workspace:write`, `sandbox:read`, `sandbox:write`, `provider:read` and `provider:write`, or `openshell:all`.
- **Service URLs:** [service exposure](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) URLs skip the gateway's authentication, so prefer [`openshell forward service`](../agents-inference/interfaces.md#forwarding-a-native-service).
  The chart routes only gRPC, so the URLs need the operator's own route, as the guide's [Route Sandbox Service Traffic](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/kubernetes/ingress.mdx#route-sandbox-service-traffic) section describes.
  OpenShell builds them with the gateway pod's port, 8080, so behind an ingress on port 443 the URLs that apply prints name a port the ingress doesn't serve.
  With the chart's default service domain, the recorded runs printed `https://<workspace>--<sandbox>--<service>.openshell.localhost:8080/`.

## Using a Model Server in the Cluster

Sandboxes can use a model server that you run in the gateway's cluster.
NemoClaw creates nothing for it: you deploy the server with your platform's own tools, and the sandboxes reach it through its Service.
This has been tried on one kind cluster and one OpenShift Local node.
[Current limits](../resources/limits.md#platforms-models-and-placement) lists what is untested.
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

- **Destination:** OpenShell decides which address the name may reach when sandboxes connect.
  NemoClaw grants no address.
  OpenShell refuses the Kubernetes control-plane ports 2379, 2380, 6443, 10250, and 10255, so serve the model on another port.
- **Key:** `credential` is optional.
  It names the variable that holds the server's key where you run `nemoclaw`.
  OpenShell stores the key and adds it to sandbox requests.
  Give the server the same key from a Secret, as [Supplying the Key on Other Platforms](../agents-inference/inference.md#supplying-the-key-on-other-platforms) shows.
  The key crosses the cluster network over plain HTTP unless your network plugin or a service mesh encrypts Pod traffic.
- **Model IDs:** The machine running `nemoclaw` usually can't resolve cluster names, so onboarding can't list the server's models.
  Write the route's model ID yourself.
- **The server:** NemoClaw's vLLM and Ollama runtime images can run it.
  `vllm_runtime` and `ollama_runtime` describe the launch and requirements a platform needs ([Direct OpenTofu Usage](../references/provider.md#direct-opentofu-usage)).
  The vLLM image's CUDA 13.0 needs NVIDIA driver 580 or newer on the GPU nodes.
  NemoClaw doesn't check the nodes.
  Readiness is the platform's: point its probe at the server's health endpoint.
- **Ollama:** Its health endpoint answers before it has a model, and it doesn't pull one when a request names it.
  Pull the route's model into the server before the first agent request.

Start from [the in-cluster vLLM example](../../examples/kubernetes/in-cluster-vllm.yaml), or from [the in-cluster Ollama example](../../examples/kubernetes/in-cluster-ollama.yaml) for a server without a key.

## Destroying a Deployment

**Destroy deletes every sandbox, its in-memory conversation history, and its workspace claim.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, the gateway release, and the development issuer.
Each sandbox's workspace claim goes with it, and the claim's StorageClass decides whether the workspace files go too.
With the `Delete` reclaim policy, the cluster removes the volume and its data.
With `Retain`, such as OpenShift Local's default StorageClass, the volume stays `Released` with the workspace files on it until you remove it.
OpenShell creates workspace claims in the cluster's default StorageClass.
To choose another, set `workspace_storage_class` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway).

Destroy keeps the namespace, the credential key Secret, and the gateway's persistent volumes, as described in [deletion and retention](state.md#deletion-and-retention).
To remove them and any released workspace volumes, follow [Removing Retained Resources](usage.md#removing-retained-resources).
If destroy fails or is interrupted while removing the gateway release, follow [Recovering an Interrupted Helm Removal](usage.md#recovering-an-interrupted-helm-removal).
If an apply failed or stopped while Helm installed the gateway release, or plan, apply, or destroy names a gateway release that the state doesn't record, follow [Recovering From an Unfinished Helm Install](usage.md#recovering-from-an-unfinished-helm-install).

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

Then follow [Removing Retained Resources](usage.md#removing-retained-resources) on Kubernetes without its destroy check.
Its pod list still shows this deployment's gateway, issuer, and sandboxes.
Deleting the namespace stops them, so continue if nothing else uses the namespace.
That procedure keeps a namespace that existed before the first apply, so first delete the deployment's workloads in it:

- The gateway's objects, labeled `app.kubernetes.io/instance` with the release name
- The gateway's Helm release records, labeled `owner=helm` and `name` with the release name
- The issuer's objects, labeled `nemoclaw.nvidia.com/uid` with the deployment's UID
- The deployment's Sandboxes

Wait until the pod list shows none of them.
Keep the state directory until the namespace, or the deployment's objects in a kept namespace, the volumes, and both cluster-wide objects are gone.
This procedure hasn't been run on a cluster.
