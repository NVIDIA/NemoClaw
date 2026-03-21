---
name: nemoclaw-get-started
description: Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when setting up NemoClaw for the first time, onboarding openclaw, or following the quickstart.
---

# Nemoclaw Get Started

Installs NemoClaw, launches a sandbox, and runs the first agent prompt.

> **Note:** NemoClaw is in early preview. APIs, commands, and policies may change between releases.

> **Note:** NemoClaw currently requires a fresh installation of OpenClaw.

## Prerequisites

### Hardware

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 vCPU | 4+ vCPU |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB free | 40 GB free |

### Software

| Dependency | Version |
|------------|---------|
| Linux | Ubuntu 22.04 LTS or later |
| Node.js | 20 or later |
| npm | 10 or later |
| Container runtime | Supported runtime installed and running |
| OpenShell | Installed |

### Container Runtime Support

| Platform | Supported runtimes |
|----------|--------------------|
| Linux | Docker |
| macOS (Apple Silicon) | Colima, Docker Desktop |
| Windows WSL | Docker Desktop (WSL backend) |

## Step 1: Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

When the install completes, a summary confirms the running environment:

```
──────────────────────────────────────────────────
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoint API)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────
```

## Step 2: Connect to the Sandbox

```bash
nemoclaw my-assistant connect
```

This connects you to the sandbox shell `sandbox@my-assistant:~$` where you can run `openclaw` commands.

## Step 3: Chat with the Agent

**OpenClaw TUI** — interactive chat interface:

```bash
openclaw tui
```

**OpenClaw CLI** — single message, full response in terminal:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

### Troubleshooting

If you run into issues during installation or onboarding, refer to the Troubleshooting guide (see the `nemoclaw-reference` skill) for common error messages and resolution steps.

## Related Skills

- `nemoclaw-configure-inference` — Switch inference providers to use a different model or endpoint
- `nemoclaw-manage-policy` — Approve or deny network requests when the agent tries to reach external hosts
- `nemoclaw-deploy-remote` — Deploy to a remote GPU instance for always-on operation
- `nemoclaw-monitor-sandbox` — Monitor sandbox activity through the OpenShell TUI
