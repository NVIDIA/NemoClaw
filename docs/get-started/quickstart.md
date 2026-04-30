---
title:
  page: "NemoClaw Quickstart with OpenClaw"
  nav: "Quickstart with OpenClaw"
description:
  main: "Install NemoClaw, launch a sandbox, and run your first agent prompt."
  agent: "Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time."
keywords: ["nemoclaw quickstart", "install nemoclaw openclaw sandbox"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "inference_routing", "nemoclaw"]
content:
  type: get_started
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Quickstart with OpenClaw

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

:::{note}
Make sure you have completed reviewing the [Prerequisites](prerequisites.md) before following this guide.
:::

## Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

:::{note}
NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.
:::

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer might not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

:::{note}
The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
This is a build-time setting baked into the sandbox image, not a runtime knob.
If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.
:::

### Respond to the Onboard Wizard

After the installer launches `nemoclaw onboard`, the wizard runs preflight checks, starts or reuses the OpenShell gateway, and asks for an inference provider, sandbox name, optional web search, optional messaging channels, and network policy presets.
At any prompt, press Enter to accept the default shown in `[brackets]`, type `back` to return to the previous prompt, or type `exit` to quit.
If existing sandbox sessions are running, the installer warns before onboarding because the setup can rebuild or upgrade sandboxes after the new sandbox launches.

The inference provider prompt presents a numbered list.

```text
  1) NVIDIA Endpoints
  2) OpenAI
  3) Other OpenAI-compatible endpoint
  4) Anthropic
  5) Other Anthropic-compatible endpoint
  6) Google Gemini
  7) Local Ollama (localhost:11434)
  Choose [1]:
```

Pick the option that matches where you want inference traffic to go, then expand the matching helper below for the follow-up prompts and the API key environment variable to set.
For the full list of providers and validation behavior, refer to [Inference Options](../inference/inference-options.md).
Local Ollama appears only when NemoClaw detects Ollama on the host.

:::{tip}
Export the API key before launching the installer so the wizard does not have to ask for it.
For example, run `export NVIDIA_API_KEY=<your-key>` before `curl ... | bash`.
If you entered a key incorrectly, refer to [Reset a Stored Credential](#reset-a-stored-credential) to clear and re-enter it.
:::

:::{dropdown} Option 1: NVIDIA Endpoints
:icon: server

Routes inference to models hosted on [build.nvidia.com](https://build.nvidia.com).

Use `NVIDIA_API_KEY` for the API key. Get one from the [NVIDIA build API keys page](https://build.nvidia.com/settings/api-keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, press Enter (or type `1`) to select **NVIDIA Endpoints**.
2. At the `NVIDIA_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model from the list (for example, **Nemotron 3 Super 120B**, **GLM-5.1**, **MiniMax M2.5**, or **GPT-OSS 120B**), or pick **Other...** to enter any model ID from the [NVIDIA Endpoints catalog](https://build.nvidia.com).

NemoClaw validates the model against the catalog API before creating the sandbox.

:::{tip}
Use this option for Nemotron and other models hosted on `build.nvidia.com`. If you run NVIDIA Nemotron from a self-hosted NIM, an enterprise gateway, or any other endpoint, choose **Option 3** instead, since all Nemotron models expose OpenAI-compatible APIs.
:::
:::

:::{dropdown} Option 2: OpenAI
:icon: server

Routes inference to the OpenAI API at `https://api.openai.com/v1`.

Use `OPENAI_API_KEY` for the API key. Get one from the [OpenAI API keys page](https://platform.openai.com/api-keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `2` to select **OpenAI**.
2. At the `OPENAI_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model (for example, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, or `gpt-5.4-pro-2026-03-05`), or pick **Other...** to enter any OpenAI model ID.
:::

:::{dropdown} Option 3: Other OpenAI-Compatible Endpoint
:icon: link-external

Routes inference to any server that implements `/v1/chat/completions`, including OpenRouter, LocalAI, llama.cpp, vLLM behind a proxy, and any compatible gateway.

Use `COMPATIBLE_API_KEY` for the API key. Set it to whatever credential your endpoint expects. If your endpoint does not require auth, use any non-empty placeholder.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `3` to select **Other OpenAI-compatible endpoint**.
2. At the `OpenAI-compatible base URL` prompt, enter the provider's base URL. Find the exact value in your provider's API documentation. NemoClaw appends `/v1` automatically, so leave that suffix off.
3. At the `COMPATIBLE_API_KEY:` prompt, paste your key if it is not already exported.
4. At the `Other OpenAI-compatible endpoint model []:` prompt, enter the model ID exactly as it appears in your provider's model catalog.

For example, when you use NVIDIA's OpenAI-compatible inference endpoint, enter `https://inference-api.nvidia.com` as the base URL and the model ID your endpoint exposes, such as `openai/openai/gpt-5.5`.

NemoClaw sends a real inference request to validate the endpoint and model.
If the endpoint does not return the streaming events OpenClaw needs from the Responses API, NemoClaw falls back to the chat completions API and configures OpenClaw to use `openai-completions`.

:::{tip}
NVIDIA Nemotron models expose OpenAI-compatible APIs, so this option is the right choice for any Nemotron deployment that does not live on `build.nvidia.com`. Common examples include a self-hosted NIM container, an enterprise NVIDIA AI Enterprise gateway, or a vLLM/SGLang server running Nemotron weights. Point the base URL at your endpoint and enter the Nemotron model ID exactly as your server reports it.
:::
:::

:::{dropdown} Option 4: Anthropic
:icon: server

Routes inference to the Anthropic Messages API at `https://api.anthropic.com`.

Use `ANTHROPIC_API_KEY` for the API key. Get one from the [Anthropic console keys page](https://console.anthropic.com/settings/keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `4` to select **Anthropic**.
2. At the `ANTHROPIC_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model (for example, `claude-sonnet-4-6`, `claude-haiku-4-5`, or `claude-opus-4-6`), or pick **Other...** to enter any Claude model ID.
:::

:::{dropdown} Option 5: Other Anthropic-Compatible Endpoint
:icon: link-external

Routes inference to any server that implements the Anthropic Messages API at `/v1/messages`, including Claude proxies, Bedrock-compatible gateways, and self-hosted Anthropic-compatible servers.

Use `COMPATIBLE_ANTHROPIC_API_KEY` for the API key. Set it to whatever credential your endpoint expects.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `5` to select **Other Anthropic-compatible endpoint**.
2. At the `Anthropic-compatible base URL` prompt, enter the proxy or gateway's base URL from its documentation.
3. At the `COMPATIBLE_ANTHROPIC_API_KEY:` prompt, paste your key if it is not already exported.
4. At the `Other Anthropic-compatible endpoint model []:` prompt, enter the model ID exactly as it appears in your gateway's model catalog.
:::

:::{dropdown} Option 6: Google Gemini
:icon: server

Routes inference to Google's OpenAI-compatible Gemini endpoint at `https://generativelanguage.googleapis.com/v1beta/openai/`.

Use `GEMINI_API_KEY` for the API key. Get one from [Google AI Studio API keys](https://aistudio.google.com/app/apikey).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `6` to select **Google Gemini**.
2. At the `GEMINI_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [5]:` prompt, pick a curated model (for example, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, or `gemini-2.5-flash-lite`), or pick **Other...** to enter any Gemini model ID.
:::

:::{dropdown} Option 7: Local Ollama
:icon: cpu

Routes inference to a local Ollama instance on `localhost:11434`. This option only appears when Ollama is installed or running on the host.

No API key is required. NemoClaw generates a token and starts an authenticated proxy so containers can reach Ollama without exposing it to your network.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `7` to select **Local Ollama**.
2. At the `Choose model [1]:` prompt, pick from **Ollama models** if any are already installed. If none are installed, pick a **starter model** to pull and load now, or pick **Other...** to enter any Ollama model ID.

For setup details, including GPU recommendations and starter model choices, refer to [Use a Local Inference Server](../inference/use-local-inference.md).

:::{warning}
Ollama binds to `0.0.0.0` so the sandbox can reach it through Docker. On public WiFi, any device on the same network can send prompts to your GPU through the Ollama API. Refer to CNVD-2025-04094 and CVE-2024-37032.
:::
:::

:::{dropdown} Experimental: Local NIM and Local vLLM
:icon: beaker

These options appear when `NEMOCLAW_EXPERIMENTAL=1` is set and the prerequisites are met.

- **Local NVIDIA NIM** requires a NIM-capable GPU. NemoClaw pulls and manages a NIM container.
- **Local vLLM** requires a vLLM server already running on `localhost:8000`. NemoClaw auto-detects the loaded model.

For setup, refer to [Use a Local Inference Server](../inference/use-local-inference.md).
:::

### Review the Configuration Before the Sandbox Build

After you enter the sandbox name, the wizard prints a review summary and asks for final confirmation before registering the provider, prompting for optional integrations, and building the sandbox image.
For example, if you picked an OpenAI-compatible endpoint, the summary looks like the following:

```text
  ──────────────────────────────────────────────────
  Review configuration
  ──────────────────────────────────────────────────
  Provider:      compatible-endpoint
  Model:         openai/openai/gpt-5.5
  API key:       COMPATIBLE_API_KEY (staged for OpenShell gateway registration)
  Web search:    disabled
  Messaging:     none
  Sandbox name:  my-gpt-claw
  Note:          Sandbox build takes ~6 minutes on this host.
  ──────────────────────────────────────────────────
  Web search and messaging channels will be prompted next.
  Apply this configuration? [Y/n]:
```

The default is `Y`, so you can press Enter once to continue. Answer `n` to abort cleanly, fix the entries, and re-run `nemoclaw onboard`.

Non-interactive runs (`NEMOCLAW_NON_INTERACTIVE=1`) print the summary for log clarity but skip the prompt.

### Configure Web Search and Messaging

After you confirm the summary, NemoClaw registers the selected provider with the OpenShell gateway and sets the `inference.local` route.
The wizard then asks whether to enable Brave Web Search.
If you enable it, enter a Brave Search API key when prompted.

The wizard also offers messaging channels such as Telegram, Discord, and Slack.
Press a channel number to toggle it, then press Enter to continue.
If you select a channel, NemoClaw validates the token format before it bakes the channel configuration into the sandbox.
For example, Slack bot tokens must start with `xoxb-`.

### Choose Network Policy Presets

After the sandbox image builds and OpenClaw starts inside the sandbox, NemoClaw asks which network policy tier to apply.
The default **Balanced** tier includes common development presets such as npm, PyPI, Hugging Face, Homebrew, and Brave Search.
Use the arrow keys or `j` and `k` to move, Space to select, and Enter to confirm.

The preset selector lets you include more destinations, such as GitHub, Jira, Slack, Telegram, or local inference.
Press `r` to toggle a selected preset between read-only and read-write when the preset supports both modes.

When the install completes, a summary confirms the running environment.
The `Model` and provider line reflects the inference option you picked during onboarding.
The example below shows the result if you picked an OpenAI-compatible endpoint during onboarding.

```text
──────────────────────────────────────────────────
Sandbox      my-gpt-claw (Landlock + seccomp + netns)
Model        openai/openai/gpt-5.5 (Other OpenAI-compatible endpoint)
──────────────────────────────────────────────────
Run:         nemoclaw my-gpt-claw connect
Status:      nemoclaw my-gpt-claw status
Logs:        nemoclaw my-gpt-claw logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

If you picked a different option, the `Model` line shows that provider's model and label instead. For example, you might see `gpt-5.4 (OpenAI)`, `claude-sonnet-4-6 (Anthropic)`, `gemini-2.5-flash (Google Gemini)`, `llama3.1:8b (Local Ollama)`, or `<your-model> (Other OpenAI-compatible endpoint)`.

## Open the OpenClaw UI in a Browser

The onboard wizard starts a background port forward to the sandbox dashboard, then prints a tokenized URL in the install summary.
The default host port is `18789`.
If that port is already taken, NemoClaw uses the next free dashboard port, such as `18790`, and prints that port in the final URL.

```text
──────────────────────────────────────────────────
OpenClaw UI (tokenized URL; treat it like a password; save it now - it will not be printed again)
Port 18790 must be forwarded before opening these URLs.
Dashboard: http://127.0.0.1:18790/#token=<auth-token>
──────────────────────────────────────────────────
```

Open the printed URL in your browser.
The `#token=<auth-token>` fragment authenticates the browser to the sandbox gateway, so save the URL securely and treat it like a password.
NemoClaw prints the token only once.

### Restart the Port Forward

If the forward stopped, or the installer reported that no active forward was found and the URL does not load, restart it manually with the port from the install summary.

```console
$ openshell forward start --background <dashboard-port> my-gpt-claw
```

To list active forwards across all sandboxes, run the following command.

```console
$ openshell forward list
```

### Run Multiple Sandboxes

Each sandbox needs its own dashboard port, since `openshell forward` refuses to bind a port that another sandbox is already using.
When the default port is already held by another sandbox, `nemoclaw onboard` scans ports `18789` through `18799` and uses the next free port.

```console
$ nemoclaw onboard                                      # first sandbox uses 18789
$ nemoclaw onboard                                      # second sandbox uses the next free port, such as 18790
```

To choose a specific port, pass `--control-ui-port`:

```console
$ nemoclaw onboard --control-ui-port 19000
```

You can also set `CHAT_UI_URL` or `NEMOCLAW_DASHBOARD_PORT` before onboarding:

```console
$ CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

For full details on port conflicts and overrides, refer to [Port already in use](../reference/troubleshooting.md#port-already-in-use).

### Open the UI from a Remote Host

If NemoClaw is running on a remote GPU instance and you want to open the UI from a laptop, refer to [Remote Dashboard Access](../deployment/deploy-to-remote-gpu.md#remote-dashboard-access). Set `CHAT_UI_URL` to the origin the browser uses before running onboard, so the gateway's CORS allowlist accepts the remote browser.

## Chat with the Agent from the Terminal

If you prefer a terminal-based chat, connect to the sandbox and use the OpenClaw CLI.

```bash
nemoclaw my-assistant connect
```

In the sandbox shell, open the OpenClaw terminal UI and start a chat.

```bash
openclaw tui
```

Alternatively, send a single message and print the response.

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

## Reconfigure or Recover

Recover from a misconfigured sandbox without re-running the full onboard wizard or destroying workspace state.

### Change Inference Model or API

Change the active model or provider at runtime without rebuilding the sandbox:

```console
$ openshell inference set -g nemoclaw --model <model> --provider <provider>
```

Refer to [Switch inference providers](../inference/switch-inference-providers.md) for provider-specific model IDs and API compatibility notes.

### Reset a Stored Credential

If a provider credential was entered incorrectly during onboarding, clear the gateway-registered value and re-enter it on the next onboard run:

```console
$ nemoclaw credentials list                # see which providers are registered
$ nemoclaw credentials reset <PROVIDER>    # clear a single provider, for example nvidia-prod
$ nemoclaw onboard                         # re-run to re-enter the cleared provider
```

The credentials command is documented in full at [`nemoclaw credentials reset <PROVIDER>`](../reference/commands.md#nemoclaw-credentials-reset-provider).

### Rebuild a Sandbox While Preserving Workspace State

If you changed the underlying Dockerfile, upgraded OpenClaw, or want to pick up a new base image without losing your sandbox's workspace files, use `rebuild` instead of destroying and recreating:

```console
$ nemoclaw <sandbox-name> rebuild
```

Rebuild preserves the mounted workspace and registered policies while recreating the container. Refer to [`nemoclaw <name> rebuild`](../reference/commands.md#nemoclaw-name-rebuild) for flag details.

### Add a Network Preset After Onboarding

Apply an additional preset (for example, Telegram or GitHub) to a running sandbox without re-onboarding:

```console
$ nemoclaw <sandbox-name> policy-add
```

Refer to [`nemoclaw <name> policy-add`](../reference/commands.md#nemoclaw-name-policy-add) for usage details and flags.

## Update to the Latest Version

When a new NemoClaw release becomes available, update the `nemoclaw` CLI on your host and check existing sandboxes for stale agent/runtime versions.

### Update the NemoClaw CLI

Re-run the installer.
Before it onboards anything, the installer calls [`nemoclaw backup-all`](../reference/commands.md#nemoclaw-backup-all) automatically, storing a snapshot of each running sandbox in `~/.nemoclaw/rebuild-backups/` as a safety net.

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

### Upgrade sandboxes with stale agent and runtime versions

The installer checks registered sandboxes after onboarding succeeds and runs `nemoclaw upgrade-sandboxes --auto` for stale running sandboxes. Use `upgrade-sandboxes` directly to verify the result, rebuild when you skipped the installer or onboarding step, or handle sandboxes that were stopped or could not be version-checked. The upgrade flow is non-destructive by default because NemoClaw preserves manifest-defined workspace state, but a manual snapshot before any major upgrade gives you a state restore point.

**Safe upgrade flow:**

```console
$ nemoclaw <sandbox-name> snapshot create --name pre-upgrade   # optional, recommended
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash          # updates CLI; auto-upgrades stale running sandboxes
$ nemoclaw upgrade-sandboxes --check                            # verify or list remaining stale/unknown sandboxes
$ nemoclaw upgrade-sandboxes                                    # manually rebuild remaining stale running sandboxes
```

For scripted manual rebuilds, use `nemoclaw upgrade-sandboxes --auto` to skip the confirmation prompt.

If the upgraded sandbox needs its workspace state reverted, restore the pre-upgrade snapshot into the running sandbox. This restores saved state directories only; it does not downgrade the sandbox image or agent/runtime:

```console
$ nemoclaw <sandbox-name> snapshot restore pre-upgrade
```

#### What changes during a rebuild

Each rebuild destroys the existing container and creates a new one. NemoClaw protects your data through the same backup-and-restore flow as [`nemoclaw <name> rebuild`](../reference/commands.md#nemoclaw-name-rebuild):

- NemoClaw preserves manifest-defined workspace state. Before deleting the old container, NemoClaw snapshots the state directories defined in the agent manifest (typically `/sandbox/.openclaw/workspace/`) and restores them into the new container. Stored credentials (`~/.nemoclaw/credentials.json`) and registered policy presets live on the host and are re-applied to the new sandbox automatically.
- NemoClaw does not preserve runtime changes outside the workspace state directories. This includes packages installed inside the running container with `apt` or `pip`, files in non-workspace paths, and in-memory or process state. If you have customized the running container at runtime, capture that as `Dockerfile` changes (for `nemoclaw onboard --from`) or a manual `openshell sandbox download` before the rebuild starts.

Aborts before the destroy step are non-destructive. The flow refuses to proceed past preflight if a credential is missing (see below) or past backup if the snapshot fails (with `"Aborting rebuild to prevent data loss"`), so a botched run leaves the original sandbox intact and ready to retry.

See [Backup and Restore](../workspace/backup-restore.md) for the full list of state-preservation guarantees, snapshot retention, and instructions for manual backups when the auto-flow is not enough.

:::{note} If the rebuild aborts with `Missing credential: <KEY>`
The rebuild preflight reads the provider credential recorded by your last `nemoclaw onboard` session. If you have switched providers since onboarding (for example, from a remote API to a local Ollama setup) the preflight may still reference the old key and fail before any destroy step runs.

To recover, re-run `nemoclaw onboard` and select your current provider. This refreshes the session metadata. Your existing container keeps serving traffic until the new image is ready.
:::

## Uninstall

To remove NemoClaw and all resources created during setup, run the CLI's built-in uninstall command:

```bash
nemoclaw uninstall
```

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

`nemoclaw uninstall` runs the version-pinned `uninstall.sh` that shipped with your installed CLI, so it does not fetch anything over the network at uninstall time.

If the `nemoclaw` CLI is missing or broken, fall back to the hosted script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

For a full comparison of the two forms — what they fetch, what they trust, and when to prefer each — see [`nemoclaw uninstall` vs. the hosted `uninstall.sh`](../reference/commands.md#nemoclaw-uninstall-vs-the-hosted-uninstallsh).

## Next Steps

- [NemoHermes Quickstart](quickstart-hermes.md) to launch Hermes instead of the default OpenClaw agent.
- [Switch inference providers](../inference/switch-inference-providers.md) to use a different model or endpoint.
- [Approve or deny network requests](../network-policy/approve-network-requests.md) when the agent tries to reach external hosts.
- [Customize the network policy](../network-policy/customize-network-policy.md) to pre-approve trusted domains.
- [Deploy to a remote GPU instance](../deployment/deploy-to-remote-gpu.md) for always-on operation.
- [Monitor sandbox activity](../monitoring/monitor-sandbox-activity.md) through the OpenShell TUI.
- [Consult the troubleshooting guide](../reference/troubleshooting.md) for common error messages and resolution steps.
