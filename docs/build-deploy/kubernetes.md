<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying to Kubernetes

Run agent sandboxes on an existing Kubernetes cluster through an NVIDIA OpenShell gateway.
NemoClaw either [installs and manages the gateway](#deploying-with-a-managed-gateway) or [uses one that a gateway operator runs](#deploying-with-an-external-gateway).
On OpenShift, follow this page and apply the differences in [Deploying to OpenShift](openshift.md).

## Choosing a Gateway

You preview a deployment document with `nemoclaw plan` and create it with `nemoclaw apply`, which records what it created in a state directory, as [Deploying Your First OpenClaw Agent](../get-started/first-deployment.md) shows.
The document's `spec.gateway.management` selects one of two cases:

| Aspect | Managed Gateway | External Gateway |
|---|---|---|
| Who runs the gateway | NemoClaw installs the pinned OpenShell Helm chart in a namespace that it binds or creates | A gateway operator installs, upgrades, and removes it |
| What NemoClaw needs | A kubeconfig and an exact context, or the service account of the pod that runs NemoClaw, with rights in the namespace and on two cluster-wide objects | The gateway's endpoint, and a token and TLS material from the gateway operator, but no cluster access |
| How people reach the agents | With the `oidc` profile, the OpenShell CLI and their own tokens; with `development`, not at all | An OpenShell CLI profile for the gateway, from the gateway operator |

Choose a managed gateway when you can give NemoClaw access to a namespace and want it to install a gateway for this deployment.
Choose an external gateway when a gateway operator already runs OpenShell at NemoClaw's pinned version, when NemoClaw must not hold cluster credentials, or when the gateway must sit behind a [Gateway API ingress](#reaching-an-external-gateway-through-an-ingress), which a managed gateway does not support ([current limits](../resources/limits.md#platforms-models-and-placement)).

## Preparing for Either Gateway

Both cases need the following before the first plan:

- Install the NemoClaw bundle, as [Installing the CLI](../get-started/install.md) describes, or [build one from source](build.md#building-a-native-bundle).
- Put the agent images in a registry the cluster can pull from, and get each image's metadata bundle, as [Preparing Agent Images](#preparing-agent-images) describes.
- Provide an inference endpoint that the sandboxes can reach from inside the cluster, such as [a model server you run in the cluster](#using-a-model-server-in-the-cluster), because Kubernetes does not support managed model services under `spec.services` ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
- [Size the cluster](#sandbox-count-and-cluster-size) for the sandboxes you declare, at most 256 per document.

When the gateway authenticates with OIDC, as with the `oidc` profile, the token that NemoClaw sends, from `token.env` or an external gateway's `credential`, must carry the gateway's `admin_role` role.
That role is `openshell-admin` in the `realm_access.roles` claim by default, and the token needs none when the gateway leaves both `admin_role` and `user_role` empty ([OIDC settings](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx#oidc)).
NemoClaw reads the gateway's version and drivers and creates and deletes its workspace, which OpenShell allows only to a Platform Admin ([role model](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/workspaces.mdx#understand-the-role-model)), so without the role, plan fails with `observation permission denied`.
If the gateway sets `scopes_claim`, the token also needs `config:read`, `config:write`, `workspace:read`, `workspace:write`, `sandbox:read`, `sandbox:write`, `provider:read`, and `provider:write`, or `openshell:all`.

### Preparing Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there, and NemoClaw checks the bundle, which covers every Linux platform that the image's index lists, against the digest in `image.ref`.

To use the release's agent images, follow these steps:

1. Put each agent image's `NAME@sha256:DIGEST` reference from the image table in the [v0.1.0 release notes on GitHub](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0) in `image.ref`, never a tag.
2. Download the matching `<image>.metadata.json` file attached to the same release, never metadata from another image.
3. Before each plan and apply, but not destroy, set the variable that the sandbox's `image.metadata.env` names, such as `NEMOCLAW_AGENT_IMAGE_METADATA` in managed-development.yaml, to that file's absolute path.
   If it is unset, plan and apply ask for it, and with `--non-interactive` they fail with `missing credential environment variables`.
   Plan and apply fail with `image runtime metadata is unavailable` when the path is relative or names no file, or when the file does not match the digest in `image.ref`.

When you copy an image to another registry, copy its whole index so its digest stays the same, or, if a copy changes the digest, write the metadata bundle again from the copy with `--registry`, as [Writing Image Metadata for Kubernetes or OpenShift](build.md#writing-image-metadata-for-kubernetes-or-openshift) describes.
To build the images yourself, follow [Building Agent Images](build.md#building-agent-images) and that metadata section, and keep UID and GID `10001` in [a derived image](derived-images.md#keeping-what-nemoclaw-relies-on).

## Deploying With a Managed Gateway

With `management: managed`, NemoClaw installs the pinned OpenShell chart in the target's namespace with the bundle's Helm provider, not a Helm CLI, and creates the namespace if it does not exist.
It names the Helm release, written `<release>` on this page, after the deployment's OpenShell workspace with `-gateway` appended, such as `nc-0123456789abcdef-gateway`.
NemoClaw and its OpenTofu providers reach the gateway through a port forward that each command opens on a free local port, so the document names no gateway address unless you [publish the gateway](#publishing-the-gateway-outside-the-cluster); to reach it yourself, forward a port as [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli) shows.

To deploy with a managed gateway, follow these sections in order:

1. [Preparing the Cluster](#preparing-the-cluster).
2. [Writing the Managed Deployment Document](#writing-the-managed-deployment-document), which starts with the authentication profile, and for `oidc`, [Authenticating Through an Existing OIDC Issuer](#authenticating-through-an-existing-oidc-issuer).
3. [Applying the Managed Deployment](#applying-the-managed-deployment).
4. With `oidc`, [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli).

[Destroying a Managed Deployment](#destroying-a-managed-deployment) follows them, and the four sections after it describe settings to decide before the first plan: [Publishing the Gateway Outside the Cluster](#publishing-the-gateway-outside-the-cluster), [Referencing Registry Credentials](#referencing-registry-credentials), [Choosing the Gateway's StorageClass and Resources](#choosing-the-gateways-storageclass-and-resources), and [Running NemoClaw in a Pod](#running-nemoclaw-in-a-pod).

### Preparing the Cluster

The cluster operator installs the following before the first apply, and NemoClaw checks none of them:

| Prerequisite | Purpose | Without It |
|---|---|---|
| [Agent Sandbox 1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.3), installed from its `sandbox.yaml` manifest, with its controller running in `agent-sandbox-system` | Runs the sandboxes that OpenShell creates | The chart's preflight stops the install |
| A StorageClass for the gateway's 1 GiB volume and each sandbox's 2 GiB workspace claim: the cluster's default, or the classes that the target's [`dataStorageClass`](#choosing-the-gateways-storageclass-and-resources) and the `workspace_storage_class` setting in the `openshell.drivers.kubernetes` table name, as [the placement example](../../examples/platforms/kubernetes/sandbox-placement.yaml) shows | Holds the gateway's database and each sandbox's `/sandbox` files | The gateway's claim stays pending, and apply fails when Helm's wait times out; a sandbox's claim stays pending, its pod does not start, and OpenShell deletes the sandbox after five minutes |
| A network plugin that enforces ingress and egress NetworkPolicy in the deployment's namespace, as [OpenShell requires](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/setup.mdx#prerequisites) | OpenShell's NetworkPolicies stop each sandbox's workload pod from reaching the network except through its supervisor, and the development issuer's policy admits only the gateway | Nothing reports it: Kubernetes accepts NetworkPolicies that no plugin enforces |

[Current limits](../resources/limits.md#platforms-models-and-placement) lists the clusters and configurations that no test covers.

NemoClaw reaches the cluster with the kubeconfig file and exact context that the target's `kubeconfig` and `context` name, or, when the target omits both, as the service account of [the pod that runs NemoClaw](#running-nemoclaw-in-a-pod).
NemoClaw never selects a context for you: neither it nor its OpenTofu providers read `KUBECONFIG`, `~/.kube/config`, or their current context.
If the kubeconfig runs an exec plugin, such as `aws` for EKS, list the variables it needs in the target's `environment`, such as `[AWS_PROFILE, AWS_REGION]`, because OpenTofu and its providers receive only those, the variables that the document's references name, and platform variables such as `PATH` and `HOME`.

The context or service account needs the rules that [Running NemoClaw in a Pod](#running-nemoclaw-in-a-pod) lists, and `create` on namespaces if NemoClaw creates the namespace; a cluster administrator's context has them all.
Besides the namespace, the gateway adds two cluster-wide objects, the chart's ClusterRole and ClusterRoleBinding, both named `<release>-node-reader-<namespace>`, which destroy removes with the gateway release.

### Writing the Managed Deployment Document

Choose the target's `authentication.profile` first, because it decides which example you start from and is fixed after the first apply:

- `development`, in [managed-development.yaml](../../examples/platforms/kubernetes/managed-development.yaml): NemoClaw runs its own token issuer in the namespace (a Deployment, Service, NetworkPolicy, Secret, and ConfigMaps named `<release>-oidc` and `<release>-oidc-ca`), which only the gateway can reach.
  Only NemoClaw gets tokens, signed with a key that never leaves the state directory, so you cannot invoke the agents or run `openshell` commands against the gateway yourself.
  The issuer's certificates are valid for 365 days, and NemoClaw does not renew them, so create a new deployment before they expire, as [Rotating Credentials](../security/credential-rotation.md#gateway-connections) describes.
- `oidc`, in [managed-oidc.yaml](../../examples/platforms/kubernetes/managed-oidc.yaml): your identity provider issues tokens to NemoClaw and to people, who invoke agents and run `openshell` commands as [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli) describes.
  Set up the issuer as [Authenticating Through an Existing OIDC Issuer](#authenticating-through-an-existing-oidc-issuer) describes.
  The example also names the pull Secret `registry-credentials`: create it as [Referencing Registry Credentials](#referencing-registry-credentials) describes, or delete the `openshell.drivers.kubernetes` table for images that need no login.

Copy the example to `deployment.yaml` in a new working directory, or start from another in [the examples' index](../../examples/platforms/kubernetes/README.md), and replace these values before the first plan:

- `metadata.uid`: a new UUID, which names the gateway's Helm release and the deployment's OpenShell workspace.
- `kubeconfig` and `context` in `spec.gateway.target.kubernetes`: `{env: NAME}`, where the variable `NAME` holds the kubeconfig file's path, and the exact context in that file, such as `my-cluster`, which this page's commands use.
  The examples name the variable `NEMOCLAW_CLUSTER_KUBECONFIG`, which this page's `kubectl` commands also read, so export it in each shell before you run them, such as with `export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"`.
  `NAME` cannot be `KUBECONFIG` or another [reserved name](../reference/configuration.md#managedkubernetes), and when [NemoClaw runs in a pod](#running-nemoclaw-in-a-pod), you omit both.
- `namespace` in the same target: a namespace for this deployment alone, which NemoClaw creates if it does not exist.
  NemoClaw binds an existing namespace by UID and never labels, changes, or deletes it, and it refuses one that another NemoClaw deployment created.
- Each sandbox's `image.ref` and `image.metadata`, as [Preparing Agent Images](#preparing-agent-images) describes.

If any sandbox will use `driverConfig`, such as to choose its nodes and resources, set `allow_driver_config: true` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway) from the first apply, as [the placement example](../../examples/platforms/kubernetes/sandbox-placement.yaml) does, because changing it later upgrades the gateway's release.

Before the first plan, also decide whether the deployment [publishes the gateway](#publishing-the-gateway-outside-the-cluster), uses [another StorageClass](#choosing-the-gateways-storageclass-and-resources), pulls with [registry credentials](#referencing-registry-credentials), or [runs NemoClaw in a pod](#running-nemoclaw-in-a-pod), because `expose` and `dataStorageClass` are fixed after the first plan, and the pod's service account after the first apply.

NemoClaw fixes each of the following settings at the plan or apply that the table names, then refuses to change it and leaves the resources unchanged:

| Fixed After | Settings |
|---|---|
| The first plan | `metadata.uid`, `management`, the target key (`kubernetes` or `openshift`), whether [`expose`](#publishing-the-gateway-outside-the-cluster) is set and its Service type, `expose.endpoint`, and [`dataStorageClass`](#choosing-the-gateways-storageclass-and-resources) |
| The first apply | `namespace`, `context`, `environment`, `authentication.profile`, [`caConfigMap` and `token.env`](#authenticating-through-an-existing-oidc-issuer), the `kubeconfig` variable's name, and whether NemoClaw uses a kubeconfig or [the pod's service account](#running-nemoclaw-in-a-pod) |

To change one of these settings before any apply, plan again with a new state directory, because plan creates nothing in the cluster.
After an apply, create a new deployment with a new `metadata.uid`, a new state directory, and a namespace that no other NemoClaw deployment created, such as the old name after you [remove what the old deployment retains](usage.md#removing-retained-resources).
[Identifying the Failure](../observability/troubleshooting.md#identifying-the-failure) lists the messages with which plan refuses a change.

### Authenticating Through an Existing OIDC Issuer

To authenticate through your identity provider, set `authentication.profile` to `oidc` and the following fields, as [managed-oidc.yaml](../../examples/platforms/kubernetes/managed-oidc.yaml) does:

- `openshell.gateway.oidc` in [`spec.gateway.config`](usage.md#configuring-a-managed-gateway): OpenShell's OIDC settings in OpenShell's names, such as `issuer` and `audience`, as its [gateway authentication guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx#oidc) describes.
  Plan fails without this table, and omitted settings take OpenShell's defaults, such as `realm_access.roles` for `roles_claim` and `openshell-admin` for `admin_role`.
  The example sets `roles_claim: groups`, `admin_role: openshell-admins`, and `user_role: openshell-users`: set them to the claim and role names that your issuer puts in tokens, or delete them to take the defaults.
- `authentication.caConfigMap`: optional, a ConfigMap in the namespace whose `ca.crt` verifies the issuer's certificate, for an issuer that a private CA signed.
  The gateway trusts it, alongside its own trusted CAs, only for the issuer's discovery and signing keys, and NemoClaw neither creates nor reads it.
- `authentication.token.env`: the variable holding the bearer token that NemoClaw sends to the gateway, with the role and scopes that [Preparing for Either Gateway](#preparing-for-either-gateway) lists.

To authenticate through the issuer, follow these steps:

1. If you set `caConfigMap`, create the namespace, which NemoClaw then binds and never deletes, and the ConfigMap in it before the first apply:

   ```sh
   kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster create namespace nemoclaw-oidc
   kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
     --namespace nemoclaw-oidc create configmap issuer-ca \
     --from-file=ca.crt=/path/to/issuer-ca.pem
   ```

2. Before each plan, apply, or destroy, and whenever the token expires, get an access token for the audience from your identity provider, and put it in the variable that `token.env` names, such as with `export NEMOCLAW_GATEWAY_TOKEN="$(REPLACE_WITH_TOKEN_COMMAND)"`.
   NemoClaw runs no sign-in flow and stores no token, and a token of only whitespace fails with `the variable token.env names holds no OIDC token`.
   Use a token that stays valid for the whole command, which for a first apply can include Helm's 600-second wait, because NemoClaw reads it once per command and never refreshes it.

### Applying the Managed Deployment

Keep the state directory for the life of the deployment, because plan, apply, and destroy need the cluster ownership receipt and, with `development`, the issuer's keys, which it holds under `kubernetes/` ([Local Deployment Files](state.md#local-deployment-files)).

From the directory holding `deployment.yaml`, follow these steps:

1. Set the variables that the document names, such as these for managed-development.yaml:

   ```sh
   export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"
   export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/openclaw.metadata.json"
   ```

   Also set the document's other references, such as the example's `NVIDIA_INFERENCE_API_KEY`, and with the `oidc` profile, [a token](#authenticating-through-an-existing-oidc-issuer) in the variable that `token.env` names.
   For managed-oidc.yaml, set `NEMOCLAW_OPENCLAW_IMAGE_METADATA` and `NEMOCLAW_HERMES_IMAGE_METADATA` to the paths of `openclaw.metadata.json` and `hermes.metadata.json` instead of `NEMOCLAW_AGENT_IMAGE_METADATA`.
   Plan and apply ask for an unset variable that they read, and with `--non-interactive` fail instead ([Credential Resolution](../references/cli.md#credential-resolution)).

2. Preview the deployment with `nemoclaw plan --state-dir .local/kubernetes deployment.yaml`, and stop on an error.
3. Apply it with `nemoclaw apply --state-dir .local/kubernetes deployment.yaml`.
   If Helm's 600-second wait for the gateway's install times out, Helm uninstalls the release and its pods before apply returns, so to see why, read the namespace's pods, their events, and the gateway's log in another terminal while apply waits ([Diagnosing a Kubernetes Gateway Startup Failure](../observability/troubleshooting.md#diagnosing-a-kubernetes-gateway-startup-failure)).
   If apply fails, such as with `Managed Kubernetes reconciliation is incomplete`, correct the cause and apply again with the same YAML, NemoClaw bundle, metadata bundles, and state directory.
4. Check that apply lists each agent with a runtime under `Agents`.
   With `development`, skip the `openshell` commands printed there, because only NemoClaw can get a token for the gateway.
   Without `expose`, plan and apply report the gateway as `not published`, and each NemoClaw command forwards its own local port to the gateway pod.
   With `oidc` and no `expose`, the OpenShell CLI needs a port forward of your own, as [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli) shows.

### Reaching the Gateway From the OpenShell CLI

With the `oidc` profile, the OpenShell CLI can reach the gateway with your own token, to [invoke agents](../agents-inference/interfaces.md#invoking-an-agent) and run other `openshell` commands, through steps that no automated test covers ([current limits](../resources/limits.md#access-and-diagnostics)).

Before you start, check the following:

- The client host has an OpenShell CLI at the version that your release's [`version-pins.json`](../references/compatibility.md#using-one-release-together) lists as `components.gateway.version`, or for a source build the `openshell` version in [`versions.json`](../../versions.json), installed as [Before the First Deployment](../get-started/prerequisites.md#before-the-first-deployment) describes.
- Your identity provider has registered a client for the OpenShell CLI that accepts the sign-in redirect to `http://127.0.0.1` on any port, path `/callback`.
- The client host and the browser that opens for the sign-in trust the CA that signed the issuer's certificate.
  For a CA that the host does not trust, such as the one in `caConfigMap`, set `SSL_CERT_FILE` to a PEM file holding it for every `openshell` command, which then trusts only that file's certificates.

For a [published gateway](#publishing-the-gateway-outside-the-cluster), skip step 2, and in step 3 add the gateway at `expose.endpoint` instead of `https://127.0.0.1:17671`.
To reach the gateway, follow these steps with your document's context and namespace in place of `my-cluster` and `nemoclaw-oidc`:

1. Set the deployment's release, then copy the CA certificate from the Secret `<release>-client-tls` to where the OpenShell CLI looks for the certificates of a gateway entry, named `nemoclaw-oidc` here:

   ```sh
   deployment_release=REPLACE_WITH_WORKSPACE-gateway # REPLACE_WITH_WORKSPACE: the workspace that plan and apply print, such as nc-0123456789abcdef; the result is also the gateway StatefulSet's name
   mtls="${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateways/nemoclaw-oidc/mtls"
   mkdir -p "$mtls"
   kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster --namespace nemoclaw-oidc \
     get secret "$deployment_release-client-tls" -o 'go-template={{index .data "ca.crt"}}' \
     | base64 -d > "$mtls/ca.crt"
   ```

2. Forward a free local port, 17671 here, to the gateway's port 8080 in the pod `<release>-0`, and leave the forward running.
   The gateway's certificate names `127.0.0.1`, so keep that address.

   ```sh
   kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster --namespace nemoclaw-oidc \
     port-forward "pod/$deployment_release-0" 17671:8080
   ```

3. In another terminal, add the gateway entry at the forwarded port, with the issuer and audience from `openshell.gateway.oidc` and the CLI's client ID.
   The CLI opens a browser to sign in, then sends your token with each request, and [OpenShell's authentication guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx#oidc) covers token refresh and sign-out.

   ```sh
   openshell gateway add https://127.0.0.1:17671 \
     --name nemoclaw-oidc \
     --oidc-issuer https://login.example.com/realms/openshell \
     --oidc-client-id REPLACE_WITH_CLI_CLIENT_ID \
     --oidc-audience openshell
   ```

   Where no browser can open, such as in a CI job, pass the ID of a confidential client in `--oidc-client-id`; its tokens must carry the audience and a role from `openshell.gateway.oidc`.
   Export its secret in `OPENSHELL_OIDC_CLIENT_SECRET` first, and keep it set while you run `openshell` commands, because the CLI gets each new token with it.

4. Run `openshell status`, and confirm that it reports the gateway as connected and authenticated.
   With only the `user_role` role, it reports `authorization denied`, because its check reads gateway details that only an admin can read.
5. [Select the gateway and workspace](../agents-inference/interfaces.md#selecting-the-gateway-and-workspace) with `OPENSHELL_GATEWAY=nemoclaw-oidc`, the entry name that apply's `REPLACE_WITH_PROFILE_NAME` stands for, and the workspace that apply prints.

A token with only the `user_role` role, unlike one with `admin_role`, reaches the deployment's workspace only after a Platform Admin adds the token's subject: until then, sandbox commands fail with `not a member of workspace` and print the `openshell workspace member add` command to run.
Reach a sandbox's services with [`openshell forward service`](../agents-inference/interfaces.md#forwarding-a-native-service), because service URLs need `enable_gateway_service_routing: true` in the `openshell.gateway` table of `spec.gateway.config`, and even then do not open as printed ([current limits](../resources/limits.md#access-and-diagnostics)).
With that setting, [service URLs](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) skip the gateway's sign-in, so each service must authenticate its own clients.

### Destroying a Managed Deployment

**Destroy deletes every sandbox, its in-memory conversation history, and its workspace claim.**
Run it with the same NemoClaw bundle and state directory as the deployment, and set the same kubeconfig and `environment` variables as for apply, because destroy reads them only from the environment and never asks for them.
Destroy reads no image metadata or inference credentials.
With the `oidc` profile, first put a fresh token in the variable that `token.env` names.
From the directory that holds the state directory, follow these steps:

1. Preview the removal with `nemoclaw plan --destroy --state-dir .local/kubernetes`.
2. Review the preview, then run `nemoclaw destroy --state-dir .local/kubernetes`, which does not prompt.

Destroy removes the sandboxes and their agents, the deployment's OpenShell workspace and provider registrations, the gateway's Helm release with its [cluster-wide objects](#preparing-the-cluster), and, with the `development` profile, the issuer.
It keeps the namespace, the gateway's volume, the Secrets that hold its keys and certificates, and the chart's certificate hook ServiceAccount, Role, and RoleBinding, which Helm does not remove, as [Finding Retained Kubernetes Objects](state.md#finding-retained-kubernetes-objects) lists.
It leaves the objects you created unchanged: a namespace that existed before the first apply, registry pull Secrets, and the `caConfigMap`.
Applying the same document with the same state directory reinstalls the gateway on the kept volume and recreates the sandboxes.
With `oidc`, a new deployment has a new CA, and `openshell gateway add` refuses an existing entry name, so before you reach a new deployment, run `openshell gateway remove nemoclaw-oidc`, with your entry's name, on each client host.

Use the following procedure for each situation:

| Situation | Procedure |
|---|---|
| You want to remove what destroy keeps, and the `Released` workspace volumes that a `Retain` reclaim policy leaves | [Removing Retained Resources](usage.md#removing-retained-resources) |
| Destroy failed or was interrupted while removing the gateway release | [Recovering an Interrupted Helm Removal](usage.md#recovering-an-interrupted-helm-removal) |
| An apply failed or stopped while Helm installed the gateway release, or plan, apply, or destroy names a gateway release that the state does not record | [Recovering From an Unfinished Helm Install](usage.md#recovering-from-an-unfinished-helm-install) |
| Destroy refuses, and names an object it recorded that is missing or was replaced | [Recovering When Destroy Refuses](usage.md#recovering-when-destroy-refuses) |

### Publishing the Gateway Outside the Cluster

The target's `expose` publishes the gateway at `expose.endpoint`, where other clients, such as the OpenShell CLI with the `oidc` profile, dial it without a port forward.
NemoClaw's own plan, apply, and destroy still use port forwards, so they still need `pods/portforward` ([current limits](../resources/limits.md#platforms-models-and-placement)).
On the `kubernetes` target, `expose` takes `endpoint` and `service`, and `service` sets the OpenShell chart's own gateway Service to `NodePort` at the endpoint's port, which passes TLS and client certificates through to the gateway unchanged.
Plan refuses a `route`, which only the `openshift` target takes, as [Publishing the Gateway Through a Route](openshift.md#publishing-the-gateway-through-a-route) describes.
A published gateway on a cluster other than kind is untested, and `expose.service` takes no `LoadBalancer` yet ([current limits](../resources/limits.md#platforms-models-and-placement)).
Add `expose` under `target.kubernetes`, as [the NodePort example](../../examples/platforms/kubernetes/published-nodeport.yaml) does: `expose: {endpoint: https://gateway.agents.example.com:30080, service: {type: NodePort}}`.

Choose the endpoint before the first plan, because `expose`, its endpoint, and the Service's type are [fixed after it](#writing-the-managed-deployment-document), and the chart writes the endpoint's host into the gateway certificate once, in the Secret `<release>-server-tls`, which destroy keeps.
The endpoint follows these rules:

- It has the form `https://HOST:PORT`, with no path, where `HOST` is a node's IPv4 address or a lowercase DNS name for the nodes.
- The port is in the cluster's node-port range, 30000 through 32767 by default.
  Ports 30000 through 30085 are the least likely to be taken, because Kubernetes leaves that band for Services that name their port.
  NemoClaw does not check the range: apply fails if Kubernetes refuses the port or another Service holds it.

Before you publish the gateway, consider the following:

- The port is open on every node, and the gateway authenticates each request by its token, not by a client certificate, so restrict who can reach the port with your network's own controls.
- The Service does not publish the gateway's plaintext metrics port, and the gateway then serves no metrics.
- With gateway service routing turned on, [service URLs](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) skip the gateway's sign-in, so anyone who reaches the endpoint with a service's host name reaches that service.

### Referencing Registry Credentials

On a managed gateway, sandbox pods pull with the Secrets in the deployment's namespace that OpenShell's `image_pull_secrets` setting names, in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway), as [the OIDC example](../../examples/platforms/kubernetes/managed-oidc.yaml) does with `image_pull_secrets: [registry-credentials]`.
Credential values stay in Kubernetes: NemoClaw does not read, create, rotate, or remove these Secrets, and destroy keeps them.
The gateway and its helper pods pull the public images that [`versions.json`](../../versions.json) pins, without pull Secrets ([current limits](../resources/limits.md#platforms-models-and-placement)).

Before the first apply, create the namespace, which NemoClaw then binds and never deletes, and its Secrets; without them, the first apply's sandboxes cannot pull, and OpenShell deletes them after five minutes.
Build each Secret from a protected Docker configuration file whose registry `auths` entries hold the credentials, as [Kubernetes registry authentication](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/) describes, because the kubelet cannot run a `credsStore` or `credHelpers` helper.
Run the following with your document's context and namespace in place of `my-cluster` and `nemoclaw-oidc`, skipping the first command if the namespace exists:

```sh
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster create namespace nemoclaw-oidc
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-oidc create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/private/registry/config.json
```

If a sandbox's image pull fails, read its pod's events, repair the Secret, and apply again with the same document and state directory.
Keep the credential file out of source control and shared diagnostics, and retire upstream registry credentials separately.

### Choosing the Gateway's StorageClass and Resources

The gateway keeps its SQLite database on a 1 GiB volume that the chart claims from the cluster's default StorageClass.
On a cluster without a default, or whose default is NFS, name a block-backed class in the target's `dataStorageClass`, because SQLite's write-ahead-log mode does not work on NFS and other network filesystems.
NemoClaw does not check that the class exists: a missing class leaves the gateway's claim pending and fails the apply, and creating the class and applying the same document again binds it.
`dataStorageClass` is [fixed after the first plan](#writing-the-managed-deployment-document), because the claim keeps the class it was created with.
Each sandbox's workspace claim also takes the default class, so on a cluster without one, also name a class in `workspace_storage_class`, in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway), as [the placement example](../../examples/platforms/kubernetes/sandbox-placement.yaml) does.

The gateway requests 250m CPU and 256 MiB of memory and is limited to 1 CPU and 2 GiB, which fit [256 sandboxes](#sandbox-count-and-cluster-size).
To change them, such as for a LimitRange whose maximum memory is below 2 GiB, set the target's [`resources`](../reference/configuration.md#managedkubernetes), which replaces all four values, so a quantity you leave out takes Kubernetes' default:

```yaml
spec:
  gateway:
    target:
      kubernetes:
        # kubeconfig, context, namespace, and authentication as in the preceding sections
        dataStorageClass: fast-ssd
        resources:
          requests: {cpu: 500m, memory: 512Mi}
          limits: {cpu: "2", memory: 4Gi}
```

Write memory in whole `Mi` or `Gi`, not `256m`, and CPU in quoted cores, such as `"2"`, or millicores, such as `500m`, and keep each request within its limit, or plan refuses the document.
Changing `resources` restarts the gateway, and its sandboxes and agents keep running.

### Running NemoClaw in a Pod

When `nemoclaw` runs in a pod, such as a CI job, omit the target's `kubeconfig` and `context`, and NemoClaw connects as the pod's service account, with the token and CA that Kubernetes mounts in `/var/run/secrets/kubernetes.io/serviceaccount/`.
Where `KUBERNETES_SERVICE_HOST` or `KUBERNETES_SERVICE_PORT` is unset, as outside a pod, plan then fails with `the pod's in-cluster Kubernetes configuration is missing`.
In the pod, omit `--kubeconfig` and `--context` from the `kubectl` commands on this page.
No automated test runs NemoClaw in a pod, and the following rules are untested on clusters other than kind ([current limits](../resources/limits.md#platforms-models-and-placement)).

To run NemoClaw in a pod, follow these steps:

1. Create the deployment's namespace, which NemoClaw then binds, and a service account for the pod in it.
   Kubernetes mounts the account's token unless the pod or the account sets `automountServiceAccountToken: false`.
2. Create a ClusterRole with the following rules, which include the chart's own, because Kubernetes lets an account create a Role or ClusterRole only with rules it holds itself:

   ```yaml
   rules:
     # NemoClaw's own rule, which the chart's ClusterRole also grants.
     - {apiGroups: [""], resources: [namespaces], verbs: [get]}
     - {apiGroups: [rbac.authorization.k8s.io], resources: [clusterroles, clusterrolebindings], verbs: [get, create, delete]}
     # Granted by the chart's ClusterRole.
     - {apiGroups: [""], resources: [nodes], verbs: [get, list, watch]}
     - {apiGroups: [node.k8s.io], resources: [runtimeclasses], verbs: [get]}
     - {apiGroups: [scheduling.k8s.io], resources: [priorityclasses], verbs: [get]}
     - {apiGroups: [authentication.k8s.io], resources: [tokenreviews], verbs: [create]}
   ```

3. Create a Role in the namespace with the following rules:

   ```yaml
   rules:
     - {apiGroups: [""], resources: [configmaps, serviceaccounts, services], verbs: [get, create, delete]}
     - {apiGroups: [""], resources: [secrets], verbs: [get, list, create, update, delete]}
     - {apiGroups: [apps], resources: [deployments, statefulsets], verbs: [get, create, delete]}
     - {apiGroups: [batch], resources: [jobs], verbs: [get, watch, create, delete]}
     - {apiGroups: [networking.k8s.io], resources: [networkpolicies], verbs: [get, create, delete]}
     - {apiGroups: [rbac.authorization.k8s.io], resources: [roles, rolebindings], verbs: [get, create, delete]}
     # The OpenTofu providers' port forwards; the WebSocket upgrade also needs create.
     - {apiGroups: [""], resources: [pods/portforward], verbs: [get, create]}
     # Granted by the chart's Roles.
     - {apiGroups: [""], resources: [pods], verbs: [get, list, watch, create, patch, delete]}
     - {apiGroups: [""], resources: [events], verbs: [get, list, watch]}
     - {apiGroups: [agents.x-k8s.io], resources: [sandboxes, sandboxes/status], verbs: [get, list, watch, create, update, patch, delete]}
     # Granted by the chart's Role when allow_driver_config is true.
     - {apiGroups: [""], resources: [persistentvolumeclaims], verbs: [get]}
   ```

4. Bind the ClusterRole with a ClusterRoleBinding, and the Role with a RoleBinding in the namespace, both to the service account.
5. Run the pod with that service account, a persistent volume for `--state-dir` that you keep across runs, the NemoClaw bundle, `deployment.yaml`, each metadata bundle, and the variables that the document's references name.

These rules cover plan, a first apply, export, and destroy with `workspace_mode: shared`, which NemoClaw sets, and OpenShell's default supervisor topology, but not what the chart's Roles and PodDisruptionBudget need with `supervisor_topology: gateway`.
They grant no `patch` or `update` on the chart's StatefulSets, Deployments, Services, or ConfigMaps, so if an apply that upgrades the gateway's release, such as after a `resources` or `spec.gateway.config` change, fails with a permission error, add those verbs to the Role.

## Deploying With an External Gateway

With `management: external`, a gateway operator runs OpenShell on the cluster, and NemoClaw connects to its endpoint without cluster access and changes only its own workspace, providers, and sandboxes on the gateway.
After [Preparing for Either Gateway](#preparing-for-either-gateway), copy [external-gateway.yaml](../../examples/platforms/kubernetes/external-gateway.yaml) to `deployment.yaml` in a new working directory, and give it a new UUID in `metadata.uid`, such as from `uuidgen`, and its own state directory, even when another document uses the same gateway ([Sharing a Gateway Across Deployments](../agents-inference/inference.md#sharing-a-gateway-across-deployments)).
Replace its image references as [Preparing Agent Images](#preparing-agent-images) describes, and its inference provider's `endpoint` and the route's `overrides.model` with your model server's, such as [one in the cluster](#using-a-model-server-in-the-cluster).

### What the Gateway Operator Provides

Before the first plan, get the following from the gateway operator:

| Item | Requirement |
|---|---|
| OpenShell | Exactly the version that your release's [`version-pins.json`](../references/compatibility.md#using-one-release-together) lists as `components.gateway.version`, or for a source build the `openshell` version in [`versions.json`](../../versions.json), with exactly one compute driver, `kubernetes`. |
| Endpoint | An `https://` address that the host running `nemoclaw` can reach. NemoClaw accepts an `http://` endpoint only on a literal loopback address. |
| TLS material | The CA certificate that signed the gateway's server certificate, unless a publicly trusted CA signed it, and a client certificate and key only when the gateway receives client certificates itself, not behind an ingress that terminates TLS. |
| Token | For a gateway that authenticates with OIDC, an access token for its audience, with the role and scopes that [Preparing for Either Gateway](#preparing-for-either-gateway) lists. |
| Cluster | Agent Sandbox, a StorageClass, and a network plugin that enforces NetworkPolicy, as [Preparing the Cluster](#preparing-the-cluster) describes, and room for the sandboxes, as [Sandbox Count and Cluster Size](#sandbox-count-and-cluster-size) describes. |
| OpenShell settings | An external gateway takes no `spec.gateway.config`, so the gateway operator sets OpenShell's settings: `image_pull_secrets` for private agent images, `allow_driver_config` for sandboxes with `driverConfig`, `workspace_storage_class` for workspace claims, OIDC, and service routing. |
| OpenShell CLI profiles | A profile for each person who invokes agents, whose token carries the gateway's `admin_role` role, or its `user_role` role once a Platform Admin adds them to the deployment's workspace with `openshell workspace member add`. NemoClaw's `credential` and `tls` references do not configure the CLI. Without a profile, create one with an OpenShell CLI at the gateway's version: put the operator's CA, if any, in `${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateways/NAME/mtls/ca.crt`, then run `openshell gateway add` with the endpoint and the issuer, as [Reaching the Gateway From the OpenShell CLI](#reaching-the-gateway-from-the-openshell-cli) shows for a managed gateway. |

### Connecting to the External Gateway

Set the example's `spec.gateway` fields as follows; plan and apply check the gateway before any change, and stop with the message in the last column when a field is wrong:

| Field | Value | Plan Stops With |
|---|---|---|
| `endpoint` | The gateway's `https://` origin, with no path, whose server certificate names its host. | `the gateway's TLS server certificate does not name the endpoint's host` |
| `credential` | Optional: the variable holding the operator's token, for a gateway that authenticates with OIDC. NemoClaw [reads it on every run](../security/credential-rotation.md#gateway-connections) and never refreshes it, so when it expires, set a new one and rerun. | `observation authentication failed` for an expired or refused token, or `observation permission denied` for one without the [administrator role](#preparing-for-either-gateway) |
| `tls.ca` | The variable holding the absolute path of the CA certificate file, which replaces the host's trusted CAs. Omit `tls` only when a publicly trusted CA signed the gateway's certificate and you use no client certificate. | `the gateway's TLS server certificate is not signed by the configured certificate authority`, or `observation authentication failed` when the file cannot be read |
| `tls.certificate` and `tls.key` | The variables holding the absolute paths of a client certificate and key, which also need `tls.ca`, only when the gateway receives client certificates itself, which no live test covers ([current limits](../resources/limits.md#access-and-diagnostics)). Otherwise delete both lines. | `the gateway refused the TLS client certificate`, or `observation authentication failed` when a file cannot be read |

Behind a Gateway API ingress, set `endpoint` and `tls.ca` as [Reaching an External Gateway Through an Ingress](#reaching-an-external-gateway-through-an-ingress) describes, before the first plan.
When the gateway's version or driver differs from [What the Gateway Operator Provides](#what-the-gateway-operator-provides), plan stops with `gateway runs OpenShell VERSION, but this build requires PINNED`, `gateway compute driver is DRIVER, but spec.gateway.target selects kubernetes`, or `gateway reports N compute drivers, but exactly one is required`.
The first successful plan fixes `metadata.uid`, `management`, the target, and `endpoint`, and a failed plan fixes nothing.
To change one of them before any apply, plan again with a new state directory, and after an apply, destroy the deployment and create a new one with a new `metadata.uid` and state directory ([Identifying the Failure](../observability/troubleshooting.md#identifying-the-failure)).

From the directory holding `deployment.yaml`, follow these steps:

1. Set the variables that the document names, such as these for the example without a client certificate:

   ```sh
   export GATEWAY_TOKEN="$(REPLACE_WITH_TOKEN_COMMAND)"
   export GATEWAY_CA="$PWD/gateway-ca.pem"
   export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/openclaw.metadata.json"
   export INFERENCE_API_KEY="$(REPLACE_WITH_KEY_COMMAND)"
   ```

   Plan and apply ask for an unset variable that they read, and with `--non-interactive` fail instead ([Credential Resolution](../references/cli.md#credential-resolution)).

2. Preview the deployment with `nemoclaw plan --state-dir .local/kubernetes deployment.yaml`, and stop on an error.
3. Apply it with `nemoclaw apply --state-dir .local/kubernetes deployment.yaml`, which prints the gateway's endpoint, the workspace, and the commands that [select them](../agents-inference/interfaces.md#selecting-the-gateway-and-workspace), with `REPLACE_WITH_PROFILE_NAME` in place of your OpenShell CLI profile.
   If apply fails, such as with `observation authentication failed` after the token expires, correct the cause and apply again with the same YAML, NemoClaw bundle, metadata bundles, and state directory.
4. Check that apply lists each agent with a runtime under `Agents`.

Keep the state directory, because destroy needs it.

### Reaching an External Gateway Through an Ingress

When a Gateway API ingress terminates TLS in front of the gateway, the gateway operator installs OpenShell behind it with OpenShell's [Kubernetes ingress guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/ingress.mdx), at the version that [What the Gateway Operator Provides](#what-the-gateway-operator-provides) names, in a setup that no automated test covers ([current limits](../resources/limits.md#platforms-models-and-placement)).
NemoClaw needs these choices from the operator:

- The guide's [end-to-end TLS](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/ingress.mdx#end-to-end-tls-backendtlspolicy) setup, because its `server.disableTls=true` setup sends bearer tokens unencrypted from the ingress to the gateway pod, and its plaintext setup gives an `http://` endpoint, which NemoClaw accepts only on a literal loopback address.
- An OIDC issuer, because the ingress forwards no client certificate, and for an issuer with a private CA, the chart's `server.oidc.caConfigMapName` naming a ConfigMap, created before the install in the release's namespace, whose `ca.crt` verifies it.
- No request timeout on the chart's `GRPCRoute`, because agent starts and agent requests run as `openshell sandbox exec` streams, and NemoClaw waits up to 90 seconds for a sandbox deletion.
  By default, Envoy Gateway ends any request longer than 15 seconds, so the operator disables the timeout with a `BackendTrafficPolicy` on the chart's route, with the gateway cluster's kubeconfig and context in place of `$NEMOCLAW_CLUSTER_KUBECONFIG` and `my-cluster`.
  The route is named `openshell` in the guide's `openshell` namespace, and for another release, it is the release's GRPCRoute in its namespace:

  ```sh
  kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster --namespace openshell apply -f - <<'EOF'
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

  Other Gateway API implementations might set a different default, or none, so check yours before the first apply.

In the deployment, delete `tls.certificate` and `tls.key`, and set the other fields from the ingress:

| Field | Value |
|---|---|
| `endpoint` | `https://` and the ingress's host name, with the listener's port when it is not 443, such as `https://gateway.example.com`. The listener certificate must name the host, and when the operator sets the chart's `grpcRoute.hostnames`, the host must be one of them. |
| `tls.ca` | The CA that signed the certificate in the Secret that the listener's `certificateRefs` names, `openshell-ingress-tls` in the guide, which is the chart's own CA only when the listener reuses the chart's server certificate Secret. Omit `tls` when a publicly trusted CA signed it. |

[Service URLs](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) skip the gateway's sign-in, so prefer [`openshell forward service`](../agents-inference/interfaces.md#forwarding-a-native-service).
They need the operator's `enable_gateway_service_routing: true`, and behind an ingress also a route of their own, as the guide's [Route Sandbox Service Traffic](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/ingress.mdx#route-sandbox-service-traffic) section describes, and they name the gateway pod's port 8080, which the ingress does not serve.

### Destroying an External-Gateway Deployment

**Destroy deletes every sandbox, its in-memory conversation history, and its workspace claim.**
Run it with the same NemoClaw bundle and state directory as the deployment, with the gateway's `credential` variable holding an unexpired token and its `tls` variables set, because destroy reads them only from the environment and never asks for them.
Destroy reads no image metadata or inference credentials.
From the directory that holds the state directory, follow these steps:

1. Preview the removal with `nemoclaw plan --destroy --state-dir .local/kubernetes`.
2. Review the preview, then run `nemoclaw destroy --state-dir .local/kubernetes`, which does not prompt.

If destroy stops partway, such as when the token expires, set a new token and run destroy again with the same state directory, because plan and apply refuse a state whose destroy is unfinished.

Destroy removes the deployment's sandboxes and agents, its provider registrations and profiles, and its OpenShell workspace, and leaves the gateway, its other workspaces, and the inference services.
Under a StorageClass with the `Retain` reclaim policy, each workspace volume stays `Released` with its files, so ask the gateway operator to remove the ones you no longer need.

## Using a Model Server in the Cluster

Sandboxes on either gateway can use a model server that is deployed in the gateway's cluster with the platform's own tools, by you or, with an external gateway, by someone with access to that cluster, and NemoClaw creates nothing for it ([current limits](../resources/limits.md#platforms-models-and-placement)).
Set the inference provider's `endpoint` to the server's Service by its cluster DNS name and port, such as `http://qwen.models.svc.cluster.local:8000/v1`, as [the in-cluster vLLM example](../../examples/platforms/kubernetes/vllm/in-cluster-vllm.yaml) does, or [the in-cluster Ollama example](../../examples/platforms/kubernetes/ollama/in-cluster-ollama.yaml) for a server without a key.
Before the first agent request, check the following:

| Topic | What to Know |
|---|---|
| Port | NemoClaw checks only the endpoint's form, and OpenShell refuses the Kubernetes control-plane ports 2379, 2380, 6443, 10250, and 10255 when sandboxes connect, so serve the model on another port. |
| Key | `credential` is optional and names the variable that holds the server's key where you run `nemoclaw`. OpenShell stores the key and adds it to sandbox requests, so give the server the same key from a Secret, as [Supplying the Key on Other Platforms](../agents-inference/inference.md#supplying-the-key-on-other-platforms) shows. The key crosses the cluster network over plain HTTP unless your network plugin or a service mesh encrypts Pod traffic. |
| Model IDs | The host running `nemoclaw` usually cannot resolve cluster names, so onboarding cannot list the server's models: write the route's model ID yourself. |
| Server | NemoClaw's vLLM and Ollama runtime images can run it, with the launch that `vllm_runtime` and `ollama_runtime` describe ([Direct OpenTofu Usage](../references/provider.md#direct-opentofu-usage)) and the readiness probes that [Supplying the Key on Other Platforms](../agents-inference/inference.md#supplying-the-key-on-other-platforms) gives. The vLLM image needs NVIDIA driver 580 or newer on the GPU nodes, which NemoClaw does not check. Ollama does not pull a model that a request names, so pull the route's model before the first request. |

[The GPU autoscaling example](../../examples/platforms/kubernetes/gpu-autoscaling/README.md) gives one sandbox per user a shared model Service that Kubernetes scales.

## Sandbox Count and Cluster Size

A document holds up to 256 sandboxes with a `kubernetes` or `openshift` gateway, so split a larger fleet across documents.
Each document has one gateway, one OpenTofu state, and with a managed gateway one namespace, so the cap also bounds what one gateway outage or slow plan affects.
Size the cluster for the sandboxes you declare, as this table does for 256:

| Resource | What 256 Sandboxes Need | Who Sets It |
|---|---|---|
| Pods | 512, two per sandbox with OpenShell's default supervisor topology, so at least five nodes at the kubelet's default of 110 pods per node, plus room for the gateway, the issuer, and the cluster's own pods | The cluster operator, who also gives a node allowed more than 250 pods a pod range larger than a /24 |
| Node CPU and memory | About 210 GiB of memory at about 0.85 GiB per OpenClaw sandbox, and for a sandbox that sets `cpu` or `memory`, that much allocatable, because Kubernetes makes it both the request and the limit ([CPU and Memory Limits](../agents-inference/agents.md#cpu-and-memory-limits)) | The cluster operator |
| Workspace storage | 512 GiB, at 2 GiB per sandbox by default | `workspace_storage_class` and `workspace_default_storage_size` in the `openshell.drivers.kubernetes` table, which the gateway operator sets for an external gateway |
| Gateway CPU and memory | Up to about 1.2 GiB of memory, within the managed gateway's [defaults](#choosing-the-gateways-storageclass-and-resources) of 250m CPU and 256 MiB requested and 1 CPU and 2 GiB limits | The target's `resources`, or for an external gateway, the gateway operator |
| Open files | 800 to 1,000 for the gateway, which holds about three connections per sandbox | The node's container runtime: k3d nodes on Docker set a soft limit of 1,024, which 256 sandboxes exceed, so create them with `k3d cluster create --runtime-ulimit "nofile=1048576:1048576"` |

OpenShell deletes a sandbox whose pod has not started within five minutes, so add sandboxes in steps that the StorageClass provisions in that time, such as at most 64 per apply with k3s's local-path provisioner, which makes about one volume every two seconds.

## Next Steps

[Invoke an agent](../agents-inference/interfaces.md#invoking-an-agent) through the OpenShell CLI, which needs the `oidc` profile on a managed gateway.
To declare a managed gateway in your own OpenTofu project instead, refer to [Managed Kubernetes Gateway](../references/provider.md#managed-kubernetes-gateway).
