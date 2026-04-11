---
title: Inference Routing
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-inference]
tags: [inference, routing, providers, core]
---

# Inference Routing

Inference requests from the agent never leave the [sandbox](../entities/sandbox.md)
directly. [OpenShell](../entities/openshell.md) intercepts every call and routes it
to the active provider through the managed `inference.local` endpoint.

## Flow

```text
OpenClaw Agent (sandbox)
  → inference.local (CONNECT tunnel, managed route)
    → OpenShell Gateway (credential injection, provider routing)
      → Selected Provider Endpoint
```

The sandbox never sees raw API keys. Provider swapping is transparent to the
agent and does not require a sandbox restart.

## Supported Providers

| Provider | Type | Notes |
|---|---|---|
| NVIDIA Endpoints | OpenAI-compatible | Production default. `integrate.api.nvidia.com` |
| OpenAI | Native OpenAI API | GPT models |
| Anthropic | Native Anthropic API | Claude models (uses `anthropic-messages`) |
| Google Gemini | OpenAI-compatible | Google's endpoint |
| Compatible OpenAI endpoints | Custom | Proxies and compatible gateways |
| Compatible Anthropic endpoints | Custom | Claude proxy services |
| Local [Ollama](../entities/ollama.md) | OpenAI-compatible (routed) | Experimental |
| Local NIM | OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` |
| Local vLLM | OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` |

## Runtime Switching

Switch providers without restarting the sandbox:

```bash
openshell inference set --provider <id> --model <name>
openshell inference get    # Verify
```

## Validation During Onboarding

| Provider Type | Validation Method |
|---|---|
| OpenAI-compatible | Tries `/responses` then `/chat/completions` |
| Anthropic | Tries `/v1/messages` |
| NVIDIA | Validates against `integrate.api.nvidia.com/v1/models` |
| Compatible endpoints | Sends real inference request |
| Local Ollama | Pulls model, warms weights, validates |

## See Also

- [OpenShell Gateway](../entities/openshell-gateway.md) — Credential-owning proxy
- [Ollama](../entities/ollama.md) — Local inference provider
- [NVIDIA Nemotron](../entities/nvidia-nemotron.md) — Default cloud model
- [Turn Orchestration](turn-orchestration.md) — Multi-model GPU sharing
