---
title:
  page: "Use a Custom LLM Provider with NemoClaw"
  nav: "Custom LLM Provider"
description: "Configure NemoClaw to use any OpenAI-compatible LLM endpoint, including third-party providers like OpenAI, Azure, Anthropic, Perplexity, Google, and self-hosted models."
keywords: ["custom llm", "third-party model", "openai compatible", "api endpoint", "nemoclaw provider"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "inference_routing", "custom_provider"]
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

# Use a Custom LLM Provider with NemoClaw

NemoClaw routes inference through any **OpenAI-compatible** `/v1/chat/completions` endpoint.
This guide shows how to point NemoClaw at a third-party LLM provider — no code changes required.

## Overview

NemoClaw uses three configuration values to connect to an LLM:

| Setting | Description | Example |
|---|---|---|
| **Endpoint URL** | Base URL of the OpenAI-compatible API | `https://inference-api.nvidia.com/v1` |
| **API Key** | Authentication token for the endpoint | `sk-abc123...` |
| **Model ID** | Model identifier recognized by the endpoint | `azure/openai/gpt-5.4` |

Any provider that exposes a standard `/v1/chat/completions` endpoint works out of the box.

---

## Quick Start

### Option A: Interactive Onboarding

The simplest path — the wizard walks you through everything:

```console
$ nemoclaw onboard
```

When prompted for the endpoint, select **"Custom"** and enter your provider's base URL.
Paste your API key when asked, then pick or type the model ID.

### Option B: Non-Interactive (One Command)

```console
$ export NEMOCLAW_API_KEY="your-api-key-here"
$ openclaw nemoclaw onboard \
    --endpoint custom \
    --endpoint-url "https://your-provider.com/v1" \
    --model "your/model-id" \
    --api-key "$NEMOCLAW_API_KEY"
```

### Option C: Manual Provider Setup

If you already have a running sandbox and want to switch providers:

```console
# 1. Set your API key
export NEMOCLAW_API_KEY="your-api-key-here"

# 2. Create (or update) the provider
openshell provider create \
  --name my-provider \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://your-provider.com/v1"

# 3. Set the inference route
openshell inference set --provider my-provider --model "your/model-id"

# 4. Verify
openshell inference get
```

---

## Provider Examples

Below are ready-to-use configurations for popular LLM providers.

### NVIDIA Inference API (Default)

```bash
export NEMOCLAW_API_KEY="sk-your-nvidia-key"

openshell provider create \
  --name nvidia-nim \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://inference-api.nvidia.com/v1"

openshell inference set --provider nvidia-nim --model azure/openai/gpt-5.4
```

Available models include:
- `azure/openai/gpt-5.4` — OpenAI GPT-5.4 via Azure
- `nvidia/nemotron-3-super-120b-a12b` — Nemotron 3 Super 120B
- `nvidia/llama-3.1-nemotron-ultra-253b-v1` — Nemotron Ultra 253B
- `nvidia/llama-3.3-nemotron-super-49b-v1.5` — Nemotron Super 49B v1.5

### OpenAI Direct

```bash
export NEMOCLAW_API_KEY="sk-your-openai-key"

openshell provider create \
  --name openai-direct \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://api.openai.com/v1"

openshell inference set --provider openai-direct --model gpt-4o
```

### Azure OpenAI

```bash
export NEMOCLAW_API_KEY="your-azure-api-key"

openshell provider create \
  --name azure-openai \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment/v1"

openshell inference set --provider azure-openai --model gpt-4o
```

### Anthropic (via OpenAI-Compatible Proxy)

If you use a proxy that exposes Anthropic models through an OpenAI-compatible interface
(e.g., LiteLLM, OpenRouter):

```bash
export NEMOCLAW_API_KEY="your-proxy-api-key"

openshell provider create \
  --name anthropic-proxy \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

openshell inference set --provider anthropic-proxy --model anthropic/claude-sonnet-4-6
```

### Google Gemini (via OpenAI-Compatible Proxy)

```bash
export NEMOCLAW_API_KEY="your-proxy-api-key"

openshell provider create \
  --name gemini-proxy \
  --type openai \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY" \
  --config "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

openshell inference set --provider gemini-proxy --model google/gemini-2.5-pro
```

### Local vLLM

```bash
openshell provider create \
  --name vllm-local \
  --type openai \
  --credential "OPENAI_API_KEY=dummy" \
  --config "OPENAI_BASE_URL=http://host.openshell.internal:8000/v1"

openshell inference set --provider vllm-local --model your-local-model
```

### Local Ollama

```bash
openshell provider create \
  --name ollama-local \
  --type openai \
  --credential "OPENAI_API_KEY=ollama" \
  --config "OPENAI_BASE_URL=http://host.openshell.internal:11434/v1"

openshell inference set --provider ollama-local --model llama3.3
```

---

## Changing the Configuration After Setup

### Update the API Key

```bash
export NEMOCLAW_API_KEY="your-new-key"

openshell provider update nvidia-nim \
  --credential "NEMOCLAW_API_KEY=$NEMOCLAW_API_KEY"
```

### Switch to a Different Endpoint

```bash
openshell provider update nvidia-nim \
  --config "OPENAI_BASE_URL=https://new-endpoint.example.com/v1"
```

### Switch to a Different Model

No rebuild required — just update the inference route:

```bash
openshell inference set --provider nvidia-nim --model "new/model-id"
```

### Verify Current Configuration

```bash
# Check inference route
openshell inference get

# Check sandbox status
openclaw nemoclaw status
```

---

## Network Policy Configuration

When using a custom endpoint, the sandbox network policy must allow outbound access
to the provider's hostname. The default policy (`nemoclaw-blueprint/policies/openclaw-sandbox.yaml`)
allows these hosts:

- `integrate.api.nvidia.com:443`
- `inference-api.nvidia.com:443`

To add a new endpoint, update the policy file under the `network_policies.nvidia.endpoints` section:

```yaml
network_policies:
  nvidia:
    name: nvidia
    endpoints:
      # existing entries...
      - host: your-provider.example.com
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: "*", path: "/**" }
```

Then apply the updated policy:

```console
$ openshell policy set --file nemoclaw-blueprint/policies/openclaw-sandbox.yaml
```

For local providers (vLLM, Ollama), traffic goes through `host.openshell.internal`
which is already allowed by the gateway.

---

## Configuration File Reference

NemoClaw stores onboard configuration in `~/.nemoclaw/config.json`:

```json
{
  "endpointType": "custom",
  "endpointUrl": "https://your-provider.com/v1",
  "ncpPartner": null,
  "model": "your/model-id",
  "profile": "ncp",
  "credentialEnv": "NEMOCLAW_API_KEY",
  "onboardedAt": "2026-03-25T00:00:00.000Z"
}
```

| Field | Description |
|---|---|
| `endpointType` | One of: `build`, `ncp`, `nim-local`, `vllm`, `ollama`, `custom` |
| `endpointUrl` | Full base URL of the inference API |
| `model` | Model ID to use for inference |
| `credentialEnv` | Environment variable name that holds the API key |
| `profile` | Blueprint profile name |

---

## Supported Endpoint Types

| Type | Description | Requires API Key | Default URL |
|---|---|---|---|
| `build` | NVIDIA Inference API | Yes | `https://inference-api.nvidia.com/v1` |
| `ncp` | NVIDIA Cloud Partner | Yes | User-provided |
| `custom` | Any OpenAI-compatible endpoint | Yes | User-provided |
| `nim-local` | Self-hosted NIM container | Yes | `http://nim-service.local:8000/v1` |
| `vllm` | Local vLLM server | No | `http://host.openshell.internal:8000/v1` |
| `ollama` | Local Ollama server | No | `http://host.openshell.internal:11434/v1` |

---

## Troubleshooting

### API key rejected

- Confirm the key is valid for the endpoint: `curl -H "Authorization: Bearer $NEMOCLAW_API_KEY" https://your-endpoint/v1/models`
- NemoClaw accepts any key format — there is no prefix requirement.

### Model not found

- List available models: `curl -H "Authorization: Bearer $NEMOCLAW_API_KEY" https://your-endpoint/v1/models`
- Ensure the model ID matches exactly (case-sensitive).

### Connection refused from sandbox

- The sandbox network policy may be blocking the host. See [Network Policy Configuration](#network-policy-configuration) above.
- For local providers, use `http://host.openshell.internal:<port>/v1` (not `localhost`).

### Rate limit errors (429)

- The provider is throttling requests. Wait and retry, or upgrade your plan.

---

## Related Topics

- [Switch Inference Models at Runtime](./switch-inference-providers.md)
- [Inference Profiles Reference](../reference/inference-profiles.md)
- [Network Policy — Approve Network Requests](../network-policy/approve-network-requests.md)
