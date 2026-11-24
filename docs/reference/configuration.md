<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# YAML Configuration Reference

<!-- Generated from the SDK schema. Edit Rust field descriptions and constraints, then run cargo run --locked -p nemoclaw-build -- schema. -->

This reference and the [JSON Schema](../../schemas/nemoclaw-v1alpha1.schema.json) describe authored YAML for this source revision.
See [schema maintenance](../../internal-docs/contributing/configuration-schema.md) for generation and validation commands.

Paths use `[]` for an array element and `{key}` for a map entry.
Required fields must appear when their containing object is present; conditional requirements are stated in the table or description.
An optional object can contain required fields if you choose to declare it.
Omit optional deployment fields instead of assigning `null`; nested Fabric settings and configuration follow the selected owner schema.
Defaults describe SDK normalization or backend behavior; JSON Schema validation does not insert values.
Empty or zero selects a default only where stated.

## Validation Beyond the Schema

- Document::parse rejects YAML aliases, anchors, merge keys, all explicit tags (including core tags such as !!binary), duplicate keys, multiple documents, and input larger than 1 MiB. It applies the compiled input schema before defaulting; Document::validate applies the normalized schema and semantic checks, including for directly constructed Rust values.
- The parser checks the shape of every endpoint URL and the gateway endpoint's transport and address policy; OpenShell checks inference destinations when sandboxes connect. It also checks canonical private IPv4 /24 networks, local engine socket syntax, and publication address/port/network agreement.
- A managed kubernetes or openshift target requires a namespace and an authentication profile, and a kubeconfig environment reference and context together; omitting both selects the service account of the pod that runs NemoClaw. Agent Sandbox, and the StorageClass that dataStorageClass names or else a default one, are platform prerequisites that are not checked. Each request in resources must not exceed its limit, compared in millicores or mebibytes. Without expose, the document names no endpoint: each command forwards a free local port to the gateway pod. With it, expose.endpoint names a lowercase DNS name or IPv4 address and an explicit port. expose.service has the chart's NodePort Service publish that port, which Kubernetes checks against the cluster's node-port range; expose.route, only on the openshift target, has the chart's pass-through Route publish the host, which must be a DNS name, at the port the cluster's router serves. Managed inference services are excluded. OpenShift uses the upstream Kubernetes driver and requires platform-owned OpenShift security prerequisites. Namespace identity, ownership, and credential files are checked during operations.
- Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.
- Explicit filesystem grants must permit reads of the paths the selected image's runtime requires, such as Fabric's /opt/fabric; parent and read-write grants count. Planning checks them against the image's metadata; it does not resolve symlinks or establish runtime permissions.
- The schema requires an explicit default for multiple model choices. Rust checks unique route names, that the default names a route, and that native model and tool fields have valid structural shapes. Fabric validates adapter-specific combinations.
- The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and missing agent references, and permits at most one attached web search definition per sandbox. Native search must be authored separately through public Fabric configuration and validated by Fabric. Agent-inline definitions attach directly; unused enclosing definitions grant no access.
- The schema requires exactly one sandbox harness or harnessRef and rejects agent-level harness selection. Rust resolves visible harnesses without shadowing. Each sandbox requires one agent and hosts one Fabric runtime using the sandbox-selected implementation. Shared definitions reuse configuration across sandboxes.
- Native reasoning-effort identifiers are preserved for Fabric validation. Managed inference services may constrain routes to their declared served model.
- Rust resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names and shadowing. The schema rejects inline/reference ambiguity.
- The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 providers attached to one sandbox (its inference providers, web search, and api integrations, OpenShell's limit per sandbox), incompatible managed-service combinations, and compares route models and authentication with the selected provider. Provider transport and reference consistency are checked after reference resolution for both inline and shared definitions. Unselected definitions create no resources. Snapshot identity must match the service model.
- The parser checks memory threshold ordering and GPU/KV budget relationships; that a recipe's GPU belongs to a hardware profile's GPU family; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.
- Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation.

## Document

Desired configuration for one deployment. Fields describe authored input before SDK normalization.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `document root`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `apiVersion` | string | Yes | — | Configuration API version understood by this SDK. Constraints: `"nemoclaw.nvidia.com/v1alpha1"`. |
| `kind` | string | Yes | — | Configuration document kind. Constraints: `"NemoClawConfig"`. |
| `metadata` | [Metadata](#metadata) | Yes | — | Deployment name and durable ownership identity. |
| `spec` | [Spec](#spec) | Yes | — | Gateway, inference provider, and sandbox configuration. |

## Agent

One agent instance with its own inference choices, tools, and integrations.

Guide: [Agent runtimes](../agents-inference/agents.md).

Paths:

- `spec.sandboxes.{key}.agent`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `auth` | [AgentAuth](#agentauth) | No | — | Require API-key authentication through the selected routed provider. The provider must supply a credential. |
| `inference` | [Inference](#inference) | No | — | Inline inference configuration. Exactly one of inference or inferenceRef is required. |
| `inferenceRef` | string | No | — | Name of an enclosing inference configuration. Excludes inline inference. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `instructions` | object | No | — | Fabric's instructions section, passed to Fabric unchanged: the agent's system prompt and instruction files. Fabric validates it against the selected adapter. |
| `integrationRefs` | array of string | No | — | Unique integration names selected from spec.integrations or this sandbox's integrations. Omission selects no enclosing definitions. Constraints: items: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions attached directly to this agent. Names must not collide with definitions in enclosing scopes. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `mcp` | object | No | — | Fabric's MCP section, passed to Fabric unchanged. NemoClaw grants no network access or credentials for the servers it names. |
| `name` | string | Yes | — | Lowercase agent name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `skills` | object | No | — | Fabric's skills section, passed to Fabric unchanged, such as directories and duplicates. Paths are absolute sandbox paths. |
| `tools` | object | No | — | Fabric's tools section, passed to Fabric unchanged, such as enabled, blocked, and definitions. Fabric validates tool identifiers against the selected adapter; this does not change OS-level filesystem permissions. |
| `workflow` | object | No | — | Fabric's workflow section, passed to Fabric unchanged: the registered workflow target the agent runs. |

## AgentAuth

Authenticate inference using the primary route's credential-bearing provider.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.sandboxes.{key}.agent.auth`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `method` | [AuthMethod](#authmethod) | Yes | — | API-key authentication. Interactive login is not supported. |

## ApfPolicyAuthority

Who registers APF with the gateway as its interceptor and provider-profile source.

Guide: [Letting APF author sandbox policy](../build-deploy/usage.md#letting-apf-author-sandbox-policy).

Paths:

- `spec.gateway.policyAuthority.apf`

Accepted input: object.

### Alternative 1

NemoClaw registers APF in a managed Docker gateway's configuration file.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | APF's gRPC origin as the gateway reaches it: `https://HOST[:PORT]`, without a path. Constraints: pattern `^https://[^/?#@]+$`. |
| `registration` | string | Yes | — | Who registers APF with the gateway: managed means NemoClaw does, external means the gateway's operator does. Constraints: `"managed"`. |
| `tls` | [InterceptorTls](#interceptortls) | No | — | The CA certificate that verifies APF; omission uses the gateway's system roots. |

### Alternative 2

The gateway's operator registers APF, such as in spec.gateway.config. Required on an external gateway.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `registration` | string | Yes | — | Who registers APF with the gateway: managed means NemoClaw does, external means the gateway's operator does. Constraints: `"external"`. |

## ApiAuthStyle

How an API key is sent.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.integrations.{key}.authStyle`
- `spec.sandboxes.{key}.agent.integrations.{key}.authStyle`
- `spec.sandboxes.{key}.integrations.{key}.authStyle`

Accepted input: string.

Constraints: `"bearer"` or `"header"`.

## AuthMethod

Authentication method supported through the OpenShell provider.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.sandboxes.{key}.agent.auth.method`

Accepted input: string.

Constraints: `"api-key"`.

## AuthorizationMode

OpenShell's service authorization modes.

Guide: [Agent interfaces](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway).

Paths:

- `spec.sandboxes.{key}.serviceExposures.{key}.authorizationMode`

Accepted input: string.

Constraints: `"STRIP"` or `"BEARER_PASSTHROUGH"`.

## Compatibility

Execution host requirements and labels that must be present on the pinned image.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.compatibility`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `architecture` | string | Yes | — | Execution host CPU architecture. Constraints: `"arm64"` or `"amd64"`. |
| `gpu` | string | Yes | — | GPU name that must equal the observed device name. It must belong to a hardware profile's GPU family; that profile's memory architecture decides whether the GPU budget is checked against GPU or host memory. Constraints: minimum characters 1. |
| `imageLabels` | map of string | Yes | — | Required org.nemoclaw.* labels. org.nemoclaw.recipe.protocol must equal v1. Constraints: keys: pattern `^org\.nemoclaw\.`; values: minimum characters 1; maximum characters 256. |
| `minDriverMajor` | integer | Yes | — | Minimum NVIDIA driver major version. Constraints: minimum 1; maximum 10000. |
| `minHostMemoryGiB` | integer | Yes | — | Minimum total host memory in GiB. Constraints: minimum 1; maximum 4096. |

## Compilation

Typed vLLM compilation settings.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.serving.compilation`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `captureSizes` | array of integer | Yes | — | Nonempty list of CUDA graph capture sizes. Constraints: minimum items 1; maximum items 64; items: minimum 1; maximum 65536. |
| `cudagraphMode` | string | Yes | — | CUDA graph execution mode. Constraints: `"NONE"` or `"FULL_DECODE_ONLY"`. |
| `mode` | integer | Yes | — | Compilation mode understood by the pinned vLLM image. Constraints: minimum 0; maximum 3. |

## ContainerData

An owned disposable data volume. The image must supply a mount directory writable by its configured user.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.data`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `mountPath` | string | Yes | — | /data or one application directory below /var/lib. Constraints: pattern `^(/data\|/var/lib/[a-z][a-z0-9-]{0,62})$`. |

## ContainerExecution

Container execution limits, independent of application/model memory policy.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.container`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `cpuLimitMillis` | integer | No | — | CPU limit in millicores. Omission leaves CPU usage unrestricted. Constraints: minimum 1; maximum 4294967295. |
| `gpu` | boolean | No | — | Expose the engine's GPU devices. Omission leaves GPU access disabled. |
| `ipc` | [ServiceIpc](#serviceipc) | No | — | Private IPC by default; host shares the host IPC namespace. |
| `memoryLimitGiB` | integer | No | — | Container memory limit in GiB; not a GPU-memory reservation. Omission selects 1 GiB. Constraints: minimum 1; maximum 8589934591. |
| `sharedMemoryGiB` | integer | No | — | Shared memory in GiB. Omission selects 64 MiB. Constraints: minimum 1; maximum 64. |
| `ulimits` | map of integer | No | — | Process limits by Docker limit name. Each value sets both soft and hard limits; -1 means unlimited. |

## ContainerPublication

One application TCP listener on the host.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.publication`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bindAddress` | string | Yes | — | Loopback or private host IPv4 address. |
| `port` | integer | Yes | — | Same unprivileged TCP port inside the container and on the host. Constraints: minimum 1024; maximum 65535. |

## ContainerReadiness

Readiness observation. Omission uses the image's Docker HEALTHCHECK.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.readiness`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `path` | string | No | — | HTTP GET path on the container's listener. Success requires HTTP 200; redirects are not followed. |
| `runtimeStatus` | string | No | — | Managed-runtime status file containing phase and updated. Requires a ready report from this container start, not an old volume's report. |
| `timeoutSeconds` | integer | No | — | Startup wait in seconds, 1–3600. Omission selects 300. Constraints: minimum 1; maximum 3600. |

## DedicatedHardware

Requirements each selected NVIDIA GPU with dedicated memory on Linux AMD64 must meet. Declaring requirements does not qualify a model or host.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.hardware`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `architecture` | string | Yes | — | CPU architecture; this dedicated-memory contract requires amd64. Constraints: `"amd64"`. |
| `minComputeCapability` | integer | Yes | — | Minimum NVIDIA compute capability, encoded as major times ten plus minor; 90 means 9.0. Constraints: minimum 10; maximum 999. |
| `minDriverMajor` | integer | Yes | — | Minimum installed NVIDIA driver major version. Constraints: minimum 1; maximum 9999. |
| `minGpuMemoryBytes` | integer | Yes | — | Minimum total dedicated memory of each selected GPU in bytes. Host RAM is measured separately. Constraints: minimum 4294967296; maximum 4398046511104. |

## DockerTarget

A managed gateway container on a local Docker engine.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.docker`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | No | `"unix:///var/run/docker.sock"` | The local engine's API service, which NemoClaw installs the gateway with and which runs every sandbox: a Unix socket, or on Windows a local engine's named pipe such as `npipe:////./pipe/docker_engine`, in which case the gateway binds `/var/run/docker.sock` in the engine's VM, as it does on macOS for Docker Desktop's, Colima's, Rancher Desktop's, or a Podman machine's socket. Constraints: `""` or pattern `^(unix:///\|npipe:////\./pipe/)`. Omitted or empty selects Docker's default socket. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before local container creation: IfNotPresent, the default, or Never. Constraints: `"IfNotPresent"` or `"Never"`. |
| `networkCIDR` | string | No | — | Canonical private IPv4 /24 of the network the gateway and its sandboxes share. Constraints: `""` or pattern `/24$`. Omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid). |
| `port` | integer | No | `17681` | Loopback TCP port the gateway listens on, from 1024 through 65535. NemoClaw and the OpenShell CLI reach the gateway at `http://127.0.0.1:PORT`. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |

## ExplicitPolicy

Credential-free OpenShell policy. Validation and protocol conversion use the pinned OpenShell policy library.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}`
- `spec.sandboxes.{key}.network.policy.explicit`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `filesystem_policy` | [PolicyFilesystem](#policyfilesystem) | No | — | Filesystem grants. Omission retains OpenShell filesystem defaults, not the isolated preset. |
| `landlock` | [PolicyLandlock](#policylandlock) | No | — | Kernel filesystem enforcement compatibility. |
| `network_middlewares` | map of [PolicyMiddleware](#policymiddleware) | No | — | Supervisor middleware attachments keyed by policy-local names, which OpenShell's logs report. Each names a built-in middleware or a service registered in the gateway's `openshell.supervisor.middleware` configuration, and selects the admitted destination hosts it runs for. |
| `network_policies` | map of [PolicyRule](#policyrule) | Yes | — | Named egress rules. An empty map grants no general egress. |
| `process` | [PolicyProcess](#policyprocess) | No | — | Sandbox process user and group. |
| `version` | integer | Yes | — | Policy format version; currently 1. Constraints: `1`; minimum 0; maximum 4294967295. |

## ExplicitPolicySelection

Select an explicit policy; no isolated defaults are merged into it.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.sandboxes.{key}.network.policy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `explicit` | [ExplicitPolicy](#explicitpolicy) | Yes | — | Complete sandbox policy in OpenShell YAML field names. |

## ExposureRoute

The OpenShift Route that publishes a managed gateway.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.openshift.expose.route`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `annotations` | map of string | No | — | Annotations on the Route, such as `haproxy.router.openshift.io/timeout`. OpenShift checks them; changing them updates the Route in place. |

## ExposureService

The Service that publishes a managed cluster gateway.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes.expose.service`
- `spec.gateway.target.openshift.expose.service`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `type` | string | Yes | — | `NodePort` listens on the endpoint's port on every node; the port must be in the cluster's node-port range, 30000 through 32767 by default. Constraints: `"NodePort"`. |

## ExternalCluster

No settings: each sandbox's image.metadata stands in for an engine NemoClaw could inspect.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes`
- `spec.gateway.target.openshift`

Accepted input: object.

## ExternalEngine

The engine holding an existing gateway's sandbox images.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.docker`
- `spec.gateway.target.podman`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | No | — | Engine containing the sandbox images, used only for image metadata inspection. Required for deployment planning; omission permits retained-state teardown. |

## ExternalOllama

External Ollama daemon observed by the managed proxy installer.

Guide: [External Ollama through a managed proxy](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy).

Paths:

- `spec.services.{key}.upstream`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | Loopback-only Ollama HTTP endpoint ending in /v1. |
| `model` | [ExternalOllamaModel](#externalollamamodel) | Yes | — | Existing model verified before the proxy starts. |

## ExternalOllamaModel

Existing Ollama model installation, independently owned outside the deployment.

Guide: [External Ollama through a managed proxy](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy).

Paths:

- `spec.services.{key}.upstream.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `digest` | string | Yes | — | Lowercase 64-character model digest reported by Ollama's /api/tags API. Constraints: pattern `^[a-f0-9]{64}$`. |
| `name` | string | Yes | — | Installed Ollama model name including its tag. Constraints: pattern `^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$`. |

## ExternalTarget

Where an existing gateway runs its sandboxes: exactly one of docker, podman, kubernetes, and openshift.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target`

Accepted input: object.

### Alternative 1

A gateway that runs sandboxes on a Docker engine.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `docker` | [ExternalEngine](#externalengine) | Yes | — | A gateway that runs sandboxes on a Docker engine. |

### Alternative 2

A gateway that runs sandboxes on a Podman engine.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `podman` | [ExternalEngine](#externalengine) | Yes | — | A gateway that runs sandboxes on a Podman engine. |

### Alternative 3

A gateway that runs sandboxes on a Kubernetes cluster.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `kubernetes` | [ExternalCluster](#externalcluster) | Yes | — | A gateway that runs sandboxes on a Kubernetes cluster. |

### Alternative 4

A gateway that runs sandboxes on an OpenShift cluster.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `openshift` | [ExternalCluster](#externalcluster) | Yes | — | A gateway that runs sandboxes on an OpenShift cluster. |

## File

One immutable file in a model snapshot.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.snapshot.files[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Relative file path. Traversal and reserved NemoClaw metadata names are rejected. Constraints: minimum characters 1. |
| `sha256` | string | Yes | — | Lowercase SHA-256 of the complete file. Constraints: pattern `^[a-f0-9]{64}$`. |
| `size` | integer | Yes | — | Expected file length in bytes; zero is rejected. Constraints: minimum 1. |

## FileRef

Environment variable whose value is the path of a local file; the configuration holds neither the path nor the file.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.policyAuthority.apf.tls.ca`
- `spec.gateway.target.kubernetes.kubeconfig`
- `spec.gateway.target.openshift.kubeconfig`
- `spec.gateway.tls.ca`
- `spec.gateway.tls.certificate`
- `spec.gateway.tls.key`
- `spec.sandboxes.{key}.image.metadata`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `env` | string | Yes | — | Uppercase name of the caller environment variable that holds the local file path. NEMOCLAW_KUBERNETES_STATE and the NEMOCLAW_MANAGED_K8S_, HELM_, KUBE_, and KUBERNETES_SERVICE_ prefixes are reserved for runtime controls. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

## Gateway

Install a gateway on a local engine or an existing cluster, or connect to an existing gateway.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway`

Accepted input: object.

### Alternative 1

A gateway installed and managed by this deployment. The SDK pins its image.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `config` | any JSON value | No | — | OpenShell gateway settings in the OpenShell Helm chart's gatewayConfig format: each key names a TOML table, such as openshell.drivers.docker, and holds its fields; nested maps are inline tables, and a list of maps is an array of tables. Docker and Podman gateways write it into the configuration file of each new gateway container, so a change replaces the container and keeps its data; Kubernetes and OpenShift pass it to the chart's gatewayConfig. OpenShell validates the settings; keys NemoClaw manages are rejected. Must not contain secrets. |
| `management` | string | Yes | — | Whether this deployment manages the gateway. Constraints: `"managed"`. |
| `policyAuthority` | [PolicyAuthority](#policyauthority) | No | — | Who authors sandbox policy on this gateway; omission means NemoClaw does. |
| `target` | [ManagedTarget](#managedtarget) | No | — | Where NemoClaw installs the gateway, which also selects the compute driver it runs every sandbox with. Omission selects Docker with its defaults. |

### Alternative 2

An existing gateway managed outside this deployment.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `credential` | [SecretRef](#secretref) | No | — | Optional bearer credential reference for an external HTTPS gateway. |
| `endpoint` | string | Yes | — | Gateway HTTP(S) origin, without a path. Constraints: pattern `^https?://`. |
| `management` | string | Yes | — | Whether this deployment manages the gateway. Constraints: `"external"`. |
| `policyAuthority` | [PolicyAuthority](#policyauthority) | No | — | Who authors sandbox policy on this gateway; omission means NemoClaw does. |
| `target` | [ExternalTarget](#externaltarget) | No | — | Where the existing gateway runs its sandboxes; omission selects Docker. Planning checks it against the compute driver the gateway reports. |
| `tls` | [TLS](#tls) | No | — | Optional TLS references for an external HTTPS gateway: a CA alone, or with a client certificate and key for mutual TLS. |

## GatewayResourceList

Quantities of CPU and memory.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes.resources.limits`
- `spec.gateway.target.kubernetes.resources.requests`
- `spec.gateway.target.openshift.resources.limits`
- `spec.gateway.target.openshift.resources.requests`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `cpu` | string | No | — | CPU in cores with up to three decimals, such as "1" or "0.5", or in millicores, such as 250m. Quote cores: YAML reads an unquoted 1 or 0.5 as a number. Constraints: pattern `^(?:[0-9]{1,6}(?:\.[0-9]{1,3})?\|[1-9][0-9]{0,8}m)$`. |
| `memory` | string | No | — | Memory in whole mebibytes or gibibytes, such as 512Mi or 2Gi. Kubernetes reads a lowercase m as thousandths of a byte. Constraints: pattern `^[1-9][0-9]{0,8}(?:Mi\|Gi)$`. |

## GatewayResources

A Kubernetes container's CPU and memory requests and limits.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes.resources`
- `spec.gateway.target.openshift.resources`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `limits` | [GatewayResourceList](#gatewayresourcelist) | No | — | The most the gateway may use: Kubernetes throttles its CPU at the CPU limit, and restarts it after it exceeds the memory limit. |
| `requests` | [GatewayResourceList](#gatewayresourcelist) | No | — | What the scheduler reserves for the gateway on its node. Each request must not exceed its limit. |

## GgufModel

Exact immutable public artifact, independently hashed before serving.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `file` | string | Yes | — | Relative .gguf path at that commit; traversal, backslashes and reserved metadata paths are rejected. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.gguf$`; minimum characters 6; maximum characters 512. |
| `repository` | string | Yes | — | Public Hugging Face owner/repository containing the GGUF. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$`; maximum characters 200. |
| `revision` | string | Yes | — | Exact lowercase 40-character repository commit; branches and tags are rejected. Constraints: pattern `^[a-f0-9]{40}$`. |
| `sha256` | string | Yes | — | Lowercase SHA-256 of the complete GGUF, checked on acquisition; warm starts observe verified size and modification time. Constraints: pattern `^[a-f0-9]{64}$`. |
| `sizeBytes` | integer | Yes | — | Exact nonzero GGUF byte length, used to bound acquisition and disk requirements. Constraints: minimum 1; maximum 1099511627776. |

## Grant

Endpoint grants added to the isolated preset, restricted to executables.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.grants.{key}`
- `spec.sandboxes.{key}.network.grants.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `binaries` | array of [PolicyBinary](#policybinary) | No | — | Executables allowed to use the endpoints. Omitted or empty selects the harness's executables. |
| `endpoints` | array of [PolicyEndpoint](#policyendpoint) | Yes | — | Allowed destinations and optional application-protocol restrictions, in OpenShell's endpoint shape. |

## HardwareProfile

GPU-family contracts, not model or whole-system qualifications. System profiles fix ARM64; GPU profiles require architecture. Each currently requires one visible GPU.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.hardware.profile`

Accepted input: string.

Constraints: `"dgx-spark"` or `"rtx-spark"` or `"dgx-station"` or `"gb200"` or `"gb300"` or `"gh200"` or `"h100"` or `"h200"` or `"a100"` or `"a10"` or `"a10g"` or `"a40"` or `"l4"` or `"l40"` or `"l40s"` or `"t4"` or `"rtx-6000-ada"` or `"rtx-pro-6000-blackwell"` or `"rtx-3090"` or `"rtx-4090"` or `"rtx-5090"`.

## Harness

One harness runtime configuration. Every sandbox runs its own instance for its configured agent.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.harnesses.{key}`
- `spec.sandboxes.{key}.harness`
- `spec.sandboxes.{key}.harnesses.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `discovery` | object | No | — | Fabric's discovery section, passed to Fabric unchanged: additional descriptor discovery paths in the sandbox. |
| `environment` | object | No | — | Fabric's environment section, passed to Fabric unchanged. The deployment sets provider to local and workspace to /sandbox/workspace; a different authored value fails. |
| `kind` | string | Yes | — | Fabric harness implementation for the sandbox agent. Constraints: pattern `\S`; minimum characters 1. |
| `relay` | object | No | — | Fabric's relay section, passed to Fabric unchanged, such as Relay plugins. Relay validates and activates them. |
| `runtime` | object | No | — | Fabric's runtime section, passed to Fabric unchanged, such as timeout_seconds and max_turns. The deployment sets artifacts and, where both the CLI's Fabric catalog and the image's adapter accept it, keep_state; a different authored value fails. |
| `settings` | object | No | — | Opaque native settings validated by the selected Fabric adapter. |
| `telemetry` | object | No | — | Fabric's telemetry section, passed to Fabric unchanged, such as providers.relay. NemoClaw grants no network access for its exporters. |

## Image

Sandbox image identity.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes.{key}.image`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `metadata` | [FileRef](#fileref) | No | — | Environment reference to the absolute path of a local OCI metadata bundle for `ref`; required for Kubernetes and OpenShift, where no local engine can be inspected. Destroy does not read it. Its index, manifest, configuration, and Fabric catalog are verified against `ref` before use. The bundle holds no image layers or credentials. Docker and Podman inspect their engine instead. |
| `ref` | string | Yes | — | Immutable image reference, pinned by SHA-256 digest. Required on every gateway target. Use the selected release's image digest or build from the same source revision. Onboarding links the matching image build and registry-access guides. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |

## ImagePullPolicy

Controls image acquisition on the selected container engine. Does not control model downloads or OpenShell sandbox images.

Guide: [Container image downloads](../build-deploy/usage.md#control-container-image-downloads).

Paths:

- `spec.gateway.target.docker.imagePullPolicy`
- `spec.gateway.target.podman.imagePullPolicy`
- `spec.services.{key}.imagePullPolicy`

Accepted input: string.

Constraints: `"Always"` or `"IfNotPresent"` or `"Never"`.

## Inference

Agent inference routing.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferences.{key}`
- `spec.sandboxes.{key}.agent.inference`
- `spec.sandboxes.{key}.inferences.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `default` | string | No | — | Initial model choice by route name. Required with multiple routes; omission selects the sole route. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `routes` | array of [Route](#route) | Yes | — | One or more uniquely named model choices. Fabric validates native multiple-model support. Constraints: minimum items 1; maximum items 32. |

## InferenceApi

Wire API used by the agent through OpenShell; no protocol conversion is implied.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferenceProviders.{key}.api`
- `spec.inferences.{key}.routes[].provider.api`
- `spec.sandboxes.{key}.agent.inference.routes[].provider.api`
- `spec.sandboxes.{key}.inferenceProviders.{key}.api`
- `spec.sandboxes.{key}.inferences.{key}.routes[].provider.api`

Accepted input: string.

Constraints: `"openai-completions"` or `"openai-responses"` or `"anthropic-messages"`.

## InferenceProvider

Choose an endpoint for external inference or serviceRef for a managed service.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferenceProviders.{key}`
- `spec.sandboxes.{key}.inferenceProviders.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [InferenceApi](#inferenceapi) | No | — | Request API. Omission selects anthropic-messages for Anthropic providers and openai-completions for OpenAI providers. NemoClaw uses it to read the endpoint's model catalog; agents use the protocol their adapter selects for the provider. |
| `credential` | [SecretRef](#secretref) | No | — | Optional API credential reference for an external HTTPS endpoint. Excluded by serviceRef. |
| `endpoint` | string | Without serviceRef | — | Inference HTTP(S) URL owned outside the deployment. Required without serviceRef and excluded with serviceRef. |
| `provider` | string | Yes | — | OpenShell provider implementation. Must match the selected API family. Constraints: `"openai"` or `"anthropic"`. |
| `serviceRef` | string | No | — | Name of a managed service in spec.services. Excludes endpoint and credential. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## InlineInferenceProvider

Inference definition owned by one route, with the fields of an inferenceProviders entry and its own name.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferences.{key}.routes[].provider`
- `spec.sandboxes.{key}.agent.inference.routes[].provider`
- `spec.sandboxes.{key}.inferences.{key}.routes[].provider`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [InferenceApi](#inferenceapi) | No | — | Request API. Omission selects anthropic-messages for Anthropic providers and openai-completions for OpenAI providers. NemoClaw uses it to read the endpoint's model catalog; agents use the protocol their adapter selects for the provider. |
| `credential` | [SecretRef](#secretref) | No | — | Optional API credential reference for an external HTTPS endpoint. Excluded by serviceRef. |
| `endpoint` | string | Without serviceRef | — | Inference HTTP(S) URL owned outside the deployment. Required without serviceRef and excluded with serviceRef. |
| `name` | string | Yes | — | Provider name. Must not shadow an enclosing definition. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `provider` | string | Yes | — | OpenShell provider implementation. Must match the selected API family. Constraints: `"openai"` or `"anthropic"`. |
| `serviceRef` | string | No | — | Name of a managed service in spec.services. Excludes endpoint and credential. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## InlineRecipe

Data-only contract for executables and capabilities packaged in a pinned runtime image.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `apiVersion` | string | Yes | — | Inline recipe protocol version. Constraints: `"nemoclaw.nvidia.com/recipe/v1"`. |
| `compatibility` | [Compatibility](#compatibility) | Yes | — | Required execution host and image capabilities; declaring them does not establish live qualification. |
| `licenses` | array of string | Yes | — | Nonempty list of absolute paths to retained license files inside the image. Constraints: minimum items 1; items: pattern `^/`. |
| `preparation` | [Tool](#tool) | Yes | — | Executable that prepares candidate model data. |
| `resources` | [Resources](#resources) | Yes | — | Preparation capacity, GPU budget, and startup headroom. |
| `reuse` | [Reuse](#reuse) | No | — | Optional cache import. The new recipe must verify the imported data before accepting it. |
| `serving` | [Settings](#settings) | Yes | — | Recipe-specific vLLM settings. |
| `snapshot` | [Manifest](#manifest) | No | — | Optional pinned file manifest. When omitted, the SDK resolves the model inventory. When present, its repository and revision must match service.model. |
| `sourceNotices` | array of string | Yes | — | Nonempty list of absolute paths to retained source notices inside the image. Constraints: minimum items 1; items: pattern `^/`. |
| `verification` | [Tool](#tool) | Yes | — | Executable that independently verifies prepared data before publication. |

## Integration

Integration configuration attached inline to an agent or selected through integrationRefs. Unsupported kinds are rejected.

Guide: [Agent runtimes](../agents-inference/agents.md).

Paths:

- `spec.integrations.{key}`
- `spec.sandboxes.{key}.agent.integrations.{key}`
- `spec.sandboxes.{key}.integrations.{key}`

Accepted input: object.

### Alternative 1

Web search with gateway-held credentials and explicit agent grants.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `credential` | [SecretRef](#secretref) | Yes | — | Host environment reference. OpenShell supplies the search provider's placeholder to the sandbox. |
| `kind` | string | Yes | — | Integration implementation selected by this definition. Constraints: `"webSearch"`. |
| `provider` | [SearchProvider](#searchprovider) | Yes | — | Supported search service. |
| `sandboxEnv` | string | No | — | Variable name the sandbox sees for the key, such as BRAVE_SEARCH_API_KEY for Hermes's Brave plugin. Defaults to the provider's own, BRAVE_API_KEY or TAVILY_API_KEY. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

### Alternative 2

A key-authenticated HTTP API, such as an MCP service, with a gateway-held key.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authStyle` | [ApiAuthStyle](#apiauthstyle) | No | — | How the key is sent: bearer, the default, as a bearer token, or header, as the raw value of headerName. |
| `credential` | [SecretRef](#secretref) | Yes | — | Host environment reference holding the API key. |
| `endpoints` | array of string | Yes | — | The API's HTTPS URLs. One key reaches each URL's host, port and path subtree. Constraints: minimum items 1. |
| `headerName` | string | No | — | The header that carries the key. Defaults to Authorization for bearer; required for header. |
| `kind` | string | Yes | — | Integration implementation selected by this definition. Constraints: `"api"`. |
| `sandboxEnv` | string | No | — | Variable name the sandbox sees for the key, such as NVIDIA_API_KEY for tools that read it. Defaults to `NEMOCLAW_API_<registration>_KEY`. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

## InterceptorTls

TLS file reference for a service the gateway dials.

Guide: [Letting APF author sandbox policy](../build-deploy/usage.md#letting-apf-author-sandbox-policy).

Paths:

- `spec.gateway.policyAuthority.apf.tls`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `ca` | [FileRef](#fileref) | Yes | — | Environment variable whose value names the local CA certificate file. NemoClaw copies the certificate into the gateway's storage. |

## KubernetesAuthentication

Authentication provisioned for a managed cluster gateway.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes.authentication`
- `spec.gateway.target.openshift.authentication`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `caConfigMap` | string | No | — | Existing ConfigMap in this deployment's namespace whose `ca.crt` verifies the issuer's TLS certificate; omit for a publicly trusted issuer. Constraints: pattern `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$`; minimum characters 1; maximum characters 253. |
| `profile` | string | Yes | — | `development` generates a scoped local issuer for isolated qualification; `oidc` uses an existing OIDC issuer, configured in spec.gateway.config's openshell.gateway.oidc table. Constraints: `"development"` or `"oidc"`. |
| `token` | [SecretRef](#secretref) | No | — | Environment reference holding the bearer token NemoClaw sends to the gateway. Required for `oidc`; your identity provider's tooling obtains and refreshes it. |

## KubernetesExpose

Publication of a managed Kubernetes gateway's endpoint through the chart's Service.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes.expose`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | The address clients outside the cluster dial: `https://HOST:PORT`, with a lowercase DNS name or IPv4 address and an explicit nonzero port, and no path. The gateway certificate names its host. Constraints: pattern `^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:(?:[1-9][0-9]{0,3}\|[1-5][0-9]{4}\|6[0-4][0-9]{3}\|65[0-4][0-9]{2}\|655[0-2][0-9]\|6553[0-5])$`. |
| `service` | [ExposureService](#exposureservice) | Yes | — | The gateway chart's own Service, which publishes the endpoint's port and forwards it to the gateway pod. TLS and client certificates pass through to the gateway unchanged. |

## LlamaCppServing

Explicit context and batching; full CUDA offload, one slot and f16 KV are fixed.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `batchTokens` | integer | No | — | Maximum logical prompt batch size; omission selects 2048. Constraints: minimum 1; maximum 4096. |
| `contextTokens` | integer | No | — | Context tokens for the single slot, from 8192 through 131072; actual fit needs qualification. Constraints: minimum 8192; maximum 131072. |
| `microBatchTokens` | integer | No | — | Physical prompt microbatch, no larger than batchTokens; omission selects 512. Constraints: minimum 1; maximum 4096. |
| `modelName` | string | No | — | Nonempty model alias advertised in inventory; the agent route must name it. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`; minimum characters 1. |
| `port` | integer | No | — | Published inference port, from 1024 through 65535. Constraints: minimum 1024; maximum 65535. |
| `reasoningStrength` | any JSON value | No | — | Optional low, medium or high reasoning_strength argument passed to the embedded Jinja template. Constraints: `"low"` or `"medium"` or `"high"`. |
| `startupTimeoutSeconds` | integer | No | — | Seconds allowed for health and model inventory after launch; omission selects 1800. Constraints: minimum 60; maximum 3600. |

## ManagedKubernetes

An existing cluster for a managed gateway, reached with an explicit kubeconfig and context or, with both omitted, the service account of the pod that runs NemoClaw. The SDK does not create a cluster or select an ambient context. Agent Sandbox, and a default StorageClass unless dataStorageClass names another, are platform prerequisites that the SDK does not check. Without expose, NemoClaw reaches the gateway through a port forward on a free local port for each command, so the document names no port.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.kubernetes`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [KubernetesAuthentication](#kubernetesauthentication) | Yes | — | How the managed gateway authenticates users: a generated development issuer, or an existing OIDC issuer. |
| `context` | string | No | — | Exact kubeconfig context used for every cluster operation. Requires kubeconfig. Constraints: pattern `^[^\x00-\x20\x7f]+$`; minimum characters 1; maximum characters 253. |
| `dataStorageClass` | string | No | — | StorageClass of the gateway's data volume, which holds its SQLite database; omit to use the cluster's default StorageClass. Use a block-backed class: SQLite runs in write-ahead-log mode, which NFS and other network filesystems do not support. The SDK does not check that the class exists: with a missing class, the volume's claim stays pending and apply fails when Helm's wait times out. Fixed after the first plan, because the claim keeps the class it was created with. Constraints: pattern `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$`; minimum characters 1; maximum characters 253. |
| `environment` | array of string | No | — | Caller environment variables that the kubeconfig's exec credential plugin needs, such as `AWS_PROFILE` for an EKS cluster. Requires kubeconfig. Cluster operations receive only platform variables and these; they are resolved like credential references and never written to configuration or state. Constraints: maximum items 32; items: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |
| `expose` | [KubernetesExpose](#kubernetesexpose) | No | — | How clients outside the cluster reach the gateway: the endpoint they dial, and the Service or Route that publishes it. The gateway certificate names the endpoint's host. NemoClaw's own commands still forward a free local port to the gateway pod. The endpoint, whether a Service or a Route publishes the gateway, and the Service's type are fixed after the first plan. |
| `kubeconfig` | [FileRef](#fileref) | No | — | Environment reference whose value is the local kubeconfig file path. Requires context; omit both to use the pod's service account. The file and its credentials remain outside configuration and exported state. Process, loader, trust, proxy, cluster, Python, Helm, OpenTofu, and SDK control variable names are reserved. |
| `namespace` | string | Yes | — | Namespace for this deployment's gateway and generated development authentication resources. An existing namespace is bound by UID and never changed; a missing one is created. A namespace another NemoClaw deployment created is refused. Constraints: pattern `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`; minimum characters 1; maximum characters 63. |
| `resources` | [GatewayResources](#gatewayresources) | No | — | CPU and memory for the gateway container, which the chart's resources take as written. Omitted, the gateway requests 250m CPU and 256Mi and is limited to 1 CPU and 2Gi, which fit 256 sandboxes. Set, it replaces all four, and a quantity it leaves out takes Kubernetes' default: a namespace LimitRange's, or for a request, its limit. A change restarts the gateway, and its sandboxes keep running. |

## ManagedOpenShift

An existing OpenShift cluster for a managed gateway, with the fields of a kubernetes target. The namespace assigns the gateway's user and group IDs, and expose may also take a Route.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.openshift`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [KubernetesAuthentication](#kubernetesauthentication) | Yes | — | How the managed gateway authenticates users: a generated development issuer, or an existing OIDC issuer. |
| `context` | string | No | — | Exact kubeconfig context used for every cluster operation. Requires kubeconfig. Constraints: pattern `^[^\x00-\x20\x7f]+$`; minimum characters 1; maximum characters 253. |
| `dataStorageClass` | string | No | — | StorageClass of the gateway's data volume, which holds its SQLite database; omit to use the cluster's default StorageClass. Use a block-backed class: SQLite runs in write-ahead-log mode, which NFS and other network filesystems do not support. The SDK does not check that the class exists: with a missing class, the volume's claim stays pending and apply fails when Helm's wait times out. Fixed after the first plan, because the claim keeps the class it was created with. Constraints: pattern `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$`; minimum characters 1; maximum characters 253. |
| `environment` | array of string | No | — | Caller environment variables that the kubeconfig's exec credential plugin needs, such as `AWS_PROFILE` for an EKS cluster. Requires kubeconfig. Cluster operations receive only platform variables and these; they are resolved like credential references and never written to configuration or state. Constraints: maximum items 32; items: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |
| `expose` | [OpenShiftExpose](#openshiftexpose) | No | — | How clients outside the cluster reach the gateway: the endpoint they dial, and the Service or Route that publishes it. The gateway certificate names the endpoint's host. NemoClaw's own commands still forward a free local port to the gateway pod. The endpoint, whether a Service or a Route publishes the gateway, and the Service's type are fixed after the first plan. |
| `kubeconfig` | [FileRef](#fileref) | No | — | Environment reference whose value is the local kubeconfig file path. Requires context; omit both to use the pod's service account. The file and its credentials remain outside configuration and exported state. Process, loader, trust, proxy, cluster, Python, Helm, OpenTofu, and SDK control variable names are reserved. |
| `namespace` | string | Yes | — | Namespace for this deployment's gateway and generated development authentication resources. An existing namespace is bound by UID and never changed; a missing one is created. A namespace another NemoClaw deployment created is refused. Constraints: pattern `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`; minimum characters 1; maximum characters 63. |
| `resources` | [GatewayResources](#gatewayresources) | No | — | CPU and memory for the gateway container, which the chart's resources take as written. Omitted, the gateway requests 250m CPU and 256Mi and is limited to 1 CPU and 2Gi, which fit 256 sandboxes. Set, it replaces all four, and a quantity it leaves out takes Kubernetes' default: a namespace LimitRange's, or for a request, its limit. A change restarts the gateway, and its sandboxes keep running. |

## ManagedTarget

Where NemoClaw installs a managed gateway: exactly one of docker, podman, kubernetes, and openshift. Each holds only the settings NemoClaw uses to install the gateway there; OpenShell's own settings stay in config and each sandbox's driverConfig.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target`

Accepted input: object.

### Alternative 1

A gateway container on a local Docker engine, which runs every sandbox on that engine.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `docker` | [DockerTarget](#dockertarget) | Yes | — | A gateway container on a local Docker engine, which runs every sandbox on that engine. |

### Alternative 2

A gateway container on a local rootless Linux Podman engine, which runs every sandbox on that engine. Rootful, remote, and other platforms are unqualified.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `podman` | [PodmanTarget](#podmantarget) | Yes | — | A gateway container on a local rootless Linux Podman engine, which runs every sandbox on that engine. Rootful, remote, and other platforms are unqualified. |

### Alternative 3

OpenShell's gateway chart on an existing Kubernetes cluster, which schedules every sandbox.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `kubernetes` | [ManagedKubernetes](#managedkubernetes) | Yes | — | OpenShell's gateway chart on an existing Kubernetes cluster, which schedules every sandbox. |

### Alternative 4

OpenShell's gateway chart on an existing OpenShift cluster, which schedules every sandbox. The namespace assigns the gateway's user and group IDs, and only this target publishes the gateway through a Route.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `openshift` | [ManagedOpenShift](#managedopenshift) | Yes | — | OpenShell's gateway chart on an existing OpenShift cluster, which schedules every sandbox. The namespace assigns the gateway's user and group IDs, and only this target publishes the gateway through a Route. |

## Manifest

Pinned model snapshot inventory. The parser rejects duplicate files and file/directory conflicts.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.snapshot`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `files` | array of [File](#file) | Yes | — | Nonempty inventory of pinned model files. Constraints: minimum items 1. |
| `repository` | string | Yes | — | Repository identity, which must match service.model.repository when used in a recipe. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$`; maximum characters 200. |
| `revision` | string | Yes | — | Immutable commit, which must match service.model.revision when used in a recipe. Constraints: pattern `^[a-f0-9]{40}$`. |

## Memory

Resident watchdog thresholds are validated before runtime creation. The parser also checks relationships between thresholds.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | `5` | Consecutive low-memory samples before the watchdog stops the owned process. Constraints: `0` or minimum 1; maximum 5. Omitted or zero selects the default. |
| `freeGateGiB` | integer | No | `12` | Available-memory gate in GiB for minFreeGiB. Must be at least minAvailableGiB after defaults. Constraints: `0` or minimum 6; maximum 24. Omitted or zero selects the default. |
| `gpuMemoryGiB` | integer | No | — | GPU budget in GiB for each selected GPU without a recipe. Must be omitted or zero with a recipe, which supplies its own byte budget. Constraints: minimum 0; maximum 96. Omitted or zero stays zero in the document. Without a recipe or gpuMemoryUtilization, the backend uses 16 GiB. A recipe supplies resources.gpuMemoryBytes; gpuMemoryUtilization requires zero here. |
| `gpuMemoryUtilization` | number | No | — | Optional fraction of each selected GPU's observed dedicated memory, from 0.05 through 0.95, which vLLM's --gpu-memory-utilization applies to each GPU's own total. Requires hardware with explicit minGpuMemoryBytes, including dedicated-memory named profiles. Excludes unified-memory profiles, recipe, fixed gpuMemoryGiB and explicit KV-cache allocation; vLLM sizes its cache natively. Constraints: minimum 0.05; maximum 0.95. |
| `hostReserveGiB` | integer | No | `32` | Host memory reserve in GiB excluded from the serving budget. At least 6 with a dedicated-memory profile or dedicated hardware, and at least 28 with a unified-memory profile or a recipe. Constraints: `0` or minimum 6; maximum 64. Omitted or zero selects the default. |
| `kvCacheGiB` | integer | No | `8` | KV cache allocation in GiB on each selected GPU for ordinary vLLM, passed as --kv-cache-memory-bytes. Omitted or zero defaults to 8, except gpuMemoryUtilization requires zero and lets vLLM allocate its cache. Recipe serving does not emit this flag. Constraints: minimum 0. Omitted or zero selects 8 GiB, except gpuMemoryUtilization keeps zero and lets vLLM allocate its cache. |
| `minAvailableGiB` | integer | No | `8` | Available-memory threshold in GiB that contributes a low-memory sample. Constraints: `0` or minimum 6; maximum 16. Omitted or zero selects the default. |
| `minFreeGiB` | integer | No | `3` | Free-memory threshold in GiB, used when available memory is below freeGateGiB. Constraints: `0` or minimum 2; maximum 8. Omitted or zero selects the default. |

When `gpuMemoryUtilization` is present: `gpuMemoryGiB`: `0`; `kvCacheGiB`: `0`. Otherwise: `kvCacheGiB`: `0` or minimum 4; maximum 12.

## Metadata

Deployment identity persists across apply, export, recovery, and destroy.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `metadata`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Lowercase deployment name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `uid` | string | Yes | — | Immutable deployment UUID. Use a fresh UUID for a new deployment and retain it for later operations. Either case is accepted; NemoClaw stores it lowercase. Constraints: pattern `^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`. |

## Model

Immutable model identity used for snapshot resolution and storage.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `repository` | string | Yes | — | Public Hugging Face owner/repository name. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$`; maximum characters 200. |
| `revision` | string | Yes | — | Full lowercase 40-hex commit revision; branches and tags are rejected. Constraints: pattern `^[a-f0-9]{40}$`. |

## Network

Sandbox policy selection.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.sandboxes.{key}.network`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `grantRefs` | array of string | No | — | Names of grants in spec.grants added to the isolated preset, alongside grants. Names must be unique across both. Excluded by policy and policyRef. Constraints: items: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `grants` | map of [Grant](#grant) | No | — | Named grants added to the isolated preset, each like an OpenShell network policy rule without its name. An explicit policy holds its own grants. |
| `policy` | [ExplicitPolicySelection](#explicitpolicyselection) | No | — | Complete authored OpenShell policy, replacing the isolated preset. Excludes tier and policyRef. |
| `policyRef` | string | No | — | Name of a policy in spec.policies, applied as if written in policy.explicit. Excludes tier and policy. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `tier` | string | No | `"isolated"` | Isolated policy preset. Omit when declaring policy or policyRef; omitting all three selects isolated. Constraints: `""` or `"isolated"`. Omitted or empty selects isolated only without policy or policyRef. |

## NgcCredential

An operator-owned regular file on the Docker engine host. NemoClaw never copies its contents into configuration or state.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.ngcCredential`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `file` | string | Yes | — | Absolute file path. Rotate by selecting a versioned path and explicitly recreating the service; the operator retains and removes the file. Constraints: minimum characters 2; maximum characters 4096. |

## NimBackend

Native backend supported by the managed NIM authentication contract.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.backend`

Accepted input: string.

Constraints: `"vllm"`.

## NimModel

Native model profile, GPU memory floor, and cache allowance.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `cacheBytes` | integer | Yes | — | Full cache disk allowance in bytes, excluding 16 GiB of working headroom. Constraints: minimum 1; maximum 1099511627776. |
| `chatTemplateKwargs` | object | No | — | Native vLLM default chat-template arguments, passed as JSON. Omission retains native defaults; request-level arguments take precedence. |
| `minGpuMemoryBytes` | integer | Yes | — | Profile's upstream memory floor, in bytes; include activation headroom in the budget. Constraints: minimum 1; maximum 1099511627776. |
| `name` | string | Yes | — | Exact name advertised by NIM and used by the inference route. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`; minimum characters 1; maximum characters 200. |
| `profile` | string | Yes | — | Native profile identifier from this image's embedded manifest. Constraints: pattern `^[a-f0-9]{64}$`. |
| `toolParser` | string | No | — | Native vLLM tool parser; a nonempty name enables auto tool choice. Omission leaves native defaults. Match the parser to the model and pinned image. Constraints: pattern `^[a-z0-9_]*$`; maximum characters 64. |

## NimServing

Native listener and generation settings; the public route filter uses the same serving port.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `contextTokens` | integer | No | — | Maximum prompt plus generated token count. Constraints: minimum 1024; maximum 131072. |
| `port` | integer | No | — | Native listener on the private model network; the next port is reserved for its backend. Constraints: minimum 1024; maximum 65534. |
| `startupTimeoutSeconds` | integer | No | — | Maximum native startup wait in seconds, including profile/cache preparation. Constraints: minimum 60; maximum 7200. |

## OllamaMemory

Ollama GPU budget and host memory protection.

Guide: [Managed Ollama](../agents-inference/inference.md#running-managed-ollama).

Paths:

- `spec.services.{key}.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | `5` | Consecutive low-memory samples before stopping the owned process. Constraints: `0` or minimum 1; maximum 5. Omitted or zero selects the default. |
| `freeGateGiB` | integer | No | `12` | Available-memory gate for the free-memory threshold. Constraints: `0` or minimum 6; maximum 24. Omitted or zero selects the default. |
| `gpuMemoryGiB` | integer | No | `0` | Fixed serving budget in GiB for each selected GPU when utilization is omitted. Omission or zero selects 16 GiB. Constraints: `0` or minimum 0; maximum 96. Omitted or zero stays zero in the document. Without gpuMemoryUtilization, the installer uses 16 GiB. |
| `gpuMemoryUtilization` | number | No | — | Optional fraction of observed dedicated GPU memory, taken of the smallest selected GPU; the resulting budget applies to each selected GPU. Constraints: minimum 0.05; maximum 0.95. |
| `hostReserveGiB` | integer | No | `32` | Host memory reserve excluded from serving. At least 6 with a dedicated-memory profile or dedicated hardware, and at least 28 with a unified-memory profile. Constraints: `0` or minimum 6; maximum 64. Omitted or zero selects the default. |
| `minAvailableGiB` | integer | No | `8` | Available-memory threshold used by the bounded runtime watchdog. Constraints: `0` or minimum 6; maximum 16. Omitted or zero selects the default. |
| `minFreeGiB` | integer | No | `3` | Free-memory threshold used below freeGateGiB. Constraints: `0` or minimum 2; maximum 8. Omitted or zero selects the default. |

## OllamaModel

One immutable Ollama registry model installation.

Guide: [Managed Ollama](../agents-inference/inference.md#running-managed-ollama).

Paths:

- `spec.services.{key}.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `digest` | string | Yes | — | Lowercase SHA-256 of the registry manifest selected for that tag. Constraints: pattern `^[a-f0-9]{64}$`. |
| `name` | string | Yes | — | Public library model name including its tag. Constraints: pattern `^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$`. |

## OllamaServing

Native Ollama serving controls supported by the managed installer.

Guide: [Managed Ollama](../agents-inference/inference.md#running-managed-ollama).

Paths:

- `spec.services.{key}.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `contextTokens` | integer | No | `32768` | Maximum model context length. Constraints: `0` or minimum 8192; maximum 65536. Omitted or zero selects the default. |
| `maxSequences` | integer | No | `1` | Maximum concurrent sequences. Constraints: `0` or minimum 1; maximum 2. Omitted or zero selects the default. |
| `port` | integer | No | `18888` | Inference listening port. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |
| `startupTimeoutSeconds` | integer | No | `1800` | Seconds allowed for model loading and readiness. Constraints: `0` or minimum 60; maximum 3600. Omitted or zero selects the default. |

## OpenShiftExpose

Publication of a managed OpenShift gateway's endpoint, through exactly one of service and route.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.openshift.expose`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | The address clients outside the cluster dial: `https://HOST:PORT`, with a lowercase DNS name or IPv4 address and an explicit nonzero port, and no path. The gateway certificate names its host. Constraints: pattern `^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:(?:[1-9][0-9]{0,3}\|[1-5][0-9]{4}\|6[0-4][0-9]{3}\|65[0-4][0-9]{2}\|655[0-2][0-9]\|6553[0-5])$`. |
| `route` | [ExposureRoute](#exposureroute) | No | — | The gateway chart's own OpenShift Route, which publishes the endpoint's host through the cluster's router and passes TLS through to the gateway by SNI, so TLS and client certificates reach the gateway unchanged. The endpoint's host is a DNS name, since clients send no SNI host name for an IP address, and its port is the one the router serves. Only the openshift target takes it. |
| `service` | [ExposureService](#exposureservice) | No | — | The gateway chart's own Service, which publishes the endpoint's port and forwards it to the gateway pod. TLS and client certificates pass through to the gateway unchanged. |

## Overrides

Model settings for one named inference choice.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferences.{key}.routes[].overrides`
- `spec.sandboxes.{key}.agent.inference.routes[].overrides`
- `spec.sandboxes.{key}.inferences.{key}.routes[].overrides`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `extensions` | object | No | — | Model fields the selected adapter declares as extensions, such as Pi's context_window; Fabric validates them. |
| `harnessProvider` | string | No | — | Fabric model provider the harness uses, such as custom. Defaults to the inference provider's API family. |
| `maxTokens` | integer | No | — | Maximum output tokens requested from the native adapter. Planning rejects this field when the image's adapter does not accept it. Constraints: minimum 1; maximum 4294967295. |
| `model` | string | Yes | — | Model identifier. For a managed service, match its served model: vLLM's recipe serving.modelName, serving.modelName, or model.repository; Ollama's model.name; an Ollama proxy's upstream.model.name. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. |
| `settings` | object | No | — | Opaque native model settings validated by Fabric's selected model schema. |
| `temperature` | number | No | — | Sampling temperature, passed to Fabric's temperature. Planning rejects this field when the image's adapter does not accept it; Fabric validates the range. |
| `topP` | number | No | — | Nucleus sampling probability, passed to Fabric's top_p. Planning rejects this field when the image's adapter does not accept it; Fabric validates the range. |

## PodmanTarget

A managed gateway container on a local rootless Linux Podman engine. Podman's socket depends on the user, so engine has no default.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.target.podman`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | Yes | — | The local engine's API service, which NemoClaw installs the gateway with and which runs every sandbox: a Unix socket, or on Windows a local engine's named pipe such as `npipe:////./pipe/docker_engine`, in which case the gateway binds `/var/run/docker.sock` in the engine's VM, as it does on macOS for Docker Desktop's, Colima's, Rancher Desktop's, or a Podman machine's socket. Constraints: pattern `^(unix:///\|npipe:////\./pipe/)`; minimum characters 1. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before local container creation: IfNotPresent, the default, Never, or Always, which contacts the registry before creation or restart. |
| `networkCIDR` | string | No | — | Canonical private IPv4 /24 of the network the gateway and its sandboxes share. Constraints: `""` or pattern `/24$`. Omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid). |
| `port` | integer | No | `17681` | Loopback TCP port the gateway listens on, from 1024 through 65535. NemoClaw and the OpenShell CLI reach the gateway at `http://127.0.0.1:PORT`. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |

## PolicyAllowRule

One allowed application-protocol action.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].rules[]`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[]`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[]`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `allow` | [PolicyMatcher](#policymatcher) | Yes | — | Request matcher. |

## PolicyAnyMatcher

Alternative values for a policy matcher.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.grants.{key}.endpoints[].deny_rules[].tool`
- `spec.grants.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.grants.{key}.endpoints[].rules[].allow.tool`
- `spec.policies.{key}.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.policies.{key}.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[].allow.tool`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[].allow.tool`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.tool`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `any` | array of string | Yes | — | Nonempty list of nonempty glob strings. |

## PolicyAuthority

The component that authors every sandbox's policy on a gateway, instead of NemoClaw.

Guide: [Letting APF author sandbox policy](../build-deploy/usage.md#letting-apf-author-sandbox-policy).

Paths:

- `spec.gateway.policyAuthority`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `apf` | [ApfPolicyAuthority](#apfpolicyauthority) | Yes | — | APF's admission interceptor replaces each sandbox's policy with its signed bundle's, and APF serves the provider profiles. Sandboxes must not set a policy, policyRef, grants, or grantRefs, and API integrations must not set mcp. NemoClaw requires APF's provenance on each sandbox, records each policy APF issues with a new provenance token, and asks APF to issue its policy again when the loaded policy changes without one. |

## PolicyBinary

Executable identity for an egress grant.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.binaries[]`
- `spec.policies.{key}.network_policies.{key}.binaries[]`
- `spec.sandboxes.{key}.network.grants.{key}.binaries[]`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.binaries[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `path` | string | Yes | — | Absolute executable path inside the sandbox. |

## PolicyEndpoint

TCP destination and optional application-protocol policy. Invalid or conflicting combinations are rejected by OpenShell.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[]`
- `spec.policies.{key}.network_policies.{key}.endpoints[]`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[]`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `access` | string | No | — | full or read-only preset; mutually exclusive with rules. Constraints: `"full"` or `"read-only"`. |
| `allow_encoded_slash` | boolean | No | — | Allow encoded slash path segments when required by the upstream API. |
| `allowed_ips` | array of string | No | — | Resolved IP addresses or CIDRs allowed by OpenShell destination validation. |
| `deny_rules` | array of [PolicyMatcher](#policymatcher) | No | — | Application-protocol deny rules, evaluated before allow rules. Constraints: minimum items 1. |
| `enforcement` | string | No | — | enforce or audit; omission selects OpenShell's default, audit, which logs and forwards requests that break the endpoint's rules. Constraints: `"enforce"` or `"audit"`. |
| `host` | string | No | — | Destination hostname or DNS glob; may be omitted with allowed_ips. |
| `json_rpc` | [PolicyJsonRpc](#policyjsonrpc) | No | — | JSON-RPC inspection limits. |
| `mcp` | [PolicyMcp](#policymcp) | No | — | MCP method and tool inspection settings. |
| `path` | string | No | — | HTTP path glob selecting the endpoint on a shared host. |
| `port` | integer | No | — | Single TCP port; mutually exclusive with ports. Constraints: minimum 1; maximum 65535. |
| `ports` | array of integer | No | — | Nonempty unique TCP ports; mutually exclusive with port. Constraints: minimum items 1; items: minimum 1; maximum 65535. |
| `protocol` | string | No | — | rest, websocket, json-rpc, or mcp; omit for TCP. Constraints: `"rest"` or `"websocket"` or `"json-rpc"` or `"mcp"`. |
| `request_body_credential_rewrite` | boolean | No | — | Enable OpenShell placeholder rewriting in supported REST request bodies. |
| `rules` | array of [PolicyAllowRule](#policyallowrule) | No | — | Application-protocol allow rules. Constraints: minimum items 1. |
| `tls` | string | No | — | Omit for automatic TLS handling, or use skip for a raw tunnel. Constraints: `"skip"`. |
| `websocket_credential_rewrite` | boolean | No | — | Enable OpenShell placeholder rewriting in client WebSocket text messages; requires protocol websocket. |

## PolicyFilesystem

Filesystem access grants inside the sandbox.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.filesystem_policy`
- `spec.sandboxes.{key}.network.policy.explicit.filesystem_policy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `include_workdir` | boolean | No | — | Whether to include the working directory as writable; omitted means false in a declared filesystem policy. |
| `read_only` | array of string | No | — | Absolute read-only paths. |
| `read_write` | array of string | No | — | Absolute writable paths. |

## PolicyJsonRpc

JSON-RPC request inspection bounds.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].json_rpc`
- `spec.policies.{key}.network_policies.{key}.endpoints[].json_rpc`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].json_rpc`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].json_rpc`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `max_body_bytes` | integer | No | — | Maximum buffered request bytes, 1 through 1048576. Constraints: minimum 1; maximum 1048576. |

## PolicyLandlock

Landlock compatibility; hard_requirement refuses unavailable enforcement.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.landlock`
- `spec.sandboxes.{key}.network.policy.explicit.landlock`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `compatibility` | string | Yes | — | best_effort or hard_requirement. Constraints: `"best_effort"` or `"hard_requirement"`. |

## PolicyMatcher

Request method/path or MCP tool selector; protocol-specific combinations are validated by OpenShell.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].deny_rules[]`
- `spec.grants.{key}.endpoints[].rules[].allow`
- `spec.policies.{key}.network_policies.{key}.endpoints[].deny_rules[]`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[].allow`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].deny_rules[]`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[].allow`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[]`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `method` | string | No | — | HTTP or RPC method. |
| `params` | map of [PolicyValueMatcher](#policyvaluematcher) | No | — | MCP parameters; only name is supported by the pinned protocol. |
| `path` | string | No | — | HTTP path glob. |
| `tool` | [PolicyValueMatcher](#policyvaluematcher) | No | — | MCP tool-name selector. |

## PolicyMcp

MCP request inspection and tool-name restrictions.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].mcp`
- `spec.policies.{key}.network_policies.{key}.endpoints[].mcp`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].mcp`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].mcp`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `allow_all_known_mcp_methods` | boolean | No | — | Allow known MCP methods, subject to tool restrictions; defaults to false. |
| `max_body_bytes` | integer | No | — | Maximum buffered request bytes, 1 through 1048576. Constraints: minimum 1; maximum 1048576. |
| `strict_tool_names` | boolean | No | — | Enforce standard MCP tool-name syntax; defaults to true. |
| `versions` | array of string | No | — | Supported MCP protocol revisions; omission uses the pinned OpenShell default. |

## PolicyMiddleware

One supervisor middleware attachment. OpenShell validates the attachment, including unique orders and selectors that avoid `tls: skip` endpoints, and the named middleware validates `config`.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.network_middlewares.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_middlewares.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `config` | object | No | — | Settings passed to the middleware, which defines and validates their format. |
| `endpoints` | [PolicyMiddlewareEndpoints](#policymiddlewareendpoints) | Yes | — | Admitted destination hosts the middleware runs for. |
| `middleware` | string | Yes | — | A built-in middleware, such as `openshell/regex`, or the `name` of a service registered with the gateway. |
| `name` | string | No | — | Display name; omission uses the attachment's key. |
| `on_error` | string | No | — | fail_closed blocks the affected traffic when the middleware fails; fail_open lets it continue. Omission selects fail_closed. A middleware denial blocks traffic either way. Constraints: `"fail_closed"` or `"fail_open"`. |
| `order` | integer | No | — | Position among attachments that select the same host; lower values run first. Orders must be unique within the policy; omission means 0. Constraints: minimum -2147483648; maximum 2147483647. |

## PolicyMiddlewareEndpoints

Destination hosts selected for a middleware attachment, as exact hosts or DNS globs in endpoint-host syntax, without a port.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.network_middlewares.{key}.endpoints`
- `spec.sandboxes.{key}.network.policy.explicit.network_middlewares.{key}.endpoints`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `exclude` | array of string | No | — | Hosts to skip; exclusions take precedence over inclusions. |
| `include` | array of string | Yes | — | Hosts to run the middleware for; OpenShell requires at least one. |

## PolicyProcess

Process identity resolved inside the sandbox image.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.process`
- `spec.sandboxes.{key}.network.policy.explicit.process`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `run_as_group` | string | No | — | sandbox or a numeric non-root sandbox GID accepted by OpenShell. |
| `run_as_user` | string | No | — | sandbox or a numeric non-root sandbox UID accepted by OpenShell. |

## PolicyRule

Named endpoint grants restricted to declared executable paths.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.policies.{key}.network_policies.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `binaries` | array of [PolicyBinary](#policybinary) | Yes | — | Executable identities allowed to use these destinations. |
| `endpoints` | array of [PolicyEndpoint](#policyendpoint) | Yes | — | Allowed destinations and optional application-protocol restrictions. |
| `name` | string | Yes | — | Human-readable rule name. |

## PolicyValueMatcher

A literal glob or a nonempty list of alternative globs.

Guide: [Sandbox policy](../security/sandbox-network.md).

Paths:

- `spec.grants.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.grants.{key}.endpoints[].deny_rules[].tool`
- `spec.grants.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.grants.{key}.endpoints[].rules[].allow.tool`
- `spec.policies.{key}.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.policies.{key}.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.policies.{key}.network_policies.{key}.endpoints[].rules[].allow.tool`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes.{key}.network.grants.{key}.endpoints[].rules[].allow.tool`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes.{key}.network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.tool`

Accepted input: string or [PolicyAnyMatcher](#policyanymatcher).

## Registry

A registry NemoClaw authenticates to when pulling images through Docker.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.registries[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `address` | string | Yes | — | Registry address, such as nvcr.io or registry.example.com:5000, matching its entry in the Docker configuration file. Constraints: minimum characters 1; maximum characters 253. |
| `configFile` | string | No | — | Absolute path of the Docker configuration file that holds the login, on the machine running OpenTofu. Defaults to `.docker/config.json` in the user's home directory; `DOCKER_CONFIG` is not read. Constraints: minimum characters 1; maximum characters 4096. |

## Resources

Resource declarations checked against host observations and produced data.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.resources`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `gpuMemoryBytes` | integer | Yes | — | Serving GPU budget in bytes for each selected GPU, including its share of the model, caches, and other allocations. Checked against each selected GPU's memory on dedicated-memory GPUs, and against host memory with the host reserve on unified memory. Constraints: minimum 4294967296; maximum 4398046511104. |
| `preparationMemoryGiB` | integer | Yes | — | Preparation memory requirement in GiB, in addition to the service host reserve. Constraints: minimum 1; maximum 4096. |
| `preparedBytes` | integer | Yes | — | Maximum total prepared-data bytes. Constraints: minimum 1; maximum 1099511627776. |
| `startupHeadroomGiB` | integer | Yes | — | Host available memory in GiB required at startup, beyond the GPU budget on unified memory or beyond the host reserve on a dedicated-memory GPU. Constraints: minimum 0; maximum 4096. |

## Reuse

Explicit cache import, verified by the new recipe before acceptance.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.reuse`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `preparationKey` | string | Yes | — | SHA-256 preparation key identifying previously prepared data. Constraints: pattern `^[a-f0-9]{64}$`. |
| `snapshotDirectory` | string | Yes | — | Existing snapshot directory relative to /data. Traversal, backslashes, and empty path components are rejected. Constraints: minimum characters 1. |

## Route

Native model connection authorized through an attached OpenShell provider.

Guide: [Inference configuration](../agents-inference/inference.md).

Paths:

- `spec.inferences.{key}.routes[]`
- `spec.sandboxes.{key}.agent.inference.routes[]`
- `spec.sandboxes.{key}.inferences.{key}.routes[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Unique lowercase name for this model choice. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `overrides` | [Overrides](#overrides) | Yes | — | Model selection, shared limits, and optional native settings. |
| `provider` | [InlineInferenceProvider](#inlineinferenceprovider) | No | — | Inline inference definition owned by this route. Excludes providerRef and must not shadow an enclosing definition. |
| `providerRef` | string | No | — | Name of an enclosing inference provider. Exactly one of providerRef or provider is required. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## Sandbox

The gateway owns sandbox creation and dependency placement.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `agent` | [Agent](#agent) | Yes | — | The configured agent hosted by this sandbox in one Fabric runtime. Deploy additional agents in separate sandboxes. |
| `cpu` | any JSON value | No | — | CPU limit OpenShell gives the sandbox, as a quantity such as 500m or 2, passed to its resources.limits.cpu: Docker and Podman apply it as a runtime limit, Kubernetes as the container's request and limit. OpenShell validates it. Changing it replaces the sandbox; omission sets no limit. Constraints: minimum characters 1. |
| `driverConfig` | object | No | — | OpenShell's per-driver sandbox configuration, such as mounts, passed through unchanged. NemoClaw sets nothing in it. The gateway must allow driver configuration: on a managed gateway, unless driverConfig is empty, spec.gateway.config must set allow_driver_config: true in the compute driver's table, such as openshell.drivers.docker, or plan rejects the sandbox. |
| `gpus` | integer | No | — | GPUs OpenShell assigns to the sandbox's programs, as its resource_requirements.gpu.count; separate from inference services. OpenShell picks the devices unless driverConfig names them. Changing the count replaces the sandbox; omission requests none. Constraints: minimum 1; maximum 4294967295. |
| `harness` | [Harness](#harness) | No | — | Inline harness configuration. Exactly one of harness or harnessRef is required. The sandbox agent uses this harness implementation. |
| `harnessRef` | string | No | — | Name of a visible harness configuration. Excludes inline harness. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `harnesses` | map of [Harness](#harness) | No | — | Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `image` | [Image](#image) | Yes | — | Immutable agent image that contains the selected Fabric adapter and, on Kubernetes, is compatible with the gateway's runtime user and group IDs. Required: no default image is published. |
| `inferenceProviders` | map of [InferenceProvider](#inferenceprovider) | No | — | Named inference definitions visible to this sandbox's routes through providerRef. Names must not shadow deployment definitions. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `inferences` | map of [Inference](#inference) | No | — | Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions selected by this sandbox's agent through integrationRefs. Names must not collide with deployment definitions. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `memory` | any JSON value | No | — | Memory limit OpenShell gives the sandbox, as a quantity such as 512Mi or 4Gi, passed to its resources.limits.memory: Docker and Podman apply it as a runtime limit, Kubernetes as the container's request and limit. OpenShell validates it. Changing it replaces the sandbox; omission sets no limit. Constraints: minimum characters 1. |
| `network` | [Network](#network) | No | — | Sandbox network policy; omission selects isolated egress with grants for declared inference. Changing network rules, middleware bindings, or grants updates the running sandbox in place; changing filesystem, Landlock, or process settings replaces it. |
| `serviceExposures` | map of [ServiceExposure](#serviceexposure) | No | — | OpenShell service exposures, keyed by service name: loopback ports in the sandbox that the gateway makes reachable at a URL it reports. OpenShell checks each name when it exposes the service. Changing them updates the running sandbox's endpoints in place. Constraints: maximum entries 32. |

## SearchProvider

Search provider supported by the managed profile.

Guide: [Agent runtimes](../agents-inference/agents.md).

Paths:

- `spec.integrations.{key}.provider`
- `spec.sandboxes.{key}.agent.integrations.{key}.provider`
- `spec.sandboxes.{key}.integrations.{key}.provider`

Accepted input: string.

Constraints: `"brave"` or `"tavily"`.

## SecretRef

Environment variable whose value is a bearer or API credential; the configuration holds no credential value.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.credential`
- `spec.gateway.target.kubernetes.authentication.token`
- `spec.gateway.target.openshift.authentication.token`
- `spec.inferenceProviders.{key}.credential`
- `spec.inferences.{key}.routes[].provider.credential`
- `spec.integrations.{key}.credential`
- `spec.sandboxes.{key}.agent.inference.routes[].provider.credential`
- `spec.sandboxes.{key}.agent.integrations.{key}.credential`
- `spec.sandboxes.{key}.inferenceProviders.{key}.credential`
- `spec.sandboxes.{key}.inferences.{key}.routes[].provider.credential`
- `spec.sandboxes.{key}.integrations.{key}.credential`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `env` | string | Yes | — | Uppercase name of the caller environment variable that holds the credential. NEMOCLAW_KUBERNETES_STATE and the NEMOCLAW_MANAGED_K8S_, HELM_, KUBE_, and KUBERNETES_SERVICE_ prefixes are reserved for runtime controls. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

## ServiceAuthentication

Bearer authentication for a managed inference service.

Guide: [Managed vLLM authentication](../agents-inference/inference.md#authenticating-a-managed-vllm-service).

Paths:

- `spec.services.{key}.authentication`

Accepted input: string.

Constraints: `"bearer"`.

## ServiceContainer

Managed inference CPU and memory limits, GPU selection, IPC, and shared-memory settings.

Guide: [Container limits and update policy](../agents-inference/inference.md#setting-container-limits-and-update-policy).

Paths:

- `spec.services.{key}.container`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `cpuLimitMillis` | integer | No | — | CPU usage limit in millicores. Omission leaves Docker CPU usage unrestricted. Changing the limit replaces the model container. Constraints: minimum 1; maximum 4294967295. |
| `gpuDevices` | array of string | No | — | The GPUs the model container gets on a host with several, as `docker run --gpus device=` names them: each a UUID from `nvidia-smi --query-gpu=uuid`, such as `GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3`, or an index as a string, such as "1", which can change when the host boots. List exactly one: serving one model across several GPUs isn't implemented yet. Omission exposes every GPU, and the model runtime then requires the host to have exactly one. Changing the list replaces the model container. Constraints: minimum items 1; maximum items 1; items: pattern `^(?:GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|0\|[1-9][0-9]{0,2})$`. |
| `ipc` | [ServiceIpc](#serviceipc) | No | — | IPC namespace. Omission uses private; host shares the execution host's IPC namespace. |
| `memoryLimitGiB` | integer | No | — | Container memory limit in GiB, independent of the model's GPU budget. Omission sets a 104 GiB limit. Changing the limit replaces the model container. Constraints: minimum 1; maximum 8589934591. |
| `sharedMemoryGiB` | integer | No | — | Shared-memory size in GiB, from 1 through 64. Omission uses 8; host IPC uses the host's existing shared-memory mount instead. Constraints: minimum 1; maximum 64. |

## ServiceDefinition

One explicitly supported managed container package.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}`

Accepted input: object.

### Alternative 1

Managed Ollama daemon and selected model.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `container` | [ServiceContainer](#servicecontainer) | No | — | Container CPU and memory limits, GPU selection, IPC, and shared memory for Docker. Native managed Podman inference is unsupported. Omission uses private IPC and 8 GiB of shared memory. |
| `hardware` | [ServiceHardware](#servicehardware) | Yes | — | Explicit supported GPU or system profile. |
| `image` | string | Yes | — | Immutable runtime image containing Ollama and the NemoClaw supervisor. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before container creation. Omission means IfNotPresent. Constraints: `"IfNotPresent"` or `"Never"`. |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"ollama"`. |
| `memory` | [OllamaMemory](#ollamamemory) | No | — | GPU budget and resident memory-protection thresholds. |
| `model` | [OllamaModel](#ollamamodel) | Yes | — | Selected immutable Ollama registry model. |
| `placement` | [ServicePlacement](#serviceplacement) | With external gateway or Podman; paired with publication | — | SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication. |
| `publication` | [ServicePublication](#servicepublication) | With placement | — | Private inference address reachable by OpenShell. Required with placement. |
| `serving` | [OllamaServing](#ollamaserving) | No | — | Ollama serving limits. |
| `updatePolicy` | [ServiceUpdatePolicy](#serviceupdatepolicy) | No | `"Preserve"` | Preserve refuses replacement of a running Docker model container. Recreate permits sequential replacement and possible downtime until removed or changed. |

### Alternative 2

Managed authentication proxy for an external Ollama daemon and model.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | Private or loopback HTTP IPv4:port/v1 published by the proxy and reachable by OpenShell. |
| `engine` | string | No | — | Local Docker engine: a Unix socket, or on Windows a named pipe such as `npipe:////./pipe/docker_engine`. Omission uses the managed gateway engine. Constraints: pattern `^(unix:///[^?#\x00]*\|npipe:////\./pipe/[A-Za-z0-9._-]+)$`. |
| `image` | string | Yes | — | Immutable NemoClaw proxy image. The external daemon runs on the selected Docker host. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before container creation. Omission means IfNotPresent. Constraints: `"IfNotPresent"` or `"Never"`. |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"ollamaProxy"`. |
| `upstream` | [ExternalOllama](#externalollama) | Yes | — | External loopback-only daemon and already-installed model. |

### Alternative 3

Managed vLLM runtime and immutable model snapshot.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [ServiceAuthentication](#serviceauthentication) | No | — | Optional native bearer authentication. The runtime uses a key supplied in NEMOCLAW_INFERENCE_KEY, or generates and retains one in its credential storage; omission preserves unauthenticated serving. |
| `container` | [ServiceContainer](#servicecontainer) | No | — | Container CPU and memory limits, GPU selection, IPC, and shared memory for Docker. Native managed Podman inference is unsupported. Omission uses private IPC and 8 GiB of shared memory. |
| `hardware` | [ServiceHardware](#servicehardware) | Without recipe | — | Explicit hardware contract: a named GPU or system profile, or dedicated GPU requirements for Linux AMD64. Required without an inline recipe; excludes recipe. |
| `image` | string | Yes | — | Immutable runtime image containing vLLM, the NemoClaw supervisor, and any declared recipe tools. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before container creation. Omission means IfNotPresent. Constraints: `"IfNotPresent"` or `"Never"`. |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"vllm"`. |
| `memory` | [Memory](#memory) | No | — | GPU budget and resident watchdog thresholds. Omission selects the SDK defaults. |
| `model` | [Model](#model) | Yes | — | Public Hugging Face repository and immutable commit. |
| `placement` | [ServicePlacement](#serviceplacement) | With external gateway or Podman; paired with publication | — | SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication. |
| `publication` | [ServicePublication](#servicepublication) | With placement | — | Private inference address reachable by OpenShell. Required with placement. |
| `recipe` | [InlineRecipe](#inlinerecipe) | Without hardware | — | Inline preparation and serving contract supplied by the pinned runtime image. Required without hardware; excludes hardware. |
| `serving` | [Serving](#serving) | No | — | Service limits. Omission selects the SDK defaults; recipe serving settings select recipe-specific parsers and execution options. |
| `updatePolicy` | [ServiceUpdatePolicy](#serviceupdatepolicy) | No | `"Preserve"` | Preserve refuses replacement of a running Docker model container. Recreate permits sequential replacement and possible downtime until removed or changed. |

### Alternative 4

Managed llama.cpp runtime and immutable GGUF.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [ServiceAuthentication](#serviceauthentication) or null | No | — | Native bearer authentication using a platform-supplied key or retained generated credential. |
| `container` | [ServiceContainer](#servicecontainer) | No | — | Container CPU and memory limits, GPU selection, IPC, and shared memory for Docker. Native managed Podman inference is unsupported. Omission uses private IPC and 8 GiB of shared memory. |
| `hardware` | [ServiceHardware](#servicehardware) | Yes | — | Execution hardware observed before acquisition and startup; one NVIDIA CUDA GPU is required. |
| `image` | string | Yes | — | Immutable image containing llama-server and the NemoClaw supervisor. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) | No | — | Image acquisition before container creation. Omission means IfNotPresent. Constraints: `"IfNotPresent"` or `"Never"`. |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"llamaCpp"`. |
| `memory` | [SingleGpuMemory32](#singlegpumemory32) | No | — | Declared admission budget and resident host memory protection. |
| `model` | [GgufModel](#ggufmodel) | Yes | — | One immutable public GGUF artifact; no model-source credential is resolved. |
| `placement` | [ServicePlacement](#serviceplacement) | With external gateway or Podman; paired with publication | — | SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication. |
| `publication` | [ServicePublication](#servicepublication) | With placement | — | Private inference address reachable by OpenShell. Required with placement. |
| `serving` | [LlamaCppServing](#llamacppserving) | No | — | Native llama-server context, batching, alias and readiness deadline. |
| `updatePolicy` | [ServiceUpdatePolicy](#serviceupdatepolicy) | No | `"Preserve"` | Preserve refuses replacement of a running Docker model container. Recreate permits sequential replacement and possible downtime until removed or changed. |

### Alternative 5

Native vLLM-backed NIM behind a private Docker network and route filter.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [ServiceAuthentication](#serviceauthentication) or null | No | — | Native vLLM bearer authentication; the published listener filters management routes. |
| `backend` | [NimBackend](#nimbackend) | Yes | — | Explicit native backend; other NIM engines are unsupported. |
| `backendNetworkCIDR` | string | Yes | — | Dedicated canonical private IPv4 /24, distinct from all other service and gateway networks on this engine. |
| `container` | [ServiceContainer](#servicecontainer) or null | No | — | Docker execution limits and GPU selection, separate from native memory protection. |
| `hardware` | [ServiceHardware](#servicehardware) | Yes | — | Required GPU and execution-host compatibility. |
| `image` | string | Yes | — | Digest-pinned native NIM image containing the NemoClaw supervisor and nginx. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `imagePullPolicy` | [ImagePullPolicy](#imagepullpolicy) or null | No | — | IfNotPresent acquires a missing image; Never requires a locally installed image. Constraints: `"IfNotPresent"` or `"Never"`; . |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"nim"`. |
| `memory` | [SingleGpuMemory40](#singlegpumemory40) | No | — | GPU budget and host memory protection. |
| `model` | [NimModel](#nimmodel) | Yes | — | Exact native model and embedded profile. |
| `ngcCredential` | [NgcCredential](#ngccredential) | Yes | — | Operator-owned NGC credential file on the selected Docker host, mounted read-only for native startup. |
| `placement` | [ServicePlacement](#serviceplacement) or null | No | — | Explicit SSH Docker placement; pair with publication. Omission inherits a managed local Docker gateway. |
| `publication` | [ServicePublication](#servicepublication) or null | No | — | Private published inference address reachable by OpenShell; pair with placement. |
| `serving` | [NimServing](#nimserving) | No | — | Native ports, context length, and startup wait. |
| `updatePolicy` | [ServiceUpdatePolicy](#serviceupdatepolicy) | No | `"Preserve"` | Preserve refuses model replacement; Recreate permits sequential replacement and downtime during explicit apply. |

### Alternative 6

Image-owned container with explicit launch settings and bounded readiness.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `command` | array of string | No | — | Optional argument list for the image entrypoint, without implicit shell expansion. |
| `container` | [ContainerExecution](#containerexecution) | No | — | Execution limits. These do not replace the image's model-memory policy. |
| `data` | [ContainerData](#containerdata) | No | — | Disposable application data. Omission provides /data; destroy removes this volume. Typed model services retain their own storage policy. |
| `environment` | map of string | No | — | Literal application settings, visible in configuration, plans/state, exports, and Docker inspection. No host-variable expansion or protected credential delivery. Constraints: keys: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |
| `files` | map of string | No | — | Literal nonsecret configuration files uploaded before startup with mode 0444. Contents are retained in plans and state; these are not secret files or immutable mounts. |
| `image` | string | Yes | — | Immutable application image. The image owns its entrypoint and default command. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `kind` | string | Yes | — | Supported installer selected by this service definition. Constraints: `"container"`. |
| `port` | integer | No | — | Listener inside the container. It must match the application's own configuration; omission uses publication.port when published. Constraints: minimum 1; maximum 65535. |
| `publication` | [ContainerPublication](#containerpublication) | No | — | Optional loopback or private IPv4 TCP publication. Omission publishes no port. |
| `readiness` | [ContainerReadiness](#containerreadiness) | No | — | HTTP, managed-runtime status, or image HEALTHCHECK readiness on every apply. |
| `user` | string | No | `"65532:65532"` | Numeric UID:GID. Omission selects 65532:65532; root requires an explicit 0:0 for images that need it. Constraints: pattern `^[0-9]{1,9}:[0-9]{1,9}$`. |

## ServiceExposure

One OpenShell service exposure: a loopback port the gateway makes reachable.

Guide: [Agent interfaces](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway).

Paths:

- `spec.sandboxes.{key}.serviceExposures.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authorizationMode` | [AuthorizationMode](#authorizationmode) | No | — | How OpenShell treats an incoming application Authorization header. Omission leaves OpenShell's default, STRIP. |
| `targetPort` | integer | Yes | — | Loopback TCP port the service listens on inside the sandbox. Constraints: minimum 1; maximum 65535. |

## ServiceHardware

Explicit execution hardware: a named profile or dedicated GPU requirements. Excludes an inline recipe.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.hardware`

Accepted input: [DedicatedHardware](#dedicatedhardware) or object.

### Alternative 2

A named hardware contract with fixed compatibility requirements.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `architecture` | string | No | — | Host CPU architecture: amd64 or arm64. Required for GPU profiles; system profiles fix arm64 and reject a conflicting value. Constraints: `"amd64"` or `"arm64"`. |
| `minGpuMemoryBytes` | integer | No | — | Minimum dedicated memory of each selected GPU in bytes, from 4 GiB through 4 TiB. Required with gpuMemoryUtilization; forbidden for unified-memory profiles. Fixed budgets otherwise use observed capacity. Constraints: minimum 4294967296; maximum 4398046511104. |
| `profile` | [HardwareProfile](#hardwareprofile) | Yes | — | GPU family and memory architecture. Every profile requires observed compute capability and driver major 580 or newer. Unified-memory profiles budget host RAM; dedicated-memory profiles require GPU total/free counters. |

## ServiceIpc

IPC namespace used by the managed inference container.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.container.ipc`

Accepted input: string.

Constraints: `"private"` or `"host"`.

## ServicePlacement

Execution host and Docker network for a remote model service.

Guide: [SSH model service](../agents-inference/remote-service.md).

Paths:

- `spec.services.{key}.placement`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | Yes | — | SSH Docker endpoint used for an explicitly placed service. Constraints: pattern `^ssh://`. |
| `networkCIDR` | string | Yes | — | Canonical private IPv4 /24 on the selected Docker engine. Constraints: pattern `/24$`. |

## ServicePublication

HTTP model publication must match the bind address, service port, and /v1 path.

Guide: [SSH model service](../agents-inference/remote-service.md).

Paths:

- `spec.services.{key}.publication`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bindAddress` | string | Yes | — | Private host IPv4 address outside the service Docker subnet. Loopback is rejected. |
| `endpoint` | string | Yes | — | Private HTTP inference URL reachable by OpenShell. Constraints: pattern `^http://.+:[0-9]+/v1$`. |

## ServiceUpdatePolicy

Whether updates may stop an existing model service before its replacement is ready.

Guide: [Container limits and update policy](../agents-inference/inference.md#setting-container-limits-and-update-policy).

Paths:

- `spec.services.{key}.updatePolicy`

Accepted input: string.

Constraints: `"Preserve"` or `"Recreate"`.

## Serving

Limits apply with or without a recipe. Recipe serving settings replace the ordinary service parser settings.

Guide: [Managed models](../agents-inference/models.md).

Paths:

- `spec.services.{key}.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `batchTokens` | integer | No | `1024` | Maximum tokens in a scheduled batch. Constraints: `0` or minimum 512; maximum 4096. Omitted or zero selects the default. |
| `contextTokens` | integer | No | `32768` | Maximum model context length in tokens. Constraints: `0` or minimum 8192; maximum 65536. Omitted or zero selects the default. |
| `enforceEager` | boolean | No | — | Without a recipe, omission or true enables eager execution; false leaves compilation and CUDA graphs at vLLM's native defaults. |
| `mambaBackend` | string | No | `""` | Native Mamba backend without a recipe. Empty uses vLLM's default; flashinfer selects the pinned image's FlashInfer backend. Constraints: `""` or `"flashinfer"`. |
| `maxSequences` | integer | No | `1` | Maximum concurrent sequences. Constraints: `0` or minimum 1; maximum 2. Omitted or zero selects the default. |
| `modelName` | string | No | `""` | Optional advertised model name without a recipe. Omission uses the model repository; routes must match the advertised name. Constraints: `""` or pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. |
| `pipelineParallelSize` | integer | No | — | vLLM's --pipeline-parallel-size without a recipe: how many GPU stages each hold a range of layers. vLLM uses tensor × pipeline parallel size GPUs; selected GPUs the layout doesn't use stay reserved but idle. Constraints: minimum 1; maximum 16. Omission gives vLLM's default of 1. Must be omitted with a recipe, which sets its own. |
| `port` | integer | No | `18888` | Inference listening port. Explicit publication must use this port. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |
| `reasoningParser` | string | No | `""` | Native vLLM reasoning parser used when no recipe is declared. Empty omits the parser flag. Constraints: pattern `^[a-z0-9_]*$`. |
| `speculativeTokens` | integer | No | `0` | MTP speculative tokens. Must be zero without a recipe. Constraints: minimum 0; maximum 3. |
| `startupTimeoutSeconds` | integer | No | `1800` | Seconds allowed for backend readiness before startup fails. Constraints: `0` or minimum 60; maximum 3600. Omitted or zero selects the default. |
| `tensorParallelSize` | integer | No | — | vLLM's --tensor-parallel-size without a recipe: how many GPUs split each layer. vLLM checks the layout against the GPUs it sees and the model when it starts, and fails startup if they don't support it. Constraints: minimum 1; maximum 16. Omission gives vLLM the number of container.gpuDevices entries, or 1 without them, when pipelineParallelSize is also omitted, and vLLM's default of 1 when it's set. Must be omitted with a recipe, which sets its own. |
| `toolParser` | string | No | `""` | Native vLLM tool-call parser used when no recipe is declared. Empty omits the parser flag. Constraints: pattern `^[a-z0-9_]*$`. |

## Settings

Recipe settings select serving behavior without shell hooks or arbitrary argument lists.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `chunkedPrefill` | boolean | No | `false` | Enable chunked prefill. |
| `compilation` | [Compilation](#compilation) | No | — | Optional typed compilation settings. Omission selects compilation mode 0 for recipe serving. |
| `environment` | map of string | No | `{}` | Literal VLLM_* environment values for serving. Do not place credentials here. Constraints: keys: pattern `^VLLM_[A-Z0-9_]*$`; values: pattern `^[^\x00]*$`; maximum characters 4096. |
| `kvCacheDtype` | string | No | `""` | KV cache dtype understood by the pinned vLLM image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `lazyLoading` | boolean | No | `false` | Enable the lazy safetensors loading strategy. |
| `mambaCacheDtype` | string | No | `""` | Mamba SSM cache dtype understood by the pinned vLLM image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `modelName` | string | Yes | — | Model identifier advertised by vLLM. The primary route model must match it. Constraints: pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`; maximum characters 256. |
| `pipelineParallelSize` | integer | No | — | vLLM's --pipeline-parallel-size: how many GPU stages each hold a range of layers. Constraints: minimum 1; maximum 16. Omission selects vLLM's default of 1. |
| `preparedEnvironment` | map of string | No | `{}` | VLLM_* variables mapped to paths beneath verified prepared data; . selects its root. Names must not also appear in environment. Constraints: keys: pattern `^VLLM_[A-Z0-9_]*$`. |
| `reasoningParser` | string | No | `""` | Native vLLM reasoning parser supplied by the runtime image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `tensorParallelSize` | integer | No | — | vLLM's --tensor-parallel-size: how many GPUs split each layer. vLLM checks the layout against the GPUs it sees and the model when it starts. Constraints: minimum 1; maximum 16. Omission selects vLLM's default of 1. |
| `toolParser` | string | No | `""` | Native vLLM tool parser supplied by the runtime image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |

## SingleGpuMemory32

Single-GPU admission budget and continuous host memory thresholds.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | — | Consecutive low-memory observations required to stop native inference. Constraints: minimum 1; maximum 5. |
| `freeGateGiB` | integer | No | — | Available-memory gate for the free-memory threshold, in GiB. Constraints: minimum 6; maximum 24. |
| `gpuMemoryGiB` | integer | No | — | GPU budget in GiB; native allocation semantics depend on the backend. Constraints: minimum 4; maximum 512. |
| `hostReserveGiB` | integer | No | — | Host memory reserved outside the native model allocation, in GiB. Constraints: minimum 28; maximum 64. |
| `minAvailableGiB` | integer | No | — | Stop threshold for available host memory, in GiB. Constraints: minimum 6; maximum 16. |
| `minFreeGiB` | integer | No | — | Stop threshold for free host memory, in GiB. Constraints: minimum 2; maximum 8. |

## SingleGpuMemory40

Single-GPU admission budget and continuous host memory thresholds.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.services.{key}.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | — | Consecutive low-memory observations required to stop native inference. Constraints: minimum 1; maximum 5. |
| `freeGateGiB` | integer | No | — | Available-memory gate for the free-memory threshold, in GiB. Constraints: minimum 6; maximum 24. |
| `gpuMemoryGiB` | integer | No | — | GPU budget in GiB; native allocation semantics depend on the backend. Constraints: minimum 4; maximum 512. |
| `hostReserveGiB` | integer | No | — | Host memory reserved outside the native model allocation, in GiB. Constraints: minimum 28; maximum 64. |
| `minAvailableGiB` | integer | No | — | Stop threshold for available host memory, in GiB. Constraints: minimum 6; maximum 16. |
| `minFreeGiB` | integer | No | — | Stop threshold for free host memory, in GiB. Constraints: minimum 2; maximum 8. |

## Spec

The configuration requires at least one named sandbox and at least one selected inference provider. Managed packages declared under services are installed independently of their consumers.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `gateway` | [Gateway](#gateway) | Yes | — | OpenShell gateway connection or managed gateway settings. |
| `grants` | map of [Grant](#grant) | No | — | Named network grants available to sandbox networks through grantRefs. Each selected grant becomes a policy rule with its definition's name; unselected grants are validated but grant nothing. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `harnesses` | map of [Harness](#harness) | No | — | Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `inferenceProviders` | map of [InferenceProvider](#inferenceprovider) | No | — | Named inference definitions available to sandbox routes through providerRef. Unselected definitions create no resources or credential requirements. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `inferences` | map of [Inference](#inference) | No | — | Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions shared by agents through integrationRefs. Definitions alone grant no access. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `policies` | map of [ExplicitPolicy](#explicitpolicy) | No | — | Named complete OpenShell sandbox policies available to sandbox networks through policyRef. Unselected policies are validated but apply to no sandbox. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `registries` | array of [Registry](#registry) | No | — | Registries whose images NemoClaw pulls through Docker with the logins of the machine running OpenTofu, from its Docker configuration file. Lists addresses only; credentials stay in that file or its credential store. Constraints: maximum items 32. |
| `sandboxes` | map of [Sandbox](#sandbox) | Yes | — | Named sandboxes: one to 256 with a kubernetes or openshift gateway target, whose cluster schedules them, and one to 32 with docker or podman, which run every sandbox on one host. Each runs one agent through its selected Fabric adapter and attaches at most 32 providers, OpenShell's limit per sandbox: its selected inference providers, web search, and api integrations. Declaration order does not select a default sandbox or agent. Constraints: minimum entries 1; keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `services` | map of [ServiceDefinition](#servicedefinition) | No | — | Named managed container services to install, verify once, and remove during destroy. Inference providers may consume their connection through serviceRef. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## TLS

Gateway TLS file references: the CA certificate that verifies the gateway, and a client certificate and key, which must appear together, when the gateway requires one.

Guide: [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.tls`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `ca` | [FileRef](#fileref) | Yes | — | Environment variable whose value names the local CA certificate file. |
| `certificate` | [FileRef](#fileref) | No | — | Environment variable whose value names the local client certificate file. Requires key. |
| `key` | [FileRef](#fileref) | No | — | Environment variable whose value names the local client private-key file. Requires certificate. |

## Tool

Executable identity inside the runtime image; this is not a shell command.

Guide: [Inline model recipes](../agents-inference/recipes.md).

Paths:

- `spec.services.{key}.recipe.preparation`
- `spec.services.{key}.recipe.verification`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `executable` | string | Yes | — | Absolute path to the executable inside the image. Traversal and empty path components are rejected. Constraints: pattern `^/`; maximum characters 4096. |
| `sha256` | string | Yes | — | Lowercase SHA-256 of the executable file. Constraints: pattern `^[a-f0-9]{64}$`. |
