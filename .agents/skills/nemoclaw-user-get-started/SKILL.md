---
name: "nemoclaw-user-get-started"
description: "Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time. Trigger keywords - nemoclaw quickstart, install nemoclaw openclaw sandbox, nemohermes quickstart, hermes agent nemoclaw, run hermes openshell sandbox, nemoclaw prerequisites, nemoclaw supported platforms, nemoclaw hardware software, nemoclaw windows wsl2 setup, nemoclaw install windows docker desktop."
license: "Apache-2.0"
metadata:
  author: "Miyoung Choi <miyoungc@nvidia.com>"
  tags:
    - nemoclaw
    - quickstart
    - installation
    - onboarding
    - openclaw
    - hermes
    - wsl
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Quickstart with OpenClaw

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

**Note:**

Make sure you have completed reviewing the [Prerequisites](references/prerequisites.md) before following this guide.

## Instructions

Use this skill only for **first-time install and first-prompt** flows. Hand off to a sibling skill for ongoing operations.

Follow this fixed sequence. Do not exceed the listed tool budget.

1. **Identify the platform** in one question or by inspection: macOS, Linux, Windows + WSL 2, or remote GPU (Brev / DGX). Do not call any tools yet.
2. **Load at most one reference.** Choose the single reference that matches the user's situation:
   - Verifying hardware/OS support → `references/prerequisites.md`.
   - Windows-specific setup → `references/windows-preparation.md`.
   - Hermes-instead-of-OpenClaw → `references/quickstart-hermes.md`.
   - Detailed wizard walkthrough → `references/quickstart-details.md`.
   - Otherwise → use the inline steps below; do not load any reference.
3. **Walk the user through three phases**, in order, scoped to their platform:
   - **Install** with the installer one-liner from the inline steps.
   - **Onboard** by responding to the wizard (provider, sandbox name, policy tier).
   - **First prompt** via the dashboard URL or `nemoclaw <name> connect` then `openclaw tui`.
4. **Verify and stop.** Point the user at `nemoclaw <name> status` to confirm the sandbox is healthy. For ongoing tasks (rebuild, channels, monitoring) recommend `nemoclaw-user-manage-sandboxes` or `nemoclaw-user-monitor-sandbox` and stop.

Tool budget per invocation: at most **one** Read of a single `references/*.md` file. Do not chain into other references in the same response. If the user's question expands into policy editing, inference switching, or multi-sandbox operations, return the quickstart answer and suggest the appropriate sibling skill rather than calling more tools.

## Examples

**Example 1 — Fresh macOS install.** User says "I just got a new MacBook, how do I try NemoClaw?" Identify platform = macOS. Skip references (inline steps cover this). Provide the `curl ... | bash` installer, walk them through the wizard summary screen, and end with `http://127.0.0.1:18789/` plus `nemoclaw my-sandbox status`.

**Example 2 — Windows user.** User says "Can I run NemoClaw on Windows 11?" Identify platform = Windows. Load `references/windows-preparation.md` exactly once. Cover WSL 2 + Ubuntu + Docker Desktop prep, then return them to the standard install one-liner inside WSL.

**Example 3 — Hermes path.** User says "I want to run Hermes, not OpenClaw, in the sandbox." Identify intent = Hermes. Load `references/quickstart-hermes.md` exactly once. Provide Hermes-specific install + onboard + first-prompt steps. Do not load `quickstart-details.md` in the same turn.

**Example 4 — Out-of-scope handoff.** User says "My sandbox is running but messaging isn't working." Do not load any reference here. Recommend `nemoclaw-user-manage-sandboxes` and stop.

## Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

**Note:**

NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

The piped installer prompts through your terminal. In headless scripts or CI,
pass explicit acceptance to the `bash` side of the pipe:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

If you use nvm or fnm to manage Node.js, the installer might not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

On Linux, the installer checks Docker before it installs NemoClaw.
If Docker is missing, the installer downloads the official Docker convenience script, asks for `sudo`, installs Docker, and starts the Docker service when systemd is available.
If Docker is installed but your current shell cannot use the Docker socket yet, the installer adds your user to the `docker` group when needed and exits with a recovery command.

On macOS, the installer uses the Docker-driver OpenShell gateway path with Docker Desktop or Colima.

```console
$ newgrp docker
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

On DGX Spark, DGX Station, and Windows WSL, an interactive installer offers express install after you accept the third-party software notice.
Express install switches onboarding to non-interactive mode, allows `sudo` password prompts for required host changes, and selects the managed local inference path for that platform.
Unless `NEMOCLAW_POLICY_TIER` is set, it applies sandbox policy in `suggested` mode with the `balanced` tier by default, using the base sandbox policy plus supported package, model, web-search, and local-inference presets.
On WSL, express install selects the Windows-host Ollama setup path.
Set `NEMOCLAW_NO_EXPRESS=1` to skip the express prompt, or set `NEMOCLAW_PROVIDER` before launching the installer when you want to choose a provider yourself.

The installer auto-launches `nemoclaw onboard` when it can locate the freshly-installed binary.
If it cannot locate the binary, or if blocking host preflight checks fail, it does not launch the wizard automatically.
In that case, the installer prints the relevant diagnostics and a `To finish setup, run:` block with the explicit `nemoclaw onboard` command.

**Note:**

The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
This is a build-time setting baked into the sandbox image, not a runtime knob.
If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.

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
  Note:          Sandbox build typically takes 5–15 minutes on this host.
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

The wizard also offers messaging channels such as Telegram, Discord, Slack, WeChat, and WhatsApp.
Press a channel number to toggle it, then press Enter to continue.
If you select a channel, NemoClaw validates the token format before it bakes the channel configuration into the sandbox.
For example, Slack bot tokens must start with `xoxb-`.
WeChat and WhatsApp are experimental.
Review Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill) before enabling them.

### Choose Network Policy Presets

After the sandbox image builds and OpenClaw starts inside the sandbox, NemoClaw asks which network policy tier to apply.
The default **Balanced** tier includes common development presets such as npm, PyPI, Hugging Face, Homebrew, and Brave Search when the selected agent supports web search.
Use the arrow keys or `j` and `k` to move, Space to select, and Enter to confirm.

The preset selector lets you include more destinations, such as GitHub, Jira, Slack, Telegram, or local inference.
Press `r` to toggle a selected preset between read-only and read-write when the preset supports both modes.

When the install completes, a summary confirms the running environment.
Before printing the summary, NemoClaw verifies that the sandbox gateway and dashboard port forward are reachable.
Inference route and messaging bridge checks are reported as warnings when they need more time or additional configuration.
The `Model` and provider line reflects the inference option you picked during onboarding.
The example below shows the result if you picked an OpenAI-compatible endpoint during onboarding.

```text
──────────────────────────────────────────────────
NemoClaw is ready

Sandbox:  my-gpt-claw
Model:    openai/openai/gpt-5.5 (Other OpenAI-compatible endpoint)

Start chatting

  Browser:
    http://127.0.0.1:18789/

  Terminal:
    nemoclaw my-gpt-claw connect
    then run: openclaw tui

Authenticated dashboard URL, if needed:
  nemoclaw my-gpt-claw dashboard-url --quiet

Manage later

  Status:      nemoclaw my-gpt-claw status
  Logs:        nemoclaw my-gpt-claw logs --follow
  Model:       nemoclaw inference set --model <model> --provider <provider> --sandbox my-gpt-claw
  Policies:    nemoclaw my-gpt-claw policy-add
  Credentials: nemoclaw credentials reset <KEY> && nemoclaw onboard
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

If you picked a different option, the `Model` line shows that provider's model and label instead. For example, you might see `gpt-5.4 (OpenAI)`, `claude-sonnet-4-6 (Anthropic)`, `gemini-2.5-flash (Google Gemini)`, `llama3.1:8b (Local Ollama)`, `nvidia-routed (Model Router)`, or `<your-model> (Other OpenAI-compatible endpoint)`.

Load [references/quickstart-details.md](references/quickstart-details.md) for detailed steps on Respond to the Onboard Wizard.

## Run Your First Agent Prompt

You can chat with the agent from the terminal or the browser.

### Open the OpenClaw UI in a Browser to Chat with the Agent

The onboard wizard starts a background port forward to the sandbox dashboard, then prints the dashboard URL in the install summary.
The default host port is `18789`.
If that port is already taken, NemoClaw uses the next free dashboard port, such as `18790`, and prints that port in the final URL.
If the chosen port becomes occupied after the sandbox build starts, onboarding rolls back the newly-created sandbox and asks you to retry instead of printing an unreachable dashboard URL.
The install transcript does not print the gateway token.
If the browser requires authentication, use the `dashboard-url --quiet` command to print a complete URL explicitly.

```text
nemoclaw my-gpt-claw dashboard-url --quiet
```

Open the dashboard URL in your browser.
If the browser asks for authentication, run `nemoclaw my-gpt-claw dashboard-url --quiet` and open the returned URL.
Treat the authenticated URL like a password.

### Chat with the Agent from the Terminal

Connect to the sandbox and use the OpenClaw CLI.

```bash
nemoclaw my-assistant connect
# inside the sandbox:
openclaw tui
```

## References

- **Load [references/quickstart-hermes.md](references/quickstart-hermes.md)** when users ask for Hermes setup, NemoHermes onboarding, or running Hermes inside OpenShell. Installs NemoClaw, selects the Hermes agent, and launches a sandboxed Hermes API endpoint.
- **Load [references/prerequisites.md](references/prerequisites.md)** when verifying prerequisites before installation. Lists the hardware, software, and container runtime requirements for running NemoClaw.
- **Load [references/windows-preparation.md](references/windows-preparation.md)** when preparing a Windows machine for NemoClaw, enabling WSL 2, configuring Docker Desktop for Windows, or troubleshooting a Windows-specific install error. Covers Windows-only preparation steps required before the Quickstart.
- **Load [references/quickstart-details.md](references/quickstart-details.md)** when you need detailed steps for Respond to the Onboard Wizard.

## Related Skills

- `nemoclaw-user-overview` — NemoClaw Overview (use the `nemoclaw-user-overview` skill) to learn what NemoClaw is and its capabilities
