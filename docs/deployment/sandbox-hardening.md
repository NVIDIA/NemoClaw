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

> **Note:** The `Dockerfile` itself cannot enforce `--cap-drop` — that is a
> runtime concern controlled by the container orchestrator. Always configure
> capability dropping in your `docker run` flags, Compose file, or Kubernetes
> `securityContext`.

## References

- [#807](https://github.com/NVIDIA/NemoClaw/issues/807) — gcc in sandbox image
- [#808](https://github.com/NVIDIA/NemoClaw/issues/808) — netcat in sandbox image
- [#809](https://github.com/NVIDIA/NemoClaw/issues/809) — No process limit
- [#797](https://github.com/NVIDIA/NemoClaw/issues/797) — Drop Linux capabilities
