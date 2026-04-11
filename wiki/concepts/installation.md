---
title: Installation
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-get-started]
tags: [install, onboard, setup]
---

# Installation

## Quick Install

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Installs Node.js if not present, then runs the guided onboard wizard to create
a sandbox, configure inference, and apply security policies.

## Hardware Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 vCPU | 4+ vCPU |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB free | 40 GB free |

## Software Requirements

| Dependency | Version |
|---|---|
| Linux | Ubuntu 22.04 LTS or later |
| Node.js | 22.16 or later |
| npm | 10 or later |
| Container runtime | Docker (Linux), Colima/Docker Desktop (macOS) |
| [OpenShell](../entities/openshell.md) | Installed |

## Platform-Specific Notes

### macOS (Apple Silicon)

1. Install Xcode CLI Tools: `xcode-select --install`
2. Install and start Colima or Docker Desktop
3. Run the installer

### WSL2 (Windows)

- Docker Desktop with WSL backend required
- Dashboard URL uses WSL host IP (use as printed, don't replace with localhost)

### DGX Spark

See [DGX Spark](../entities/dgx-spark.md) for Spark-specific setup.

## Post-Install Verification

```text
Dashboard    http://127.0.0.1:18789/
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)
```

If `nemoclaw` is not found, run `source ~/.bashrc` or open a new terminal.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

| Flag | Effect |
|---|---|
| `--yes` | Skip confirmation prompt |
| `--keep-openshell` | Leave openshell installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |

## See Also

- [CLI Commands](cli-commands.md) — Full command reference
- [DGX Spark](../entities/dgx-spark.md) — Spark-specific setup
