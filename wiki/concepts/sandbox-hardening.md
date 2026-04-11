---
title: Sandbox Hardening
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-reference-architecture]
tags: [security, sandbox, hardening]
---

# Sandbox Hardening

Four protection layers enforce isolation inside the [sandbox](../entities/sandbox.md):

## Layers

| Layer | What it protects | When applied |
|---|---|---|
| [Network](network-policy.md) | Blocks unauthorized outbound connections | Hot-reloadable at runtime |
| Filesystem | Prevents reads/writes outside `/sandbox` and `/tmp` | Locked at sandbox creation |
| Process | Blocks privilege escalation and dangerous syscalls | Locked at sandbox creation |
| [Inference](inference-routing.md) | Reroutes model API calls to controlled backends | Hot-reloadable at runtime |

## Specific Measures

- **Landlock LSM** — Best-effort filesystem confinement
- **seccomp** — Blocks dangerous syscalls
- **Network namespace** — Isolated networking
- **Capability dropping** — All Linux capabilities dropped at runtime via Docker flags
- **Process limits** — `ulimit -u 512` (fork-bomb mitigation)
- **No build tools** — gcc, g++, make, netcat explicitly removed from image
- **User isolation** — Runs as `sandbox:sandbox` user/group
- **Immutable config** — `/sandbox/.openclaw` is read-only (prevents token tampering)

## Filesystem Access

| Path | Access | Purpose |
|---|---|---|
| `/sandbox`, `/tmp`, `/dev/null` | Read-write | Agent working directory |
| `/sandbox/.openclaw` | Read-only | Immutable gateway config |
| `/sandbox/.openclaw-data` | Read-write | Agent/plugin writable state |
| `/usr`, `/lib`, `/proc`, `/etc` | Read-only | System files |

## See Also

- [Network Policy](network-policy.md) — Egress control details
- [Sandbox](../entities/sandbox.md) — The container being hardened
- [OpenShell](../entities/openshell.md) — Runtime enforcing the hardening
