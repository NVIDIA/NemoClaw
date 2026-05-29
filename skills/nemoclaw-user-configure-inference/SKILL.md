---
name: "nemoclaw-user-configure-inference"
description: "Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Trigger keywords - nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, switch nemoclaw inference model, change inference runtime, nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, nemoclaw tool calling, ollama tool calls, vllm tool-call-parser, raw json in tui, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing."
license: "Apache-2.0"
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

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps on Non-Interactive Setup.

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

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps on Non-Interactive Setup, Selecting the API Path.

## Anthropic-Compatible Server

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps.

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

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps on Non-Interactive Setup, Override the Managed-vLLM Model.

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

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps on Non-Interactive Setup.

## Timeout Configuration

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps.

## Verify the Configuration

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps.

## Switch Models at Runtime

Load [references/use-local-inference-details.md](references/use-local-inference-details.md) for detailed steps.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/set-up-sub-agent.md](references/set-up-sub-agent.md)** when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model.
- **[references/tool-calling-reliability.md](references/tool-calling-reliability.md)** — Explains Ollama tool-call leak symptoms, when vLLM with a tool-call parser is recommended, and how to repoint NemoClaw to a parser-aware local endpoint.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.
- **Load [references/use-local-inference-details.md](references/use-local-inference-details.md)** when you need detailed steps for Non-Interactive Setup, Selecting the API Path, Anthropic-Compatible Server, and related details.

## Related Skills

- [Inference Options](references/inference-options.md) for the full list of providers available during onboarding.
- [Tool-Calling Reliability](references/tool-calling-reliability.md) for diagnosing raw JSON tool-call output with local models.
- [Switch Inference Models](references/switch-inference-providers.md) for runtime model switching.
- `nemoclaw-user-get-started` — Quickstart (use the `nemoclaw-user-get-started` skill) for first-time installation
