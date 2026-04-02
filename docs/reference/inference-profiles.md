---
title:
  page: "NemoClaw Inference Profiles"
  nav: "Inference Profiles"
description:
  main: "Configuration reference for NemoClaw routed inference providers."
  agent: "Documents configuration options for NemoClaw routed inference providers. Use when configuring inference profiles, looking up provider routing settings, or reviewing available LLM providers."
keywords: ["nemoclaw inference profiles", "nemoclaw provider routing"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "inference_routing", "llms"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Inference Profiles

NemoClaw configures inference through the OpenShell gateway.
The agent inside the sandbox talks to `inference.local`, and OpenShell routes that traffic to the provider you selected during onboarding.

## Routed Provider Model

NemoClaw keeps provider credentials on the host.
The sandbox does not receive your raw OpenAI, Anthropic, Gemini, or NVIDIA API key.

At onboard time, NemoClaw configures:

- an OpenShell provider
- an OpenShell inference route
- the baked OpenClaw model reference inside the sandbox

That means the sandbox knows which model family to use, while OpenShell owns the actual provider credential and upstream endpoint.

## Supported Providers

The following non-experimental provider paths are available through `nemoclaw onboard`.

| Provider | Endpoint Type | Notes |
|---|---|---|
| NVIDIA Endpoints | OpenAI-compatible | Hosted models on `integrate.api.nvidia.com` |
| OpenAI | Native OpenAI-compatible | Uses OpenAI model IDs |
| Other OpenAI-compatible endpoint | Custom OpenAI-compatible | For compatible proxies and gateways |
| Anthropic | Native Anthropic | Uses `anthropic-messages` |
| Other Anthropic-compatible endpoint | Custom Anthropic-compatible | For Claude proxies and compatible gateways |
| Google Gemini | OpenAI-compatible | Uses Google's OpenAI-compatible endpoint |

## Validation During Onboarding

NemoClaw validates the selected provider and model before it creates the sandbox.

- OpenAI-compatible providers:
  NemoClaw tries `/responses` first, then `/chat/completions`.
- Anthropic-compatible providers:
  NemoClaw tries `/v1/messages`.
- NVIDIA Endpoints manual model entry:
  NemoClaw also validates the model name against `https://integrate.api.nvidia.com/v1/models`.
- Compatible endpoint flows:
  NemoClaw validates by sending a real inference request, because many proxies do not expose a reliable `/models` endpoint.

If validation fails, the wizard does not continue to sandbox creation.

## Local Ollama

Local Ollama is available in the standard onboarding flow when Ollama is installed or running on the host.
It uses the same routed `inference.local` pattern, but the upstream runtime runs locally instead of in the cloud.

Ollama gets additional onboarding help:

- if no models are installed, NemoClaw offers starter models
- it pulls the selected model
- it warms the model
- it validates the model before continuing

On Linux hosts that run NemoClaw with Docker, the sandbox reaches Ollama through `http://host.openshell.internal:11434`, not the host shell's `localhost` socket.
If Ollama is already running, make sure it listens on `0.0.0.0:11434` instead of `127.0.0.1:11434`.
Run the following command to start Ollama with that bind address.

```console
$ OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

If Ollama only binds loopback, NemoClaw can detect it on the host, but the sandbox-side validation step fails because containers cannot reach it.

## Experimental Local Providers

The following local providers require `NEMOCLAW_EXPERIMENTAL=1`:

- Local NVIDIA NIM (requires a NIM-capable GPU)
- Local vLLM (must already be running on `localhost:8000`)

## Runtime Switching

For runtime switching guidance, refer to [Switch Inference Models](../inference/switch-inference-providers.md).
