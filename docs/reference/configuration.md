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
- Explicit filesystem grants must permit reads of the selected harness runtime directories; parent and read-write grants count. This parser check does not inspect images, resolve symlinks, or establish runtime permissions.
- The parser checks unique agent names, uniquely named model choices with an explicit default for multiple choices, multiple choices for OpenClaw and Pi, and a shared disclosure mode among unrestricted agents; omitted disclosure means progressive.
- The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and incompatible agent grants, and permits at most one attached Brave search definition per sandbox. Agent-inline definitions attach directly; unused enclosing definitions grant no access.
- The parser requires exactly one sandbox harness or harnessRef, resolves visible harnesses without shadowing, and rejects agent-level harness selection. All agents use the sandbox-selected implementation; OpenClaw and Deep Agents support multiple agents. Shared definitions reuse configuration across sandboxes.
- The parser permits non-default reasoningEffort values only on the initial default choice. Managed Ollama and its proxy currently manage one selected model; vLLM choices must match its served model.
- The parser resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names, shadowing, and inline/reference ambiguity.
- The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 selected providers, and more than one selected provider with managed inference dependencies, and compares route models and authentication with the selected provider. With multiple named definitions, provider/agent compatibility is a parser check. Unselected definitions create no resources. Snapshot identity must match the service model.
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

One agent instance with its own inference choices, tools, and integrations.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.sandboxes[].agents[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `auth` | [AgentAuth](#agentauth) | No | — | Hermes API-key authentication through the routed provider. The provider must declare a credential reference. |
| `inference` | [Inference](#inference) | No | — | Inline inference configuration. Exactly one of inference or inferenceRef is required. |
| `inferenceRef` | string | No | — | Name of an enclosing inference configuration. Excludes inline inference. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrationRefs` | array of string | No | — | Unique integration names selected from spec.integrations or this sandbox's integrations. Omission selects no enclosing definitions. Constraints: items: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions attached directly to this agent. Names must not collide with definitions in enclosing scopes. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `name` | string | Yes | — | Lowercase agent name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `tools` | [AgentTools](#agenttools) | No | — | Read-only tools for OpenClaw, Deep Agents, or Pi, or OpenClaw disclosure mode. Omission preserves native defaults. allow: [read] restricts tools, not OS-level filesystem access. |

## AgentAuth

Authenticate Hermes inference using the primary route's credential-bearing provider.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.sandboxes[].agents[].auth`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `method` | [AuthMethod](#authmethod) | Yes | — | API-key authentication. Interactive login is not supported. |

## AgentExecution

Execution timeout shared by the sandbox; native heartbeat settings are OpenClaw-only.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.harnesses.{key}.execution`
- `spec.sandboxes[].harness.execution`
- `spec.sandboxes[].harnesses.{key}.execution`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `heartbeatEvery` | string | No | — | Heartbeat duration in seconds, minutes, or hours, such as 30m. Zero disables heartbeat. Omission leaves native defaults; an explicit interval uses an isolated heartbeat session. Constraints: pattern `^[0-9]+[smh]$(?![\s\S])`; maximum characters 256. |
| `timeoutSeconds` | integer | No | — | Agent-turn timeout in seconds. Omission selects 600 for OpenClaw and 300 for other harnesses. OpenClaw adds 60 seconds to the enclosing Fabric timeout; readiness and health checks use separate budgets. Constraints: minimum 1; maximum 1000000000. |

## AgentInterfaces

Harness-specific native interfaces; OpenClaw uses gateway settings, Hermes uses separate services.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces`
- `spec.sandboxes[].harness.interfaces`
- `spec.sandboxes[].harnesses.{key}.interfaces`

Accepted input: [OpenClawInterfaces](#openclawinterfaces) or [HermesInterfaces](#hermesinterfaces).

## AgentObservability

Harness-native telemetry shared by the sandbox.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.harnesses.{key}.observability`
- `spec.sandboxes[].harness.observability`
- `spec.sandboxes[].harnesses.{key}.observability`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `otlp` | [OtlpTracing](#otlptracing) | No | — | Export OpenClaw traces to an externally operated local OTLP/HTTP collector. |
| `relay` | [RelayTracing](#relaytracing) | No | — | Emit Hermes ATOF and ATIF traces through its in-process NeMo Relay integration. |

## AgentTools

Native read-only tool restriction or OpenClaw discovery mode. These forms are mutually exclusive.

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

Tool supported by the native read-only policy.

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
- `spec.inferences.{key}.routes[].provider.service.recipe.compatibility`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.compatibility`
- `spec.sandboxes[].inferenceProviders[].service.recipe.compatibility`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.compatibility`

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
- `spec.inferences.{key}.routes[].provider.service.recipe.serving.compilation`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.serving.compilation`
- `spec.sandboxes[].inferenceProviders[].service.recipe.serving.compilation`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.serving.compilation`

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
- `spec.inferences.{key}.routes[].provider.credential`
- `spec.integrations.{key}.credential`
- `spec.sandboxes[].agents[].inference.routes[].provider.credential`
- `spec.sandboxes[].agents[].integrations.{key}.credential`
- `spec.sandboxes[].inferenceProviders[].credential`
- `spec.sandboxes[].inferences.{key}.routes[].provider.credential`
- `spec.sandboxes[].integrations.{key}.credential`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `env` | string | Yes | — | Uppercase environment variable name. For TLS fields, its value is a local certificate or key file path; otherwise it is a bearer/API credential. Constraints: pattern `^[A-Z_][A-Z0-9_]{0,127}$`. |

## DashboardBind

Address on which the native dashboard listens inside the sandbox.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces.dashboard.bind`
- `spec.sandboxes[].harness.interfaces.dashboard.bind`
- `spec.sandboxes[].harnesses.{key}.interfaces.dashboard.bind`

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
- `spec.inferences.{key}.routes[].provider.ollama.network.management`
- `spec.inferences.{key}.routes[].provider.ollamaProxy.model.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.network.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollamaProxy.model.management`
- `spec.sandboxes[].inferenceProviders[].ollama.network.management`
- `spec.sandboxes[].inferenceProviders[].ollamaProxy.model.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.network.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollamaProxy.model.management`
- `spec.sandboxes[].network.proxy.management`

Accepted input: string.

Constraints: `"external"`.

## ExternalNetwork

Identify a network owned outside this deployment.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].ollama.network`
- `spec.inferences.{key}.routes[].provider.ollama.network`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.network`
- `spec.sandboxes[].inferenceProviders[].ollama.network`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.network`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `management` | [ExternalManagement](#externalmanagement) | No | — | Optional external ownership declaration. Omission means external. |
| `name` | string | Yes | — | Existing network name on the Ollama Docker engine. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## ExternalOllamaModel

Existing Ollama model installation, independently owned outside the deployment.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].ollamaProxy.model`
- `spec.inferences.{key}.routes[].provider.ollamaProxy.model`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollamaProxy.model`
- `spec.sandboxes[].inferenceProviders[].ollamaProxy.model`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollamaProxy.model`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `digest` | string | Yes | — | Lowercase 64-character model digest reported by Ollama's /api/tags API. Constraints: pattern `^[a-f0-9]{64}$`. |
| `management` | [ExternalManagement](#externalmanagement) | No | — | Optional ownership declaration; omission means external. |

## File

One immutable file in a model snapshot.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.snapshot.files[]`
- `spec.inferences.{key}.routes[].provider.service.recipe.snapshot.files[]`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.snapshot.files[]`
- `spec.sandboxes[].inferenceProviders[].service.recipe.snapshot.files[]`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.snapshot.files[]`

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
| `image` | string | No | — | Managed gateway image pinned by the SDK. Omit or leave empty for an external gateway. Managed only: omitted or empty selects ghcr.io/nvidia/openshell/gateway@sha256:2a745259fd2dd579300f3e4b76a7fcce1dc92305d653d36b67ca6b3ecabefad7. |
| `management` | string | Yes | — | Whether the SDK manages the gateway or connects to an existing one. Constraints: `"managed"` or `"external"`. |
| `network` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for the gateway network configured by networkCIDR. Omission means managed for a managed gateway. |
| `networkCIDR` | string | No | — | Canonical private IPv4 /24 for a managed gateway. Omit or leave empty for an external gateway. Managed only: omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid). |
| `storage` | [ManagedResource](#managedresource) | No | — | Optional ownership declaration for gateway storage. Omission means managed for a managed gateway; external gateways cannot declare storage. |
| `tls` | [TLS](#tls) | No | — | Optional mutual TLS references for an external HTTPS gateway. |

## Harness

One harness runtime configuration. Every sandbox runs its own instance; agents within a sandbox share its settings.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.harnesses.{key}`
- `spec.sandboxes[].harness`
- `spec.sandboxes[].harnesses.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `execution` | [AgentExecution](#agentexecution) | No | — | OpenClaw timeout and heartbeat defaults shared by the sandbox. |
| `interfaces` | [AgentInterfaces](#agentinterfaces) | No | — | Native dashboard access for this sandbox runtime. |
| `kind` | string | Yes | — | Fabric harness implementation. Multiple agents require OpenClaw or Deep Agents. Constraints: `"deepagents"` or `"hermes"` or `"openclaw"` or `"claude"` or `"codex"` or `"mini-swe-agent"` or `"nooa"` or `"nooa-bench"` or `"remote-agent"` or `"pi"`. |
| `observability` | [AgentObservability](#agentobservability) | No | — | Harness-native tracing shared by the sandbox. |

## HermesApi

Hermes HTTP API listener inside the sandbox; host access requires OpenShell forwarding.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces.api`
- `spec.sandboxes[].harness.interfaces.api`
- `spec.sandboxes[].harnesses.{key}.interfaces.api`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `port` | integer | Yes | — | Sandbox-local API port, from 8642 through 8652. Constraints: minimum 8642; maximum 8652. |

## HermesDashboard

Native Hermes dashboard with isolated configuration and active sessions.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces.dashboard`
- `spec.sandboxes[].harness.interfaces.dashboard`
- `spec.sandboxes[].harnesses.{key}.interfaces.dashboard`

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

- `spec.harnesses.{key}.interfaces`
- `spec.sandboxes[].harness.interfaces`
- `spec.sandboxes[].harnesses.{key}.interfaces`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [HermesApi](#hermesapi) | No | — | Authenticated HTTP API settings. Omitting api selects port 8642; declaring api requires port. |
| `dashboard` | [HermesDashboard](#hermesdashboard) | No | — | Dashboard service settings; omitted settings enable port 18789 with internal port 19119. |

## HermesTui

Browser chat/TUI availability; standalone terminal access remains native Hermes behavior.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces.dashboard.tui`
- `spec.sandboxes[].harness.interfaces.dashboard.tui`
- `spec.sandboxes[].harnesses.{key}.interfaces.dashboard.tui`

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
| `ref` | string | No | `"nc-multi-models@sha256:3ab70ded67440e838a37d6c9f0e3b08b95e2acf416c6076f8817bac190525cf0"` | Immutable image reference. Omitted or empty selects the SDK-pinned Fabric image. Constraints: `""` or pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`. Omitted or empty selects the default. |

## Inference

Agent inference routing.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferences.{key}`
- `spec.sandboxes[].agents[].inference`
- `spec.sandboxes[].inferences.{key}`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `default` | string | No | — | Initial model choice by route name. Required with multiple routes; omission selects the sole route. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `routes` | array of [Route](#route) | Yes | — | One or more uniquely named model choices. Multiple choices require OpenClaw or Pi. Constraints: minimum items 1; maximum items 32. |

## InferenceApi

Wire API used by the agent through OpenShell; no protocol conversion is implied.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].api`
- `spec.inferences.{key}.routes[].provider.api`
- `spec.sandboxes[].agents[].inference.routes[].provider.api`
- `spec.sandboxes[].inferenceProviders[].api`
- `spec.sandboxes[].inferences.{key}.routes[].provider.api`

Accepted input: string.

Constraints: `"openai-completions"` or `"openai-responses"` or `"anthropic-messages"`.

## InferenceProvider

Choose endpoint for external inference, endpoint plus ollama for managed Ollama, or service for managed vLLM.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[]`
- `spec.inferences.{key}.routes[].provider`
- `spec.sandboxes[].agents[].inference.routes[].provider`
- `spec.sandboxes[].inferenceProviders[]`
- `spec.sandboxes[].inferences.{key}.routes[].provider`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `api` | [InferenceApi](#inferenceapi) | No | — | Request API. Omission selects anthropic-messages for Claude, openai-responses for Codex, and openai-completions for other non-Pi harnesses. Pi requires omission and selects its API through native model metadata. |
| `credential` | [Credential](#credential) | No | — | Optional API credential reference for an external HTTPS endpoint. Excluded by service and ollama. |
| `endpoint` | string | Without service | — | Inference HTTP(S) URL. Required without service; omit or leave empty with service. HTTP requires a literal private or loopback address. |
| `management` | [Management](#management) | No | — | Optional server ownership. Omission means managed with service or ollama, external with endpoint alone. The OpenShell provider registration remains deployment-owned in either mode. |
| `name` | string | Yes | — | Provider name referenced by model choices. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `ollama` | [ManagedOllama](#managedollama) | No | — | Manage Ollama through a local Unix Docker socket and an existing network. Requires an explicit private or loopback IP:port/v1 HTTP endpoint. |
| `ollamaProxy` | [OllamaProxy](#ollamaproxy) | No | — | Manage an authenticated proxy while leaving the endpoint's Ollama daemon and installed model external. |
| `provider` | string | Yes | — | OpenShell provider implementation. Must match the selected API family. Constraints: `"openai"` or `"anthropic"`. |
| `service` | [Service](#service) | No | — | Manage vLLM from a pinned runtime image and model. Excludes ollama and credential; endpoint must be omitted or empty. |

## InlineRecipe

Data-only contract for executables and capabilities packaged in a pinned runtime image.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe`
- `spec.inferences.{key}.routes[].provider.service.recipe`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe`
- `spec.sandboxes[].inferenceProviders[].service.recipe`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe`

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

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.integrations.{key}`
- `spec.sandboxes[].agents[].integrations.{key}`
- `spec.sandboxes[].integrations.{key}`

Accepted input: object.

### Alternative 1

Brave Search with gateway-held credentials and explicit agent grants.


| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `credential` | [Credential](#credential) | Yes | — | Host environment reference. OpenShell supplies a BRAVE_API_KEY placeholder to the sandbox. |
| `kind` | string | Yes | — | Integration implementation selected by this definition. Constraints: `"webSearch"`. |
| `provider` | [SearchProvider](#searchprovider) | Yes | — | Supported search service. |

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
- `spec.inferences.{key}.routes[].provider.ollama.management`
- `spec.inferences.{key}.routes[].provider.ollama.model.management`
- `spec.inferences.{key}.routes[].provider.ollama.storage.management`
- `spec.inferences.{key}.routes[].provider.ollamaProxy.management`
- `spec.inferences.{key}.routes[].provider.service.management`
- `spec.inferences.{key}.routes[].provider.service.model.management`
- `spec.inferences.{key}.routes[].provider.service.placement.network.management`
- `spec.inferences.{key}.routes[].provider.service.storage.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.model.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.storage.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollamaProxy.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.model.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.placement.network.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.storage.management`
- `spec.sandboxes[].inferenceProviders[].ollama.management`
- `spec.sandboxes[].inferenceProviders[].ollama.model.management`
- `spec.sandboxes[].inferenceProviders[].ollama.storage.management`
- `spec.sandboxes[].inferenceProviders[].ollamaProxy.management`
- `spec.sandboxes[].inferenceProviders[].service.management`
- `spec.sandboxes[].inferenceProviders[].service.model.management`
- `spec.sandboxes[].inferenceProviders[].service.placement.network.management`
- `spec.sandboxes[].inferenceProviders[].service.storage.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.model.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.storage.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollamaProxy.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.model.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.placement.network.management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.storage.management`

Accepted input: string.

Constraints: `"managed"`.

## ManagedOllama

Managed Ollama uses a pinned image, an existing Docker network, and an explicit model:tag on the route.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.inferenceProviders[].ollama`
- `spec.inferences.{key}.routes[].provider.ollama`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama`
- `spec.sandboxes[].inferenceProviders[].ollama`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama`

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
- `spec.inferences.{key}.routes[].provider.ollama.model`
- `spec.inferences.{key}.routes[].provider.ollama.storage`
- `spec.inferences.{key}.routes[].provider.service.placement.network`
- `spec.inferences.{key}.routes[].provider.service.storage`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.model`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.storage`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.placement.network`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.storage`
- `spec.sandboxes[].inferenceProviders[].ollama.model`
- `spec.sandboxes[].inferenceProviders[].ollama.storage`
- `spec.sandboxes[].inferenceProviders[].service.placement.network`
- `spec.sandboxes[].inferenceProviders[].service.storage`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.model`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.storage`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.placement.network`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.storage`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `management` | [ManagedManagement](#managedmanagement) | Yes | — | Managed ownership. Omit the enclosing object to keep the same behavior. |

## Management

Ownership of the inference server, separate from NemoClaw's owned routing registration.

Guide: [Resource ownership](../usage.md#resource-ownership).

Paths:

- `spec.inferenceProviders[].management`
- `spec.inferences.{key}.routes[].provider.management`
- `spec.sandboxes[].agents[].inference.routes[].provider.management`
- `spec.sandboxes[].inferenceProviders[].management`
- `spec.sandboxes[].inferences.{key}.routes[].provider.management`

Accepted input: string or string.

Constraints: `"managed"` or `"external"`.

## Manifest

Pinned model snapshot inventory. The parser rejects duplicate files and file/directory conflicts.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.snapshot`
- `spec.inferences.{key}.routes[].provider.service.recipe.snapshot`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.snapshot`
- `spec.sandboxes[].inferenceProviders[].service.recipe.snapshot`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.snapshot`

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
- `spec.inferences.{key}.routes[].provider.service.memory`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.memory`
- `spec.sandboxes[].inferenceProviders[].service.memory`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.memory`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `consecutiveSamples` | integer | No | `5` | Consecutive low-memory samples before the watchdog stops the owned process. Constraints: `0` or minimum 1; maximum 5. Omitted or zero selects the default. |
| `freeGateGiB` | integer | No | `12` | Available-memory gate in GiB for minFreeGiB. Must be at least minAvailableGiB after defaults. Constraints: `0` or minimum 6; maximum 24. Omitted or zero selects the default. |
| `gpuMemoryGiB` | integer | No | — | Total GPU budget in GiB without a recipe. Must be omitted or zero with a recipe, which supplies its own byte budget. Constraints: minimum 0; maximum 96. Omitted or zero stays zero in the document. Without a recipe or gpuMemoryUtilization, the backend uses 16 GiB. A recipe supplies resources.gpuMemoryBytes; gpuMemoryUtilization requires zero here. |
| `gpuMemoryUtilization` | number | No | — | Optional fraction of observed dedicated GPU memory, from 0.05 through 0.95. Requires service.hardware and excludes a recipe, gpuMemoryGiB and explicit KV-cache allocation; vLLM sizes its cache natively. Constraints: minimum 0.05; maximum 0.95. |
| `hostReserveGiB` | integer | No | `32` | Host memory reserve in GiB excluded from the serving budget. Constraints: `0` or minimum 28; maximum 64. Omitted or zero selects the default. |
| `kvCacheGiB` | integer | No | `8` | KV cache allocation in GiB for ordinary vLLM. Omitted or zero defaults to 8, except gpuMemoryUtilization requires zero and lets vLLM allocate its cache. Recipe serving does not emit this flag. Constraints: minimum 0. Omitted or zero selects 8 GiB, except gpuMemoryUtilization keeps zero and lets vLLM allocate its cache. |
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
- `spec.inferences.{key}.routes[].provider.service.model`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.model`
- `spec.sandboxes[].inferenceProviders[].service.model`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.model`

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
- `spec.inferences.{key}.routes[].provider.ollama.network`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollama.network`
- `spec.sandboxes[].inferenceProviders[].ollama.network`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollama.network`

Accepted input: string or [ExternalNetwork](#externalnetwork).

Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`.

## OllamaProxy

Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferenceProviders[].ollamaProxy`
- `spec.inferences.{key}.routes[].provider.ollamaProxy`
- `spec.sandboxes[].agents[].inference.routes[].provider.ollamaProxy`
- `spec.sandboxes[].inferenceProviders[].ollamaProxy`
- `spec.sandboxes[].inferences.{key}.routes[].provider.ollamaProxy`

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

- `spec.harnesses.{key}.interfaces.dashboard`
- `spec.sandboxes[].harness.interfaces.dashboard`
- `spec.sandboxes[].harnesses.{key}.interfaces.dashboard`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bind` | [DashboardBind](#dashboardbind) | No | — | Sandbox bind address; defaults to loopback. Host publication still requires OpenShell forwarding. |
| `port` | integer | No | — | Sandbox gateway port; defaults to 18789. Ports 8642 through 8652 are reserved for Hermes. Constraints: minimum 1024; maximum 65535. |

## OpenClawInterfaces

Native interfaces belonging to the sandbox harness runtime.

Guide: [Agent interfaces](../interfaces.md).

Paths:

- `spec.harnesses.{key}.interfaces`
- `spec.sandboxes[].harness.interfaces`
- `spec.sandboxes[].harnesses.{key}.interfaces`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `dashboard` | [OpenClawDashboard](#openclawdashboard) | Yes | — | Enable the OpenClaw dashboard with sandbox-local token authentication. |

## OtlpTracing

Explicitly enabled HTTP/protobuf tracing. The collector is not managed by NemoClaw.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.harnesses.{key}.observability.otlp`
- `spec.sandboxes[].harness.observability.otlp`
- `spec.sandboxes[].harnesses.{key}.observability.otlp`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `enabled` | boolean | Yes | — | Must be true. Omit observability to leave native telemetry unconfigured. Constraints: `true`. |
| `endpoint` | string | Yes | — | Local collector base URL; currently http://host.openshell.internal:4318. Constraints: `"http://host.openshell.internal:4318"`. |
| `sampleRate` | number | Yes | — | Fraction of traces sampled, from 0 through 1 inclusive. Constraints: minimum 0; maximum 1. |
| `serviceName` | string | Yes | — | Nonempty printable ASCII service name, without leading or trailing spaces, at most 256 characters. Constraints: pattern `^[!-~](?:[ -~]*[!-~])?$(?![\s\S])`; minimum characters 1; maximum characters 256. |

## Overrides

Model settings for one named inference choice.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferences.{key}.routes[].overrides`
- `spec.sandboxes[].agents[].inference.routes[].overrides`
- `spec.sandboxes[].inferences.{key}.routes[].overrides`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `contextWindow` | integer | No | — | Model context capacity in tokens. Does not resize the inference server. Constraints: minimum 1; maximum 4194304. |
| `maxTokens` | integer | No | — | Maximum output tokens for OpenClaw, Deep Agents, mini-swe-agent, or remote-agent. Constraints: minimum 1; maximum 1000000000. |
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
| `versions` | array of string | No | — | Supported MCP protocol revisions; omission uses the pinned OpenShell default. |

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

- `spec.inferences.{key}.routes[].overrides.reasoningEffort`
- `spec.sandboxes[].agents[].inference.routes[].overrides.reasoningEffort`
- `spec.sandboxes[].inferences.{key}.routes[].overrides.reasoningEffort`

Accepted input: string.

Constraints: `"default"` or `"low"` or `"medium"` or `"high"`.

## RelayTracing

Explicitly enabled in-process NeMo Relay tracing.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.harnesses.{key}.observability.relay`
- `spec.sandboxes[].harness.observability.relay`
- `spec.sandboxes[].harnesses.{key}.observability.relay`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `enabled` | boolean | Yes | — | Must be true. Omit observability to leave Relay tracing disabled. Constraints: `true`. |

## Resources

Resource declarations checked against host observations and produced data.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.resources`
- `spec.inferences.{key}.routes[].provider.service.recipe.resources`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.resources`
- `spec.sandboxes[].inferenceProviders[].service.recipe.resources`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.resources`

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
- `spec.inferences.{key}.routes[].provider.service.recipe.reuse`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.reuse`
- `spec.sandboxes[].inferenceProviders[].service.recipe.reuse`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.reuse`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `preparationKey` | string | Yes | — | SHA-256 preparation key identifying previously prepared data. Constraints: pattern `^[a-f0-9]{64}$`. |
| `snapshotDirectory` | string | Yes | — | Existing snapshot directory relative to /data. Traversal, backslashes, and empty path components are rejected. Constraints: minimum characters 1. |

## Route

Native model connection authorized through an attached OpenShell provider.

Guide: [Inference configuration](../inference.md).

Paths:

- `spec.inferences.{key}.routes[]`
- `spec.sandboxes[].agents[].inference.routes[]`
- `spec.sandboxes[].inferences.{key}.routes[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `name` | string | Yes | — | Unique lowercase name for this model choice. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `overrides` | [Overrides](#overrides) | Yes | — | Model selection, optional OpenClaw tuning, and optional Pi model metadata. |
| `provider` | [InferenceProvider](#inferenceprovider) | No | — | Inline inference definition owned by this route. Excludes providerRef and must not shadow an enclosing definition. |
| `providerRef` | string | No | — | Name of an enclosing inference provider. Exactly one of providerRef or provider is required. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |

## Runtime

Sandbox runtime selected through OpenShell.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes[].runtime`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `provider` | string | No | `"docker"` | Docker or Podman driver. A managed service with Podman requires explicit service placement. Constraints: `""` or `"docker"` or `"podman"`. Omitted or empty selects the default. |

## Sandbox

The gateway owns sandbox creation. OpenClaw and Hermes accept managed gateway or inference dependencies.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec.sandboxes[]`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `agents` | array of [Agent](#agent) | Yes | — | Instances of the sandbox-selected harness. OpenClaw supports multiple named agents in one runtime; Deep Agents supports separate Fabric runtimes in one sandbox. Other harnesses require one agent. Constraints: minimum items 1. |
| `harness` | [Harness](#harness) | No | — | Inline harness configuration. Exactly one of harness or harnessRef is required. Every agent in the sandbox is an instance of this harness implementation. |
| `harnessRef` | string | No | — | Name of a visible harness configuration. Excludes inline harness. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `harnesses` | map of [Harness](#harness) | No | — | Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `image` | [Image](#image) | No | — | Sandbox agent image; omission selects the SDK default. |
| `inferenceProviders` | array of [InferenceProvider](#inferenceprovider) | No | — | Named inference definitions visible to this sandbox's routes. Names must not shadow deployment definitions. |
| `inferences` | map of [Inference](#inference) | No | — | Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions selected by this sandbox's agents through integrationRefs. Names must not collide with deployment definitions. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `name` | string | Yes | — | Lowercase sandbox name. Constraints: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `network` | [Network](#network) | No | — | Sandbox network policy; omission selects isolated egress with grants for declared inference. |
| `runtime` | [Runtime](#runtime) | No | — | Sandbox driver; omission selects Docker. A managed gateway requires Docker. |

## SearchProvider

Search provider supported by the managed profile.

Guide: [Agent runtimes](../agents.md).

Paths:

- `spec.integrations.{key}.provider`
- `spec.sandboxes[].agents[].integrations.{key}.provider`
- `spec.sandboxes[].integrations.{key}.provider`

Accepted input: string.

Constraints: `"brave"`.

## Service

Managed vLLM service. Explicit placement and publication must appear together.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service`
- `spec.inferences.{key}.routes[].provider.service`
- `spec.sandboxes[].agents[].inference.routes[].provider.service`
- `spec.sandboxes[].inferenceProviders[].service`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `authentication` | [ServiceAuthentication](#serviceauthentication) | No | — | Optional native bearer authentication. The runtime generates and retains the key; omission preserves unauthenticated serving. |
| `backend` | string | Yes | — | Managed inference backend. Constraints: `"vllm"`. |
| `container` | [ServiceContainer](#servicecontainer) | No | — | Optional managed container IPC and shared-memory settings. Omission uses private IPC and 8 GiB of shared memory. |
| `hardware` | [ServiceHardware](#servicehardware) | No | — | Optional single NVIDIA GPU requirements on Linux AMD64 with dedicated GPU memory. Omission keeps the existing Spark or inline-recipe host contract. |
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
- `spec.inferences.{key}.routes[].provider.service.authentication`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.authentication`
- `spec.sandboxes[].inferenceProviders[].service.authentication`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.authentication`

Accepted input: string.

Constraints: `"bearer"`.

## ServiceContainer

Managed inference IPC and shared-memory settings.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.container`
- `spec.inferences.{key}.routes[].provider.service.container`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.container`
- `spec.sandboxes[].inferenceProviders[].service.container`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.container`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `ipc` | [ServiceIpc](#serviceipc) | No | — | IPC namespace. Omission uses private; host shares the execution host's IPC namespace. |
| `sharedMemoryGiB` | integer | No | — | Shared-memory size in GiB, from 1 through 64. Omission uses 8; host IPC uses the host's existing shared-memory mount instead. Constraints: minimum 1; maximum 64. |

## ServiceHardware

Requirements for one NVIDIA GPU with dedicated memory on Linux AMD64. Declaring requirements does not qualify a model or host.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.hardware`
- `spec.inferences.{key}.routes[].provider.service.hardware`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.hardware`
- `spec.sandboxes[].inferenceProviders[].service.hardware`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.hardware`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `architecture` | string | Yes | — | CPU architecture; this dedicated-memory contract requires amd64. Constraints: `"amd64"`. |
| `minComputeCapability` | integer | Yes | — | Minimum NVIDIA compute capability, encoded as major times ten plus minor; 90 means 9.0. Constraints: minimum 10; maximum 999. |
| `minDriverMajor` | integer | Yes | — | Minimum installed NVIDIA driver major version. Constraints: minimum 1; maximum 9999. |
| `minGpuMemoryBytes` | integer | Yes | — | Minimum total dedicated GPU memory in bytes. Host RAM is measured separately. Constraints: minimum 4294967296; maximum 4398046511104. |

## ServiceIpc

IPC namespace used by the managed inference container.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.container.ipc`
- `spec.inferences.{key}.routes[].provider.service.container.ipc`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.container.ipc`
- `spec.sandboxes[].inferenceProviders[].service.container.ipc`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.container.ipc`

Accepted input: string.

Constraints: `"private"` or `"host"`.

## ServicePlacement

Execution host and Docker network for a remote model service.

Guide: [SSH model service](../remote-service.md).

Paths:

- `spec.inferenceProviders[].service.placement`
- `spec.inferences.{key}.routes[].provider.service.placement`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.placement`
- `spec.sandboxes[].inferenceProviders[].service.placement`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.placement`

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
- `spec.inferences.{key}.routes[].provider.service.publication`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.publication`
- `spec.sandboxes[].inferenceProviders[].service.publication`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.publication`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `bindAddress` | string | Yes | — | Private host IPv4 address outside the service Docker subnet. Loopback is rejected. |
| `endpoint` | string | Yes | — | Private HTTP inference URL reachable by OpenShell. Constraints: pattern `^http://.+:[0-9]+/v1$`. |

## Serving

Limits apply with or without a recipe. Recipe serving settings replace the ordinary service parser settings.

Guide: [Managed models](../models.md).

Paths:

- `spec.inferenceProviders[].service.serving`
- `spec.inferences.{key}.routes[].provider.service.serving`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.serving`
- `spec.sandboxes[].inferenceProviders[].service.serving`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.serving`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `batchTokens` | integer | No | `1024` | Maximum tokens in a scheduled batch. Constraints: `0` or minimum 512; maximum 4096. Omitted or zero selects the default. |
| `contextTokens` | integer | No | `32768` | Maximum model context length in tokens. Constraints: `0` or minimum 8192; maximum 65536. Omitted or zero selects the default. |
| `enforceEager` | boolean | No | — | Without a recipe, omission or true enables eager execution; false leaves compilation and CUDA graphs at vLLM's native defaults. |
| `mambaBackend` | string | No | `""` | Native Mamba backend without a recipe. Empty uses vLLM's default; flashinfer selects the pinned image's FlashInfer backend. Constraints: `""` or `"flashinfer"`. |
| `maxSequences` | integer | No | `1` | Maximum concurrent sequences. Constraints: `0` or minimum 1; maximum 2. Omitted or zero selects the default. |
| `modelName` | string | No | `""` | Optional advertised model name without a recipe. Omission uses the model repository; routes must match the advertised name. Constraints: `""` or pattern `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. |
| `port` | integer | No | `18888` | Inference listening port. Explicit publication must use this port. Constraints: `0` or minimum 1024; maximum 65535. Omitted or zero selects the default. |
| `reasoningParser` | string | No | `""` | Native vLLM reasoning parser used when no recipe is declared. Empty omits the parser flag. Constraints: `""` or `"qwen3"` or `"deepseek_r1"` or `"nemotron_v3"`. |
| `speculativeTokens` | integer | No | `0` | MTP speculative tokens. Must be zero without a recipe. Constraints: minimum 0; maximum 3. |
| `startupTimeoutSeconds` | integer | No | `1800` | Seconds allowed for backend readiness before startup fails. Constraints: `0` or minimum 60; maximum 3600. Omitted or zero selects the default. |
| `toolParser` | string | No | `""` | Native vLLM tool-call parser used when no recipe is declared. Empty omits the parser flag. Constraints: `""` or `"hermes"` or `"qwen3_coder"` or `"qwen3_xml"` or `"llama3_json"` or `"mistral"`. |

## Settings

Recipe settings select serving behavior without shell hooks or arbitrary argument lists.

Guide: [Inline model recipes](../recipes.md).

Paths:

- `spec.inferenceProviders[].service.recipe.serving`
- `spec.inferences.{key}.routes[].provider.service.recipe.serving`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.serving`
- `spec.sandboxes[].inferenceProviders[].service.recipe.serving`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.serving`

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

The configuration requires one to 32 named sandboxes and at least one selected inference provider. At most one selected provider may have managed inference dependencies.

Guide: [Configuration and credentials](../usage.md#configuration-and-credentials).

Paths:

- `spec`

| Field | Input type | Required | Default | Description and constraints |
|---|---|---|---|---|
| `gateway` | [Gateway](#gateway) | Yes | — | OpenShell gateway connection or managed gateway settings. |
| `harnesses` | map of [Harness](#harness) | No | — | Named harness configurations available through harnessRef. Selecting a definition reuses configuration; runtime processes belong to each sandbox. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `inferenceProviders` | array of [InferenceProvider](#inferenceprovider) | No | — | Named inference definitions available to sandbox routes. Unselected definitions create no resources or credential requirements. |
| `inferences` | map of [Inference](#inference) | No | — | Named inference configurations available through inferenceRef. Definitions resolve providers in their own scope and create no resources until selected. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `integrations` | map of [Integration](#integration) | No | — | Named integration definitions shared by agents through integrationRefs. Definitions alone grant no access. Constraints: keys: pattern `^[a-z][a-z0-9-]{0,39}$`. |
| `sandboxes` | array of [Sandbox](#sandbox) | Yes | — | One to 32 uniquely named sandboxes. Each selects one harness: one or more OpenClaw or Deep Agents instances, or one agent of another harness. Declaration order does not select a default sandbox or agent. Constraints: minimum items 1; maximum items 32. |

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
- `spec.inferences.{key}.routes[].provider.service.recipe.preparation`
- `spec.inferences.{key}.routes[].provider.service.recipe.verification`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.preparation`
- `spec.sandboxes[].agents[].inference.routes[].provider.service.recipe.verification`
- `spec.sandboxes[].inferenceProviders[].service.recipe.preparation`
- `spec.sandboxes[].inferenceProviders[].service.recipe.verification`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.preparation`
- `spec.sandboxes[].inferences.{key}.routes[].provider.service.recipe.verification`

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
