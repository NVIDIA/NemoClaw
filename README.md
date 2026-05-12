<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# 🦞 NVIDIA NemoClaw: Reference Stack for Running OpenClaw in OpenShell

<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](https://github.com/NVIDIA/NemoClaw/blob/main/LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md)
[![Project Status](https://img.shields.io/badge/status-alpha-orange)](https://github.com/NVIDIA/NemoClaw/blob/main/docs/about/release-notes.md)
[![Discord](https://img.shields.io/badge/Discord-Join-7289da)](https://discord.gg/XFpfPv9Uvx)
<!-- end-badges -->

<!-- start-intro -->
NVIDIA NemoClaw is an open source reference stack that simplifies running [OpenClaw](https://openclaw.ai) always-on assistants more safely.
It installs the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime, part of NVIDIA Agent Toolkit, which provides additional security for running autonomous agents.
<!-- end-intro -->

> **Alpha software**
>
> NemoClaw is available in early preview starting March 16, 2026.
> This software is not production-ready.
> Interfaces, APIs, and behavior may change without notice as we iterate on the design.
> The project is shared to gather feedback and enable early experimentation.
> We welcome issues and discussion from the community while the project evolves.

NemoClaw adds guided onboarding, a hardened blueprint, state management, OpenShell-managed channel messaging, routed inference, and layered protection on top of the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime. For the full feature list, refer to [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html). For the system diagram, component model, and blueprint lifecycle, refer to [How It Works](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html) and [Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html).

## Getting Started

Follow these steps to install NemoClaw and run your first sandboxed OpenClaw agent.

<!-- start-quickstart-guide -->

### Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

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
| Node.js    | 22.16 or later |
| npm        | 10 or later |
| Platform   | See below |

#### OpenShell Lifecycle

For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.

#### Container Runtimes

The following table lists tested platform and runtime combinations.
Availability is not limited to these entries, but untested configurations may have issues.

<!-- platform-matrix:begin -->
| OS | Container runtime | Status | Notes |
|----|-------------------|--------|-------|
| Linux | Docker | Tested | Primary tested path. |
| macOS (Apple Silicon) | Colima, Docker Desktop | Tested with limitations | Install Xcode Command Line Tools (`xcode-select --install`) and start the runtime before running the installer. |
| DGX Spark | Docker | Tested | Use the standard installer and `nemoclaw onboard`. For an end-to-end walkthrough with local Ollama inference, see the [NVIDIA Spark playbook](https://build.nvidia.com/spark/nemoclaw). |
| Windows WSL2 | Docker Desktop (WSL backend) | Tested with limitations | Requires WSL2 with Docker Desktop backend. |
<!-- platform-matrix:end -->

For platform-specific pre-setup (for example, Windows WSL 2), see [Prerequisites](https://docs.nvidia.com/nemoclaw/latest/get-started/prerequisites.html).

### Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

> **ℹ️ Note**
>
> NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.
>
> The installer runs as your normal user and does not require `sudo` or root.
> It installs Node.js via nvm and NemoClaw via npm, both into user-local directories.
> Docker must be installed and running before you run the installer. Installing Docker may require elevated privileges on Linux.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

The piped installer prompts through your terminal. In headless scripts or CI,
pass explicit acceptance to the `bash` side of the pipe:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
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

### Chat with the Agent

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

### Model Router (Experimental)

NemoClaw includes an optional model router that automatically picks the most efficient model for each query. Instead of sending every request to a single large model, the router uses a lightweight encoder to predict which model in a pool can handle each query correctly, then routes to the cheapest one that meets an accuracy threshold.

The router uses the [NVIDIA LLM Router v3](https://github.com/NVIDIA-AI-Blueprints/llm-router/tree/v3) prefill routing engine and runs on the host as a LiteLLM proxy. The sandbox reaches it through the OpenShell gateway and continues to call `https://inference.local/v1`; do not probe `localhost:4000` or `host.openshell.internal` directly from inside the sandbox.

#### Enable during onboard

Select **Model Router (experimental)** during the onboard wizard, or set `NEMOCLAW_PROVIDER=routed` for non-interactive mode:

```bash
NEMOCLAW_PROVIDER=routed nemoclaw onboard --non-interactive
```

The onboard wizard starts the router, configures the OpenShell provider, and creates the sandbox. The router process runs on the host on port 4000.

#### Configure the model pool

Edit `nemoclaw-blueprint/router/pool-config.yaml` to define which models the router can choose from:

```yaml
routing:
  method: prefill
  checkpoint: llm-router/checkpoints/prefill_router_qwen08b.pt
  tolerance: 0.20
  encoder: Qwen/Qwen3.5-0.8B

models:
  - name: nano
    litellm_model: "openai/nvidia/nvidia/Nemotron-3-Nano-30B-A3B"
    cost_per_m_input_tokens: 0.05
    api_base: "https://inference-api.nvidia.com"

  - name: super
    litellm_model: "openai/nvidia/nvidia/nemotron-3-super-v3"
    cost_per_m_input_tokens: 0.10
    api_base: "https://inference-api.nvidia.com"
```

The `tolerance` parameter controls the accuracy-cost tradeoff: 0.0 always picks the most accurate model, 1.0 always picks the cheapest, and 0.20 (default) allows up to 20 percentage points below the best for a cheaper model.

#### Architecture

The router runs on the host, not inside the sandbox:

```text
Sandbox (OpenClaw) ──> OpenShell Gateway (L7 proxy) ──> Model Router (:4000) ──> NVIDIA API
                                                         └── PrefillRouter selects model
```

Credentials flow through the OpenShell provider system. The sandbox never sees raw API keys.

### Uninstall

To remove NemoClaw and all resources created during setup, run the CLI's built-in uninstall command:

```bash
nemoclaw uninstall
```

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

`nemoclaw uninstall` runs the version-pinned `uninstall.sh` shipped with your installed CLI, with no network fetch at uninstall time.

If the `nemoclaw` CLI is missing or broken, fall back to the hosted script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

For a full comparison of the two forms, see [`nemoclaw uninstall` vs. the hosted `uninstall.sh`](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html#nemoclaw-uninstall-vs-the-hosted-uninstallsh).

For troubleshooting installation or onboarding issues, see the [Troubleshooting guide](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html).

<!-- end-quickstart-guide -->

## Documentation

Refer to the following pages on the official documentation website for more information on NemoClaw.

| Page | Description |
|------|-------------|
| [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html) | What NemoClaw does and how it fits together. |
| [Architecture Overview](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html) | High-level overview of Plugin, blueprint, sandbox lifecycle, and protection layers. |
| [Ecosystem](https://docs.nvidia.com/nemoclaw/latest/about/ecosystem.html) | How OpenClaw, OpenShell, and NemoClaw form a stack and when to use NemoClaw versus OpenShell alone. |
| [Architecture Details](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html) | Detailed description of Plugin structure, blueprint lifecycle, sandbox environment, and host-side state. |
| [Prerequisites](https://docs.nvidia.com/nemoclaw/latest/get-started/prerequisites.html) | Hardware, software, and supported platforms, with any platform-specific pre-setup. |
| [Inference Options](https://docs.nvidia.com/nemoclaw/latest/inference/inference-options.html) | Supported providers, validation, and routed inference configuration. |
| [Network Policies](https://docs.nvidia.com/nemoclaw/latest/reference/network-policies.html) | Baseline rules, operator approval flow, and egress control. |
| [Customize Network Policy](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html) | Static and dynamic policy changes, presets. |
| [Security Best Practices](https://docs.nvidia.com/nemoclaw/latest/security/best-practices.html) | Controls reference, risk framework, and posture profiles for sandbox security. |
| [Sandbox Hardening](https://docs.nvidia.com/nemoclaw/latest/deployment/sandbox-hardening.html) | Container security measures, capability drops, process limits. |
| [CLI Commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html) | Full NemoClaw CLI command reference. |
| [Troubleshooting](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html) | Common issues and resolution steps. |

## Project Structure

The following directories make up the NemoClaw repository.

```text
NemoClaw/
├── bin/              # CLI entry point and library modules (CJS)
├── nemoclaw/         # TypeScript plugin (Commander CLI extension)
│   └── src/
│       ├── blueprint/    # Runner, snapshot, SSRF validation, state
│       ├── commands/     # Slash commands, migration state
│       └── onboard/      # Onboarding config
├── nemoclaw-blueprint/   # Blueprint YAML and network policies
│   └── router/
│       ├── pool-config.yaml  # Model pool and routing config
│       └── llm-router/      # LLM Router v3 submodule (prefill routing engine)
├── scripts/          # Install helpers, setup, automation
├── test/             # Integration and E2E tests
└── docs/             # User-facing docs (Sphinx/MyST)
```

## Community

Join the NemoClaw community to ask questions, share feedback, and report issues.

- [Discord](https://discord.gg/XFpfPv9Uvx)
- [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions)
- [GitHub Issues](https://github.com/NVIDIA/NemoClaw/issues)

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the PR process.

## Security

NVIDIA takes security seriously.
If you discover a vulnerability in NemoClaw, **DO NOT open a public issue.**
Use one of the private reporting channels described in [SECURITY.md](SECURITY.md):

- Submit a report through the [NVIDIA Vulnerability Disclosure Program](https://www.nvidia.com/en-us/security/report-vulnerability/).
- Send an email to [psirt@nvidia.com](mailto:psirt@nvidia.com) encrypted with the [NVIDIA PGP key](https://www.nvidia.com/en-us/security/pgp-key).
- Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configuring-private-vulnerability-reporting-for-a-repository) to submit a report directly on this repository.

For security bulletins and PSIRT policies, visit the [NVIDIA Product Security](https://www.nvidia.com/en-us/security/) portal.

## Notice and Disclaimer

This software automatically retrieves, accesses or interacts with external materials. Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses. You are solely responsible for finding, reviewing and complying with all applicable terms, conditions, and licenses, and for verifying the security, integrity and suitability of any retrieved materials for your specific use case. This software is provided "AS IS", without warranty of any kind. The author makes no representations or warranties regarding any retrieved materials, and assumes no liability for any losses, damages, liabilities or legal consequences from your use or inability to use this software or any retrieved materials. Use this software and the retrieved materials at your own risk.

## License

Apache 2.0. See [LICENSE](LICENSE).
