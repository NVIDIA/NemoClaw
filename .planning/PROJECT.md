# NemoClaw Windows Installer

## What This Is

A Windows PowerShell script that automates installing Docker Desktop and setting up an Ubuntu container with NemoClaw/OpenClaw pre-installed. It forwards the OpenClaw dashboard (port 18789) to the host machine and creates a shared folder on the user's Desktop for passing files into the container. Includes start/stop/restart/status management commands.

## Core Value

A Windows user can run one script and get a working OpenClaw dashboard accessible from their browser, with a Desktop folder for sharing files — no Linux or Docker knowledge required.

## Requirements

### Validated

- [x] PowerShell script installs Docker Desktop if not already installed — Validated in Phase 01: prerequisites-and-docker-desktop
- [x] Script creates an Ubuntu 22.04 container with NemoClaw installed via install.sh — Validated in Phase 02: container-setup-and-nemoclaw-install
- [x] OpenClaw dashboard port (18789) is forwarded to the host machine — Validated in Phase 02: container-setup-and-nemoclaw-install
- [x] Desktop folder `NemoClaw` is created and mounted into the container — Validated in Phase 02: container-setup-and-nemoclaw-install
- [x] Script prompts the user for their NVIDIA API key during setup — Validated in Phase 02: container-setup-and-nemoclaw-install

### Active
- [x] Script provides start, stop, restart, and status commands for the container — Validated in Phase 03: lifecycle-management
- [ ] Script handles errors gracefully with clear messages (Docker not starting, network issues, etc.)

### Out of Scope

- Linux or macOS installation — Windows-only scope
- OpenShell/k3s orchestration — using plain Docker container instead
- GPU passthrough — not required for basic dashboard access
- Automatic updates of NemoClaw inside the container

## Context

NemoClaw is an NVIDIA open-source stack that runs OpenClaw AI assistants inside sandboxed environments. The normal installation path assumes a Linux machine with OpenShell (k3s-based container orchestration). This project creates a simplified Windows entry point that bypasses OpenShell and runs NemoClaw directly in a Docker container.

The existing repo has a Dockerfile (node:22-slim base) but the user wants a fresh Ubuntu 22.04 container with install.sh run inside it, closer to the documented bare-metal install path.

Key technical details:
- OpenClaw dashboard runs on port 18789 (configurable via PUBLIC_PORT env var)
- NemoClaw install requires Node.js 20+ and npm 10+
- The install.sh in the repo handles Node.js installation and onboarding
- NVIDIA API key is needed for inference (build.nvidia.com)

## Constraints

- **Platform**: Windows 10/11 with PowerShell 5.1+
- **Docker**: Docker Desktop (includes WSL2 backend)
- **Container base**: Ubuntu 22.04 LTS
- **Port**: 18789 for OpenClaw dashboard
- **Shared folder**: `$HOME\Desktop\NemoClaw` on host → mounted path in container

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Docker Desktop over WSL Docker Engine | Easiest for Windows users, GUI management | Implemented in Phase 01 |
| Fresh Ubuntu over existing Dockerfile | Closer to documented install path, user preference | Implemented in Phase 02 |
| Prompt for API key during setup | Interactive setup experience, no env var prerequisite | Implemented in Phase 02 |
| Include start/stop/restart/status commands | Users shouldn't need to learn Docker CLI | Implemented in Phase 03 |

---
*Last updated: 2026-03-20 after Phase 03 completion*
