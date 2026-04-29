<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Inference Options

NemoClaw supports multiple inference providers.
During onboarding, the `nemoclaw onboard` wizard presents a numbered list of providers to choose from.
Your selection determines where the agent's inference traffic is routed.

## How Inference Routing Works

The agent inside the sandbox talks to `inference.local`.
It never connects to a provider directly.
OpenShell intercepts inference traffic on the host and forwards it to the provider you selected.

Provider credentials stay on the host.
The sandbox does not receive your API key.

## Provider Status

<!-- provider-status:begin -->
| Provider | Status | Endpoint type | Notes |
|----------|--------|---------------|-------|
| NVIDIA Endpoints | Tested | OpenAI-compatible | Hosted models on integrate.api.nvidia.com |
| OpenAI | Tested | Native OpenAI-compatible | Uses OpenAI model IDs |
| Other OpenAI-compatible endpoint | Tested | Custom OpenAI-compatible | For compatible proxies and gateways |
| Anthropic | Tested | Native Anthropic | Uses anthropic-messages |
| Other Anthropic-compatible endpoint | Tested | Custom Anthropic-compatible | For Claude proxies and compatible gateways |
| Google Gemini | Tested | OpenAI-compatible | Uses Google's OpenAI-compatible endpoint |
| Local Ollama | Caveated | Local Ollama API | Available when Ollama is installed or running on the host |
| Local NVIDIA NIM | Experimental | Local OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU |
| Local vLLM | Experimental | Local OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` and a server already running on `localhost:8000` |
<!-- provider-status:end -->

## Provider Options

The onboard wizard presents the following provider options by default.
The first six are always available.
Ollama appears when it is installed or running on the host.

| Option | Description | Curated models |
|--------|-------------|----------------|
| NVIDIA Endpoints | Routes to models hosted on [build.nvidia.com](https://build.nvidia.com). You can also enter any model ID from the catalog. Set `NVIDIA_API_KEY`. | Nemotron 3 Super 120B, Kimi K2.5, GLM-5.1, MiniMax M2.5, GPT-OSS 120B |
| OpenAI | Routes to the OpenAI API. Set `OPENAI_API_KEY`. | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro-2026-03-05` |
| Other OpenAI-compatible endpoint | Routes to any server that implements `/v1/chat/completions`. If the endpoint also supports `/responses` with OpenClaw-style tool calling, NemoClaw can use that path; otherwise it falls back to `/chat/completions`. The wizard prompts for a base URL and model name. Works with OpenRouter, LocalAI, llama.cpp, or any compatible proxy. Set `COMPATIBLE_API_KEY`. | You provide the model name. |
| Anthropic | Routes to the Anthropic Messages API. Set `ANTHROPIC_API_KEY`. | `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6` |
| Other Anthropic-compatible endpoint | Routes to any server that implements the Anthropic Messages API (`/v1/messages`). The wizard prompts for a base URL and model name. Set `COMPATIBLE_ANTHROPIC_API_KEY`. | You provide the model name. |
| Google Gemini | Routes to Google's OpenAI-compatible endpoint. NemoClaw prefers `/responses` only when the endpoint proves it can handle tool calling in a way OpenClaw uses; otherwise it falls back to `/chat/completions`. Set `GEMINI_API_KEY`. | `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| Local Ollama | Routes to a local Ollama instance on `localhost:11434`. NemoClaw detects installed models, offers starter models if none are present, pulls and warms the selected model, and validates it. | Selected during onboarding. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill). |

## Choosing the Right Option for Nemotron

NVIDIA Nemotron models expose OpenAI-compatible APIs across every supported deployment surface, so two onboarding options can route to Nemotron.

| Where Nemotron is hosted | Onboard wizard option | Why |
|---|---|---|
| `build.nvidia.com` (NVIDIA-hosted) | **Option 1: NVIDIA Endpoints** | NemoClaw sets the base URL to `https://integrate.api.nvidia.com/v1` for you and validates the model against the build catalog. |
| Self-hosted NIM container | **Option 3: Other OpenAI-compatible endpoint** | NIM exposes an OpenAI-compatible `/v1/chat/completions` route. Point the base URL at your NIM service and enter the Nemotron model ID. |
| Enterprise NVIDIA AI Enterprise gateway | **Option 3: Other OpenAI-compatible endpoint** | Enterprise gateways front Nemotron with the same OpenAI-compatible contract. Use the gateway's base URL and your enterprise token. |
| vLLM, SGLang, or TRT-LLM serving Nemotron weights | **Option 3: Other OpenAI-compatible endpoint** | Each runtime exposes Nemotron through `/v1/chat/completions`. Use the runtime's base URL and the model ID it reports. |
| Local NIM started by the wizard | **Local NVIDIA NIM** (experimental) | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU. NemoClaw pulls and manages the container for you. |

For Option 3, the API key environment variable is `COMPATIBLE_API_KEY`. Set it to whatever credential your endpoint expects, or any non-empty placeholder if your endpoint does not require auth.

## Experimental Options

The following local inference options require `NEMOCLAW_EXPERIMENTAL=1` and, when prerequisites are met, appear in the onboarding selection list.

| Option | Condition | Notes |
|--------|-----------|-------|
| Local NVIDIA NIM | NIM-capable GPU detected | Pulls and manages a NIM container. |
| Local vLLM | vLLM running on `localhost:8000` | Auto-detects the loaded model. |

For setup instructions, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).

## Validation

NemoClaw validates the selected provider and model before creating the sandbox.
If credential validation fails, the wizard asks whether to re-enter the API key, choose a different provider, retry, or exit.
The `nvapi-` prefix check applies only to `NVIDIA_API_KEY`.
Other provider credentials, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and compatible endpoint keys, use provider-aware validation during retry.

| Provider type | Validation method |
|---|---|
| OpenAI | Tries `/responses` first, then `/chat/completions`. |
| NVIDIA Endpoints | Tries `/responses` first with a tool-calling probe that matches OpenClaw behavior. Falls back to `/chat/completions` if the endpoint does not return a compatible tool call. |
| Google Gemini | Tries `/responses` first with a tool-calling probe that matches OpenClaw behavior. Falls back to `/chat/completions` if the endpoint does not return a compatible tool call. |
| Other OpenAI-compatible endpoint | Tries `/responses` first with a tool-calling probe that matches OpenClaw behavior. Falls back to `/chat/completions` if the endpoint does not return a compatible tool call. |
| Anthropic-compatible | Tries `/v1/messages`. |
| NVIDIA Endpoints (manual model entry) | Validates the model name against the catalog API. |
| Compatible endpoints | Sends a real inference request because many proxies do not expose a `/models` endpoint. For OpenAI-compatible endpoints, the probe includes tool calling before NemoClaw favors `/responses`. |

## Next Steps

- Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill) for Ollama, vLLM, NIM, and compatible-endpoint setup details.
- Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for changing the model at runtime without re-onboarding.
