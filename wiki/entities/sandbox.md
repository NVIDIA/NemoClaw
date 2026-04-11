---
title: Sandbox
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-about-how-it-works, docs-reference-architecture]
tags: [sandbox, container, security, core]
---

# Sandbox

The isolated [OpenShell](openshell.md) container that runs [OpenClaw](openclaw.md)
with policy-enforced egress and filesystem restrictions.

## Container Image

`ghcr.io/nvidia/openshell-community/sandboxes/openclaw:latest`

Approximately 2.4 GB compressed. During image push, Docker, k3s, and the
OpenShell gateway run alongside, which can consume significant memory.
Minimum 8 GB RAM recommended; swap can work around lower memory at the cost
of performance.

## Inside the Sandbox

- OpenClaw pre-installed with NemoClaw plugin
- Inference routed through `inference.local` (HTTPS managed endpoint)
- Network egress restricted by baseline policy + operator approvals
- Runs as `sandbox:sandbox` user/group
- Working directories: `/sandbox` (read-write), `/tmp` (read-write)
- System paths: read-only

## Hardening

See [sandbox hardening](../concepts/sandbox-hardening.md) for full details.

| Measure | Detail |
|---|---|
| Landlock LSM | Best-effort filesystem confinement |
| seccomp | Blocks dangerous syscalls |
| Network namespace | Isolated networking |
| Capability dropping | All Linux capabilities dropped at runtime |
| Process limits | `ulimit -u 512` (fork-bomb mitigation) |
| No build tools | gcc, g++, make, netcat explicitly removed |

## Filesystem Layout

| Path | Access | Purpose |
|---|---|---|
| `/sandbox`, `/tmp`, `/dev/null` | Read-write | Agent working directory |
| `/sandbox/.openclaw` | Read-only | Immutable gateway config |
| `/sandbox/.openclaw-data` | Read-write | Agent/plugin writable state |
| `/usr`, `/lib`, `/proc`, `/etc` | Read-only | System files |

## Lifecycle

- Created during `nemoclaw onboard`
- Persists across restarts (PVC data retained)
- Destroyed permanently with `nemoclaw <name> destroy`
- After host reboot: `openshell gateway start --name nemoclaw` then reconnect

## See Also

- [OpenShell](openshell.md) — Runtime managing the sandbox
- [Sandbox Hardening](../concepts/sandbox-hardening.md) — Security layers
- [Network Policy](../concepts/network-policy.md) — Egress rules
- [Workspace Files](../concepts/workspace-files.md) — Persistent agent state
- [Backup and Restore](../concepts/backup-and-restore.md) — Protecting sandbox data
