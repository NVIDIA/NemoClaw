---
name: nemoclaw-get-started
description: Installs NemoClaw, launch a sandbox, and run your first agent prompt. Use when inference routing, install nemoclaw openclaw sandbox, nemoclaw, nemoclaw quickstart, nemoclaw quickstart install launch, openclaw, openshell, sandboxing.
---

# Nemoclaw Get Started

Install NemoClaw, launch a sandbox, and run your first agent prompt.

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

For troubleshooting installation or onboarding issues, see the Troubleshooting guide (see the `nemoclaw-reference` skill).

## Related Skills

- `nemoclaw-configure-inference` — Switch inference providers to use a different model or endpoint
- `nemoclaw-manage-policy` — Approve or deny network requests when the agent tries to reach external hosts
- `nemoclaw-deploy-remote` — Deploy to a remote GPU instance for always-on operation
- `nemoclaw-monitor-sandbox` — Monitor sandbox activity through the OpenShell TUI
