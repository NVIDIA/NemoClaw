---
title: OpenShell
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-about-overview, docs-reference-architecture]
tags: [runtime, sandbox, security, nvidia, core]
---

# OpenShell

NVIDIA OpenShell is the container runtime that provides the sandbox isolation
layer in NemoClaw. Part of NVIDIA Agent Toolkit. It enforces Landlock LSM,
seccomp profiles, and network namespace isolation.

## Responsibilities

- Creates and manages sandboxed containers
- Enforces network policy (egress allowlisting)
- Enforces filesystem policy (read-only / read-write paths)
- Routes inference calls through the [gateway](openshell-gateway.md)
- Provides the operator TUI (`openshell term`) for monitoring and approvals

## Key Host Commands

| Command | Purpose |
|---|---|
| `openshell term` | Launch TUI for monitoring and egress approval |
| `openshell sandbox list` | List all sandboxes |
| `openshell sandbox connect <name>` | Shell into sandbox |
| `openshell sandbox download <name> <path>` | Download files from sandbox |
| `openshell sandbox upload <name> <src> <dest>` | Upload files to sandbox |
| `openshell sandbox exec <name> <cmd>` | Execute command in sandbox |
| `openshell inference set --provider <id> --model <name>` | Switch inference at runtime |
| `openshell inference get` | Check active provider/model |
| `openshell policy set <file>` | Apply policy dynamically |
| `openshell gateway start --name nemoclaw` | Start gateway (e.g. after reboot) |

## Links

- GitHub: <https://github.com/NVIDIA/OpenShell>

## See Also

- [OpenShell Gateway](openshell-gateway.md) — Credential-owning proxy
- [Sandbox](sandbox.md) — Isolated container managed by OpenShell
- [Sandbox Hardening](../concepts/sandbox-hardening.md) — Security layers
- [Network Policy](../concepts/network-policy.md) — Egress control
