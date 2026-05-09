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

NVIDIA NemoClaw is available in early preview starting March 16, 2026. Use the following GitHub resources to track changes.

| Resource | Description |
|---|---|
| [Releases](https://github.com/NVIDIA/NemoClaw/releases) | Versioned release notes and downloadable assets. |
| [Release comparison](https://github.com/NVIDIA/NemoClaw/compare) | Diff between any two tags or branches. |
| [Merged pull requests](https://github.com/NVIDIA/NemoClaw/pulls?q=is%3Apr+is%3Amerged) | Individual changes with review discussion. |
| [Commit history](https://github.com/NVIDIA/NemoClaw/commits/main) | Full commit log on `main`. |

## Behavior Changes

### v0.0.38 Reliability Updates

NemoClaw v0.0.38 improves several day-two workflows:

- `nemoclaw <name> status` shows the gateway's active policy version in the displayed policy YAML when OpenShell reports one.
- `nemoclaw uninstall` stops matching Local Ollama auth proxy processes before it removes `~/.nemoclaw`, which prevents stale listeners from blocking a later reinstall.
- Local Ollama onboarding validates structured chat-completions tool calls and rejects models that leak tool-call payloads as plain text.
- Blueprint policy additions under `components.policy.additions` are validated, merged into the live policy, applied through OpenShell, and recorded in run metadata.
- Rebuild backups tolerate partial archive output when usable data was produced, then report only the manifest-defined paths that could not be archived.
- NemoHermes uninstall output uses NemoHermes-specific help, progress, and completion text.

### v0.0.34 Installer Requires Explicit Acceptance in Non-TTY Environments

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
