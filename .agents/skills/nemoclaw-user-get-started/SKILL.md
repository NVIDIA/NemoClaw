---
name: "nemoclaw-user-get-started"
description: "Lists the hardware, software, and container runtime requirements for running NemoClaw. Use when verifying prerequisites before installation. Trigger keywords - nemoclaw prerequisites, nemoclaw supported platforms, nemoclaw hardware software, nemoclaw quickstart, install nemoclaw openclaw sandbox, nemoclaw windows wsl2 setup, nemoclaw install windows docker desktop."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Prerequisites

## Gotchas

- Ollama binds to `0.0.0.0` so the sandbox can reach it through Docker.

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

> **Note:** Make sure you have completed reviewing the Prerequisites (use the `nemoclaw-user-get-started` skill) before following this guide.

## Step 1: Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

> **Note:** NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer might not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

> **Note:** The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
> This is a build-time setting baked into the sandbox image, not a runtime knob.
> If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.

### Respond to the Onboard Wizard

After the installer launches `nemoclaw onboard`, the wizard walks you through a sandbox name, an inference provider, and a network policy preset.
At any prompt, press Enter to accept the default shown in `[brackets]`, type `back` to return to the previous prompt, or type `exit` to quit.

The inference provider prompt presents a numbered list.

```text
  1) NVIDIA Endpoints
  2) OpenAI
  3) Other OpenAI-compatible endpoint
  4) Anthropic
  5) Other Anthropic-compatible endpoint
  6) Google Gemini
  7) Local Ollama        (only shown when Ollama is detected on the host)
  Choose [1]:
```

Pick the option that matches where you want inference traffic to go, then expand the matching helper below for the follow-up prompts and the API key environment variable to set.
For the full list of providers and validation behavior, refer to Inference Options (use the `nemoclaw-user-configure-inference` skill).

> **Tip:** Export the API key before launching the installer so the wizard does not have to ask for it.
> For example, run `export NVIDIA_API_KEY=<your-key>` before `curl ... | bash`.
> If you entered a key incorrectly, refer to [Reset a Stored Credential](#reset-a-stored-credential) to clear and re-enter it.

:::{dropdown} Option 1: NVIDIA Endpoints
:icon: server

Routes inference to models hosted on [build.nvidia.com](https://build.nvidia.com).

Use `NVIDIA_API_KEY` for the API key. Get one from the [NVIDIA build API keys page](https://build.nvidia.com/settings/api-keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, press Enter (or type `1`) to select **NVIDIA Endpoints**.
2. At the `NVIDIA_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model from the list (for example, **Nemotron 3 Super 120B**, **Kimi K2.5**, **GLM-5**, **MiniMax M2.5**, or **GPT-OSS 120B**), or pick **Other...** to enter any model ID from the [NVIDIA Endpoints catalog](https://build.nvidia.com).

NemoClaw validates the model against the catalog API before creating the sandbox.

> **Tip:** Use this option for Nemotron and other models hosted on `build.nvidia.com`. If you run NVIDIA Nemotron from a self-hosted NIM, an enterprise gateway, or any other endpoint, choose **Option 3** instead, since all Nemotron models expose OpenAI-compatible APIs.
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
4. At the `Other OpenAI-compatible endpoint model []:` prompt, enter the model ID exactly as it appears in your provider's model catalog (for example, `openai/gpt-5.4` on OpenRouter).

NemoClaw sends a real inference request to validate the endpoint and model. NemoClaw forces the chat completions API for compatible endpoints because many backends advertise `/v1/responses` but mishandle the `developer` role used by the Responses API.

> **Tip:** NVIDIA Nemotron models expose OpenAI-compatible APIs, so this option is the right choice for any Nemotron deployment that does not live on `build.nvidia.com`. Common examples include a self-hosted NIM container, an enterprise NVIDIA AI Enterprise gateway, or a vLLM/SGLang server running Nemotron weights. Point the base URL at your endpoint and enter the Nemotron model ID exactly as your server reports it.
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

For setup details, including GPU recommendations and starter model choices, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).

> **Warning:** Ollama binds to `0.0.0.0` so the sandbox can reach it through Docker. On public WiFi, any device on the same network can send prompts to your GPU through the Ollama API. Refer to CNVD-2025-04094 and CVE-2024-37032.
:::

:::{dropdown} Experimental: Local NIM and Local vLLM
:icon: beaker

These options appear when `NEMOCLAW_EXPERIMENTAL=1` is set and the prerequisites are met.

- **Local NVIDIA NIM** requires a NIM-capable GPU. NemoClaw pulls and manages a NIM container.
- **Local vLLM** requires a vLLM server already running on `localhost:8000`. NemoClaw auto-detects the loaded model.

For setup, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
:::

When the install completes, a summary confirms the running environment.
The `Model` and provider line reflects whichever inference option you picked in the wizard.
The example below shows the result if you accept the NVIDIA Endpoints default.

```text
──────────────────────────────────────────────────
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

If you picked a different option, the `Model` line shows that provider's model and label instead. For example, you might see `gpt-5.4 (OpenAI)`, `claude-sonnet-4-6 (Anthropic)`, `gemini-2.5-flash (Google Gemini)`, `llama3.1:8b (Local Ollama)`, or `<your-model> (Other OpenAI-compatible endpoint)`.

## Step 2: Open the OpenClaw UI in a Browser

The onboard wizard automatically starts an SSH port forward from your host's `127.0.0.1:18789` to the sandbox dashboard, then prints a tokenized URL in the install summary.

```text
──────────────────────────────────────────────────
OpenClaw UI (tokenized URL; treat it like a password; save it now - it will not be printed again)
Port 18789 must be forwarded before opening these URLs.
Dashboard: http://127.0.0.1:18789/#token=<auth-token>
──────────────────────────────────────────────────
```

Open that URL in your browser. The `#token=<auth-token>` fragment authenticates the browser to the sandbox gateway, so save the URL securely and treat it like a password. NemoClaw prints the token only once.

### Restart the Port Forward

If the forward stopped (for example, after a reboot) or you opened a new terminal and the URL no longer responds, restart it manually.

```bash
openshell forward start --background 18789 my-assistant
```

To list active forwards across all sandboxes, run the following command.

```bash
openshell forward list
```

### Run Multiple Sandboxes

Each sandbox needs its own dashboard port, since `openshell forward` refuses to bind a port that another sandbox is already using. Override the port with `CHAT_UI_URL` at onboard time — the dashboard port is derived automatically.

```console
$ nemoclaw onboard                                            # first sandbox uses 18789
$ CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard         # second sandbox uses 19000
```

You can also use `NEMOCLAW_DASHBOARD_PORT` directly if you prefer:

```console
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

For full details on port conflicts and overrides, refer to Port already in use (use the `nemoclaw-user-reference` skill).

### Open the UI from a Remote Host

If NemoClaw is running on a remote GPU instance and you want to open the UI from a laptop, refer to Remote Dashboard Access (use the `nemoclaw-user-deploy-remote` skill). Set `CHAT_UI_URL` to the origin the browser uses before running onboard, so the gateway's CORS allowlist accepts the remote browser.

## Step 3: Chat with the Agent from the Terminal

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

## Step 4: Reconfigure or Recover

Recover from a misconfigured sandbox without re-running the full onboard wizard or destroying workspace state.

### Change Inference Model or API

Change the active model or provider at runtime without rebuilding the sandbox:

```console
$ openshell inference set -g nemoclaw --model <model> --provider <provider>
```

Refer to Switch inference providers (use the `nemoclaw-user-configure-inference` skill) for provider-specific model IDs and API compatibility notes.

### Reset a Stored Credential

If an API key was entered incorrectly during onboarding, clear the stored value and re-enter it on the next onboard run:

```console
$ nemoclaw credentials list           # see which keys are stored
$ nemoclaw credentials reset <KEY>    # clear a single key, for example NVIDIA_API_KEY
$ nemoclaw onboard                    # re-run to re-enter the cleared key
```

The credentials command is documented in full at `nemoclaw credentials reset <KEY>` (use the `nemoclaw-user-reference` skill).

### Rebuild a Sandbox While Preserving Workspace State

If you changed the underlying Dockerfile, upgraded OpenClaw, or want to pick up a new base image without losing your sandbox's workspace files, use `rebuild` instead of destroying and recreating:

```console
$ nemoclaw <sandbox-name> rebuild
```

Rebuild preserves the mounted workspace and registered policies while recreating the container. Refer to `nemoclaw <name> rebuild` (use the `nemoclaw-user-reference` skill) for flag details.

### Add a Network Preset After Onboarding

Apply an additional preset (for example, Telegram or GitHub) to a running sandbox without re-onboarding:

```console
$ nemoclaw <sandbox-name> policy-add
```

Refer to `nemoclaw <name> policy-add` (use the `nemoclaw-user-reference` skill) for usage details and flags.

## Step 5: Uninstall

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

For a full comparison of the two forms — what they fetch, what they trust, and when to prefer each — see `nemoclaw uninstall` vs. the hosted `uninstall.sh` (use the `nemoclaw-user-reference` skill).

## References

- **Load [references/prerequisites.md](references/prerequisites.md)** when verifying prerequisites before installation. Lists the hardware, software, and container runtime requirements for running NemoClaw.
- **Load [references/windows-preparation.md](references/windows-preparation.md)** when preparing a Windows machine for NemoClaw, enabling WSL 2, configuring Docker Desktop for Windows, or troubleshooting a Windows-specific install error. Covers Windows-only preparation steps required before the Quickstart.

## Related Skills

- `nemoclaw-user-configure-inference` — Switch inference providers (use the `nemoclaw-user-configure-inference` skill) to use a different model or endpoint
- `nemoclaw-user-manage-policy` — Approve or deny network requests (use the `nemoclaw-user-manage-policy` skill) when the agent tries to reach external hosts
- `nemoclaw-user-deploy-remote` — Deploy to a remote GPU instance (use the `nemoclaw-user-deploy-remote` skill) for always-on operation
- `nemoclaw-user-monitor-sandbox` — Monitor sandbox activity (use the `nemoclaw-user-monitor-sandbox` skill) through the OpenShell TUI
- `nemoclaw-user-reference` — Consult the troubleshooting guide (use the `nemoclaw-user-reference` skill) for common error messages and resolution steps
