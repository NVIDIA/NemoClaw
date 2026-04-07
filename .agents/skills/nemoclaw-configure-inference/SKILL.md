---
name: "nemoclaw-configure-inference"
description: "Lists all inference providers offered during NemoClaw onboarding. Use when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Changes the active inference model without restarting the sandbox. Use when switching inference providers, changing the model runtime, or reconfiguring inference routing. Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw."
---

# NemoClaw Configure Inference

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

## Step 2: Verify the Active Model

Run the status command to confirm the change:

```console
$ nemoclaw <name> status
```

Add the `--json` flag for machine-readable output:

```console
$ nemoclaw <name> status --json
```

The output includes the active provider, model, and endpoint.

## Step 3: Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Runtime switching changes the OpenShell route. It does not rewrite your stored credentials.

---

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and two experimental options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Step 4: Ollama

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

### Linux with Docker

On Linux hosts that run NemoClaw with Docker, the sandbox reaches Ollama through
`http://host.openshell.internal:11434`, not the host shell's `localhost` socket.
If Ollama is already running, make sure it listens on `0.0.0.0:11434` instead of
`127.0.0.1:11434`.

```console
$ OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

If Ollama only binds loopback, NemoClaw can detect it on the host, but the
sandbox-side validation step fails because containers cannot reach it.

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

## Step 5: OpenAI-Compatible Server

This option works with any server that implements `/v1/chat/completions`, including vLLM, TensorRT-LLM, llama.cpp, LocalAI, and others.

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

## Step 6: Anthropic-Compatible Server

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

## Step 7: vLLM Auto-Detection (Experimental)

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

## Step 8: NVIDIA NIM (Experimental)

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

## Step 9: Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.

## Step 10: Switch Models at Runtime

You can change the model without re-running onboard.
Refer to Switch Inference Models (see the `nemoclaw-configure-inference` skill) for the full procedure.

For compatible endpoints, the command is:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), rerun `nemoclaw onboard`.

## Related Skills

- `nemoclaw-get-started` — Quickstart for first-time installation
