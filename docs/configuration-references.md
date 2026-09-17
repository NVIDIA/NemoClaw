<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Define Once or Configure Inline

Use an inline definition for one consumer, or a named definition with references to share it.
Both forms use the same configuration type, defaults, and validation.
A shared definition becomes active only when a consumer selects it.

## The Authoring Rule

For a single object, use `thing` or `thingRef`, never both.
A required selection must supply exactly one form; an optional selection may omit both.
For multiple objects, combine inline `things` and `thingRefs` only when they select distinct objects.
An inline object belongs to its consumer and is not available to siblings.

References resolve only in the enclosing collections explicitly supported for that family.
Names must be unique within each collection and must not shadow a visible enclosing definition.
Missing references and duplicate attachments are errors.
Equal settings do not make two definitions the same object: reuse requires referencing the same definition.
There is no implicit attachment, override precedence, or merging.
YAML anchors, aliases, and merge keys are disabled.

Unused enclosing definitions are retained and validated, but create no runtime resources, access grants, or credential-resolution requirements.
Selecting an object does not bypass that object's harness, service, credential, or runtime constraints.
Export preserves the declaration scope and inline/reference form, alongside defaults and supported observed updates.
Moving a definition does not authorize replacing an existing resource; normal identity and lifecycle checks still apply.

## Supported Families

Paths below are relative to `spec`; `agents[]` is inside `sandboxes[]` and `routes[]` is inside an inline or shared inference configuration.

| Family | Enclosing definitions | Consumer selection | Current runtime limit |
|---|---|---|---|
| Inference provider | `inferenceProviders[]` or `sandboxes[].inferenceProviders[]`, each with a `name` | Route `provider` or `providerRef` | Up to 32 selected providers; multiple vLLM services, at most one managed Ollama or Ollama proxy |
| Inference | `inferences.<name>` or `sandboxes[].inferences.<name>` | Agent `inference` or `inferenceRef` | OpenClaw and Pi support named choices with an explicit default; other harnesses require one choice |
| Harness | `harnesses.<name>` or `sandboxes[].harnesses.<name>` | Sandbox `harness` or `harnessRef` | Exactly one configuration per sandbox; all agents use that implementation |
| Integration | `integrations.<name>` or `sandboxes[].integrations.<name>` | Agent `integrations.<name>` and/or `integrationRefs` | Only Brave `webSearch` is implemented; one attached search definition per sandbox |

Inference providers are list entries with a `name`; inferences, harnesses, and integrations are maps keyed by name.
Inline providers also require `name`.
Deployment-level provider names identify their OpenShell registrations; sandbox-local providers receive stable identities derived from the sandbox and provider names.
Different sandboxes can reuse a local definition name without sharing its registration.
A document supports one to 32 named sandboxes; OpenClaw agents can select models from different providers.
See [multiple model choices](inference.md#give-an-agent-multiple-model-choices) for defaults and current service limits.
Multiple OpenClaw agents can reference the same provider and integration; distinct inline instances are not shared implicitly.

Hermes `auth.method` uses the provider selected by its primary route.
See [Hermes authentication](inference.md#authenticate-hermes-through-the-provider) for credential handling and migration from `auth.providerRef`.

## Reference a Harness Configuration

Define runtime settings once and select them from the sandbox:

```yaml
spec:
  harnesses:
    assistant:
      kind: openclaw
      execution:
        timeoutSeconds: 900
      interfaces:
        dashboard:
          port: 18800
  sandboxes:
    - name: assistant
      harnessRef: assistant
      agents:
        - name: researcher
          inferenceRef: chat
        - name: writer
          inferenceRef: chat
```

This fragment assumes a `chat` inference definition and omits other required deployment fields.
Put `harnesses` under the sandbox to keep the definitions local to that sandbox.
Use `harness: {kind: openclaw}` for an inline configuration without additional settings.
Execution defaults, observability, and interfaces belong inside the harness configuration.
Each sandbox requires exactly one of `harness` or `harnessRef`; agents cannot select a harness.
Every agent is an instance of the selected implementation, and multiple agents may share one runtime process.
Sharing a definition reuses configuration; each sandbox owns its runtime process.

## Reference an Inference Configuration

Use `inferenceRef` to reuse the complete inference configuration, including its provider selection and model settings:

```yaml
spec:
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11446/v1
  inferences:
    chat:
      routes:
        - name: primary
          providerRef: local
          overrides:
            model: qwen3:4b
  sandboxes:
    - name: assistant
      harness: {kind: openclaw}
      agents:
        - name: researcher
          inferenceRef: chat
        - name: writer
          inferenceRef: chat
```

This fragment omits other required deployment fields.
Move `inferences` under the sandbox to limit visibility to its agents.
Provider references resolve where the inference is defined: a deployment-level inference cannot select a sandbox-level provider.
An inline provider inside a shared inference is reused by every agent selecting that inference.
Using `inference` and `inferenceRef` together is an error, including an empty inline object.

## Reference an Inference Provider

This fragment omits the deployment's other required fields:

```yaml
spec:
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11446/v1
  sandboxes:
    - name: assistant
      harness: {kind: openclaw}
      agents:
        - name: researcher
          inference:
            routes:
              - name: primary
                providerRef: local
                overrides:
                  model: qwen3:4b
```

Move `inferenceProviders` under the sandbox to limit definition visibility to its routes.
The route still uses `providerRef: local`.
To configure that provider inline, remove the enclosing definition and use this `inference` block on the agent:

```yaml
inference:
  routes:
    - name: primary
      provider:
        name: local
        provider: openai
        endpoint: http://172.20.0.1:11446/v1
      overrides:
        model: qwen3:4b
```

Use the [complete inline example](../examples/inline-inference.yaml) as a starting point and follow [deployment prerequisites and image selection](usage.md) before applying it.
For integration examples, see [define and attach integrations](agents.md#define-and-attach-integrations).

## Combine Supported Features

The [full-featured OpenClaw example](../examples/full-featured-openclaw.yaml) combines a managed gateway, remote authenticated vLLM, explicit ownership and GPU requirements, three agents, shared search, tracing, dashboard access, execution settings, tool restrictions, and explicit network policy with a proxy.
All three agents select the same provider and inference settings; only two receive search access.
It passes the SDK parser and JSON Schema checks, but this combined deployment has not been qualified against live services.
Replace the image placeholders, deployment UID, SSH alias, addresses, and model settings for your hosts before use.
Follow the [SSH service prerequisites](remote-service.md), [agent image procedure](inference.md#build-an-image-with-the-configuration-interface), and [Brave credential instructions](agents.md#brave-web-search).
The proxy and OTLP collector must already exist and be reachable; follow the [policy and proxy prerequisites](sandbox-network.md).
Apply provisions the managed resources and checks readiness; verify inference separately.

No single active configuration exercises every schema branch:

| Alternative | Example or guide | Why separate |
|---|---|---|
| Inline provider or integration | [Inline provider](../examples/inline-inference.yaml), [inline integration](agents.md#brave-web-search) | A consumer cannot both inline and reference the same definition |
| Managed Ollama or an existing endpoint | [Managed Ollama](../examples/managed-ollama.yaml), [external endpoint](../examples/inference-tuning.yaml) | Each provider selects one service mode; managed Ollama and its proxy still require a singleton lifecycle |
| Existing Ollama through an authenticated proxy | [Proxy guide](inference.md#use-external-ollama-through-a-managed-proxy) | Alternative provider mode to managed vLLM |
| Hermes authentication, interfaces, or Relay | [Authentication](../examples/hermes-auth.yaml), [interfaces](../examples/hermes-interfaces.yaml), [Relay](agents.md#hermes-relay-tracing) | Hermes requires one agent; Hermes Relay also excludes Hermes interfaces |
| Pi model metadata | [Pi example](../examples/fabric-pi.yaml) | Specific to Pi; other harnesses reject it |
| Model preparation recipe | [Spark recipe](../examples/spark-inline.yaml) | Separate model, image, and hardware contract |
| External gateway credentials and mTLS | [Gateway fields](reference/configuration.md#gateway) | Managed gateways use local HTTP and reject these fields |

The [multiple-provider example](../examples/multiple-providers.yaml) combines selected local and hosted endpoints.
Unselected definitions do not exercise another provider's runtime.

## Other Configuration Objects

An image `ref` selects an external immutable artifact, and `credential.env` selects a caller-supplied environment variable.
These are not references to application definitions in this document, and inline credential values remain forbidden.
Service, model, recipe, policy, and gateway settings remain nested configuration.
Only the families in the table above support shared application definitions.

The [field reference](reference/configuration.md) lists exact shapes and constraints.
Editor schema checks cover structure and conditional forms; the SDK parser also resolves names and checks selected-provider compatibility when multiple named definitions exist.
Validate connectivity and inference separately using the [deployment verification steps](inference.md#verify-the-result).
