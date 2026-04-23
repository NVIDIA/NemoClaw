---
name: "nemoclaw-user-get-started"
description: "Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time. Trigger keywords - nemoclaw quickstart, install nemoclaw openclaw sandbox, nemoclaw windows wsl2 setup, nemoclaw install windows docker desktop."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Quickstart: Install, Launch, and Run Your First Agent

## Gotchas

- **OpenShell lifecycle.** For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.

## Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

> **Alpha software:** NemoClaw is in alpha, available as an early preview since March 16, 2026.
> APIs, configuration schemas, and runtime behavior are subject to breaking changes between releases.
> Do not use this software in production environments.
> File issues and feedback through the GitHub repository as the project continues to stabilize.

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

## Step 1: Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

> **Note:** NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

> **Note:** The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
> This is a build-time setting baked into the sandbox image, not a runtime knob.
> If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.

When the install completes, a summary confirms the running environment:

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

## Step 2: Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

```bash
nemoclaw my-assistant connect
```

In the sandbox shell, open the OpenClaw terminal UI and start a chat:

```bash
openclaw tui
```

Alternatively, send a single message and print the response:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

## Step 3: Uninstall

To remove NemoClaw and all resources created during setup, run the uninstall script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

For troubleshooting installation or onboarding issues, see the Troubleshooting guide (use the `nemoclaw-user-reference` skill).

## Step 4: Reconfigure or Recover

Recover from a misconfigured sandbox without re-running the full onboard wizard or destroying workspace state.

### Change inference model or API

Change the active model or provider at runtime without rebuilding the sandbox:

```console
$ openshell inference set -g nemoclaw -m <model> -p <provider>
```

See Switch inference providers (use the `nemoclaw-user-configure-inference` skill) for provider-specific model IDs and API compatibility notes.

### Reset a stored credential

If an API key was entered incorrectly during onboarding, clear the stored value and re-enter it on the next onboard run:

```console
$ nemoclaw credentials list           # see which keys are stored
$ nemoclaw credentials reset <KEY>    # clear a single key, e.g. NVIDIA_API_KEY
$ nemoclaw onboard                    # re-run to re-enter the cleared key
```

The credentials command is documented in full at Commands &rarr; `nemoclaw credentials reset` (use the `nemoclaw-user-reference` skill).

### Rebuild a sandbox while preserving workspace state

If you changed the underlying Dockerfile, upgraded OpenClaw, or want to pick up a new base image without losing your sandbox's workspace files, use `rebuild` instead of destroying and recreating:

```console
$ nemoclaw <sandbox-name> rebuild
```

Rebuild preserves the mounted workspace and registered policies while recreating the container. See Commands &rarr; `nemoclaw <name> rebuild` (use the `nemoclaw-user-reference` skill) for flag details.

### Add a network preset after onboarding

Apply an additional preset (e.g. Telegram, GitHub) to a running sandbox without re-onboarding:

```console
$ nemoclaw <sandbox-name> policy-add
```

See Commands &rarr; `nemoclaw <name> policy-add` (use the `nemoclaw-user-reference` skill) for usage details and flags.

## References

- **Load [references/windows-setup.md](references/windows-setup.md)** when installing NemoClaw on Windows, enabling WSL 2, configuring Docker Desktop for Windows, or troubleshooting a Windows-specific install error. Includes Windows-only prerequisites that must be completed before the Quickstart.

## Related Skills

- `nemoclaw-user-configure-inference` — Switch inference providers (use the `nemoclaw-user-configure-inference` skill) to use a different model or endpoint
- `nemoclaw-user-manage-policy` — Approve or deny network requests (use the `nemoclaw-user-manage-policy` skill) when the agent tries to reach external hosts
- `nemoclaw-user-deploy-remote` — Deploy to a remote GPU instance (use the `nemoclaw-user-deploy-remote` skill) for always-on operation
- `nemoclaw-user-monitor-sandbox` — Monitor sandbox activity (use the `nemoclaw-user-monitor-sandbox` skill) through the OpenShell TUI
