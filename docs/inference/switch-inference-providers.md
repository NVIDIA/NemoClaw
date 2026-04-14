---
title:
  page: "Switch NemoClaw Inference Models at Runtime"
  nav: "Switch Inference Models"
description:
  main: "Change the active inference model without restarting the sandbox."
  agent: "Changes the active inference model without restarting the sandbox. Use when switching inference providers, changing the model runtime, or reconfiguring inference routing."
keywords: ["switch nemoclaw inference model", "change inference runtime"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "inference_routing"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Switch Inference Models at Runtime

Change the active inference model while the sandbox is running.
No restart is required.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Switch to a Different Model

Switching happens through the OpenShell inference route.
Use the provider and model that match the upstream you want to use.

### NVIDIA Endpoints

```console
$ openshell inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b
```

### OpenAI

```console
$ openshell inference set --provider openai-api --model gpt-5.4
```

### Anthropic

```console
$ openshell inference set --provider anthropic-prod --model claude-sonnet-4-6
```

### Google Gemini

```console
$ openshell inference set --provider gemini-api --model gemini-2.5-flash
```

### Compatible Endpoints

If you onboarded a custom compatible endpoint, switch models with the provider created for that endpoint:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

```console
$ openshell inference set --provider compatible-anthropic-endpoint --model <model-name>
```

If the provider itself needs to change, rerun `nemoclaw onboard`.

#### Switching from Responses API to Chat Completions

If onboarding selected `/v1/responses` but the agent fails at runtime (for
example, because the backend does not emit the streaming events OpenClaw
requires), re-run onboarding so the wizard re-probes the endpoint and bakes
the correct API path into the image:

```console
$ nemoclaw onboard
```

Select the same provider and endpoint again.
The updated streaming probe will detect incomplete `/v1/responses` support
and select `/v1/chat/completions` automatically.

To force `/v1/chat/completions` without re-probing, set `NEMOCLAW_PREFERRED_API`
before onboarding:

```console
$ NEMOCLAW_PREFERRED_API=openai-completions nemoclaw onboard
```

:::{note}
`NEMOCLAW_INFERENCE_API_OVERRIDE` patches the config at container startup but
does not update the Dockerfile ARG baked into the image.
If you recreate the sandbox without the override env var, the image reverts to
the original API path.
A fresh `nemoclaw onboard` is the reliable fix because it updates both the
session and the baked image.
:::

## Cross-Provider Switching

Switching to a different provider family (for example, from NVIDIA Endpoints to Anthropic) requires updating both the gateway route and the sandbox config.

Set the gateway route on the host:

```console
$ openshell inference set --provider anthropic-prod --model claude-sonnet-4-6 --no-verify
```

Then set the override env vars and recreate the sandbox so they take effect at startup:

```console
$ export NEMOCLAW_MODEL_OVERRIDE="anthropic/claude-sonnet-4-6"
$ export NEMOCLAW_INFERENCE_API_OVERRIDE="anthropic-messages"
$ nemoclaw onboard --resume --recreate-sandbox
```

The entrypoint patches `openclaw.json` at container startup with the override values.
You do not need to rebuild the image.
Remove the env vars and recreate the sandbox to revert to the original model.

`NEMOCLAW_INFERENCE_API_OVERRIDE` accepts `openai-completions` (for NVIDIA, OpenAI, Gemini, compatible endpoints) or `anthropic-messages` (for Anthropic and Anthropic-compatible endpoints).
This variable is only needed when switching between provider families.

## Verify the Active Model

Run the status command to confirm the change:

```console
$ nemoclaw <name> status
```

Add the `--json` flag for machine-readable output:

```console
$ nemoclaw <name> status --json
```

The output includes the active provider, model, and endpoint.

## Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Same-provider model switches take effect immediately via the gateway route alone.
- Cross-provider switches also require `NEMOCLAW_MODEL_OVERRIDE` (and `NEMOCLAW_INFERENCE_API_OVERRIDE`) plus a sandbox recreate so the entrypoint patches the config at startup.
- Overrides are applied at container startup. Changing or removing env vars requires a sandbox recreate to take effect.

## Related Topics

- [Inference Options](inference-options.md) for the full list of providers available during onboarding.
