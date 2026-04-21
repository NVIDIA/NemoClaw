---
name: "nemoclaw-user-configure-inference"
description: "Lists all inference providers offered during NemoClaw onboarding. Use when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Changes the active inference model without restarting the sandbox. Use when switching inference providers, changing the model runtime, or reconfiguring inference routing. Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Configure Inference

Lists all inference providers offered during NemoClaw onboarding. Use when explaining which providers are available, what the onboard wizard presents, or how inference routing works.

## Context

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
| NVIDIA Endpoints | Routes to models hosted on [build.nvidia.com](https://build.nvidia.com). You can also enter any model ID from the catalog. Set `NVIDIA_API_KEY`. | Nemotron 3 Super 120B, Kimi K2.5, GLM-5, MiniMax M2.5, GPT-OSS 120B |
| OpenAI | Routes to the OpenAI API. Set `OPENAI_API_KEY`. | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro-2026-03-05` |
| Other OpenAI-compatible endpoint | Routes to any server that implements `/v1/chat/completions`. If the endpoint also supports `/responses` with OpenClaw-style tool calling, NemoClaw can use that path; otherwise it falls back to `/chat/completions`. The wizard prompts for a base URL and model name. Works with OpenRouter, LocalAI, llama.cpp, or any compatible proxy. Set `COMPATIBLE_API_KEY`. | You provide the model name. |
| Anthropic | Routes to the Anthropic Messages API. Set `ANTHROPIC_API_KEY`. | `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6` |
| Other Anthropic-compatible endpoint | Routes to any server that implements the Anthropic Messages API (`/v1/messages`). The wizard prompts for a base URL and model name. Set `COMPATIBLE_ANTHROPIC_API_KEY`. | You provide the model name. |
| Google Gemini | Routes to Google's OpenAI-compatible endpoint. NemoClaw prefers `/responses` only when the endpoint proves it can handle tool calling in a way OpenClaw uses; otherwise it falls back to `/chat/completions`. Set `GEMINI_API_KEY`. | `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| Local Ollama | Routes to a local Ollama instance on `localhost:11434`. NemoClaw detects installed models, offers starter models if none are present, pulls and warms the selected model, and validates it. | Selected during onboarding. For more information, refer to Use a Local Inference Server (see the `nemoclaw-user-configure-inference` skill). |

## Experimental Options

The following local inference options require `NEMOCLAW_EXPERIMENTAL=1` and, when prerequisites are met, appear in the onboarding selection list.

| Option | Condition | Notes |
|--------|-----------|-------|
| Local NVIDIA NIM | NIM-capable GPU detected | Pulls and manages a NIM container. |
| Local vLLM | vLLM running on `localhost:8000` | Auto-detects the loaded model. |

For setup instructions, refer to Use a Local Inference Server (see the `nemoclaw-user-configure-inference` skill).

## Validation

NemoClaw validates the selected provider and model before creating the sandbox.
If validation fails, the wizard returns to provider selection.

*Full details in `references/inference-options.md`.*

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.
- NemoClaw installed.
- A local model server running, or Ollama installed. The NemoClaw onboard wizard can also start Ollama for you.

Change the active inference model while the sandbox is running.
No restart is required.

## Step 1: Switch to a Different Model

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

For the compatible-endpoint provider, NemoClaw uses `/v1/chat/completions` by
default, so no env var is required to keep the safe path.
To opt in to `/v1/responses` for a backend you have verified end to end, set
`NEMOCLAW_PREFERRED_API` before onboarding:

```console
$ NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
```

> **Note:** `NEMOCLAW_INFERENCE_API_OVERRIDE` patches the config at container startup but
> does not update the Dockerfile ARG baked into the image.
> If you recreate the sandbox without the override env var, the image reverts to
> the original API path.
> A fresh `nemoclaw onboard` is the reliable fix because it updates both the
> session and the baked image.

## Step 2: Cross-Provider Switching

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

## Step 3: Tune Model Metadata

The sandbox image bakes model metadata (context window, max output tokens, and reasoning mode) into `openclaw.json` at build time.
To change these values, set the corresponding environment variables before running `nemoclaw onboard` so they patch into the Dockerfile before the image builds.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_CONTEXT_WINDOW` | Positive integer (tokens) | `131072` |
| `NEMOCLAW_MAX_TOKENS` | Positive integer (tokens) | `4096` |
| `NEMOCLAW_REASONING` | `true` or `false` | `false` |

Invalid values are ignored, and the default bakes into the image.

```console
$ export NEMOCLAW_CONTEXT_WINDOW=65536
$ export NEMOCLAW_MAX_TOKENS=8192
$ export NEMOCLAW_REASONING=true
$ nemoclaw onboard
```

These variables are build-time settings.
If you change them on an existing sandbox, recreate the sandbox so the new values bake into the image:

```console
$ nemoclaw onboard --resume --recreate-sandbox
```

## Step 4: Verify the Active Model

Run the status command to confirm the change:

```console
$ nemoclaw <name> status
```

Add the `--json` flag for machine-readable output:

```console
$ nemoclaw <name> status --json
```

The output includes the active provider, model, and endpoint.

## Step 5: Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Same-provider model switches take effect immediately via the gateway route alone.
- Cross-provider switches also require `NEMOCLAW_MODEL_OVERRIDE` (and `NEMOCLAW_INFERENCE_API_OVERRIDE`) plus a sandbox recreate so the entrypoint patches the config at startup.
- Overrides are applied at container startup. Changing or removing env vars requires a sandbox recreate to take effect.

---

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and two experimental options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Step 6: Ollama

Ollama is the default local inference option.
The onboard wizard detects Ollama automatically when it is installed or running on the host.

If Ollama is not running, NemoClaw starts it for you.
On macOS, the wizard also offers to install Ollama through Homebrew if it is not present.

Run the onboard wizard.

```console
$ nemoclaw onboard
```

Select **Local Ollama** from the provider list.
NemoClaw lists installed models or offers starter models if none are installed.
It pulls the selected model, loads it into memory, and validates it before continuing.

### Authenticated Reverse Proxy

NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated
reverse proxy on `0.0.0.0:11435`.
Containers and other hosts on the local network reach Ollama only through the
proxy, which validates a Bearer token before forwarding requests.
Ollama itself is never exposed without authentication.

The onboard wizard manages the proxy automatically:

- Generates a random 24-byte token on first run and stores it in
  `~/.nemoclaw/ollama-proxy-token` with `0600` permissions.
- Starts the proxy after Ollama and verifies it before continuing.
- Cleans up stale proxy processes from previous runs.
- Reuses the persisted token after a host reboot so you do not need to re-run
  onboard.

The sandbox provider is configured to use proxy port `11435` with the generated
token as its `OPENAI_API_KEY` credential.
OpenShell's L7 proxy injects the token at egress, so the agent inside the
sandbox never sees the token directly.

`GET /api/tags` is exempt from authentication so container health checks
continue to work.
All other endpoints (including `POST /api/tags`) require the Bearer token.

If Ollama is already running on a non-loopback address when you start onboard,
the wizard restarts it on `127.0.0.1:11434` so the proxy is the only network
path to the model server.

### Non-Interactive Setup

```console
$ NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL=qwen2.5:14b \
  nemoclaw onboard --non-interactive
```

If `NEMOCLAW_MODEL` is not set, NemoClaw selects a default model based on available memory.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |

## Step 7: OpenAI-Compatible Server

This option works with any server that implements `/v1/chat/completions`, including vLLM, TensorRT-LLM, llama.cpp, LocalAI, and others.
For compatible endpoints, NemoClaw uses `/v1/chat/completions` by default.
This avoids a class of failures where local backends accept `/v1/responses` requests but silently drop the system prompt and tool definitions.
To opt in to `/v1/responses`, set `NEMOCLAW_PREFERRED_API=openai-responses` before running onboard.

Start your model server.
The examples below use vLLM, but any OpenAI-compatible server works.

```console
$ vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000
```

Run the onboard wizard.

```console
$ nemoclaw onboard
```

When the wizard asks you to choose an inference provider, select **Other OpenAI-compatible endpoint**.
Enter the base URL of your local server, for example `http://localhost:8000/v1`.

The wizard prompts for an API key.
If your server does not require authentication, enter any non-empty string (for example, `dummy`).

NemoClaw validates the endpoint by sending a test inference request before continuing.
The wizard probes `/v1/chat/completions` by default for the compatible-endpoint provider.
If you set `NEMOCLAW_PREFERRED_API=openai-responses`, NemoClaw probes `/v1/responses` instead and only selects it when the response includes the streaming events OpenClaw requires.

### Non-Interactive Setup

Set the following environment variables for scripted or CI/CD deployments.

```console
$ NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 \
  NEMOCLAW_MODEL=meta-llama/Llama-3.1-8B-Instruct \
  COMPATIBLE_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `custom` for an OpenAI-compatible endpoint. |
| `NEMOCLAW_ENDPOINT_URL` | Base URL of the local server. |
| `NEMOCLAW_MODEL` | Model ID as reported by the server. |
| `COMPATIBLE_API_KEY` | API key for the endpoint. Use any non-empty value if authentication is not required. |

### Selecting the API Path

For the compatible-endpoint provider, `/v1/chat/completions` is the default.
NemoClaw tests streaming events during onboarding and uses chat completions
without probing the Responses API.

To opt in to `/v1/responses`, set `NEMOCLAW_PREFERRED_API` before running onboard:

```console
$ NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
```

The wizard then probes `/v1/responses` and only selects it when streaming
support is complete.
If the probe fails, the wizard falls back to `/v1/chat/completions`
automatically.
You can use this variable in both interactive and non-interactive mode.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_PREFERRED_API` | `openai-completions`, `openai-responses` | `openai-completions` for compatible endpoints |

If you already onboarded and the sandbox is failing at runtime, re-run
`nemoclaw onboard` to re-probe the endpoint and bake the correct API path
into the image.
Refer to Switch Inference Models (see the `nemoclaw-user-configure-inference` skill) for details.

## Step 8: Anthropic-Compatible Server

If your local server implements the Anthropic Messages API (`/v1/messages`), choose **Other Anthropic-compatible endpoint** during onboarding instead.

```console
$ nemoclaw onboard
```

For non-interactive setup, use `NEMOCLAW_PROVIDER=anthropicCompatible` and set `COMPATIBLE_ANTHROPIC_API_KEY`.

```console
$ NEMOCLAW_PROVIDER=anthropicCompatible \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8080 \
  NEMOCLAW_MODEL=my-model \
  COMPATIBLE_ANTHROPIC_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

## Step 9: vLLM Auto-Detection (Experimental)

When vLLM is already running on `localhost:8000`, NemoClaw can detect it automatically and query the `/v1/models` endpoint to determine the loaded model.

Set the experimental flag and run onboard.

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local vLLM [experimental]** from the provider list.
NemoClaw detects the running model and validates the endpoint.

> **Note:** NemoClaw forces the `chat/completions` API path for vLLM.
> The vLLM `/v1/responses` endpoint does not run the `--tool-call-parser`, so tool calls arrive as raw text.

### Non-Interactive Setup

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=vllm \
  nemoclaw onboard --non-interactive
```

NemoClaw auto-detects the model from the running vLLM instance.
To override the model, set `NEMOCLAW_MODEL`.

## Step 10: NVIDIA NIM (Experimental)

NemoClaw can pull, start, and manage a NIM container on hosts with a NIM-capable NVIDIA GPU.

Set the experimental flag and run onboard.

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local NVIDIA NIM [experimental]** from the provider list.
NemoClaw filters available models by GPU VRAM, pulls the NIM container image, starts it, and waits for it to become healthy before continuing.

> **Note:** NIM uses vLLM internally.
> The same `chat/completions` API path restriction applies.

### Non-Interactive Setup

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=nim \
  nemoclaw onboard --non-interactive
```

To select a specific model, set `NEMOCLAW_MODEL`.

## Step 11: Timeout Configuration

Local inference requests use a default timeout of 180 seconds.
Large prompts on hardware such as DGX Spark can exceed shorter timeouts, so NemoClaw sets a higher default for local providers (Ollama, vLLM, NIM).

To override the timeout, set the `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` environment variable before onboarding:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

The value is in seconds.
This setting is baked into the sandbox at build time.
Changing it after onboarding requires re-running `nemoclaw onboard`.

## Step 12: Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.

## Step 13: Switch Models at Runtime

You can change the model without re-running onboard.
Refer to Switch Inference Models (see the `nemoclaw-user-configure-inference` skill) for the full procedure.

For compatible endpoints, the command is:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), rerun `nemoclaw onboard`.

## Related Skills

- `nemoclaw-user-get-started` — Quickstart for first-time installation
