---
name: "nemoclaw-user-configure-inference"
description: "Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Trigger keywords - nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, switch nemoclaw inference model, change inference runtime, nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use a Local Inference Server with NemoClaw

## Prerequisites

- NemoClaw installed.
- A local model server running, or an Ollama setup that the NemoClaw onboard wizard can use, start, or install.

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and two experimental options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Step 1: Ollama

Ollama is the default local inference option.
The onboard wizard detects Ollama automatically when it is installed or running on the host.

If Ollama is installed but not running, NemoClaw starts it for you.
On macOS and Linux, the wizard can also offer to install Ollama when it is not present.
On WSL, the wizard can use, start, restart, or install Ollama on the Windows host through PowerShell interop.

Run the onboard wizard.

```console
$ nemoclaw onboard
```

Select **Local Ollama** from the provider list.
NemoClaw lists installed models or offers starter models if none are installed.
It pulls the selected model, loads it into memory, and validates it before continuing.
On WSL, if you choose the Windows-host Ollama path, NemoClaw uses `host.docker.internal:11434` and pulls missing models through the Ollama HTTP API instead of requiring the `ollama` CLI inside WSL.

### WSL with Windows-Host Ollama

When NemoClaw runs inside WSL, the provider menu can include Windows-host Ollama actions:

- **Use Ollama on Windows host** when the Windows daemon is already reachable.
- **Restart Ollama on Windows host** when the daemon is installed but only bound to Windows loopback.
- **Start Ollama on Windows host** when Ollama is installed but not running.
- **Install Ollama on Windows host** when Windows does not have Ollama installed.

The install and restart paths set `OLLAMA_HOST=0.0.0.0:11434` on the Windows side so Docker and WSL can reach the daemon through `host.docker.internal`.
Use one Ollama instance on port `11434` at a time.
If both WSL and Windows-host Ollama are running, pick the intended menu entry during onboarding so NemoClaw validates and pulls models against the right daemon.

### Authenticated Reverse Proxy

On non-WSL hosts, NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated reverse proxy on `0.0.0.0:11435`.
Containers and other hosts on the local network reach Ollama only through the
proxy, which validates a Bearer token before forwarding requests.
Ollama itself is never exposed without authentication.

WSL Ollama paths do not use this proxy.
Windows-host Ollama uses the Windows daemon through `host.docker.internal`.

For non-WSL Ollama setups, the onboard wizard manages the proxy automatically:

- Generates a random 24-byte token on first run and stores it in
  `~/.nemoclaw/ollama-proxy-token` with `0600` permissions.
- Starts the proxy after Ollama and verifies it before continuing.
- Cleans up stale proxy processes from previous runs.
- Retries the sandbox container reachability check and can continue when the host-side proxy is healthy even if the container probe fails.
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

### GPU Memory Cleanup

When you switch away from Ollama, stop host services, or destroy an Ollama-backed sandbox, NemoClaw asks Ollama to unload currently loaded models from GPU memory.
The cleanup sends `keep_alive: 0` for each model reported by Ollama and runs on a best-effort basis, so shutdown continues if Ollama is already stopped.
This does not delete downloaded model files.

### Non-Interactive Setup

```console
$ NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL=qwen2.5:14b \
  nemoclaw onboard --non-interactive --yes
```

If `NEMOCLAW_MODEL` is not set, NemoClaw selects a default model based on available memory.

`--yes` (or `NEMOCLAW_YES=1`) authorises the Ollama model download without an interactive confirmation prompt.
Under `--non-interactive`, `--yes` (or `NEMOCLAW_YES=1`) is required to authorise the download — onboard exits otherwise, since it cannot prompt.
Run onboard without `--non-interactive` to get the interactive `[y/N]` prompt that shows the model size before downloading.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |
| `NEMOCLAW_YES` | Set to `1` to auto-accept the model-download confirmation prompt. Optional. |

## Step 2: OpenAI-Compatible Server

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
Refer to Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for details.

## Step 3: Anthropic-Compatible Server

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

## Step 4: vLLM Auto-Detection (Experimental)

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

## Step 5: NVIDIA NIM (Experimental)

NemoClaw can pull, start, and manage a NIM container on hosts with a NIM-capable NVIDIA GPU.

Set the experimental flag and run onboard.

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local NVIDIA NIM [experimental]** from the provider list.
NemoClaw filters available models by GPU VRAM, pulls the NIM container image, starts it, and waits for it to become healthy before continuing.

NIM container images are hosted on `nvcr.io` and require NGC registry authentication before `docker pull` succeeds.
If Docker is not already logged in to `nvcr.io`, onboard prompts for an [NGC API key](https://org.ngc.nvidia.com/setup/api-key) and runs `docker login nvcr.io` over `--password-stdin` so the key is never written to disk or shell history.
The prompt masks the key during input and retries once on a bad key before failing.
In non-interactive mode, onboard exits with login instructions if Docker is not already authenticated; run `docker login nvcr.io` yourself, then re-run `nemoclaw onboard --non-interactive`.

> **Note:** NIM uses vLLM internally.
> The same `chat/completions` API path restriction applies.

### Non-Interactive Setup

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=nim \
  nemoclaw onboard --non-interactive
```

To select a specific model, set `NEMOCLAW_MODEL`.

## Step 6: Timeout Configuration

Local inference requests use a default timeout of 180 seconds.
Large prompts on hardware such as DGX Spark can exceed shorter timeouts, so NemoClaw sets a higher default for Ollama, vLLM, NIM, and compatible-endpoint setup.

To override the timeout, set the `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` environment variable before onboarding:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

The value is in seconds.
This setting is baked into the sandbox at build time.
Changing it after onboarding requires re-running `nemoclaw onboard`.

## Step 7: Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.

## Step 8: Switch Models at Runtime

You can change the model without re-running onboard.
Refer to Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for the full procedure.

For compatible endpoints, the command is:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), rerun `nemoclaw onboard`.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/set-up-sub-agent.md](references/set-up-sub-agent.md)** when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.

## Related Skills

- `nemoclaw-user-get-started` — Quickstart (use the `nemoclaw-user-get-started` skill) for first-time installation
