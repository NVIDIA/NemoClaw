---
name: "nemoclaw-user-configure-inference"
description: "Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Trigger keywords - nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, switch nemoclaw inference model, change inference runtime, nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing, nemoclaw tool calling, ollama tool calls, vllm tool-call-parser, raw json in tui."
license: "Apache-2.0"
---

# Use a Local Inference Server

## Gotchas

- Ollama is convenient for local chat, but some model/template combinations can return tool calls as plain text under realistic agent load.

## Prerequisites

<AgentOnly variant="openclaw">

- NemoClaw installed. Refer to the Quickstart (use the `nemoclaw-user-get-started` skill) if you have not installed yet.
- NemoClaw installed. Refer to Quickstart with Hermes (use the `nemoclaw-user-get-started` skill) if you have not installed yet.
- A local model server running, or a supported Ollama, vLLM, or NIM setup that the NemoClaw onboard wizard can use, start, or install.

import { AgentOnly } from "../_components/AgentGuide";

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and experimental managed options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Ollama

Ollama is the default local inference option.
The onboard wizard detects Ollama automatically when you have installed it or started it on the host.

If you installed Ollama but have not started it, NemoClaw starts it for you.
On macOS and Linux, the wizard can also offer to install Ollama when it is not present.
When the host Ollama is below the minimum version NemoClaw expects for its starter models (currently `0.7.0`), the wizard surfaces an explicit **Upgrade Ollama** entry in the provider menu instead of silently reusing the older daemon, and the express setup path resolves to that entry.
The wizard inspects both the CLI binary (`ollama --version`) and the locally running daemon (`/api/version` on `:11434`) so the upgrade entry still appears when only one side is stale, for example a fresh user-local binary paired with the original system daemon.
The gate skips Windows-host Ollama reached from WSL through `host.docker.internal`.
The separate **Use / Start / Install Ollama on Windows host** entries handle that case and run their own actions on the Windows side.
On macOS, the wizard runs the platform install or upgrade path with `brew upgrade ollama`.
On Linux, the wizard runs the official `https://ollama.com/install.sh` path.
Upgrades on Linux always take the sudo-driven system path because the sudo-free user-local fallback would leave the existing system daemon on `:11434` serving the stale binary.
If sudo is not available in a non-interactive run, NemoClaw refuses to silently downgrade the path and asks you to rerun interactively or upgrade Ollama manually.
After an upgrade finishes, NemoClaw re-probes the running daemon's `/api/version` and fails the run if the daemon still reports below the minimum.
Fresh installs skip this re-probe because the bundled installers ship a daemon at or above the minimum.
On WSL, the wizard can use, start, restart, or install Ollama on the Windows host through PowerShell interop.

### Linux Install Modes

On native Linux, the install path picks between a system install (under `/usr/local`, using the official `https://ollama.com/install.sh`) and a sudo-free user-local install (under `${HOME}/.local`).
NemoClaw selects the mode automatically:

- Running as root or with passwordless sudo (`sudo -n true` returns 0) selects the system install.
- A non-interactive run (`NEMOCLAW_NON_INTERACTIVE=1` or no TTY on stdin) without passwordless sudo selects the user-local install.
  This is the path that lets headless hosts complete onboarding without prompting for a sudo password.
- An interactive shell without passwordless sudo selects the system install and lets the official installer prompt for the password as usual.

Override the detection with `NEMOCLAW_OLLAMA_INSTALL_MODE=system` or `NEMOCLAW_OLLAMA_INSTALL_MODE=user`.

The user-local install replicates only the binary extraction step of the official installer.
It downloads the release tarball, extracts it to `${HOME}/.local`, and launches `${HOME}/.local/bin/ollama serve` one time.
It does not configure a systemd service, does not create the `ollama` system user, and does not install CUDA drivers, so you must relaunch the daemon manually after a reboot.
NemoClaw also prints a one-line `PATH` hint if `${HOME}/.local/bin` is not already on your `PATH`; you can add `export PATH="${HOME}/.local/bin:$PATH"` to your shell profile to invoke `ollama` directly.

Both modes rely on `zstd` for archive extraction. On Debian and Ubuntu, the system path uses `sudo apt-get` to install `zstd` automatically and explains the prompt before continuing.
The user-local path cannot bootstrap system packages without elevation.
If `zstd` is missing, it prints per-distro install hints and exits.
Install `zstd` manually, then rerun onboarding.

Run the onboard wizard.

```bash
nemoclaw onboard
```

Select **Local Ollama** from the provider list.
NemoClaw lists installed models or offers starter models if you have not installed any.
On hosts where the larger starter models fit the currently available GPU memory, the starter list includes `qwen3.6:35b` and selects it by default.
When another GPU workload is using most of the memory at onboard time, NemoClaw downgrades the menu to the largest model that still fits.
It pulls the selected model, loads it into memory, and validates it before continuing.
When Ollama reports a loaded-model context length, NemoClaw uses that value for the `contextWindow` baked into `openclaw.json` unless you set `NEMOCLAW_CONTEXT_WINDOW` yourself.
If the selected model declares that it does not support tool calling, onboarding stops with guidance to choose a model whose `ollama show <model>` capabilities include `tools`.
The validation also requires structured chat-completions tool calls.
If the model leaks tool-call JSON as plain message text, onboarding stops so you can choose a model that returns tool calls in the expected response field.
If a host-side validation probe times out, NemoClaw retries the Ollama tool-call validation with a larger timeout before failing the setup.
On WSL, if you choose the Windows-host Ollama path, NemoClaw uses `host.docker.internal:11434` and pulls missing models through the Ollama HTTP API instead of requiring the `ollama` CLI inside WSL.

### WSL with Windows-Host Ollama

When NemoClaw runs inside WSL, the provider menu can include Windows-host Ollama actions:

- Use Ollama on Windows host when the Windows daemon is already reachable.
- Restart Ollama on Windows host when you installed the daemon but bound it only to Windows loopback.
- Start Ollama on Windows host when you installed Ollama but have not started it.
- Install Ollama on Windows host when Windows does not have Ollama installed.

The install and restart paths set `OLLAMA_HOST=0.0.0.0:11434` on the Windows side so Docker and WSL can reach the daemon through `host.docker.internal`.
After an install or restart action, NemoClaw relaunches Ollama from the detected Windows tray app or verified `ollama.exe` path and waits until `host.docker.internal:11434` responds.

If the HTTP endpoint is not reachable yet, NemoClaw also checks for the Windows `ollama.exe` process through PowerShell interop so it can offer a start or restart action instead of hiding the Windows-host path.
If the daemon does not become reachable, onboarding prints PowerShell commands you can run to inspect the Windows-side process and port state. Use one Ollama instance on port `11434` at a time.
If both WSL and Windows-host Ollama are running, pick the intended menu entry during onboarding so NemoClaw validates and pulls models against the right daemon.

Windows-host Ollama requires Docker Desktop WSL integration because the sandbox reaches the Windows daemon through Docker Desktop's WSL routing path.
If NemoClaw detects native Docker Engine inside WSL, the provider menu labels Windows-host Ollama actions as requiring Docker Desktop integration.
Selecting one of those actions in the unsupported native Docker topology exits early with a remediation message instead of trying to start or install Ollama on Windows.

<AgentOnly variant="openclaw">
**Warning:**

Ollama is convenient for local chat, but some model/template combinations can
return tool calls as plain text under realistic agent load. If the TUI shows raw
JSON such as `{"name":"memory_search","arguments":{...}}` instead of running a
tool, switch to vLLM with `--enable-auto-tool-choice` and the correct
`--tool-call-parser`. See [Tool-Calling Reliability](references/tool-calling-reliability.md).
</AgentOnly>

### Authenticated Reverse Proxy

On non-WSL hosts, NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated reverse proxy on `0.0.0.0:11435`.
The native install/start paths also reset NemoClaw-managed systemd launches to the loopback binding.
Containers and other hosts on the local network reach Ollama only through the proxy, which validates a Bearer token before forwarding requests.
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

```bash
sudo ufw allow from <openshell-docker-subnet> to any port 11435 proto tcp
nemoclaw onboard
```

If the probe cannot run, for example because Docker Desktop or WSL uses a different host routing model, onboarding continues and relies on the regular proxy health check.

NemoClaw configures the sandbox provider to use proxy port `11435` with the generated token as its `OPENAI_API_KEY` credential.
OpenShell's L7 proxy injects the token at egress, so the agent inside the sandbox never sees the token directly.

All proxy endpoints require the Bearer token, including `GET /api/tags`.
Internal health and reachability checks run through the proxy treat any HTTP response, including `401`, as proof the proxy is alive.
They fail only when nothing answers at all.

If Ollama is already running on a non-loopback address when you start onboard,
the wizard restarts it on `127.0.0.1:11434` so the proxy is the only network
path to the model server.

### GPU Memory Cleanup

When you switch away from Ollama, stop host services, or destroy an Ollama-backed sandbox, NemoClaw asks Ollama to unload currently loaded models from GPU memory.
The cleanup sends `keep_alive: 0` for each model reported by Ollama and runs on a best-effort basis, so shutdown continues if Ollama is already stopped.
This does not delete downloaded model files.

### Non-Interactive Setup

```bash
NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL=qwen3.5:9b \
  nemoclaw onboard --non-interactive --yes
```

If `NEMOCLAW_MODEL` is not set, NemoClaw selects a default model based on available memory.
If `NEMOCLAW_MODEL` names a known bootstrap model (for example `qwen3.6:35b`) that does not fit the host's currently available GPU memory, NemoClaw warns and falls back to the largest known model that does fit.
Unknown or custom tags (any value the bootstrap registry has not seen) are still passed through; the Ollama runner validates the choice itself.
In interactive onboarding, registry-known installed tags that do not fit current GPU memory are filtered out of the installed-model menu.
If none of the installed registry-known tags fit, NemoClaw shows the starter-model choices and warns when even the smallest bootstrap tag may not fit.
After a selected model fails validation, NemoClaw excludes that tag from the next installed-model menu so pressing Enter cannot select the same failing model repeatedly.
When Ollama reports a loaded-model context length below `16384` and `NEMOCLAW_CONTEXT_WINDOW` is unset, NemoClaw raises the baked `contextWindow` to `16384` so the agent prompt and tool definitions fit better than the stock daemon default.
If the initial Ollama validation probe times out during a cold load, NemoClaw retries once with a 300-second probe budget.
This applies beyond DGX Spark, including tight-VRAM dGPU hosts where warm-up can spill from GPU to CPU.

`--yes` (or `NEMOCLAW_YES=1`) authorizes the Ollama model download without an interactive confirmation prompt.
Under `--non-interactive`, include `--yes` (or `NEMOCLAW_YES=1`) to authorize the download.
Onboard exits otherwise because it cannot prompt.
Run onboard without `--non-interactive` to get the interactive `[y/N]` prompt that shows the model size before downloading.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |
| `NEMOCLAW_YES` | Set to `1` to auto-accept the model-download confirmation prompt. Optional. |

## Compatible Local Servers

Use **Other OpenAI-compatible endpoint** for vLLM, TensorRT-LLM, llama.cpp, LocalAI, NIM, SGLang, or another server that implements `/v1/chat/completions`.
For compatible endpoints, NemoClaw uses `/v1/chat/completions` by default because some local backends accept `/v1/responses` but drop system prompts or tool definitions.
Set `NEMOCLAW_PREFERRED_API=openai-responses` only after you have verified that the backend streams the events OpenClaw requires.

For the full compatible-endpoint prompt flow, non-interactive variables, API-path controls, managed vLLM profiles, NIM setup, and timeout settings, refer to [Inference Options](references/inference-options.md#setup-details-for-local-and-compatible-providers).

## Managed vLLM and NIM

NemoClaw can use an already-running vLLM server on `localhost:8000`, start managed vLLM on supported NVIDIA GPU hosts, or manage a local NIM container when `NEMOCLAW_EXPERIMENTAL=1` is set.
Managed vLLM records the model returned by `/v1/models` and uses runtime metadata such as `max_model_len` when available.
NIM uses the same chat-completions API path restriction as vLLM.

For registry slugs, Hugging Face token requirements, NGC login behavior, and non-interactive examples, refer to [Inference Options](references/inference-options.md#setup-details-for-local-and-compatible-providers).

## Verify the Configuration

After onboarding completes, confirm the active provider and model.

```bash
nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.
For Local Ollama, status also checks the authenticated proxy when a proxy token is available.
If `Inference` is healthy but `Inference (auth proxy)` is not, rerun onboarding to repair the proxy path that sandbox requests use.

## Switch Models at Runtime

You can change the model without re-running onboard.
Refer to [Switch Inference Models](references/switch-inference-providers.md) for the full procedure.

For compatible endpoints, the command is:

```bash
nemoclaw inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), pass the new provider to `nemoclaw inference set`.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/set-up-sub-agent.md](references/set-up-sub-agent.md)** when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.
- **[references/tool-calling-reliability.md](references/tool-calling-reliability.md)** — Explains Ollama tool-call leak symptoms, when to use vLLM with a tool-call parser, and how to repoint NemoClaw to a parser-aware local endpoint.

## Related Skills

- [Inference Options](references/inference-options.md) for the full list of providers available during onboarding.
- [Tool-Calling Reliability](references/tool-calling-reliability.md) for diagnosing raw JSON tool-call output with local models.
- [Switch Inference Models](references/switch-inference-providers.md) for runtime model switching.
- `nemoclaw-user-get-started` — Quickstart (use the `nemoclaw-user-get-started` skill) for first-time installation
