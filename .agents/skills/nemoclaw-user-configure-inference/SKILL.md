---
name: "nemoclaw-user-configure-inference"
description: "Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Trigger keywords - nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, switch nemoclaw inference model, change inference runtime, nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, nemoclaw tool calling, ollama tool calls, vllm tool-call-parser, raw json in tui, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use a Local Inference Server

## Gotchas

- Ollama is convenient for local chat, but some model/template combinations can return tool calls as plain text under realistic agent load.

## Prerequisites

- NemoClaw installed.
- A local model server running, or a supported Ollama, vLLM, or NIM setup that the NemoClaw onboard wizard can use, start, or install.

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and experimental managed options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Ollama

Ollama is the default local inference option.
The onboard wizard detects Ollama automatically when it is installed or running on the host.

If Ollama is installed but not running, NemoClaw starts it for you.
On macOS and Linux, the wizard can also offer to install Ollama when it is not present.
When the host Ollama is below the minimum version NemoClaw expects for its starter models (currently `0.7.0`), the wizard surfaces an explicit **Upgrade Ollama** entry in the provider menu instead of silently reusing the older daemon, and the express setup path resolves to that entry.
The wizard inspects both the CLI binary (`ollama --version`) and the locally running daemon (`/api/version` on `:11434`) so the upgrade entry still appears when only one side is stale, for example a fresh user-local binary paired with the original system daemon.
The gate skips Windows-host Ollama reached from WSL via `host.docker.internal`; the separate **Use / Start / Install Ollama on Windows host** entries handle that case and run their own actions on the Windows side.
On macOS, the wizard runs the platform install or upgrade path with `brew upgrade ollama`.
On Linux, the wizard runs the official `https://ollama.com/install.sh` path.
Upgrades on Linux always take the sudo-driven system path because the sudo-free user-local fallback would leave the existing system daemon on `:11434` serving the stale binary.
If sudo is not available in a non-interactive run, NemoClaw refuses to silently downgrade the path and asks you to rerun interactively or upgrade Ollama manually.
After an upgrade finishes, NemoClaw re-probes the running daemon's `/api/version` and fails the run if the daemon still reports below the minimum.
Fresh installs skip this re-probe because the bundled installers ship a daemon at or above the minimum.
On WSL, the wizard can use, start, restart, or install Ollama on the Windows host through PowerShell interop.

### Linux Install Modes

On native Linux, the install path picks between a system install (under `/usr/local`, via the official `https://ollama.com/install.sh`) and a sudo-free user-local install (under `${HOME}/.local`).
NemoClaw selects the mode automatically:

- Running as root or with passwordless sudo (`sudo -n true` returns 0) selects the system install.
- A non-interactive run (`NEMOCLAW_NON_INTERACTIVE=1` or no TTY on stdin) without passwordless sudo selects the user-local install.
  This is the path that lets headless hosts complete onboarding without prompting for a sudo password.
- An interactive shell without passwordless sudo selects the system install and lets the official installer prompt for the password as usual.

Override the detection with `NEMOCLAW_OLLAMA_INSTALL_MODE=system` or `NEMOCLAW_OLLAMA_INSTALL_MODE=user`.

The user-local install replicates only the binary extraction step of the official installer.
It downloads the release tarball, extracts it to `${HOME}/.local`, and launches `${HOME}/.local/bin/ollama serve` once.
It does not configure a systemd service, does not create the `ollama` system user, and does not install CUDA drivers, so the daemon must be relaunched manually after a reboot.
NemoClaw also prints a one-line `PATH` hint if `${HOME}/.local/bin` is not already on your `PATH`; you can add `export PATH="${HOME}/.local/bin:$PATH"` to your shell profile to invoke `ollama` directly.

Both modes rely on `zstd` for archive extraction. On Debian and Ubuntu, the system path uses `sudo apt-get` to install `zstd` automatically and explains the prompt before continuing.
The user-local path cannot bootstrap system packages without elevation, so if `zstd` is missing it prints per-distro install hints and exits — install `zstd` manually, then rerun onboarding.

Run the onboard wizard.

```console
$ nemoclaw onboard
```

Select **Local Ollama** from the provider list.
NemoClaw lists installed models or offers starter models if none are installed.
On hosts where the larger starter models fit the currently available GPU memory, the starter list includes `qwen3.6:35b` and selects it by default.
When another GPU workload is using most of the memory at onboard time, NemoClaw downgrades the menu to the largest model that still fits.
It pulls the selected model, loads it into memory, and validates it before continuing.
When Ollama reports a loaded-model context length, NemoClaw uses that value for the `contextWindow` baked into `openclaw.json` unless you set `NEMOCLAW_CONTEXT_WINDOW` yourself.
If the selected model declares that it does not support tool calling, onboarding stops with guidance to choose a model whose `ollama show <model>` capabilities include `tools`.
The validation also requires structured chat-completions tool calls.
If the model leaks tool-call JSON as plain message text, onboarding stops so you can choose a model that returns tool calls in the expected response field.
On WSL, if you choose the Windows-host Ollama path, NemoClaw uses `host.docker.internal:11434` and pulls missing models through the Ollama HTTP API instead of requiring the `ollama` CLI inside WSL.

### WSL with Windows-Host Ollama

When NemoClaw runs inside WSL, the provider menu can include Windows-host Ollama actions:

- Use Ollama on Windows host when the Windows daemon is already reachable.
- Restart Ollama on Windows host when the daemon is installed but only bound to Windows loopback.
- Start Ollama on Windows host when Ollama is installed but not running.
- Install Ollama on Windows host when Windows does not have Ollama installed.

The install and restart paths set `OLLAMA_HOST=0.0.0.0:11434` on the Windows side so Docker and WSL can reach the daemon through `host.docker.internal`.
After an install or restart action, NemoClaw relaunches Ollama from the detected Windows tray app or verified `ollama.exe` path and waits until `host.docker.internal:11434` responds.

If the HTTP endpoint is not reachable yet, NemoClaw also checks for the Windows `ollama.exe` process through PowerShell interop so it can offer a start or restart action instead of hiding the Windows-host path.
If the daemon does not become reachable, onboarding prints PowerShell commands you can run to inspect the Windows-side process and port state. Use one Ollama instance on port `11434` at a time.
If both WSL and Windows-host Ollama are running, pick the intended menu entry during onboarding so NemoClaw validates and pulls models against the right daemon.

**Warning:**

Ollama is convenient for local chat, but some model/template combinations can
return tool calls as plain text under realistic agent load. If the TUI shows raw
JSON such as `{"name":"memory_search","arguments":{...}}` instead of running a
tool, switch to vLLM with `--enable-auto-tool-choice` and the correct
`--tool-call-parser`. See [Tool-Calling Reliability](references/tool-calling-reliability.md).

### Authenticated Reverse Proxy

On non-WSL hosts, NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated reverse proxy on `0.0.0.0:11435`.
The native install/start paths also reset NemoClaw-managed systemd launches to the loopback binding.
Containers and other hosts on the local network reach Ollama only through the
proxy, which validates a Bearer token before forwarding requests.
On that native path, NemoClaw never exposes Ollama without authentication.

WSL Ollama paths do not use this proxy.
Windows-host Ollama uses the Windows daemon through `host.docker.internal`.

For non-WSL Ollama setups, the onboard wizard manages the proxy automatically:

- Generates a random 24-byte token on first run and stores it in
  `~/.nemoclaw/ollama-proxy-token` with `0600` permissions.
- Starts the proxy after Ollama and verifies it before continuing.
- Cleans up stale proxy processes from previous runs.
- Probes the sandbox Docker network path to the proxy before committing the inference route.
- Stops matching proxy processes during uninstall before deleting NemoClaw state.
- Reuses the persisted token after a host reboot so you do not need to re-run
  onboard.

On native Linux hosts, a firewall can allow the host proxy health check while still blocking sandbox containers on the OpenShell Docker bridge.
When the sandbox-side proxy probe fails with a TCP error, onboarding exits before it saves the inference route and prints a command like:

```console
$ sudo ufw allow from <openshell-docker-subnet> to any port 11435 proto tcp
$ nemoclaw onboard
```

If the probe cannot run, for example because Docker Desktop or WSL uses a different host routing model, onboarding continues and relies on the regular proxy health check.

The sandbox provider is configured to use proxy port `11435` with the generated
token as its `OPENAI_API_KEY` credential.
OpenShell's L7 proxy injects the token at egress, so the agent inside the
sandbox never sees the token directly.

All proxy endpoints require the Bearer token, including `GET /api/tags`.
Internal health and reachability checks run via the proxy treat any HTTP
response (including `401`) as proof the proxy is alive — they only fail
when nothing answers at all.

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
If `NEMOCLAW_MODEL` names a known bootstrap model (for example `qwen3.6:35b`) that does not fit the host's currently available GPU memory, NemoClaw warns and falls back to the largest known model that does fit.
Unknown or custom tags (any value the bootstrap registry has not seen) are still passed through; the Ollama runner validates the choice itself.

`--yes` (or `NEMOCLAW_YES=1`) authorises the Ollama model download without an interactive confirmation prompt.
Under `--non-interactive`, `--yes` (or `NEMOCLAW_YES=1`) is required to authorise the download — onboard exits otherwise, since it cannot prompt.
Run onboard without `--non-interactive` to get the interactive `[y/N]` prompt that shows the model size before downloading.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |
| `NEMOCLAW_YES` | Set to `1` to auto-accept the model-download confirmation prompt. Optional. |

## OpenAI-Compatible Server

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
If a reasoning model returns only reasoning content before producing a final answer, NemoClaw retries the smoke request with a larger response budget.
Route, configuration, and authentication failures still fail immediately.

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
Refer to [Switch Inference Models](references/switch-inference-providers.md) for details.

## Anthropic-Compatible Server

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

## vLLM

When vLLM is already running on `localhost:8000`, NemoClaw can detect it automatically and query the `/v1/models` endpoint to determine the loaded model.
On supported Linux hosts with NVIDIA GPUs, the onboard wizard can also install or start a managed vLLM container for you.

For an already-running vLLM server, run `nemoclaw onboard` and select **Local vLLM [experimental]** from the provider list.

```console
$ nemoclaw onboard
```

If vLLM is already running, NemoClaw detects the running model and validates the endpoint.
If vLLM is not running and your host matches a DGX Spark or DGX Station managed profile, NemoClaw shows the **Install vLLM** or **Start vLLM** entry by default.
Generic Linux NVIDIA GPU hosts still require `NEMOCLAW_EXPERIMENTAL=1` or `NEMOCLAW_PROVIDER=install-vllm` before the managed entry appears.
NemoClaw pulls the vLLM image, downloads model weights into `~/.cache/huggingface`, starts the `nemoclaw-vllm` container on `localhost:8000`, and prints progress markers while the model loads.
The first run can take 10 to 30 minutes.
Later runs reuse the cached image and model weights.

Managed vLLM uses these profiles:

| Host profile | Default model |
|---|---|
| DGX Spark | `Qwen/Qwen3.6-27B-FP8` |
| DGX Station | `Qwen/Qwen3.6-27B-FP8` |
| Linux with an NVIDIA GPU | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` |

**Note:**

NemoClaw forces the `chat/completions` API path for vLLM.
The vLLM `/v1/responses` endpoint does not run the `--tool-call-parser`, so tool calls arrive as raw text.

### Non-Interactive Setup

Use an already-running vLLM server:

```console
$ NEMOCLAW_PROVIDER=vllm \
  nemoclaw onboard --non-interactive
```

Install or start managed vLLM when a supported profile is detected.
On DGX Spark and DGX Station, `NEMOCLAW_PROVIDER=install-vllm` is enough for non-interactive runs; add `NEMOCLAW_EXPERIMENTAL=1` on generic Linux NVIDIA GPU hosts.

```console
$ NEMOCLAW_PROVIDER=install-vllm \
  nemoclaw onboard --non-interactive
```

NemoClaw records the model returned by vLLM's `/v1/models` endpoint.
Start vLLM with the model you want before onboarding if you manage the server yourself.

### Override the Managed-vLLM Model

Managed vLLM serves the profile default unless you select a different registry entry.
Export `NEMOCLAW_VLLM_MODEL=<slug>` before invoking the installer to choose a different model from the registry.
NemoClaw uses the matching `vllm serve` flags, including the reasoning parser, tool-call parser, and `--max-model-len`.
Recognised slugs:

| Slug | Hugging Face model | Notes |
|---|---|---|
| `qwen3.6-27b` | `Qwen/Qwen3.6-27B-FP8` | Default on DGX Spark and DGX Station profiles |
| `nemotron-3-nano-4b` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | Default on the generic Linux + NVIDIA GPU profile |
| `deepseek-r1-distill-70b` | `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` | Gated. Requires Hugging Face license acceptance |

The slug is case-insensitive; the full Hugging Face id is also accepted.
An unrecognised value fails fast with a list of valid slugs.

Gated models require a Hugging Face token; export it before onboarding so NemoClaw can forward it into the managed vLLM container:

```console
$ export HF_TOKEN=<your-hf-token>
$ NEMOCLAW_PROVIDER=install-vllm \
  NEMOCLAW_VLLM_MODEL=deepseek-r1-distill-70b \
  nemoclaw onboard --non-interactive
```

`HUGGING_FACE_HUB_TOKEN` is accepted as an alternative.
The token check runs on the host before any docker pull, so a missing or empty token aborts onboarding before bandwidth is spent on a 401.

## NVIDIA NIM (Experimental)

NemoClaw can pull, start, and manage a NIM container on hosts with a NIM-capable NVIDIA GPU.

Set the experimental flag and run onboard.

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local NVIDIA NIM [experimental]** from the provider list.
NemoClaw filters available models by GPU VRAM, pulls the NIM container image, starts it, and waits for it to become healthy before continuing.
On hosts with mixed NVIDIA GPU models, the preflight summary shows each detected GPU model and the total VRAM so you can confirm which device class the model selection used.

NIM container images are hosted on `nvcr.io` and require NGC registry authentication before `docker pull` succeeds.
If Docker is not already logged in to `nvcr.io`, onboard prompts for an [NGC API key](https://org.ngc.nvidia.com/setup/api-key) and runs `docker login nvcr.io` over `--password-stdin` so the key is never written to disk or shell history.
The prompt masks the key during input and retries once on a bad key before failing.
In non-interactive mode, onboard exits with login instructions if Docker is not already authenticated; run `docker login nvcr.io` yourself, then re-run `nemoclaw onboard --non-interactive`.
If `NGC_API_KEY` or `NVIDIA_API_KEY` is already exported, NemoClaw passes it into the managed NIM container through the process environment instead of command-line arguments.
If the NIM container exits before the health endpoint becomes ready, onboarding stops early and prints the last container log lines.

**Note:**

NIM uses vLLM internally.
The same `chat/completions` API path restriction applies.

### Non-Interactive Setup

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=nim \
  nemoclaw onboard --non-interactive
```

To select a specific model, set `NEMOCLAW_MODEL`.

## Timeout Configuration

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

`NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` only governs the inference-server validation probe.
The post-create readiness wait (image build, gateway upload, in-sandbox boot) has its own budget, `NEMOCLAW_SANDBOX_READY_TIMEOUT`, also defaulting to 180 seconds.
On hosts where the sandbox image takes minutes to build or upload — large quantised models, DGX Station first runs, or remote VMs over a slow link — raise both together:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ export NEMOCLAW_SANDBOX_READY_TIMEOUT=600
$ nemoclaw onboard
```

If onboard ends with `Sandbox '<name>' was created but did not become ready within 180s`, refer to Troubleshooting (use the `nemoclaw-user-reference` skill).

## Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.
For Local Ollama, status also checks the authenticated proxy when a proxy token is available.
If `Inference` is healthy but `Inference (auth proxy)` is not, rerun onboarding to repair the proxy path that sandbox requests use.

## Switch Models at Runtime

You can change the model without re-running onboard.
Refer to [Switch Inference Models](references/switch-inference-providers.md) for the full procedure.

For compatible endpoints, the command is:

```console
$ nemoclaw inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), pass the new provider to `nemoclaw inference set`.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/set-up-sub-agent.md](references/set-up-sub-agent.md)** when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model.
- **[references/tool-calling-reliability.md](references/tool-calling-reliability.md)** — Explains Ollama tool-call leak symptoms, when vLLM with a tool-call parser is recommended, and how to repoint NemoClaw to a parser-aware local endpoint.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.

## Related Skills

- [Inference Options](references/inference-options.md) for the full list of providers available during onboarding.
- [Tool-Calling Reliability](references/tool-calling-reliability.md) for diagnosing raw JSON tool-call output with local models.
- [Switch Inference Models](references/switch-inference-providers.md) for runtime model switching.
- `nemoclaw-user-get-started` — Quickstart (use the `nemoclaw-user-get-started` skill) for first-time installation
