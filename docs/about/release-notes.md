---
title:
  page: "NemoClaw Release Notes"
  nav: "Release Notes"
description:
  main: "Changelog and feature history for NemoClaw releases."
  agent: "Includes the NemoClaw release notes. Use when users ask about recent changes, the release cadence, or where to track versioned assets on GitHub."
keywords: ["nemoclaw release notes", "nemoclaw changelog"]
topics: ["generative_ai", "ai_agents"]
tags: ["nemoclaw", "releases"]
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

# Release Notes

NVIDIA NemoClaw is available in early preview starting March 16, 2026. Use this page to track changes.

## v0.0.39

NemoClaw v0.0.39 improves several day-two workflows:

- The installer checks Docker earlier on Linux, can install and start Docker when needed, and stops with `newgrp docker` guidance when the current shell has not picked up the `docker` group yet.
- DGX Spark and DGX Station users can accept an express install prompt that preselects the local inference path and suggested policy defaults.
- NemoClaw now creates GPU-capable OpenShell Docker sandboxes by default when an NVIDIA GPU is available, with explicit `--sandbox-gpu`, `--no-sandbox-gpu`, and `--sandbox-gpu-device` controls.
- `nemohermes` supports Hermes Provider onboarding and runtime model switches through `nemohermes inference set`.
- `nemoclaw <name> hosts-add`, `hosts-list`, and `hosts-remove` manage sandbox host aliases for LAN-only services.
- `nemoclaw update` checks and runs the maintained installer flow, while `nemoclaw upgrade-sandboxes` remains responsible for rebuilding existing sandboxes.
- `nemoclaw <name> destroy` preserves the shared gateway by default unless `--cleanup-gateway` is selected.
- `nemoclaw <name> connect` repairs stale `inference.local` DNS proxy routes before opening the session.
- Windows-host Ollama onboarding relaunches the daemon with the reachable binding after install or restart.
- Local NVIDIA NIM onboarding passes `NGC_API_KEY` or `NVIDIA_API_KEY` into the managed container without putting the secret in process arguments, detects early container exits during health checks, and prints a per-GPU preflight breakdown on mixed-model hosts.
- The sandbox startup path strips additional Linux capabilities before and during privilege step-down.
- OpenClaw workspace template files are seeded when bootstrap is skipped and the workspace is still empty.
- Kimi K2.6 and related NVIDIA-hosted chat-completions paths include model-specific compatibility handling for reasoning output.

## v0.0.38

NemoClaw v0.0.38 improves several day-two workflows:

- `nemoclaw <name> status` shows the gateway's active policy version in the displayed policy YAML when OpenShell reports one.
- `nemoclaw uninstall` stops matching Local Ollama auth proxy processes before it removes `~/.nemoclaw`, which prevents stale listeners from blocking a later reinstall.
- Local Ollama onboarding validates structured chat-completions tool calls and rejects models that leak tool-call payloads as plain text.
- Blueprint policy additions under `components.policy.additions` are validated, merged into the live policy, applied through OpenShell, and recorded in run metadata.
- Rebuild backups tolerate partial archive output when usable data was produced, then report only the manifest-defined paths that could not be archived.
- NemoHermes uninstall output uses NemoHermes-specific help, progress, and completion text.

## v0.0.34

Starting with NemoClaw v0.0.34, the `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` installer pipeline no longer auto-accepts the third-party software notice when stdin is piped and `/dev/tty` is unavailable (for example, deeply detached SSH sessions or some container shells).
In environments without a TTY, accept upfront in the pipe:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

Or pass the flag through to the installer:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --yes-i-accept-third-party-software
```

Or re-run from a terminal with a controlling TTY:

```console
$ bash <(curl -fsSL https://www.nvidia.com/nemoclaw.sh)
```

The installer error message in v0.0.35+ surfaces all three invocations directly so users can copy-paste a recovery without leaving the terminal.

## Component Version Policy

NemoClaw pins the OpenClaw version inside the sandbox at build time via `min_openclaw_version` in `nemoclaw-blueprint/blueprint.yaml`; existing sandboxes do not auto-upgrade.
Run `nemoclaw <name> status` to see the OpenClaw version currently running in a sandbox, and `nemoclaw <name> rebuild` to pick up a newer pin from a NemoClaw upgrade.
See [Checking the OpenClaw version](../reference/commands.md#checking-the-openclaw-version) for the full policy.
