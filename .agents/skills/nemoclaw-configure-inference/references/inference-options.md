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

## Provider Options

The onboard wizard presents the following provider options by default.
The first six are always available.
Ollama appears when it is installed or running on the host.

| Option | Description | Curated models |
|--------|-------------|----------------|
| NVIDIA Endpoints | Routes to models hosted on [build.nvidia.com](https://build.nvidia.com). You can also enter any model ID from the catalog. Set `NVIDIA_API_KEY`. | Nemotron 3 Super 120B, Kimi K2.5, GLM-5, MiniMax M2.5, GPT-OSS 120B |
| OpenAI | Routes to the OpenAI API. Set `OPENAI_API_KEY`. | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro-2026-03-05` |
| Other OpenAI-compatible endpoint | Routes to any server that implements `/v1/chat/completions`. The wizard prompts for a base URL and model name. Works with OpenRouter, LocalAI, llama.cpp, or any compatible proxy. Set `COMPATIBLE_API_KEY`. | You provide the model name. |
| Anthropic | Routes to the Anthropic Messages API. Set `ANTHROPIC_API_KEY`. | `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6` |
| Other Anthropic-compatible endpoint | Routes to any server that implements the Anthropic Messages API (`/v1/messages`). The wizard prompts for a base URL and model name. Set `COMPATIBLE_ANTHROPIC_API_KEY`. | You provide the model name. |
| Google Gemini | Routes to Google's OpenAI-compatible endpoint. Set `GEMINI_API_KEY`. | `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| Local Ollama | Routes to a local Ollama instance on `localhost:11434`. NemoClaw detects installed models, offers starter models if none are present, pulls and warms the selected model, and validates it. | Selected during onboarding. For more information, refer to Use a Local Inference Server (see the `nemoclaw-configure-inference` skill). |

## Experimental Options

The following local inference options require `NEMOCLAW_EXPERIMENTAL=1` and, when prerequisites are met, appear in the onboarding selection list.

| Option | Condition | Notes |
|--------|-----------|-------|
| Local NVIDIA NIM | NIM-capable GPU detected | Pulls and manages a NIM container. |
| Local vLLM | vLLM running on `localhost:8000` | Auto-detects the loaded model. |

For setup instructions, refer to Use a Local Inference Server (see the `nemoclaw-configure-inference` skill).

## Validation

NemoClaw validates the selected provider and model before creating the sandbox.
If validation fails, the wizard returns to provider selection.

| Provider type | Validation method |
|---|---|
| OpenAI-compatible | Tries `/responses` first, then `/chat/completions`. |
| Anthropic-compatible | Tries `/v1/messages`. |
| NVIDIA Endpoints (manual model entry) | Validates the model name against the catalog API. |
| Compatible endpoints | Sends a real inference request because many proxies do not expose a `/models` endpoint. |

## Next Steps

- Use a Local Inference Server (see the `nemoclaw-configure-inference` skill) for Ollama, vLLM, NIM, and compatible-endpoint setup details.
- Switch Inference Models (see the `nemoclaw-configure-inference` skill) for changing the model at runtime without re-onboarding.
