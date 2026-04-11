---
title:
  page: "Sandbox Image Hardening"
  nav: "Sandbox Hardening"
description:
  main: "Security hardening measures applied to the NemoClaw sandbox container image."
  agent: "Describes security hardening measures applied to the NemoClaw sandbox container image. Use when reviewing container security, Docker capabilities, process limits, or sandbox hardening controls."
keywords: ["nemoclaw sandbox hardening", "container security", "docker capabilities", "process limits"]
topics: ["generative_ai", "ai_agents"]
tags: ["nemoclaw", "sandboxing", "security"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Sandbox Image Hardening

The NemoClaw sandbox image applies several security measures to reduce attack
surface and limit the blast radius of untrusted workloads.

## Removed Unnecessary Tools

Build toolchains (`gcc`, `g++`, `make`) and network probes (`netcat`) are
explicitly purged from the runtime image. These tools are not needed at runtime
and would unnecessarily widen the attack surface.

If you need a compiler during build, use the existing multi-stage build
(the `builder` stage has full Node.js tooling) and copy only artifacts into the
runtime stage.

## Process Limits

The container ENTRYPOINT sets `ulimit -u 512` to cap the number of processes
a sandbox user can spawn. This mitigates fork-bomb attacks. The startup script
(`nemoclaw-start.sh`) applies the same limit.

Adjust the value via the `--ulimit nproc=512:512` flag if launching with
`docker run` directly.

## Dropping Linux Capabilities

When running the sandbox container, drop all Linux capabilities and re-add only
what is strictly required:

```console
$ docker run --rm \
    --cap-drop=ALL \
    --ulimit nproc=512:512 \
    nemoclaw-sandbox
```

### Docker Compose Example

```yaml
services:
  nemoclaw-sandbox:
    image: nemoclaw-sandbox:latest
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    ulimits:
      nproc:
        soft: 512
        hard: 512
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=64m
```

> **Note:** The `Dockerfile` itself cannot enforce `--cap-drop`. That is a
> runtime concern controlled by the container orchestrator. Always configure
> capability dropping in your `docker run` flags, Compose file, or Kubernetes
> `securityContext`.

## Read-Only Home Directory

The sandbox Landlock policy restricts `/sandbox` (the agent's home directory) to read-only access.
Only explicitly declared directories are writable:

| Path | Access | Purpose |
|------|--------|---------|
| `/sandbox` | read-only | Home directory — agents cannot create arbitrary files |
| `/sandbox/.openclaw` | read-only | Immutable gateway config (auth tokens, CORS) |
| `/sandbox/.openclaw-data` | read-write | Agent state, workspace, plugins (via symlinks) |
| `/sandbox/.nemoclaw` | read-write | Plugin state and config; blueprints within are DAC-protected (root-owned) |
| `/tmp` | read-write | Temporary files and logs |

This prevents agents from:

- Writing scripts and executing them later
- Modifying their own runtime environment
- Creating hidden files that persist across invocations
- Using writable space for data staging before exfiltration

The image build pre-creates shell init files `.bashrc` and `.profile`.
These files source runtime proxy configuration from `/tmp/nemoclaw-proxy-env.sh`.

### Landlock Kernel Requirements

Landlock LSM requires Linux kernel 5.13 or later with `CONFIG_SECURITY_LANDLOCK=y`.
The NemoClaw sandbox policy uses `compatibility: best_effort`, which means Landlock enforcement is silently skipped on kernels that do not support it.

On such kernels, protection falls back to DAC (file ownership and permissions) only.
Files owned by the sandbox user (e.g., `.bashrc`, `.profile`) would be writable by the agent despite the Landlock read-only policy.

Operators should verify Landlock availability:

```console
$ ls /sys/kernel/security/landlock
```

For production deployments, kernel 5.13+ with Landlock enabled is strongly recommended.
The `test/e2e/e2e-cloud-experimental/checks/04-landlock-readonly.sh` script validates enforcement at runtime.

## References

- [#804](https://github.com/NVIDIA/NemoClaw/issues/804): Read-only home directory
- [#807](https://github.com/NVIDIA/NemoClaw/issues/807): gcc in sandbox image
- [#808](https://github.com/NVIDIA/NemoClaw/issues/808): netcat in sandbox image
- [#809](https://github.com/NVIDIA/NemoClaw/issues/809): No process limit
- [#797](https://github.com/NVIDIA/NemoClaw/issues/797): Drop Linux capabilities
