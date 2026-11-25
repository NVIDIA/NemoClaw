<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploying to OpenShift

NemoClaw runs agent sandboxes on Red Hat OpenShift as it does on Kubernetes, with the same agent images and the same NVIDIA OpenShell gateway chart.
Follow [Deploying to Kubernetes](kubernetes.md) for every step, and apply the differences that this page lists.
Both gateway cases, which [Choosing a Gateway](kubernetes.md#choosing-a-gateway) compares, use the `openshift` target: a [managed gateway](#deploying-with-a-managed-gateway-on-openshift) that NemoClaw installs, and an [external gateway](#deploying-with-an-external-gateway-on-openshift) that a gateway operator runs.

## What Differs on OpenShift

OpenShift's default security context constraint (SCC), `restricted-v2`, admits a pod only with user IDs (UIDs) and groups from the ranges that OpenShift assigns to its namespace, and the following parts of a Kubernetes deployment differ:

| Topic | Gateway Case | On Kubernetes | On OpenShift |
|---|---|---|---|
| Managed gateway target | Managed | `spec.gateway.target.kubernetes` | `spec.gateway.target.openshift`, with the same fields, and its `expose` also takes `route` |
| External gateway target | External | `kubernetes: {}` | `openshift: {}`, and the gateway still reports OpenShell's `kubernetes` compute driver |
| Gateway pod IDs | Both | The chart's UID 1000 and `fsGroup` 1000, and UID and group 65534 for the shared supervisor that `supervisor_topology = "gateway"` adds | Assigned by `restricted-v2` from the namespace's ranges once the chart's IDs are `null`, which NemoClaw sets on a managed gateway and the gateway's operator on an external one |
| Sandbox user | Both | UID 10001 | The first UID of the namespace's UID range, which also owns the files the agent writes |
| Publishing the gateway | Managed | A NodePort Service | A NodePort Service or a pass-through Route |
| Agent image registry | Both | Any registry the nodes pull from | The same, including OpenShift's internal registry |
| Workspace volumes after destroy | Both | Kept or deleted by the StorageClass's reclaim policy | The same, and OpenShift Local's default StorageClass keeps them `Released` |

## Preparing the Cluster and Images

Before the first plan, the cluster needs the following, which the platform operator provides for a managed gateway and the gateway's operator for an external one.
NemoClaw checks none of them, and OpenShell's [OpenShift guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/openshift.mdx) states the last two:

- Agent Sandbox, a StorageClass, and a network plugin that enforces NetworkPolicy, as [Preparing the Cluster](kubernetes.md#preparing-the-cluster) describes.
- Nodes sized as [Sandbox Count and Cluster Size](kubernetes.md#sandbox-count-and-cluster-size) describes.
- OpenShift 4.19 or later, because the Red Hat Enterprise Linux CoreOS (RHCOS) kernels of OpenShift 4.16 through 4.18 lack Landlock, and sandboxes fail to start without it.
- A runtime profile that lets an unprivileged process install a nested seccomp user-notification filter and use Landlock, or each sandbox fails at startup.

OpenShell needs no SCC beyond `restricted-v2` and no added Linux capability: a managed gateway, its development issuer under the `development` profile, and the sandboxes run under `restricted-v2`.
With the `development` profile on a single-node cluster from the Agent-based Installer whose cluster domain has a wildcard DNS record, the gateway cannot reach the development issuer, and apply fails when Helm's wait times out.
[Diagnosing a Kubernetes Gateway Startup Failure](../observability/troubleshooting.md#diagnosing-a-kubernetes-gateway-startup-failure) gives the commands that confirm and fix it.

The identity that applies a managed deployment needs the rules that [Running NemoClaw in a Pod](kubernetes.md#running-nemoclaw-in-a-pod) lists, which include creating the chart's cluster-wide objects, as [Preparing the Cluster](kubernetes.md#preparing-the-cluster) describes, `create` on namespaces if NemoClaw creates the namespace, and the [Route rights](#publishing-the-gateway-through-a-route) when a Route publishes the gateway.

The agent images need no OpenShift variant: use the same images and metadata bundles as [Preparing Agent Images](kubernetes.md#preparing-agent-images) describes.
OpenShell seeds each sandbox's workspace by copying the image's `/sandbox` directory as the namespace's first UID, not the images' UID 10001.
NemoClaw's agent images keep everything in `/sandbox` readable by other users, as NemoClaw's image checks require, and [an image you derive from them](derived-images.md#keeping-what-nemoclaw-relies-on) must do the same.
A volume you mount into a sandbox must be writable by the namespace's UID, not by 10001, as [Keeping Agent Files on Mounted Volumes](state.md#keeping-agent-files-on-mounted-volumes) notes.

### Using the Internal Registry

To run agent images from OpenShift's internal registry, perform the following steps:

1. Copy each image's whole index through the registry's route into a namespace of the internal registry, `<image-namespace>` here, so its digest stays the same.
   With `oc image mirror`, pass `--keep-manifest-list=true --filter-by-os='.*'`, because by default it copies only the image for the platform that `oc` runs on, which changes the digest.
2. If the copy's digest differs from the original's, write the metadata bundle again from the copy with `--registry`, as [Writing Image Metadata for Kubernetes or OpenShift](build.md#writing-image-metadata-for-kubernetes-or-openshift) describes.
3. In each sandbox's `image.ref`, reference the copy by the address that the nodes pull from, `image-registry.openshift-image-registry.svc:5000/<image-namespace>/<name>@<digest>`.
4. Give the sandbox pods pull access to `<image-namespace>`:
   - On a managed gateway, create a pull Secret in the deployment's namespace with a login that can pull from `<image-namespace>`, and name it in `image_pull_secrets`, as [Referencing Registry Credentials](kubernetes.md#referencing-registry-credentials) describes.
   - On an external gateway, ask the gateway's operator to name such a Secret in the gateway's `image_pull_secrets`.

## Deploying With a Managed Gateway on OpenShift

**Use the `openshift` target from the first plan.**
With the `kubernetes` target, `restricted-v2` refuses the gateway's pod, and the target is [fixed after the first plan](kubernetes.md#writing-the-managed-deployment-document).
To change it later, create a new deployment with a fresh `metadata.uid`, a new state directory, and another namespace, as [Adapting a Document to Another Target](usage.md#adapting-a-document-to-another-target) describes.
To reuse the namespace instead, destroy the first deployment and [remove what it retains](usage.md#on-kubernetes-or-openshift) first.

To deploy with a managed gateway on OpenShift, follow [Deploying With a Managed Gateway](kubernetes.md#deploying-with-a-managed-gateway) with `target.openshift` wherever it writes `target.kubernetes`, in these steps:

1. Prepare the cluster and images as [Preparing the Cluster and Images](#preparing-the-cluster-and-images) describes.
2. Start from [the OpenShift example](../../examples/platforms/openshift/managed-development.yaml), or from [the Route example](../../examples/platforms/openshift/published-route.yaml) for a gateway that a Route publishes with the `oidc` profile.
   When you adapt a Kubernetes document instead, leave out its policy's `process.run_as_user` and `process.run_as_group`, which the Kubernetes example sets to `"10001"`, because each sandbox runs as the namespace's first UID.
3. Replace the values that [Writing the Managed Deployment Document](kubernetes.md#writing-the-managed-deployment-document) lists, under `spec.gateway.target.openshift`.
   Keep the `openshell.drivers.kubernetes` table in `spec.gateway.config`, because OpenShift runs OpenShell's Kubernetes driver.
   The target of the OpenShift example then reads as follows:

   ```yaml
   spec:
     gateway:
       management: managed
       target:
         openshift:
           kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
           context: replace-with-explicit-openshift-context
           namespace: nemoclaw-openshift-development
           authentication:
             profile: development
   ```

4. To publish the gateway, add `expose` as [Publishing the Gateway Through a Route](#publishing-the-gateway-through-a-route) describes.
5. Plan and apply as [Applying the Managed Deployment](kubernetes.md#applying-the-managed-deployment) describes.
   Messages about a field name it under `target.openshift`, and other messages say Kubernetes on both targets.
6. With the `oidc` profile, reach the gateway from the OpenShell CLI as [Reaching the Gateway From the OpenShell CLI](kubernetes.md#reaching-the-gateway-from-the-openshell-cli) describes.
   Without `expose`, plan and apply report the gateway as `not published` and point to the Kubernetes page.

### Running Under restricted-v2

`restricted-v2` refuses the following chart defaults, so on the `openshift` target, NemoClaw sets each value to `null`, and you set none yourself:

| Chart Value | Pod | Chart Default |
|---|---|---|
| `securityContext.runAsUser` | The gateway | UID 1000 |
| `podSecurityContext.fsGroup` | The gateway, which can read its signing key, mounted with mode 0400, only through this group | `fsGroup` 1000 |
| `supervisor.podSecurityContext.runAsUser`, `runAsGroup`, and `fsGroup` | The shared supervisor Deployment that the chart adds for all sandboxes with `supervisor_topology = "gateway"` in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway) | UID and group 65534 |

`restricted-v2` then runs the gateway as the first UID of the range in the namespace's `openshift.io/sa.scc.uid-range` annotation, with the first group of its `openshift.io/sa.scc.supplemental-groups` range as `fsGroup`.
[The chart's OpenShift install](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/deploy/helm/openshell/README.md#install-on-openshift) sets the gateway's values the same way, and [the chart's OpenShift overlay](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/deploy/helm/openshell/ci/values-openshift-scc.yaml) sets the shared supervisor's.
The chart's other security settings stay, including `runAsNonRoot`, the dropped capabilities, and the seccomp profile.
NemoClaw stops setting these values once the chart leaves the IDs to OpenShift ([NVIDIA/OpenShell#5483](https://github.com/ai-openshell/openshell/issues/5483), tracked in [#13828](https://github.com/NVIDIA/NemoClaw/issues/13828)), and the `openshift` target stays.

In [your own OpenTofu project](opentofu-project.md), NemoClaw sets none of these values, and `compute_driver = "openshift"` on the `openshell_kubernetes_*` resources changes no chart values, so add them to the `values` of your `helm_release`:

```yaml
securityContext:
  runAsUser: null
podSecurityContext:
  fsGroup: null
supervisor:
  podSecurityContext:
    runAsUser: null
    runAsGroup: null
    fsGroup: null
```

### Publishing the Gateway Through a Route

Only the `openshift` target's `expose` takes `route`, which has the chart create a Route for the endpoint's host with `passthrough` TLS termination.
The cluster's router forwards each connection, by the Server Name Indication (SNI) host name that the client sends, to the chart's gateway Service inside the cluster, with TLS and client certificates unchanged.
`expose` takes exactly one of `service` and `route`, so to publish through a NodePort Service instead, follow [Publishing the Gateway Outside the Cluster](kubernetes.md#publishing-the-gateway-outside-the-cluster).

Before the first plan, follow these steps:

1. Choose the endpoint's host, a lowercase DNS name that reaches the cluster's router, such as one under its apps domain.
   The chart writes the host into the gateway certificate, and plan refuses an IP address, because clients send no SNI host name for one.
2. Add `expose` to the `openshift` target, as [the Route example](../../examples/platforms/openshift/published-route.yaml) does for a gateway with the `oidc` profile:

   ```yaml
   spec:
     gateway:
       target:
         openshift:
           # kubeconfig, context, and namespace as in the OpenShift example
           authentication:
             profile: oidc
             caConfigMap: issuer-ca
             token: {env: NEMOCLAW_GATEWAY_TOKEN}
           expose:
             endpoint: https://nemoclaw-gateway.apps.example.com:443
             route:
               annotations:
                 haproxy.router.openshift.io/timeout: 1h
   ```

   [Authenticating Through an Existing OIDC Issuer](kubernetes.md#authenticating-through-an-existing-oidc-issuer) describes the `oidc` settings and the `issuer-ca` ConfigMap to create before the first apply.
   Set the Route's fields as follows:

   | Field | Value |
   |---|---|
   | `expose.endpoint` | `https://HOST:PORT` with no path, where `HOST` is the host you chose and `PORT` is the port that the router serves, usually 443. Write the port even when it is 443, or plan refuses the endpoint. NemoClaw does not check that the router serves the port. |
   | `expose.route.annotations` | Optional, so `route: {}` publishes the gateway without any. They reach the Route unchanged, such as the router's `haproxy.router.openshift.io` settings. Changing them updates the Route in place. |

3. Give the identity that applies the deployment the following rights, because Helm creates the Route with that identity:

   - `get`, `create`, and `delete` on `routes` in the `route.openshift.io` API group, and `patch` to change the Route, such as its annotations, in place.
   - `create` on `routes/custom-host`, because OpenShift sets a Route's host only for an identity that holds this right.

   OpenShift's `admin` and `edit` roles grant both.
   When [NemoClaw runs in a pod](kubernetes.md#running-nemoclaw-in-a-pod), the Role there grants no Route rights, so add these rules to it.

After the first plan, adding or removing `expose`, switching between a Service and a Route, or changing `expose.endpoint` needs a new deployment, and plan refuses it with `state is bound to a different gateway exposure` or `state is bound to a different gateway endpoint`.

Other clients dial the endpoint through the router, so to add the gateway to the OpenShell CLI, follow [Reaching the Gateway From the OpenShell CLI](kubernetes.md#reaching-the-gateway-from-the-openshell-cli) without its port forward, at `expose.endpoint`.
As with a NodePort Service, NemoClaw's own plan, apply, and destroy still reach the gateway through port forwards, so they still need `pods/portforward` ([#14422](https://github.com/NVIDIA/NemoClaw/issues/14422)).
The notes on service URLs and on retained certificate Secrets in [Publishing the Gateway Outside the Cluster](kubernetes.md#publishing-the-gateway-outside-the-cluster) apply to a Route too.

## Deploying With an External Gateway on OpenShift

Set `spec.gateway.management` to `external` and `spec.gateway.target` to `openshift: {}`, which takes no settings and behaves as `kubernetes: {}` does.
The target is fixed after the first plan, so plan refuses a later switch between the two.
The gateway must report OpenShell's `kubernetes` compute driver, because OpenShift runs that driver, and [Connecting to the External Gateway](kubernetes.md#connecting-to-the-external-gateway) lists this check and the others with their messages.

The gateway's operator installs the OpenShell chart with `securityContext.runAsUser` and `podSecurityContext.fsGroup` set to `null`, as the TLS installs in OpenShell's [OpenShift guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/kubernetes/openshift.mdx) do, so that `restricted-v2` admits the gateway.
That guide leaves the shared supervisor's IDs unchanged, so with `supervisor_topology = "gateway"`, the operator also sets the supervisor values that [Running Under restricted-v2](#running-under-restricted-v2) lists to `null`.
That guide publishes the gateway through a pass-through Route, on OpenShift 4.19 or later, or through the Gateway API with a BackendTLSPolicy, on OpenShift 4.22 or later, and the choice decides the deployment's TLS settings:

| Gateway Published Through | `tls.ca` | `tls.certificate` and `tls.key` |
|---|---|---|
| A pass-through Route | The CA that signed the certificate the gateway presents for the endpoint's host | Set both only when the gateway's operator gives you a client certificate, which the Route passes through to the gateway |
| The Gateway API with a BackendTLSPolicy, or another ingress that ends TLS | The CA that signed the listener certificate | Leave both out, because the ingress forwards no client certificate |

To connect to the gateway, follow these steps:

1. Start from [the OpenShift external example](../../examples/platforms/openshift/external-gateway.yaml), and keep or remove its `tls.certificate` and `tls.key` as the preceding table says:

   ```yaml
   spec:
     gateway:
       management: external
       target:
         openshift: {}
       endpoint: https://openshell.example.com
       credential: {env: GATEWAY_TOKEN}
       tls:
         ca: {env: GATEWAY_CA}
         # Only for a gateway that receives the client certificate itself.
         certificate: {env: GATEWAY_CERT}
         key: {env: GATEWAY_KEY}
   ```

2. Behind the Gateway API, use the deployment values in [Reaching an External Gateway Through an Ingress](kubernetes.md#reaching-an-external-gateway-through-an-ingress).
   That section's `BackendTrafficPolicy` is for Envoy Gateway, so on OpenShift, ask the gateway's operator to check that OpenShift's Gateway API implementation does not end long requests early.
   Agent starts and agent requests run through `exec` streams, and NemoClaw waits up to 90 seconds for a sandbox deletion.
3. Set the variables, plan, and apply as [Connecting to the External Gateway](kubernetes.md#connecting-to-the-external-gateway) describes.

## Destroying on OpenShift

Destroy works as on Kubernetes: follow [Destroying a Managed Deployment](kubernetes.md#destroying-a-managed-deployment) or [Destroying an External-Gateway Deployment](kubernetes.md#destroying-an-external-gateway-deployment).

**Under a StorageClass with the `Retain` reclaim policy, each sandbox's workspace files outlive the sandbox.**
OpenShift Local's default StorageClass uses `Retain`, so when destroy deletes each sandbox's workspace claim, its volume stays `Released` with the workspace files on it.

On a managed gateway, remove the retained objects and the `Released` volumes as [Removing Retained Resources on Kubernetes or OpenShift](usage.md#on-kubernetes-or-openshift) describes.
Listing the volumes there needs read access to PersistentVolumes across the cluster.
On an external gateway, ask the gateway's operator to remove the `Released` workspace volumes.

To keep workspace files from outliving their sandboxes on a managed gateway, name a StorageClass with the `Delete` reclaim policy in `workspace_storage_class`, in the `openshell.drivers.kubernetes` table of [`spec.gateway.config`](usage.md#configuring-a-managed-gateway).
On an external gateway, that setting is the gateway operator's.

## Current Limits on OpenShift

These limits apply on OpenShift, and [Current Limits](../resources/limits.md) tracks each one:

- No automated test deploys to OpenShift, and kind cannot run a managed `openshift` gateway ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
- A managed `openshift` gateway, including one that a Route publishes, is untested beyond one OpenShift Local 4.22.14 node on `linux/amd64` ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
  On OpenShift, a gateway that a NodePort Service publishes, a deployment with a shared supervisor ([#13828](https://github.com/NVIDIA/NemoClaw/issues/13828)), Route rights narrower than the `admin` or `edit` role, and a Route from NemoClaw in a pod are untested.
- On OpenShift, pulling agent images from the internal registry through the deployment's service accounts, such as with the `system:image-puller` role, instead of a pull Secret is untested ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
  Mounted volumes, and the vLLM runtime as a [model server in the cluster](kubernetes.md#using-a-model-server-in-the-cluster), are untested on OpenShift too.
- An external gateway that requires client certificates is untested, on OpenShift as elsewhere ([current limits](../resources/limits.md#access-and-diagnostics), [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).
