<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# NemoClaw Inference Options

NemoClaw supports multiple inference providers.
During onboarding, the `nemoclaw onboard` wizard presents a numbered list of providers to choose from.
Your selection determines where the agent's inference traffic is routed.

## How Inference Routing Works

The agent inside the sandbox talks to `inference.local`.
It never connects to a provider directly.
OpenShell intercepts inference traffic on the host and forwards it to the provider you selected.

Provider credentials stay on the host.
The sandbox does not receive your API key.
Local Ollama and local vLLM do not require your host `OPENAI_API_KEY`.
NemoClaw uses provider-specific local tokens for those routes, and rebuilds of legacy local-inference sandboxes migrate away from stale OpenAI credential requirements.

## Provider Status

| Provider | Status | Endpoint type | Notes |
|----------|--------|---------------|-------|
| NVIDIA Endpoints | Tested | OpenAI-compatible | Hosted models on integrate.api.nvidia.com |
| OpenAI | Tested | Native OpenAI-compatible | Uses OpenAI model IDs |
| Other OpenAI-compatible endpoint | Tested | Custom OpenAI-compatible | For compatible proxies and gateways |
| Anthropic | Tested | Native Anthropic | Uses anthropic-messages |
| Other Anthropic-compatible endpoint | Tested | Custom Anthropic-compatible | For Claude proxies and compatible gateways |
| Google Gemini | Tested | OpenAI-compatible | Uses Google's OpenAI-compatible endpoint |
| Hermes Provider | Hermes only | OpenAI-compatible route | Available when onboarding Hermes Agent through `nemohermes` |
| Local Ollama | Caveated | Local Ollama API | Available when Ollama is installed or running on the host |
| Local NVIDIA NIM | Experimental | Local OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU |
| Local vLLM (already running) | Caveated | Local OpenAI-compatible | Appears in the onboarding menu when NemoClaw detects a server already on `localhost:8000`. No flag required. |
| Local vLLM (managed install/start) | Caveated | Local OpenAI-compatible | Appears by default on DGX Spark and DGX Station. Generic Linux NVIDIA GPU hosts require `NEMOCLAW_EXPERIMENTAL=1` or `NEMOCLAW_PROVIDER=install-vllm`. NemoClaw pulls/starts a vLLM container on a supported NVIDIA GPU host. |

## Provider Options

The onboard wizard presents the following provider options by default.
The first six are always available.
Ollama appears when it is installed or running on the host.
Local vLLM appears when NemoClaw detects a running vLLM server.
The managed install/start vLLM entry appears by default on DGX Spark and DGX Station, and appears on generic Linux NVIDIA GPU hosts after opt-in.

| Option | Description | Curated models |
|--------|-------------|----------------|
| NVIDIA Endpoints | Routes to models hosted on [build.nvidia.com](https://build.nvidia.com). You can also enter any model ID from the catalog. Set `NVIDIA_API_KEY`. | Nemotron 3 Super 120B, GLM-5.1, MiniMax M2.7, GPT-OSS 120B, DeepSeek V4 Pro |
| OpenAI | Routes to the OpenAI API. Set `OPENAI_API_KEY`. | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro-2026-03-05` |
| Other OpenAI-compatible endpoint | Routes to any server that implements `/v1/chat/completions`. NemoClaw uses `/v1/chat/completions` at runtime by default; set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` for proxies that implement it, such as some llama.cpp builds. The wizard prompts for a base URL and model name. Works with OpenRouter, LocalAI, llama.cpp, or any compatible proxy. When you enable Telegram messaging, onboarding also runs a bounded sandbox-side smoke check through `https://inference.local/v1/chat/completions`. Set `COMPATIBLE_API_KEY`. | You provide the model name. |
| Anthropic | Routes to the Anthropic Messages API. Set `ANTHROPIC_API_KEY`. | `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6` |
| Other Anthropic-compatible endpoint | Routes to any server that implements the Anthropic Messages API (`/v1/messages`). The wizard prompts for a base URL and model name. Set `COMPATIBLE_ANTHROPIC_API_KEY`. | You provide the model name. |
| Google Gemini | Routes to Google's OpenAI-compatible chat-completions endpoint. NemoClaw skips the Responses-API probe because Gemini does not support `/v1/responses`. Set `GEMINI_API_KEY`. | `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| Hermes Provider | Routes Hermes Agent through the host OpenShell provider registered by NemoClaw when onboarding Hermes Agent. | Curated Hermes Provider models such as `moonshotai/kimi-k2.6`, `openai/gpt-5.4-mini`, and `z-ai/glm-5.1`. |
| Local Ollama | Routes to a local Ollama instance on `localhost:11434`. NemoClaw detects installed models, offers starter models if none are present, pulls and warms the selected model, and validates it. | Selected during onboarding. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill). |
| Model Router | Starts a host-side router on port `4000`, registers it as an OpenAI-compatible provider, and keeps the sandbox pointed at `inference.local`. Set `NEMOCLAW_PROVIDER=routed` for non-interactive setup. | The router pool defines the model names. |

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

## Model Router

The Model Router option uses the `routed` inference profile in `nemoclaw-blueprint/blueprint.yaml`.
When you select it, NemoClaw starts the router proxy on the host, waits for its health endpoint, registers the `nvidia-router` provider with OpenShell, and creates the sandbox with the same `inference.local` route the agent uses for other providers.
The sandbox does not call the router port directly.

The router model pool lives in `nemoclaw-blueprint/router/pool-config.yaml`.
The default pool routes between NVIDIA-hosted Nemotron models and uses the `tolerance` value to choose the lowest-cost model whose predicted quality stays within the configured threshold.
To use the router in scripted setup, set:

```console
$ NEMOCLAW_PROVIDER=routed NVIDIA_API_KEY=<your-key> nemoclaw onboard --non-interactive
```

### Host Python requirement

The Model Router runs in a host-side virtual environment that NemoClaw creates during onboarding.
NemoClaw probes `python3.13`, `python3.12`, `python3.11`, `python3.10`, and bare `python3`, and adopts the first interpreter that satisfies both of:

- Version inside `[3.10, 3.14)`.
- `ensurepip`, `pyexpat`, `ssl`, and `venv` all import without error.

If no candidate qualifies, onboarding aborts and prints the real failure for each candidate.
This surfaces issues like Homebrew `python@3.14` whose `pyexpat` extension fails to dlopen against the older system `libexpat` on macOS.

To pin a specific interpreter, set `NEMOCLAW_MODEL_ROUTER_PYTHON` to its absolute path before running `nemoclaw onboard`:

```console
$ NEMOCLAW_MODEL_ROUTER_PYTHON=/opt/homebrew/bin/python3.12 nemoclaw onboard
```

The pin is strict.
NemoClaw probes only that interpreter and aborts with the failure reason if it does not qualify, rather than silently falling back to a different python on `PATH`.
Relative command names such as `python3.12` are rejected; use `command -v python3.12` to find the absolute path.
If `python -m venv` itself fails for a probe-clean interpreter (for example, a corrupt ensurepip seed), NemoClaw retries with the next healthy candidate when no pin is set; with a pin set, the failure stops onboarding so you can fix or repoint the pinned python.

## Caveated Local Options

The following local inference options are caveated.
Local NIM and generic Linux managed vLLM install/start require `NEMOCLAW_EXPERIMENTAL=1`; DGX Spark and DGX Station managed vLLM entries appear by default.
An already-running vLLM server appears directly in the onboarding selection list.

| Option | Condition | Notes |
|--------|-----------|-------|
| Local NVIDIA NIM | NIM-capable GPU detected | Pulls and manages a NIM container. |
| Local vLLM | vLLM running on `localhost:8000`, or a supported DGX Spark, DGX Station, or Linux NVIDIA GPU profile | Auto-detects the loaded model when vLLM is already running. Can install or start a managed vLLM container by default on DGX Spark/Station and after opt-in on generic Linux NVIDIA GPU hosts. |

For setup instructions, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).

## Validation

NemoClaw validates the selected provider and model before creating the sandbox.
If credential validation fails, the wizard asks whether to re-enter the API key, choose a different provider, retry, or exit.
Transient upstream validation failures are retried before the wizard reports a provider failure.
The `nvapi-` prefix check applies only to `NVIDIA_API_KEY`.
Other provider credentials, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and compatible endpoint keys, use provider-aware validation during retry.

| Provider type | Validation method |
|---|---|
| OpenAI | Tries `/responses` first, then `/chat/completions`. |
| NVIDIA Endpoints | Validates via `/v1/chat/completions` only; the `/v1/responses` probe is skipped because NVIDIA Build does not expose `/v1/responses` (returns 404 for every model). |
| Google Gemini | Validates via Gemini's OpenAI-compatible chat-completions path only; the `/v1/responses` probe is skipped because Gemini does not support the Responses API. |
| Other OpenAI-compatible endpoint | Tries `/v1/responses` first with a tool-calling probe; falls back to `/v1/chat/completions`. Selected runtime API defaults to `/v1/chat/completions`; set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` at runtime when validation succeeds. |
| Anthropic-compatible | Tries `/v1/messages`. |
| NVIDIA Endpoints (manual model entry) | Validates the model name against the catalog API. |
| Compatible endpoints | Sends a real inference request because many proxies do not expose a `/models` endpoint. For OpenAI-compatible endpoints, the probe tries `/v1/responses` first then falls back to `/v1/chat/completions`; the selected runtime API defaults to `/v1/chat/completions`. Set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` at runtime when validation succeeds. |
| Local NVIDIA NIM | Validates via `/v1/chat/completions` only; the `/v1/responses` probe is skipped (same as NVIDIA Endpoints). |

## Next Steps

- Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill) for Ollama, vLLM, NIM, and compatible-endpoint setup details.
- Tool-Calling Reliability (use the `nemoclaw-user-configure-inference` skill) for deciding when Ollama is enough and when vLLM with a parser is safer.
- Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for changing the model at runtime without re-onboarding.
