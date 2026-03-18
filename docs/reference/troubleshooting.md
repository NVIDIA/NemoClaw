---
title:
  page: "NemoClaw Troubleshooting Guide"
  nav: "Troubleshooting"
description: "Diagnose and resolve common NemoClaw installation, onboarding, and runtime issues."
keywords: ["nemoclaw troubleshooting", "nemoclaw debug sandbox issues"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "troubleshooting", "nemoclaw"]
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

# Troubleshooting

This page covers common issues you may encounter when installing, onboarding, or running NemoClaw, along with their resolution steps.

## Installation

### `nemoclaw` not found after install

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
The `nemoclaw` binary is installed but the shell session does not know where to find it.

Run `source ~/.bashrc` (or `source ~/.zshrc` for zsh), or open a new terminal window.

### Installer fails on unsupported platform

The installer checks for a supported OS and architecture before proceeding.
NemoClaw requires Linux Ubuntu 22.04 LTS or later.
If you see an unsupported platform error, verify that you are running on a supported Linux distribution.

## Onboarding

### Cgroup v2 errors during onboard

On Ubuntu 24.04, DGX Spark, and WSL2, Docker may not be configured for cgroup v2 delegation.
The onboard preflight check detects this and fails with a clear error message.

Run the Spark setup script to fix the Docker cgroup configuration, then retry onboarding:

```console
$ sudo nemoclaw setup-spark
$ nemoclaw onboard
```

### Invalid sandbox name

Sandbox names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

If the name does not match these rules, the wizard exits with an error.
Choose a name such as `my-assistant` or `dev1`.

### Sandbox creation fails on DGX

On DGX machines, sandbox creation can fail if the gateway's DNS has not finished propagating or if a stale port forward from a previous onboard run is still active.

Run `nemoclaw onboard` to retry.
The wizard cleans up stale port forwards and waits for gateway readiness automatically.

### Colima socket not detected (macOS)

Newer Colima versions use the XDG base directory (`~/.config/colima/default/docker.sock`) instead of the legacy path (`~/.colima/default/docker.sock`).
NemoClaw checks both paths.
If neither is found, verify that Colima is running:

```console
$ colima status
```

## Runtime

### Sandbox shows as stopped

The sandbox may have been stopped or deleted.
Run `nemoclaw onboard` to recreate the sandbox from the same blueprint and policy definitions.

### Status shows "not running" inside the sandbox

This is expected behavior.
When running `openclaw nemoclaw status` inside an active sandbox, host-side sandbox state and inference configuration are not inspectable.
The status command detects the sandbox context and reports "active (inside sandbox)" instead.

Run `openshell sandbox list` on the host to check the underlying sandbox state.

### Inference requests time out

Verify that the inference provider endpoint is reachable from the host.
Check the active provider and endpoint:

```console
$ openclaw nemoclaw status
```

If the endpoint is correct but requests still fail, check for network policy rules that may block the connection, and verify that your NVIDIA API key is valid.

### Agent cannot reach an external host

OpenShell blocks outbound connections to hosts not listed in the network policy.
Open the TUI to see blocked requests and approve them:

```console
$ openshell term
```

To permanently allow an endpoint, add it to the network policy.
Refer to [Customize the Network Policy](../network-policy/customize-network-policy.md) for details.

### Blueprint run failed

View the error output for the failed blueprint run:

```console
$ openclaw nemoclaw logs --run-id <id>
```

If the run ID is unknown, omit `--run-id` to view logs from the most recent run.
Use `--follow` to stream logs in real time while debugging.
