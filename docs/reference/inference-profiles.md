---
title:
  page: "NemoClaw Inference Profiles"
  nav: "Inference Profiles"
description: "Configuration reference for NemoClaw routed inference providers."
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

## Local Providers

Local providers are available behind the `NEMOCLAW_EXPERIMENTAL=1` gate.
These use the same routed `inference.local` pattern, but the upstream runtime is local to the host.

- Local Ollama
- Local NVIDIA NIM
- Local vLLM

Ollama gets additional onboarding help:

- if no models are installed, NemoClaw offers starter models
- it pulls the selected model
- it warms the model
- it validates the model before continuing

## Runtime Switching

For runtime switching guidance, refer to [Switch Inference Models](../inference/switch-inference-providers.md).
