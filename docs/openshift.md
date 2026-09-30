<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy with the OpenShift Profile

Select `runtime.provider: openshift` to use OpenShell's Kubernetes driver with OpenShift prerequisites.
This branch implements the profile through the existing NemoClaw CLI and SDK lifecycle.
Validation is offline only; no OpenShift cluster or release has been qualified.
The [branch decision](design/scope.md#kubernetes-development-branch) defines that scope.

## Prepare the Cluster and Image

Start with the [Kubernetes prerequisites](kubernetes.md#cluster-prerequisites) and NVIDIA's [OpenShell OpenShift guide](https://docs.nvidia.com/openshell/kubernetes/openshift.md).
The platform owner must supply an enforcing CNI, compatible storage and capacity, registry access, and nodes with the pinned runtime's nested seccomp and Landlock capabilities.
A distribution name or API discovery result does not establish kernel, SCC admission, storage, network isolation, or inference compatibility.
The operator needs the namespaced and cluster-wide permissions required by the upstream OpenShell chart.
The managed example requires Agent Sandbox to be preinstalled; its compatible installation remains externally owned.
The existing explicit `prerequisites.agentSandbox.management: managed` choice can install absent pinned prerequisites, but that installation also awaits live OpenShift validation.

The managed profile checks for `security.openshift.io/v1` and `project.openshift.io/v1` before provisioning.
After creating its dedicated namespace, it records the namespace UID and assigned UID/GID allocations.
It accepts the standard positive `start/count` annotations and refuses missing, malformed, or changed allocations.
An absent supplemental-group allocation uses the UID allocation, matching the pinned OpenShell driver.
The gateway, development issuer, and network probes use those recorded numeric IDs with non-root execution, dropped capabilities, and no privilege escalation.
OpenShell independently selects the namespace identity for sandbox workloads and overrides the image's process-policy IDs with that identity.
The profile grants no `anyuid` or privileged SCC and adds no Route or ingress.

Build the OpenShift agent image on a matching native host, from the repository root:

```sh
python3 image/build_fabric.py --platform linux/amd64 openclaw-openshift
export NC_AGENT_IMAGE="$(docker image inspect nc-fabric:openclaw-openshift --format '{{index .RepoDigests 0}}')"
```

Use `linux/arm64` on an ARM64 host targeting ARM64 nodes.
The image keeps runtime files readable by namespace-assigned UIDs and supplies empty read-only workspace seeds.
The upstream init container copies those seeds into private directories owned by the selected namespace identity.
Export its [digest-verified metadata](kubernetes.md#prepare-image-metadata), then make the immutable image available to the cluster through the platform owner's registry process.
These commands do not publish an image or create a cluster.

## Provision a Managed Development Gateway

Copy [managed-development.yaml](../examples/openshift/managed-development.yaml) outside the checkout.
It defines three independent agents: `assistant`, `researcher`, and `reviewer`.
Replace the deployment UID, explicit context, dedicated namespace, and every image digest.
Supply the absolute kubeconfig and metadata paths through their environment references and populate the inference key privately:

```sh
export NEMOCLAW_CLUSTER_KUBECONFIG=/absolute/private/path/kubeconfig
export NEMOCLAW_AGENT_IMAGE_METADATA=/absolute/private/path/image-metadata.json
# Supply NVIDIA_INFERENCE_API_KEY through your shell or secret manager.
```

The managed target and every agent must select the same profile:

```yaml
gateway:
  management: managed
  endpoint: https://127.0.0.1:17671
  kubernetes:
    distribution: openshift
    kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
    context: replace-with-explicit-openshift-context
    namespace: nemoclaw-openshift-development
    prerequisites:
      agentSandbox:
        management: existing
    authentication:
      profile: development
```

Each sandbox uses:

```yaml
runtime:
  provider: openshift
```

Use a [verified native bundle](build.md#build-a-native-bundle) built from this revision.
The client also requires Python 3.12 or newer, `kubectl`, `helm`, and `openssl`; it does not require `kind` or `oc`.
From the directory containing the private manifest, use the ordinary CLI:

```sh
nemoclaw plan --state-dir ./state deployment.yaml
nemoclaw apply --state-dir ./state deployment.yaml
nemoclaw export --state-dir ./state --output exported.yaml
```

A fresh plan checks prerequisites and defers agent planning until the gateway exists.
Apply provisions the pinned upstream release, opens the authenticated loopback tunnel, then creates agents through OpenShell.
Mutual TLS, bearer authentication, and inference `credential.env` handling are unchanged from the Kubernetes path.
Read [development authentication and retained state](kubernetes.md#provision-a-managed-development-gateway) before use, including its seven-day certificate lifetime and one-hour retirement cutoff.
Keep the manifest, original bundle, and state after a failure; reapply only after correcting the reported prerequisite or configuration.
Do not replace an allocation or ownership receipt to bypass a mismatch.

## Use an Existing OpenShift Gateway

Use [external-gateway.yaml](../examples/openshift/external-gateway.yaml) with the exact gateway version, bearer and mutual-TLS references, image digest, and metadata artifact.
The platform owner configures OpenShell and validates the OpenShift namespace, admission, and runtime prerequisites.
The external path checks the upstream Kubernetes compute driver; it cannot independently identify the distribution behind that gateway and does not read a kubeconfig.
Export preserves the authored `openshift` profile.

## Retire and Validate

Run `nemoclaw destroy --state-dir ./state` with the original state and credentials.
It removes owned agents and registrations; managed mode also uninstalls its OpenShell release after agent teardown.
It retains the namespace, storage, development authentication, prerequisites, and OpenShell workspace as described in [Kubernetes retention](kubernetes.md#validate-and-retire-a-deployment).
It never deletes an OpenShift cluster or project automatically.

Offline tests cover schema and provider mapping, ownership and allocation drift, chart and authentication settings, and image metadata integrity.
The [offline validation record](validation/openshift-offline.md) lists completed checks and their limits.
Live admission, storage, kernel isolation, network-policy enforcement, and three-agent inference remain required before making a compatibility claim for a selected OpenShift environment.
