<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# YAML Configuration Reference

<!-- Generated from the SDK schema. Edit Rust field descriptions and constraints, then run cargo run --locked -p nemoclaw-build -- schema. -->

This reference and the [JSON Schema](../../schemas/nemoclaw-v1alpha1.schema.json) describe authored YAML for this source revision.
See [schema maintenance](../configuration-schema.md) for generation and validation commands.

Paths use `[]` for an array element and `{key}` for a map entry.
Required fields must appear when their containing object is present; conditional requirements are stated in the table or description.
An optional object can contain required fields if you choose to declare it.
Omit optional fields instead of assigning `null`; only nested values inside a Pi `piModel` object may be null.
Defaults describe SDK normalization or backend behavior; JSON Schema validation does not insert values.
Empty or zero selects a default only where stated.

## Validation Beyond the Schema

- Document::parse remains authoritative. It rejects YAML aliases, anchors, merge keys, unsupported tags, duplicate keys, multiple documents, and input larger than 1 MiB.
- The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, Docker engine syntax, and publication address/port/network agreement.
- Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.
- The parser checks unique agent names, identical inference settings across multiple OpenClaw agents, and a shared disclosure mode among unrestricted agents; omitted disclosure means progressive.
- The parser compares providerRef with provider.name, route model with the served model, and snapshot identity with the service model.
- The parser checks memory threshold ordering and GPU/KV budget relationships; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.
- Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation.

## Document

Desired configuration for one deployment. Fields describe authored input before SDK normalization.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `document root`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `apiVersion` | string | Yes | — | Configuration API version understood by this SDK. Constraints: `"nemoclaw.nvidia.com/v1alpha1"`. |
| `kind` | string | Yes | — | Configuration document kind. Constraints: `"NemoClawConfig"`. |
| `metadata` | [Metadata](#metadata) | Yes | — | Deployment name and durable ownership identity. |
| `spec` | [Spec](#spec) | Yes | — | Gateway, inference provider, and sandbox configuration. |

## Agent

One Fabric harness and its inference route.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `auth` | [AgentAuth](#agentauth) | No | — | Hermes API-key authentication through the routed provider. The provider must declare a credential reference. |
| `execution` | [AgentExecution](#agentexecution) | No | — | OpenClaw timeout and heartbeat defaults. Declare only on the first agent in a shared sandbox. |
| `harness` | string | Yes | — | Agent harness. Harnesses other than openclaw require external gateway and inference services. Constraints: `"deepagents"` or `"hermes"` or `"openclaw"` or `"claude"` or `"codex"` or `"mini-swe-agent"` or `"nooa"` or `"nooa-bench"` or `"remote-agent"` or `"pi"`. |
| `inference` | [Inference](#inference) | Yes | — | Primary inference route for this agent. |
| `interfaces` | [AgentInterfaces](#agentinterfaces) | No | — | Native dashboard access, declared only on the first agent in a sandbox. |
| `name` | string | Yes | — | Lowercase agent name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `observability` | [AgentObservability](#agentobservability) | No | — | Shared OpenClaw tracing, declared only on the first agent. Adds the required collector egress grant. |
| `tools` | [AgentTools](#agenttools) | No | — | OpenClaw tool restriction or disclosure mode. Omission selects progressive discovery without restricting tools. allow: [read] restricts tools, not OS-level filesystem access. |

## AgentAuth

Authenticate Hermes inference using the primary route's credential-bearing provider.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].auth`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `method` | [AuthMethod](#authmethod) | Yes | — | API-key authentication. Interactive login is not supported. |
| `providerRef` | string | Yes | — | Must equal the primary route's providerRef. Secret values stay in OpenShell. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## AgentExecution

OpenClaw execution defaults shared by the sandbox. Declare only on the first agent; other agents use the same native defaults.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].execution`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `heartbeatEvery` | string | No | — | Heartbeat duration in seconds, minutes, or hours, such as 30m. Zero disables heartbeat. Omission leaves native defaults; an explicit interval uses an isolated heartbeat session. Constraints: pattern `^[0-9]+[smh]$(?![\s\S])`; maximum characters 256. |
| `timeoutSeconds` | integer | No | — | Agent-turn timeout in seconds. Omission selects 600; readiness and health checks use separate budgets. Constraints: minimum 1; maximum 1000000000. |

## AgentInterfaces

Harness-specific native interfaces; OpenClaw uses gateway settings, Hermes uses separate services.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces`

Accepted input: [OpenClawInterfaces](#openclawinterfaces) or [HermesInterfaces](#hermesinterfaces).

## AgentObservability

OpenClaw gateway telemetry, declared on the first agent and shared by its sandbox.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].observability`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `otlp` | [OtlpTracing](#otlptracing) | Yes | — | Export traces to an externally operated local OTLP/HTTP collector. Credentials, logs, and metrics are excluded. |

## AgentTools

OpenClaw tool restriction or discovery mode. These forms are mutually exclusive.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].tools`

Accepted input: object or object.

### Alternative 1

Expose only the read tool, independently of the gateway's discovery mode.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `allow` | array of [AllowedTool](#allowedtool) | Yes | — | Exactly the read tool. Empty lists, wildcards, and other tool names are rejected. Constraints: minimum items 1; maximum items 1. |

### Alternative 2

Select the shared gateway's tool discovery mode without granting additional tools.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `disclosure` | [ToolDisclosure](#tooldisclosure) | Yes | — | Progressive uses structured tool search; direct exposes tools directly. Unrestricted agents must agree; omission means progressive. |

## AllowedTool

Tool supported by the read-only OpenClaw policy.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].tools.allow[]`

Accepted input: string.

Constraints: `"read"`.

## AuthMethod

Hermes authentication method supported through the OpenShell provider.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].auth.method`

Accepted input: string.

Constraints: `"api-key"`.

## Compatibility

Execution host requirements and labels that must be present on the pinned image.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.compatibility`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `architecture` | string | Yes | — | Execution host CPU architecture. Constraints: `"arm64"` or `"amd64"`. |
| `gpu` | string | Yes | — | GPU name that must equal the observed device name. Constraints: minimum characters 1. |
| `imageLabels` | map of string | Yes | — | Required org.nemoclaw.* labels. org.nemoclaw.recipe.protocol must equal v1. Constraints: keys: pattern `^org\.nemoclaw\.`; values: minimum characters 1; maximum characters 256. |
| `minDriverMajor` | integer | Yes | — | Minimum NVIDIA driver major version. Constraints: minimum 1; maximum 10000. |
| `minHostMemoryGiB` | integer | Yes | — | Minimum total host memory in GiB. Constraints: minimum 1; maximum 4096. |

## Compilation

Typed vLLM compilation settings.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.serving.compilation`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `captureSizes` | array of integer | Yes | — | Nonempty list of CUDA graph capture sizes. Constraints: minimum items 1; maximum items 64; items: minimum 1; maximum 65536. |
| `cudagraphMode` | string | Yes | — | CUDA graph execution mode. Constraints: `"NONE"` or `"FULL_DECODE_ONLY"`. |
| `mode` | integer | Yes | — | Compilation mode understood by the pinned vLLM image. Constraints: minimum 0; maximum 3. |

## Credential

A reference to a caller-provided environment variable; the configuration contains no credential value.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.credential`
- `spec.gateway.tls.ca`
- `spec.gateway.tls.certificate`
- `spec.gateway.tls.key`
- `spec.inferenceProviders[].credential`
- `spec.sandboxes[].integrations.webSearch.credential`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `env` | string | Yes | — | Uppercase environment variable name. For TLS fields, its value is a local certificate or key file path; otherwise it is a bearer/API credential. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

## DashboardBind

Address on which the native dashboard listens inside the sandbox.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces.dashboard.bind`

Accepted input: string.

Constraints: `"127.0.0.1"` or `"0.0.0.0"`.

## ExplicitPolicy

Credential-free OpenShell policy. Validation and protocol conversion use the pinned OpenShell policy library.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `filesystem_policy` | [PolicyFilesystem](#policyfilesystem) | No | — | Filesystem grants. Omission retains OpenShell filesystem defaults, not the isolated preset. |
| `landlock` | [PolicyLandlock](#policylandlock) | No | — | Kernel filesystem enforcement compatibility. |
| `network_policies` | map of [PolicyRule](#policyrule) | Yes | — | Named egress rules. An empty map grants no general egress. |
| `process` | [PolicyProcess](#policyprocess) | No | — | Sandbox process user and group. |
| `version` | integer | Yes | — | Policy format version; currently 1. Constraints: `1`; minimum 0. |

## ExplicitPolicySelection

Select an explicit policy; no isolated defaults are merged into it.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `explicit` | [ExplicitPolicy](#explicitpolicy) | Yes | — | Complete sandbox policy in OpenShell YAML field names. |

## ExternalManagement

NemoClaw uses this resource without managing its lifecycle or administrative configuration.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].ollama.network.management`
- `spec.inferenceProviders[].ollamaProxy.model.management`
- `spec.sandboxes[].network.proxy.management`

Accepted input: string.

Constraints: `"external"`.

## ExternalNetwork

Identify a network owned outside this deployment.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].ollama.network`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `management` | [ExternalManagement](#externalmanagement) | No | — | Optional external ownership declaration. Omission means external. |
| `name` | string | Yes | — | Existing network name on the Ollama Docker engine. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## ExternalOllamaModel

Existing Ollama model installation, independently owned outside the deployment.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].ollamaProxy.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `digest` | string | Yes | — | Lowercase 64-character model digest reported by Ollama's /api/tags API. Constraints: pattern `^[a-f0-9]{64}$`. |
| `management` | [ExternalManagement](#externalmanagement) | No | — | Optional ownership declaration; omission means external. |

## File

One immutable file in a model snapshot.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.snapshot.files[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Relative file path. Traversal and reserved NemoClaw metadata names are rejected. Constraints: minimum characters 1. |
| `sha256` | string | Yes | — | Lowercase SHA-256 of the complete file. Constraints: pattern `^[a-f0-9]{64}$`. |
| `size` | integer | Yes | — | Expected file length in bytes; zero is rejected. Constraints: minimum 1. |

## Gateway

Choose a managed local Docker gateway or connect to an external gateway. Credentials and TLS require HTTPS.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.gateway`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `credential` | [Credential](#credential) | No | — | Optional bearer credential reference for an external HTTPS gateway. |
| `endpoint` | string | When external | — | Gateway HTTP(S) origin, without a path. Required for an external gateway; managed gateways use unprivileged loopback HTTP ports. Managed only: omitted or empty selects http://127.0.0.1:17681. |
| `engine` | string | No | — | Managed gateway Docker socket. Omit or leave empty for an external gateway. Managed only: omitted or empty selects unix:///var/run/docker.sock. |
| `image` | string | No | — | Managed gateway image pinned by the SDK. Omit or leave empty for an external gateway. Managed only: omitted or empty selects ghcr.io/nvidia/openshell/gateway@sha256:3d08ad1e7d839a2ffb9ac85a66102b96dd6bc042c3a6f1eaa31351998fd65792. |
| `management` | string | Yes | — | Whether the SDK manages the gateway or connects to an existing one. Constraints: `"managed"` or `"external"`. |
| `network` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for the gateway network configured by networkCIDR. Omission means managed for a managed gateway. |
| `networkCIDR` | string | No | — | Canonical private IPv4 /24 for a managed gateway. Omit or leave empty for an external gateway. Managed only: omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid). |
| `storage` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for gateway storage. Omission means managed for a managed gateway; external gateways cannot declare storage. |
| `tls` | [TLS](#tls) | No | — | Optional mutual TLS references for an external HTTPS gateway. |

## HermesApi

Hermes HTTP API listener inside the sandbox; host access requires OpenShell forwarding.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces.api`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `port` | integer | Yes | — | Sandbox-local API port, from 8642 through 8652. Constraints: minimum 8642; maximum 8652. |

## HermesDashboard

Native Hermes dashboard with isolated configuration and active sessions.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces.dashboard`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `enabled` | boolean | Yes | — | Start the dashboard. When false, all other dashboard fields must be omitted. |
| `internalPort` | integer | No | — | Native dashboard listener behind the local forwarder; defaults to 19119 and must differ from port. Constraints: minimum 1024; maximum 65535. |
| `port` | integer | No | — | Sandbox dashboard access port; defaults to 18789. Must differ from internalPort and reserved API ports. Constraints: minimum 1024; maximum 65535. |
| `tui` | [HermesTui](#hermestui) | No | — | Enable native browser chat/TUI; omitted settings preserve the pinned Hermes default of enabled. |

## HermesInterfaces

Native Hermes services. Declare at least one override; defaults enable the dashboard and browser chat.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [HermesApi](#hermesapi) | No | — | Authenticated HTTP API settings. Omitting api selects port 8642; declaring api requires port. |
| `dashboard` | [HermesDashboard](#hermesdashboard) | No | — | Dashboard service settings; omitted settings enable port 18789 with internal port 19119. |

## HermesTui

Browser chat/TUI availability; standalone terminal access remains native Hermes behavior.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces.dashboard.tui`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `enabled` | boolean | Yes | — | Permit browser chat and its WebSocket session endpoints. |

## Image

Sandbox image identity.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes[].image`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `ref` | string | No | `"nc-prototype-fabric@sha256:a608340846053d881c3c6b3bdd7541d4f2f53236deaaef8e0b8f44afd8d4e8dd"` | Immutable image reference. Omitted or empty selects the SDK-pinned Fabric image. Constraints: `""` or pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. Omitted or empty selects the default. |

## Inference

Agent inference routing.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].inference`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `routes` | array of [Route](#route) | Yes | — | Exactly one route named primary. Constraints: minimum items 1; maximum items 1. |

## InferenceApi

Wire API used by the agent through OpenShell; no protocol conversion is implied.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].api`

Accepted input: string.

Constraints: `"openai-completions"` or `"openai-responses"` or `"anthropic-messages"`.

## InferenceProvider

Choose endpoint for external inference, endpoint plus ollama for managed Ollama, or service for managed vLLM.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [InferenceApi](#inferenceapi) | No | — | Request API. Omission selects anthropic-messages for Claude, openai-responses for Codex, and openai-completions for other non-Pi harnesses. Pi requires omission and selects its API through native model metadata. |
| `credential` | [Credential](#credential) | No | — | Optional API credential reference for an external HTTPS endpoint. Excluded by service and ollama. |
| `endpoint` | string | Without service | — | Inference HTTP(S) URL. Required without service; omit or leave empty with service. HTTP requires a literal private or loopback address. |
| `management` | [Management](#management) | No | — | Optional server ownership. Omission means managed with service or ollama, external with endpoint alone. The OpenShell provider registration remains deployment-owned in either mode. |
| `name` | string | Yes | — | Provider name referenced by the primary route. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `ollama` | [ManagedOllama](#managedollama) | No | — | Manage Ollama through a local Unix Docker socket and an existing network. Requires an explicit private or loopback IP:port/v1 HTTP endpoint. |
| `ollamaProxy` | [OllamaProxy](#ollamaproxy) | No | — | Manage an authenticated proxy while leaving the endpoint's Ollama daemon and installed model external. |
| `provider` | string | Yes | — | OpenShell provider implementation. Must match the selected API family. Constraints: `"openai"` or `"anthropic"`. |
| `service` | [Service](#service) | No | — | Manage vLLM from a pinned runtime image and model. Excludes ollama and credential; endpoint must be omitted or empty. |

## InlineRecipe

Data-only contract for executables and capabilities packaged in a pinned runtime image.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe`

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

## Integrations

Optional integrations shared by named agents in a sandbox.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].integrations`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `webSearch` | [WebSearch](#websearch) | Yes | — | Brave Search with gateway-held credentials and explicit agent grants. |

## ManagedManagement

NemoClaw manages this resource's lifecycle. Storage retention is independent of ownership.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.gateway.network.management`
- `spec.gateway.storage.management`
- `spec.inferenceProviders[].ollama.management`
- `spec.inferenceProviders[].ollama.model.management`
- `spec.inferenceProviders[].ollama.storage.management`
- `spec.inferenceProviders[].ollamaProxy.management`
- `spec.inferenceProviders[].service.management`
- `spec.inferenceProviders[].service.model.management`
- `spec.inferenceProviders[].service.placement.network.management`
- `spec.inferenceProviders[].service.storage.management`

Accepted input: string.

Constraints: `"managed"`.

## ManagedOllama

Managed Ollama uses a pinned image, an existing Docker network, and an explicit model:tag on the route.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.inferenceProviders[].ollama`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | Yes | — | Local Unix Docker socket URL. Constraints: pattern `^unix:///`. |
| `image` | string | Yes | — | Immutable ollama/ollama image reference. Constraints: pattern `^ollama/ollama@sha256:[a-f0-9]{64}$`. |
| `management` | [ManagedManagement](#managedmanagement) | No | — | Optional ownership declaration for the Ollama daemon container. Omission means managed. |
| `model` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for installing the route model. Omission means managed; this does not change the selected model. |
| `network` | [NetworkReference](#networkreference) | Yes | — | Name of the existing Docker network. |
| `storage` | [ManagedResource](#managedresource) | No | — | Optional model-volume ownership declaration. Omission means managed; the volume survives destroy. |

## ManagedResource

Explicit ownership for a dependency whose creation settings remain on its parent. Only managed ownership is implemented.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.gateway.network`
- `spec.gateway.storage`
- `spec.inferenceProviders[].ollama.model`
- `spec.inferenceProviders[].ollama.storage`
- `spec.inferenceProviders[].service.placement.network`
- `spec.inferenceProviders[].service.storage`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `management` | [ManagedManagement](#managedmanagement) | Yes | — | Managed ownership. Omit the enclosing object to keep the same behavior. |

## Management

Ownership of the inference server, separate from NemoClaw's owned routing registration.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].management`

Accepted input: string or string.

Constraints: `"managed"` or `"external"`.

## Manifest

Pinned model snapshot inventory. The parser rejects duplicate files and file/directory conflicts.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.snapshot`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `files` | array of [File](#file) | Yes | — | Nonempty inventory of pinned model files. Constraints: minimum items 1. |
| `repository` | string | Yes | — | Repository identity, which must match service.model.repository when used in a recipe. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$`; maximum characters 200. |
| `revision` | string | Yes | — | Immutable commit, which must match service.model.revision when used in a recipe. Constraints: pattern `^[a-f0-9]{40}$`. |

## Memory

Resident watchdog thresholds are validated before runtime creation. The parser also checks relationships between thresholds.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | `5` | Consecutive low-memory samples before the watchdog stops the owned process. Constraints: `0` or minimum 1; maximum 5. Omitted or zero selects the default. |
| `freeGateGiB` | integer | No | `12` | Available-memory gate in GiB for minFreeGiB. Must be at least minAvailableGiB after defaults. Constraints: `0` or minimum 6; maximum 24. Omitted or zero selects the default. |
| `gpuMemoryGiB` | integer | No | — | Total GPU budget in GiB without a recipe. Must be omitted or zero with a recipe, which supplies its own byte budget. Constraints: minimum 0; maximum 96. Omitted or zero stays zero in the document. Without a recipe, the backend uses 16 GiB. With a recipe, resources.gpuMemoryBytes supplies the budget. |
| `hostReserveGiB` | integer | No | `32` | Host memory reserve in GiB excluded from the serving budget. Constraints: `0` or minimum 28; maximum 64. Omitted or zero selects the default. |
| `kvCacheGiB` | integer | No | `8` | KV cache allocation in GiB for ordinary vLLM. Recipe serving does not emit this explicit cache-allocation flag. Constraints: `0` or minimum 4; maximum 12. Omitted or zero selects the default. |
| `minAvailableGiB` | integer | No | `8` | Available-memory threshold in GiB that contributes a low-memory sample. Constraints: `0` or minimum 6; maximum 16. Omitted or zero selects the default. |
| `minFreeGiB` | integer | No | `3` | Free-memory threshold in GiB, used when available memory is below freeGateGiB. Constraints: `0` or minimum 2; maximum 8. Omitted or zero selects the default. |

## Metadata

Deployment identity persists across apply, export, recovery, and destroy.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `metadata`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Lowercase deployment name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `uid` | string | Yes | — | Immutable deployment UUID. Use a fresh UUID for a new deployment and retain it for later operations. Constraints: pattern `^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`. |

## Model

Immutable model identity used for snapshot resolution and storage.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `management` | [ManagedManagement](#managedmanagement) | No | — | Optional ownership declaration for downloading and preparing this model installation. Omission means managed. |
| `repository` | string | Yes | — | Public Hugging Face owner/repository name. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$`; maximum characters 200. |
| `revision` | string | Yes | — | Full lowercase 40-hex commit revision; branches and tags are rejected. Constraints: pattern `^[a-f0-9]{40}$`. |

## Network

Sandbox policy selection and optional agent HTTP proxy.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `policy` | [ExplicitPolicySelection](#explicitpolicyselection) | No | — | Complete authored OpenShell policy, replacing the isolated preset. |
| `proxy` | [Proxy](#proxy) | No | — | HTTP proxy address used by the agent process. Does not create a proxy or change gateway networking. |
| `tier` | string | No | `"isolated"` | Isolated policy preset. Omit when declaring policy.explicit; omission without policy selects isolated. Constraints: `""` or `"isolated"`. Omitted or empty selects isolated only without policy.explicit. |

## NetworkReference

An existing container network on the selected engine. NemoClaw attaches its container but does not create or delete the network.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].ollama.network`

Accepted input: string or [ExternalNetwork](#externalnetwork).

Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`.

## OllamaProxy

Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].ollamaProxy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `endpoint` | string | Yes | — | Private or loopback HTTP IPv4:port/v1 published by the proxy and reachable by OpenShell. |
| `engine` | string | Yes | — | Local Unix Docker socket. The external daemon runs on this same Linux host. Constraints: pattern `^unix:///`. |
| `image` | string | Yes | — | Immutable NemoClaw Ollama proxy image built locally. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `management` | [ManagedManagement](#managedmanagement) | No | — | Optional ownership declaration; omission means managed. |
| `model` | [ExternalOllamaModel](#externalollamamodel) | Yes | — | Digest of the already-installed route model. NemoClaw never installs or deletes it. |

## OpenClawDashboard

OpenClaw gateway settings. At least one field is required; omitted fields use native deployment defaults.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces.dashboard`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bind` | [DashboardBind](#dashboardbind) | No | — | Sandbox bind address; defaults to loopback. Host publication still requires OpenShell forwarding. |
| `port` | integer | No | — | Sandbox gateway port; defaults to 18789. Ports 8642 through 8652 are reserved for Hermes. Constraints: minimum 1024; maximum 65535. |

## OpenClawInterfaces

Native agent interfaces. Declare once on the first agent in a shared sandbox.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.sandboxes[].agents[].interfaces`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `dashboard` | [OpenClawDashboard](#openclawdashboard) | Yes | — | Enable the OpenClaw dashboard with sandbox-local token authentication. |

## OtlpTracing

Explicitly enabled HTTP/protobuf tracing. The collector is not managed by NemoClaw.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].observability.otlp`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `enabled` | boolean | Yes | — | Must be true. Omit observability to leave native telemetry unconfigured. Constraints: `true`. |
| `endpoint` | string | Yes | — | Local collector base URL; currently http://host.openshell.internal:4318. Constraints: `"http://host.openshell.internal:4318"`. |
| `sampleRate` | number | Yes | — | Fraction of traces sampled, from 0 through 1 inclusive. Constraints: minimum 0; maximum 1. |
| `serviceName` | string | Yes | — | Nonempty printable ASCII service name, without leading or trailing spaces, at most 256 characters. Constraints: pattern `^[!-~](?:[ -~]*[!-~])?$(?![\s\S])`; minimum characters 1; maximum characters 256. |

## Overrides

Model overrides on the primary route.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].inference.routes[].overrides`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `contextWindow` | integer | No | — | Model context capacity in tokens. Does not resize the inference server. Constraints: minimum 1; maximum 4194304. |
| `maxTokens` | integer | No | — | Maximum output tokens advertised to OpenClaw. Constraints: minimum 1; maximum 1000000000. |
| `model` | string | Yes | — | Model identifier. For a managed service, match its recipe serving.modelName or, without a recipe, model.repository. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. |
| `piModel` | object | No | — | Opaque custom model metadata for the pi harness. Its object may contain nested null values; the piModel value itself must be an object. |
| `reasoning` | boolean | No | — | Whether the model supports reasoning. |
| `reasoningEffort` | [ReasoningEffort](#reasoningeffort) | No | — | Default reasoning effort. The value default leaves the native choice in place. |

## PolicyAllowRule

One allowed application-protocol action.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `allow` | [PolicyMatcher](#policymatcher) | Yes | — | Request matcher. |

## PolicyAnyMatcher

Alternative values for a policy matcher.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.tool`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `any` | array of string | Yes | — | Nonempty list of nonempty glob strings. |

## PolicyBinary

Executable identity for an egress grant.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.binaries[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `path` | string | Yes | — | Absolute executable path inside the sandbox. |

## PolicyEndpoint

TCP destination and optional application-protocol policy. Invalid or conflicting combinations are rejected by OpenShell.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `access` | string | No | — | full or read-only preset; mutually exclusive with rules. Constraints: `"full"` or `"read-only"`. |
| `allow_encoded_slash` | boolean | No | — | Allow encoded slash path segments when required by the upstream API. |
| `allowed_ips` | array of string | No | — | Resolved IP addresses or CIDRs allowed by OpenShell destination validation. |
| `deny_rules` | array of [PolicyMatcher](#policymatcher) | No | — | Application-protocol deny rules, evaluated before allow rules. |
| `enforcement` | string | No | — | enforce or audit; omission follows OpenShell defaults. Constraints: `"enforce"` or `"audit"`. |
| `host` | string | No | — | Destination hostname or DNS glob; may be omitted with allowed_ips. |
| `json_rpc` | [PolicyJsonRpc](#policyjsonrpc) | No | — | JSON-RPC inspection limits. |
| `mcp` | [PolicyMcp](#policymcp) | No | — | MCP method and tool inspection settings. |
| `path` | string | No | — | HTTP path glob selecting the endpoint on a shared host. |
| `port` | integer | No | — | Single TCP port; mutually exclusive with ports. Constraints: minimum 1; maximum 65535. |
| `ports` | array of integer | No | — | Nonempty unique TCP ports; mutually exclusive with port. Constraints: minimum items 1; items: minimum 1; maximum 65535. |
| `protocol` | string | No | — | rest, websocket, json-rpc, or mcp; omit for TCP. Constraints: `"rest"` or `"websocket"` or `"json-rpc"` or `"mcp"`. |
| `request_body_credential_rewrite` | boolean | No | — | Enable OpenShell placeholder rewriting in supported REST request bodies. |
| `rules` | array of [PolicyAllowRule](#policyallowrule) | No | — | Application-protocol allow rules. |
| `tls` | string | No | — | terminate, passthrough, or skip, subject to protocol validation. Constraints: `"terminate"` or `"passthrough"` or `"skip"`. |
| `websocket_credential_rewrite` | boolean | No | — | Enable OpenShell placeholder rewriting after an allowed REST WebSocket upgrade. |

## PolicyFilesystem

Filesystem access grants inside the sandbox.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.filesystem_policy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `include_workdir` | boolean | No | — | Whether to include the working directory as writable; omitted means false in a declared filesystem policy. |
| `read_only` | array of string | No | — | Absolute read-only paths. |
| `read_write` | array of string | No | — | Absolute writable paths. |

## PolicyJsonRpc

JSON-RPC request inspection bounds.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].json_rpc`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `max_body_bytes` | integer | No | — | Maximum buffered request bytes, 1 through 1048576. Constraints: minimum 1; maximum 1048576. |

## PolicyLandlock

Landlock compatibility; hard_requirement refuses unavailable enforcement.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.landlock`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `compatibility` | string | Yes | — | best_effort or hard_requirement. The main-branch spelling strict maps to hard_requirement. Constraints: `"best_effort"` or `"hard_requirement"` or `"strict"`. |

## PolicyMatcher

Request method/path or MCP tool selector; protocol-specific combinations are validated by OpenShell.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[]`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `method` | string | No | — | HTTP or RPC method. |
| `params` | map of [PolicyValueMatcher](#policyvaluematcher) | No | — | MCP parameters; only name is supported by the pinned protocol. |
| `path` | string | No | — | HTTP path glob. |
| `tool` | [PolicyValueMatcher](#policyvaluematcher) | No | — | MCP tool-name selector. |

## PolicyMcp

MCP request inspection and tool-name restrictions.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].mcp`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `allow_all_known_mcp_methods` | boolean | No | — | Allow known MCP methods, subject to tool restrictions; defaults to false. |
| `max_body_bytes` | integer | No | — | Maximum buffered request bytes, 1 through 1048576. Constraints: minimum 1; maximum 1048576. |
| `strict_tool_names` | boolean | No | — | Enforce standard MCP tool-name syntax; defaults to true. |

## PolicyProcess

Process identity resolved inside the sandbox image.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.process`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `run_as_group` | string | No | — | sandbox or a numeric non-root sandbox GID accepted by OpenShell. |
| `run_as_user` | string | No | — | sandbox or a numeric non-root sandbox UID accepted by OpenShell. |

## PolicyRule

Named endpoint grants restricted to declared executable paths.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `binaries` | array of [PolicyBinary](#policybinary) | Yes | — | Executable identities allowed to use these destinations. |
| `endpoints` | array of [PolicyEndpoint](#policyendpoint) | Yes | — | Allowed destinations and optional application-protocol restrictions. |
| `name` | string | Yes | — | Human-readable rule name. |

## PolicyValueMatcher

A literal glob or a nonempty list of alternative globs.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].params.{key}`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].deny_rules[].tool`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.params.{key}`
- `spec.sandboxes[].network.policy.explicit.network_policies.{key}.endpoints[].rules[].allow.tool`

Accepted input: string or [PolicyAnyMatcher](#policyanymatcher).

## Proxy

Agent HTTP proxy, reachable from inside the sandbox. Credentials and URL syntax are excluded.

Guide: [Sandbox policy and proxy](../sandbox-network.md).

Paths:

- `spec.sandboxes[].network.proxy`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `host` | string | Yes | — | Proxy hostname or IPv4 address, without scheme, path, or credentials. Constraints: pattern `^[A-Za-z0-9._-]+$`; minimum characters 1; maximum characters 256. |
| `management` | [ExternalManagement](#externalmanagement) | No | — | Optional external ownership declaration. Omission means external; NemoClaw does not create this proxy. |
| `port` | integer | Yes | — | Proxy TCP port, from 1 through 65535. Constraints: minimum 1; maximum 65535. |

## ReasoningEffort

Native reasoning effort; default leaves the harness choice in place.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].inference.routes[].overrides.reasoningEffort`

Accepted input: string.

Constraints: `"default"` or `"low"` or `"medium"` or `"high"`.

## Resources

Resource declarations checked against host observations and produced data.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.resources`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `gpuMemoryBytes` | integer | Yes | — | Total serving GPU budget in bytes, including model, caches, and other allocations. Constraints: minimum 4294967296; maximum 4398046511104. |
| `preparationMemoryGiB` | integer | Yes | — | Preparation memory requirement in GiB, in addition to the service host reserve. Constraints: minimum 1; maximum 4096. |
| `preparedBytes` | integer | Yes | — | Maximum total prepared-data bytes. Constraints: minimum 1; maximum 1099511627776. |
| `startupHeadroomGiB` | integer | Yes | — | Additional available-memory headroom in GiB required at startup. Constraints: minimum 0; maximum 4096. |

## Reuse

Explicit cache import, verified by the new recipe before acceptance.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.reuse`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `preparationKey` | string | Yes | — | SHA-256 preparation key identifying previously prepared data. Constraints: pattern `^[a-f0-9]{64}$`. |
| `snapshotDirectory` | string | Yes | — | Existing snapshot directory relative to /data. Traversal, backslashes, and empty path components are rejected. Constraints: minimum characters 1. |

## Route

Primary inference route supplied through OpenShell.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].inference.routes[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | The primary route name. Constraints: `"primary"`. |
| `overrides` | [Overrides](#overrides) | Yes | — | Model selection, optional OpenClaw tuning, and optional Pi model metadata. |
| `providerRef` | string | Yes | — | Must equal the declared inference provider name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## Runtime

Sandbox runtime selected through OpenShell.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes[].runtime`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `provider` | string | No | `"docker"` | Docker or Podman driver. A managed service with Podman requires explicit service placement. Constraints: `""` or `"docker"` or `"podman"`. Omitted or empty selects the default. |

## Sandbox

The gateway owns sandbox creation. Only OpenClaw accepts managed gateway or inference dependencies.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `agents` | array of [Agent](#agent) | Yes | — | One or more named OpenClaw agents sharing identical inference settings. Other harnesses require one agent. Constraints: minimum items 1. |
| `image` | [Image](#image) | No | — | Sandbox agent image; omission selects the SDK default. |
| `integrations` | [Integrations](#integrations) | No | — | Optional credential-bearing agent integrations. |
| `name` | string | Yes | — | Lowercase sandbox name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `network` | [Network](#network) | No | — | Sandbox network policy; omission selects isolated inference routing. |
| `runtime` | [Runtime](#runtime) | No | — | Sandbox driver; omission selects Docker. A managed gateway requires Docker. |

## SearchProvider

Search provider supported by the managed profile.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].integrations.webSearch.provider`

Accepted input: string.

Constraints: `"brave"`.

## Service

Managed vLLM service. Explicit placement and publication must appear together.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [ServiceAuthentication](#serviceauthentication) | No | — | Optional native bearer authentication. The runtime generates and retains the key; omission preserves unauthenticated serving. |
| `backend` | string | Yes | — | Managed inference backend. Constraints: `"vllm"`. |
| `image` | string | Yes | — | Immutable runtime image containing vLLM, the supervisor, and any declared recipe tools. Constraints: pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. |
| `management` | [ManagedManagement](#managedmanagement) | No | — | Optional managed ownership declaration. Omission means managed. |
| `memory` | [Memory](#memory) | No | — | GPU budget and resident watchdog thresholds. Omission selects the SDK defaults. |
| `model` | [Model](#model) | Yes | — | Public Hugging Face repository and immutable commit. |
| `placement` | [ServicePlacement](#serviceplacement) | With external gateway or Podman; paired with publication | — | SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication. |
| `publication` | [ServicePublication](#servicepublication) | With placement | — | Private inference address reachable by OpenShell. Required with placement. |
| `recipe` | [InlineRecipe](#inlinerecipe) | No | — | Optional inline preparation and serving contract supplied by the pinned runtime image. |
| `serving` | [Serving](#serving) | No | — | Service limits. Omission selects the SDK defaults; recipe serving settings select recipe-specific parsers and execution options. |
| `storage` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for model storage. Omission means managed; existing retention behavior is unchanged. |

## ServiceAuthentication

Generated bearer authentication for a managed inference service.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.inferenceProviders[].service.authentication`

Accepted input: string.

Constraints: `"bearer"`.

## ServicePlacement

Execution host and Docker network for a remote model service.

Guide: [SSH model service](../remote-service.md).

Paths:

- `spec.inferenceProviders[].service.placement`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `engine` | string | Yes | — | SSH Docker endpoint, for example ssh://gpu-box. Constraints: pattern `^ssh://`. |
| `network` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for the network configured by networkCIDR. Omission means managed. |
| `networkCidr` | string | Yes | — | Canonical private IPv4 /24 on the selected Docker engine. Constraints: pattern `/24$`. |

## ServicePublication

HTTP model publication must match the bind address, service port, and /v1 path.

Guide: [SSH model service](../remote-service.md).

Paths:

- `spec.inferenceProviders[].service.publication`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bindAddress` | string | Yes | — | Private host IPv4 address outside the service Docker subnet. Loopback is rejected. |
| `endpoint` | string | Yes | — | Private HTTP inference URL reachable by OpenShell. Constraints: pattern `^http://.+:[0-9]+/v1$`. |

## Serving

Limits apply with or without a recipe. Recipe serving settings replace the ordinary service parser settings.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `batchTokens` | integer | No | `1024` | Maximum tokens in a scheduled batch. Constraints: `0` or minimum 512; maximum 2048. Omitted or zero selects the default. |
| `contextTokens` | integer | No | `32768` | Maximum model context length in tokens. Constraints: `0` or minimum 8192; maximum 65536. Omitted or zero selects the default. |
| `maxSequences` | integer | No | `1` | Maximum concurrent sequences. Constraints: `0` or minimum 1; maximum 2. Omitted or zero selects the default. |
| `port` | integer | No | `18888` | Inference listening port. Explicit publication must use this port. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |
| `reasoningParser` | string | No | `""` | Native vLLM reasoning parser used when no recipe is declared. Empty omits the parser flag. Constraints: `""` or `"qwen3"` or `"deepseek_r1"`. |
| `speculativeTokens` | integer | No | `0` | MTP speculative tokens. Must be zero without a recipe. Constraints: minimum 0; maximum 3. |
| `startupTimeoutSeconds` | integer | No | `1800` | Seconds allowed for backend readiness before startup fails. Constraints: `0` or minimum 60; maximum 3600. Omitted or zero selects the default. |
| `toolParser` | string | No | `""` | Native vLLM tool-call parser used when no recipe is declared. Empty omits the parser flag. Constraints: `""` or `"hermes"` or `"qwen3_coder"` or `"llama3_json"` or `"mistral"`. |

## Settings

Recipe settings select serving behavior without shell hooks or arbitrary argument lists.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `chunkedPrefill` | boolean | No | `false` | Enable chunked prefill. |
| `compilation` | [Compilation](#compilation) | No | — | Optional typed compilation settings. Omission selects compilation mode 0 for recipe serving. |
| `environment` | map of string | No | `{}` | Literal VLLM_* environment values for serving. Do not place credentials here. Constraints: keys: pattern `^VLLM_[A-Z0-9_]*$`; values: pattern `^[^\u0000]*$`; maximum characters 4096. |
| `kvCacheDtype` | string | No | `""` | KV cache dtype understood by the pinned vLLM image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `lazyLoading` | boolean | No | `false` | Enable the lazy safetensors loading strategy. |
| `mambaCacheDtype` | string | No | `""` | Mamba SSM cache dtype understood by the pinned vLLM image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `modelName` | string | Yes | — | Model identifier advertised by vLLM. The primary route model must match it. Constraints: pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`; maximum characters 256. |
| `preparedEnvironment` | map of string | No | `{}` | VLLM_* variables mapped to paths beneath verified prepared data; . selects its root. Names must not also appear in environment. Constraints: keys: pattern `^VLLM_[A-Z0-9_]*$`. |
| `reasoningParser` | string | No | `""` | Native vLLM reasoning parser supplied by the runtime image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |
| `toolParser` | string | No | `""` | Native vLLM tool parser supplied by the runtime image. Empty omits the flag. Constraints: maximum characters 256; `""` or pattern `^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$`. |

## Spec

The configuration requires one inference provider and one sandbox.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `gateway` | [Gateway](#gateway) | Yes | — | OpenShell gateway connection or managed gateway settings. |
| `inferenceProviders` | array of [InferenceProvider](#inferenceprovider) | Yes | — | Exactly one external endpoint, managed Ollama server, or managed vLLM service. Constraints: minimum items 1; maximum items 1. |
| `sandboxes` | array of [Sandbox](#sandbox) | Yes | — | Exactly one sandbox with one or more OpenClaw agents sharing a primary inference route, or one agent of another harness. Constraints: minimum items 1; maximum items 1. |

## TLS

Gateway mutual TLS file references. All three references are required when TLS is declared.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.gateway.tls`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `ca` | [Credential](#credential) | Yes | — | Environment variable whose value names the local CA certificate file. |
| `certificate` | [Credential](#credential) | Yes | — | Environment variable whose value names the local client certificate file. |
| `key` | [Credential](#credential) | Yes | — | Environment variable whose value names the local client private-key file. |

## Tool

Executable identity inside the runtime image; this is not a shell command.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.preparation`
- `spec.inferenceProviders[].service.recipe.verification`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `executable` | string | Yes | — | Absolute path to the executable inside the image. Traversal and empty path components are rejected. Constraints: pattern `^/`; maximum characters 4096. |
| `sha256` | string | Yes | — | Lowercase SHA-256 of the executable file. Constraints: pattern `^[a-f0-9]{64}$`. |

## ToolDisclosure

OpenClaw tool presentation; this does not change tool permissions.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[].tools.disclosure`

Accepted input: string or string.

Constraints: `"progressive"` or `"direct"`.

## WebSearch

Web search through the native OpenClaw Brave plugin.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].integrations.webSearch`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `agentRefs` | array of string | Yes | — | Unique names of unrestricted OpenClaw agents permitted to search. Constraints: minimum items 1; items: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `credential` | [Credential](#credential) | Yes | — | Host environment reference. OpenShell supplies a BRAVE_API_KEY placeholder to the sandbox. |
| `provider` | [SearchProvider](#searchprovider) | Yes | — | Supported search service. |
