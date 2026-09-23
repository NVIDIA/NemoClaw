<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run the Kubernetes Backend

Select `runtime.provider: kubernetes` to deploy an agent through an existing OpenShell Kubernetes gateway.
The SDK retains its plan, apply, export, recovery, and destroy behavior; OpenShell creates the Kubernetes sandbox resources.
The normal path uses the gateway endpoint supplied by the cluster owner; it has no kind dependency.
The [branch scope decision](design/scope.md#kubernetes-development-branch) separates this deployment path from the optional [local kind test fixture](testing/kubernetes-kind.md).
The [recorded validation](validation/kubernetes-kind-linux-amd64.md) covers Linux AMD64 on kind; other cluster environments still need their own validation.

## Ownership and Boundaries

The gateway must report the exact OpenShell version in [versions.json](../versions.json) and the Kubernetes compute driver.
Every sandbox using that gateway must select Kubernetes.
Use `gateway.management: external` and inference provider `endpoint` connections.
Kubernetes configurations reject the local managed gateway and `spec.services` because those installers target Docker or Podman.
The platform owner installs OpenShell and the Kubernetes prerequisites separately from the SDK's agent deployment state.

| Owner | Resources |
|---|---|
| Platform owner | Kubernetes cluster, networking, storage, Agent Sandbox prerequisite, upstream OpenShell release, gateway authentication, and registry access |
| OpenShell and Agent Sandbox | Sandbox workloads, their supervisor, native policy, and workspace resources |
| NemoClaw SDK and OpenTofu | OpenShell workspace, provider definitions, sandbox bindings, runtime configuration, and readiness observations |

Ordinary apply still refuses sandbox removal or replacement and does not adopt missing or substituted bindings.
Destroy removes the agent deployment's workloads and retains the OpenShell workspace; it does not uninstall the gateway or destroy the cluster.
Selecting Kubernetes does not certify a cluster distribution, storage driver, network implementation, or admission policy.

## Cluster Prerequisites

Before applying, the platform owner must provide:

- A reachable OpenShell HTTPS gateway at the exact version in [versions.json](../versions.json), configured with the Kubernetes compute driver and its required permissions.
- The upstream Agent Sandbox controller and resources required by that gateway; the local validation used version `0.5.0`.
- Storage and scheduling capacity for the gateway, supervisors, and sandbox workspaces, with a workspace storage mode suitable for the cluster's nodes.
- Cluster networking that enforces the gateway's ingress and egress NetworkPolicies and permits supervisor Pods to reach DNS, the gateway, and declared inference endpoints while preserving the workload Pods' direct-egress fence.
- Gateway trust, a valid OpenShell bearer token, and client certificate files for the mutual TLS connection shown in the examples.
- Immutable agent images available to the target Linux nodes and compatible with their architecture, kernel isolation features, the gateway's runtime UID/GID, and the cluster's admission policy.

Check the pinned OpenShell [cluster runtime requirements](https://github.com/NVIDIA/OpenShell/blob/1fe79f53991debf32776853a60f0cbd4e127dcfb/docs/kubernetes/sandbox-runtime.mdx#check-cluster-requirements).
They include unprivileged nested seccomp user notification, usable Landlock, Pod scheduling gates, and the safe `net.ipv4.ip_unprivileged_port_start=0` sysctl.
The platform owner must control sandbox namespaces and OpenShell role labels to preserve network isolation.

Build the agent image from this revision using [the agent image procedure](build.md#build-agent-images).
The `openclaw-kubernetes` target matches the pinned gateway's UID and GID `10001` and private sandbox directory permissions.
Supply a registry reference reachable by the cluster; a digest in a client machine's Docker store is insufficient.
The platform owner provides any registry pull credentials separately from gateway and inference credentials.
Cluster-specific OpenShell installation, ingress, storage, and identity-provider configuration remain platform responsibilities.
The platform owner also configures and retains the gateway's credential encryption key and backing storage.

## Use an Existing Gateway

Start with the [external-gateway example](../examples/kubernetes/external-gateway.yaml).
Supply a fresh deployment UID, the exact gateway endpoint, credential references, a cluster-accessible immutable agent image, and an inference endpoint reachable from inside the sandbox.
The gateway and its Agent Sandbox prerequisite must already be installed by the platform owner.
An HTTPS gateway preserves certificate verification and uses separate bearer and mTLS references.
The bearer token authenticates the user; a client TLS certificate alone is insufficient.
Credential values stay outside the configuration.

The selected gateway owns sandbox placement; selecting Kubernetes does not read an ambient kubeconfig or contact the Docker socket.
Use a [verified native bundle](build.md) with its `bin` directory on `PATH`.
Keep the adapted YAML outside the checkout alongside its private deployment state.
After supplying the credentials described below, run from the directory containing `deployment.yaml`:

```sh
nemoclaw plan --state-dir ./state deployment.yaml
nemoclaw apply --state-dir ./state deployment.yaml
nemoclaw export --state-dir ./state --output exported.yaml
```

Plan observes the gateway; apply creates the declared OpenShell resources; export records observed configuration.
Keep the same UID, bundle, and state directory for subsequent operations.
On failure, retain them and follow [interrupted-operation recovery](usage.md#recover-an-interrupted-operation).
No-op apply still checks runtime health.
An application-health result does not establish a successful model response.

### Supply Credentials as on Docker

Kubernetes uses the same `credential: {env: VARIABLE_NAME}` mechanism as Docker and Podman.
The caller supplies environment values to the NemoClaw CLI or SDK process and its provider subprocess; the YAML contains only references.
The [Docker NVIDIA fixture](../crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/v1.yaml) and the Kubernetes hosted example both select `NVIDIA_INFERENCE_API_KEY`.
The [Docker Brev workflow](../.github/workflows/brev.yml) injects that variable from its repository secret named `NVIDIA_API_KEY`.

| Example reference | Value supplied to the client process |
|---|---|
| `gateway.credential.env: GATEWAY_TOKEN` | OpenShell bearer token issued by the platform's configured identity provider |
| `gateway.tls.ca.env: GATEWAY_CA` | Local path to the gateway CA certificate file |
| `gateway.tls.certificate.env: GATEWAY_CERT` | Local path to the client certificate file |
| `gateway.tls.key.env: GATEWAY_KEY` | Local path to the client private-key file |
| `inferenceProviders[].credential.env: NVIDIA_INFERENCE_API_KEY` | NVIDIA hosted API key |

The gateway variable names are examples, not reserved SDK settings.
The managed Docker fixture uses a local loopback gateway and does not declare these external-gateway credentials; its hosted inference credential uses the same reference mechanism.
A Kubernetes service-account token is not automatically an OpenShell bearer token.
See [credential ownership](usage.md#configuration-and-credentials) for storage, access, removal, and rotation limits.

For automated deployments, inject the same values through the CI runner's secret store or an operator-managed secret manager.
If the client runs inside Kubernetes, use [Secret-backed environment variables](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/#define-container-environment-variables-using-secret-data) for the bearer token and inference key, and read-only Secret volumes for TLS files.
Set the TLS environment variables to the mounted file paths, not to PEM contents.
This is configuration of the client Pod; `secretKeyRef` is not a NemoClaw YAML field, and the SDK does not read Kubernetes Secrets directly.
Restrict access to these Secrets and enable storage encryption through the platform's [Secret controls](https://kubernetes.io/docs/concepts/security/secrets-good-practices/).

A Secret update does not refresh an existing Pod's environment; recreate the client Pod before the next operation when using Secret-backed environment variables.
The gateway token is read when the connection is created, and the SDK does not refresh it automatically.
Changing an inference key's value under the same environment reference does not trigger an update of OpenShell's registered provider credential.
For an already authenticated provider, supply the new key through a new environment variable, update its `credential.env`, then review the plan and apply with the same deployment state.
Keep its provider name and endpoint unchanged; this updates the registered credential in place.
Verify inference before revoking the old upstream key.

### Deploy Multiple Agents

Both Kubernetes examples define three OpenClaw sandboxes: `assistant`, `researcher`, and `reviewer`.
Each sandbox has one `agent`, its own runtime and workspace files, and `runtime.provider: kubernetes`.
All three agents select `inferenceRef: chat`, which resolves to the shared `spec.inferences.chat` routes and one deployment-level inference provider.
The names identify independent agents; they do not configure specialized roles or automatic collaboration.
See [agent configuration](agents.md) for harness and inference settings.

Before applying, replace the image placeholder in every sandbox and supply one fresh deployment UID for the entire configuration.
Use one SDK state directory for all three sandboxes in that deployment.
Before the first apply, choose the agent count by adding or removing complete `spec.sandboxes` entries; keep sandbox names unique and retain the selected network policy on each entry.
The examples are checked by the schema and parser; the [recorded live validation](validation/kubernetes-kind-linux-amd64.md) covers a single OpenClaw sandbox.

### Reuse the Docker Hosted NVIDIA Profile

The [Kubernetes hosted NVIDIA example](../examples/kubernetes/hosted-nvidia.yaml) preserves the inference provider, API, model, and credential reference from the [Docker hosted fixture](../crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/v1.yaml) and shares that profile across three agents.
It uses `https://integrate.api.nvidia.com/v1`, model `nvidia/nemotron-3-super-120b-a12b`, API `openai-completions`, and credential environment variable `NVIDIA_INFERENCE_API_KEY`.
For Kubernetes, supply a fresh deployment UID, the external gateway connection, and the Kubernetes agent image, and keep the process UID and GID at `10001`.
Provide the referenced credential privately in the client process environment before plan or apply.
OpenShell stores the supplied provider credential; destroy removes its registration but does not revoke the upstream API key.
Unset the local variable after use and retire the key separately when it is no longer needed.
The [recorded live test](validation/kubernetes-kind-linux-amd64.md#observed-results) passed with the same endpoint and API using the user-selected Ultra model; the example keeps the Docker fixture's Super model for comparison.

## Validate and Retire a Deployment

Use [headless OpenClaw invocation](agents.md#run-one-headless-openclaw-request) to verify an actual model response separately from apply.
For a disposable single-agent deployment, the opt-in [Kubernetes lifecycle test](testing/live.md#kubernetes) checks apply, a model response, export, unchanged reapply, and destroy through the supplied gateway.
It does not create or delete a cluster.

To remove all agents and owned provider registrations in the deployment, run from the directory containing its original state:

```sh
nemoclaw destroy --state-dir ./state
```

The gateway, Kubernetes prerequisites, and OpenShell workspace remain under their existing owners.
Use the separate [kind test guide](testing/kubernetes-kind.md) only when creating or retiring an isolated local test cluster.
