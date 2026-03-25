---
title:
  page: "Switch NemoClaw Inference Models at Runtime"
  nav: "Switch Inference Models"
description: "Change the active inference model without restarting the sandbox."
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

## Local Ollama Behavior

When you select Local Ollama during onboarding, NemoClaw still points OpenClaw at the managed `https://inference.local/v1` route.
The sandbox does not talk to Ollama directly.

On WSL2 with Docker Desktop, NemoClaw discovers Ollama from the Linux side, then configures the provider with a container-reachable hostname such as `host.docker.internal`.
This allows sandbox requests to reach a Windows-hosted Ollama instance without hard-coding the Windows host IP into the sandbox configuration.

NemoClaw also records the effective Ollama context window for the selected model. It checks the running-model context first and then falls back to the configured `num_ctx` reported by Ollama. OpenClaw uses that discovered limit when advertising the model inside the sandbox.

If you increase the context length in Ollama, re-run onboarding so NemoClaw can sync the updated model metadata into the sandbox.

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

For Local Ollama, run a managed-route request from inside the sandbox to verify the full path:

```console
$ nemoclaw <name> connect
$ curl -sk https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer unused" \
  -d '{"model":"<ollama-model>","messages":[{"role":"user","content":"Reply with exactly: OLLAMA_OK"}],"max_tokens":16}'
```

If you want to test the OpenClaw client path, use a fresh session ID:

```console
$ openclaw agent --agent main --local -m "Reply with exactly: OLLAMA_OK" --session-id ollama-smoke
```

Do not treat a blocked request to `host.docker.internal:11434` from inside the sandbox as proof that Local Ollama is broken. The direct host route can be denied by policy while the managed route continues to work.

## Available Models

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Runtime switching changes the OpenShell route. It does not rewrite your stored credentials.

## Related Topics

- [Inference Profiles](../reference/inference-profiles.md) for full profile configuration details.
