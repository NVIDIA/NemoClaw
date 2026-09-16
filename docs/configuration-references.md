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

Paths below are relative to `spec`; `agents[]` is inside `sandboxes[]` and `routes[]` is inside `agents[].inference`.

| Family | Enclosing definitions | Consumer selection | Current runtime limit |
|---|---|---|---|
| Inference provider | `inferenceProviders[]` or `sandboxes[].inferenceProviders[]`, each with a `name` | Route `provider` or `providerRef` | One selected definition across all agents in the sandbox |
| Integration | `integrations.<name>` or `sandboxes[].integrations.<name>` | Agent `integrations.<name>` and/or `integrationRefs` | Only Brave `webSearch` is implemented; one attached search definition per sandbox |

Inference providers are list entries with a `name`; integrations are maps keyed by name.
Inline providers also require `name`, which identifies the OpenShell provider registration.
The schema currently supports exactly one sandbox and one primary route per agent.
Multiple OpenClaw agents can reference the same provider and integration; distinct inline instances are not shared implicitly.

Hermes `auth.method` uses the provider selected by its primary route.
See [Hermes authentication](inference.md#authenticate-hermes-through-the-provider) for credential handling and migration from `auth.providerRef`.

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
      agents:
        - name: researcher
          harness: openclaw
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

## Other Configuration Objects

An image `ref` selects an external immutable artifact, and `credential.env` selects a caller-supplied environment variable.
These are not references to application definitions in this document, and inline credential values remain forbidden.
Service, model, recipe, policy, and gateway settings remain nested configuration.
Only the families in the table above support shared application definitions.

The [field reference](reference/configuration.md) lists exact shapes and constraints.
Editor schema checks cover structure and conditional forms; the SDK parser also resolves names and checks selected-provider compatibility when multiple named definitions exist.
Validate connectivity and inference separately using the [deployment verification steps](inference.md#verify-the-result).
