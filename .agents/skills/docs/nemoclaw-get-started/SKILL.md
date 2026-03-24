---
name: nemoclaw-get-started
description: Installs NemoClaw, launch a sandbox, and run your first agent prompt. Use when inference routing, install nemoclaw openclaw sandbox, nemoclaw, nemoclaw quickstart, nemoclaw quickstart install launch, openclaw, openshell, sandboxing.
---

# Nemoclaw Get Started

Install NemoClaw, launch a sandbox, and run your first agent prompt.

> **Alpha software:** NemoClaw is in alpha, available as an early preview since March 16, 2026.
> APIs, configuration schemas, and runtime behavior are subject to breaking changes between releases.
> Do not use this software in production environments.
> File issues and feedback through the GitHub repository as the project continues to stabilize.

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

> **Note:** NemoClaw currently requires a fresh installation of OpenClaw.

### Prerequisites

Check the prerequisites before you start to ensure you have the necessary software and hardware to run NemoClaw.

#### Hardware

| Resource | Minimum        | Recommended      |
|----------|----------------|------------------|
| CPU      | 4 vCPU         | 4+ vCPU          |
| RAM      | 8 GB           | 16 GB            |
| Disk     | 20 GB free     | 40 GB free       |

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline, which buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer. If you cannot add memory, configuring at least 8 GB of swap can work around the issue at the cost of slower performance.

#### Software

| Dependency | Version                          |
|------------|----------------------------------|
| Linux      | Ubuntu 22.04 LTS or later |
| Node.js    | 20 or later |
| npm        | 10 or later |
| Container runtime | Supported runtime installed and running |
| [OpenShell](https://github.com/NVIDIA/OpenShell) | Installed |

#### Container Runtime Support

| Platform | Supported runtimes | Notes |
|----------|--------------------|-------|
| Linux | Docker | Primary supported path today |
| macOS (Apple Silicon) | Colima, Docker Desktop | Recommended runtimes for supported macOS setups |
| macOS | Podman | Not supported yet. NemoClaw currently depends on OpenShell support for Podman on macOS. |
| Windows WSL | Docker Desktop (WSL backend) | Supported target path |

> **💡 Tip**
>
> For DGX Spark, follow the [DGX Spark setup guide](https://github.com/NVIDIA/NemoClaw/blob/main/spark-install.md). It covers Spark-specific prerequisites, such as cgroup v2 and Docker configuration, before running the standard installer.

### Install NemoClaw and Onboard OpenClaw Agent

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

[INFO]  === Installation complete ===
```

### Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

#### Connect to the Sandbox

Run the following command to connect to the sandbox:

```bash
nemoclaw my-assistant connect
```

This connects you to the sandbox shell `sandbox@my-assistant:~$` where you can run `openclaw` commands.

#### OpenClaw TUI

In the sandbox shell, run the following command to open the OpenClaw TUI, which opens an interactive chat interface.

```bash
openclaw tui
```

Send a test message to the agent and verify you receive a response.

> **ℹ️ Note**
>
> The TUI is best for interactive back-and-forth. If you need the full text of a long response such as a large code generation output, use the CLI instead.

#### OpenClaw CLI

In the sandbox shell, run the following command to send a single message and print the response:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

This prints the complete response directly in the terminal and avoids relying on the TUI view for long output.

### Uninstall

To remove NemoClaw and all resources created during setup, in the terminal outside the sandbox, run:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

The script removes sandboxes, the NemoClaw gateway and providers, related Docker images and containers, local state directories, and the global `nemoclaw` npm package. It does not remove shared system tooling such as Docker, Node.js, npm, or Ollama.

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

For example, to skip the confirmation prompt:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash -s -- --yes
```

### Troubleshooting

If you run into issues during installation or onboarding, refer to the Troubleshooting guide (see the `nemoclaw-reference` skill) for common error messages and resolution steps.

## Related Skills

- `nemoclaw-configure-inference` — Switch inference providers to use a different model or endpoint
- `nemoclaw-manage-policy` — Approve or deny network requests when the agent tries to reach external hosts
- `nemoclaw-deploy-remote` — Deploy to a remote GPU instance for always-on operation
- `nemoclaw-monitor-sandbox` — Monitor sandbox activity through the OpenShell TUI
