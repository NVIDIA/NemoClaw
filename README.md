# NVIDIA NemoClaw: OpenClaw Plugin for OpenShell

<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](https://github.com/NVIDIA/NemoClaw/blob/main/LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md)
[![Project Status](https://img.shields.io/badge/status-alpha-orange)](https://github.com/NVIDIA/NemoClaw/blob/main/docs/about/release-notes.md)
<!-- end-badges -->

NVIDIA NemoClaw is an open source stack that simplifies running [OpenClaw](https://openclaw.ai) always-on assistants safely. It installs the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime, part of [NVIDIA Agent Toolkit](https://docs.nvidia.com/nemo/agent-toolkit/latest), a secure environment for running autonomous agents, with inference routed through [NVIDIA cloud](https://build.nvidia.com).

> **Alpha software**
> 
> NemoClaw is early-stage. Expect rough edges. We are building toward production-ready sandbox orchestration, but the starting point is getting your own environment up and running.
> Interfaces, APIs, and behavior may change without notice as we iterate on the design.
> The project is shared to gather feedback and enable early experimentation, but it
> should not yet be considered production-ready.
> We welcome issues and discussion from the community while the project evolves.

---

## Quick Start

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

> [!NOTE]
> NemoClaw currently requires a fresh installation of OpenClaw.

<!-- start-quickstart-guide -->

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

### Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

```console
$ curl -fsSL https://nvidia.com/nemoclaw.sh | bash
```

When the install completes, a summary confirms the running environment:

```
──────────────────────────────────────────────────
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Cloud API)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

### Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

```console
$ nemoclaw my-assistant connect
```

#### OpenClaw TUI

The OpenClaw TUI opens an interactive chat interface. Type a message and press Enter to send it to the agent:

```console
sandbox@my-assistant:~$ openclaw tui
```

Send a test message to the agent and verify you receive a response.

> [!NOTE]
> The TUI is best for interactive back-and-forth. If you need the full text of a long response (for example, large code generation output), use the CLI instead:
>
> ```console
> sandbox@my-assistant:~$ openclaw agent --agent main --local -m "<prompt>" --session-id <id>
> ```
>
> This prints the complete response directly in the terminal and avoids relying on the TUI view for long output.

#### OpenClaw CLI

Use the OpenClaw CLI to send a single message and print the response:

```console
sandbox@my-assistant:~$ openclaw agent --agent main --local -m "hello" --session-id test
```

<!-- end-quickstart-guide -->

---

## How It Works

NemoClaw installs the NVIDIA OpenShell runtime and Nemotron models, then uses a versioned blueprint to create a sandboxed environment where every network request, file access, and inference call is governed by declarative policy. The `nemoclaw` CLI orchestrates the full stack: OpenShell gateway, sandbox, inference provider, and network policy.

| Component        | Role                                                                                      |
|------------------|-------------------------------------------------------------------------------------------|
| **Plugin**       | TypeScript CLI commands for launch, connect, status, and logs.                            |
| **Blueprint**    | Versioned Python artifact that orchestrates sandbox creation, policy, and inference setup. |
| **Sandbox**      | Isolated OpenShell container running OpenClaw with policy-enforced egress and filesystem.  |
| **Inference**    | NVIDIA cloud model calls, routed through the OpenShell gateway, transparent to the agent.  |

The blueprint lifecycle follows four stages: resolve the artifact, verify its digest, plan the resources, and apply through the OpenShell CLI.

When something goes wrong, errors may originate from either NemoClaw or the OpenShell layer underneath. Run `nemoclaw <name> status` for NemoClaw-level health and `openshell sandbox list` to check the underlying sandbox state.

---

## Inference

Inference requests from the agent never leave the sandbox directly. OpenShell intercepts every call and routes it to the NVIDIA cloud provider.

| Provider     | Model                               | Use Case                                       |
|--------------|--------------------------------------|-------------------------------------------------|
| NVIDIA cloud | `nvidia/nemotron-3-super-120b-a12b` | Production. Requires an NVIDIA API key.         |

Get an API key from [build.nvidia.com](https://build.nvidia.com). The `nemoclaw onboard` command prompts for this key during setup.

Local inference options such as Ollama and vLLM are still experimental. On macOS, they also depend on OpenShell host-routing support in addition to the local service itself being reachable on the host.

---

## Protection Layers

The sandbox starts with a strict baseline policy that controls network egress and filesystem access:

| Layer      | What it protects                                    | When it applies             |
|------------|-----------------------------------------------------|-----------------------------|
| Network    | Blocks unauthorized outbound connections.           | Hot-reloadable at runtime.  |
| Filesystem | Prevents reads/writes outside `/sandbox` and `/tmp`.| Locked at sandbox creation. |
| Process    | Blocks privilege escalation and dangerous syscalls. | Locked at sandbox creation. |
| Inference  | Reroutes model API calls to controlled backends.    | Hot-reloadable at runtime.  |

When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval.

---

## Key Commands

### Host commands (`nemoclaw`)

Run these on the host to set up, connect to, and manage sandboxes.

| Command                              | Description                                            |
|--------------------------------------|--------------------------------------------------------|
| `nemoclaw onboard`                  | Interactive setup wizard: gateway, providers, sandbox. |
| `nemoclaw deploy <instance>` (**experimental**)         | Deploy to a remote GPU instance through Brev.          |
| `nemoclaw <name> connect`            | Open an interactive shell inside the sandbox.          |
| `openshell term`                     | Launch the OpenShell TUI for monitoring and approvals. |
| `nemoclaw start` / `stop` / `status` | Manage auxiliary services (Telegram bridge, tunnel).   |

### Plugin commands (`openclaw nemoclaw`)

Run these inside the OpenClaw CLI. These commands are under active development and may not all be functional yet.

| Command                                    | Description                                              |
|--------------------------------------------|----------------------------------------------------------|
| `openclaw nemoclaw launch [--profile ...]` | Bootstrap OpenClaw inside an OpenShell sandbox.          |
| `openclaw nemoclaw status`                 | Show sandbox health, blueprint state, and inference.     |
| `openclaw nemoclaw logs [-f]`              | Stream blueprint execution and sandbox logs.             |

See the full [CLI reference](https://docs.nvidia.com/nemoclaw/latest/reference/commands.md) for all commands, flags, and options.

> **Known limitations:**
> - The `openclaw nemoclaw` plugin commands are under active development. Use the `nemoclaw` host CLI as the primary interface.
> - Setup may require manual workarounds on some platforms. File an issue if you encounter blockers.

---

## Learn More

Refer to the documentation for more information on NemoClaw.

- [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html): what NemoClaw does and how it fits together
- [How It Works](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html): plugin, blueprint, and sandbox lifecycle
- [Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html): plugin structure, blueprint lifecycle, and sandbox environment
- [Inference Profiles](https://docs.nvidia.com/nemoclaw/latest/reference/inference-profiles.html): NVIDIA cloud inference configuration
- [Network Policies](https://docs.nvidia.com/nemoclaw/latest/reference/network-policies.html): egress control and policy customization
- [CLI Commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html): full command reference

## License

This project is licensed under the [Apache License 2.0](LICENSE).
