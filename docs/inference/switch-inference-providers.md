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
skill:
  priority: 20
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
- The OpenShell CLI on your `PATH`, which NemoClaw uses under the hood.

## Switch to a Different Model

Use `nemoclaw inference set` with the provider and model that match the upstream you want to use.
The command updates the OpenShell inference route and synchronizes the running agent config.
For OpenClaw, it updates `agents.defaults.model.primary` and the matching provider namespace.
For Hermes, it updates `/sandbox/.hermes/config.yaml` (`model.default`, `model.base_url`, and `model.provider: custom`) without rebuilding or restarting Hermes.

Pass `--sandbox <name>` when you do not want to use the default registered sandbox.
Under `nemohermes`, pass `--sandbox <name>` when more than one Hermes sandbox is registered.

### NVIDIA Endpoints

```console
$ nemoclaw inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b
```

### OpenAI

```console
$ nemoclaw inference set --provider openai-api --model gpt-5.4
```

### Anthropic

```console
$ nemoclaw inference set --provider anthropic-prod --model claude-sonnet-4-6
```

### Google Gemini

```console
$ nemoclaw inference set --provider gemini-api --model gemini-2.5-flash
```

### Compatible Endpoints

If you onboarded a custom compatible endpoint, switch models with the provider created for that endpoint:

```console
$ nemoclaw inference set --provider compatible-endpoint --model <model-name>
```

```console
$ nemoclaw inference set --provider compatible-anthropic-endpoint --model <model-name>
```

### Hermes Provider

For a NemoClaw-managed Hermes sandbox, use the Hermes alias with the registered Hermes Provider route:

```console
$ nemohermes inference set --provider hermes-provider --model openai/gpt-5.4-mini
```

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

For the compatible-endpoint provider, NemoClaw uses `/v1/chat/completions` by
default, so no env var is required to keep the safe path.
To opt in to `/v1/responses` for a backend you have verified end to end, set
`NEMOCLAW_PREFERRED_API` before onboarding:

```console
$ NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
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

Switching to a different provider family (for example, from NVIDIA Endpoints to Anthropic) also uses `nemoclaw inference set`.
The command updates both the gateway route and the OpenClaw provider namespace in the running sandbox config.

```console
$ nemoclaw inference set --provider anthropic-prod --model claude-sonnet-4-6 --no-verify
```

Use `--no-verify` only when OpenShell cannot verify the provider at switch time but you have already confirmed the provider and credential.

## Tune Model Metadata

The sandbox image bakes model metadata (context window, max output tokens, reasoning mode, and accepted input modalities) into `openclaw.json` at build time.
To change these values, set the corresponding environment variables before running `nemoclaw onboard` so they patch into the Dockerfile before the image builds.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_CONTEXT_WINDOW` | Positive integer (tokens) | `131072` |
| `NEMOCLAW_MAX_TOKENS` | Positive integer (tokens) | `4096` |
| `NEMOCLAW_REASONING` | `true` or `false` | `false` |
| `NEMOCLAW_INFERENCE_INPUTS` | `text` or `text,image` | `text` |
| `NEMOCLAW_AGENT_TIMEOUT` | Positive integer (seconds) | `600` |
| `NEMOCLAW_AGENT_HEARTBEAT_EVERY` | Go-style duration (`30m`, `1h`, `0m` to disable) | `unset` (OpenClaw default) |

Invalid values are ignored, and the default bakes into the image.
Use `NEMOCLAW_INFERENCE_INPUTS=text,image` only for a model that accepts image input through the selected provider.

```console
$ export NEMOCLAW_CONTEXT_WINDOW=65536
$ export NEMOCLAW_MAX_TOKENS=8192
$ export NEMOCLAW_REASONING=true
$ export NEMOCLAW_INFERENCE_INPUTS=text,image
$ export NEMOCLAW_AGENT_TIMEOUT=1800
$ export NEMOCLAW_AGENT_HEARTBEAT_EVERY=0m
$ nemoclaw onboard
```

`NEMOCLAW_AGENT_TIMEOUT` controls the per-request inference timeout baked into
`agents.defaults.timeoutSeconds`. Increase it for slow local inference (for
example, CPU-only Ollama or vLLM on modest hardware). NemoClaw writes this
value into `openclaw.json` during onboarding. The default sandbox may keep that
file writable for agent state, but direct in-sandbox edits are not the supported
or durable way to change NemoClaw-managed defaults. Rebuild the sandbox via
`nemoclaw onboard` to apply a new value.

`NEMOCLAW_AGENT_HEARTBEAT_EVERY` sets `agents.defaults.heartbeat.every`.
This controls OpenClaw's periodic main-session agent turn.
Each interval, the agent wakes up to review follow-ups and read `HEARTBEAT.md` if present in the workspace.
The OpenClaw default is 30 minutes (1 hour for Anthropic OAuth / Claude CLI reuse).
Tune the cadence with a duration string like `5m` or `2h`, or set `0m` to disable the periodic turns entirely.
Disabling also drops `HEARTBEAT.md` from normal-run bootstrap context per upstream behavior, so the model no longer sees heartbeat-only instructions.
NemoClaw writes this value into `openclaw.json` during onboarding.
The in-sandbox `openclaw config set` command is not the supported path for
NemoClaw-managed build-time defaults, and direct file edits are overwritten by a
rebuild. Rebuild the sandbox via `nemoclaw onboard --resume` to apply a new value.

These variables are build-time settings.
If you change them on an existing sandbox, recreate the sandbox so the new values bake into the image:

```console
$ nemoclaw onboard --resume --recreate-sandbox
```

## Verify the Active Model

Run the inference command to confirm the live gateway route:

```console
$ nemoclaw inference get
```

Add `--json` for machine-readable output:

```console
$ nemoclaw inference get --json
```

Run the status command when you also need sandbox, service, and messaging health:

```console
$ nemoclaw <name> status
```

The status output includes the active provider, model, and endpoint with the rest of the sandbox state.

## Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- `nemoclaw inference set` patches the selected running OpenClaw or Hermes sandbox config and recomputes its config hash.
- Use `nemoclaw onboard --resume --recreate-sandbox` for build-time settings such as context window, max tokens, reasoning mode, heartbeat cadence, or image contents.
- Local Ollama and local vLLM routes use local provider tokens rather than `OPENAI_API_KEY`. Rebuilds of older local-inference sandboxes clear the stale OpenAI credential requirement automatically.

## Related Topics

- [Inference Options](inference-options.md) for the full list of providers available during onboarding.
