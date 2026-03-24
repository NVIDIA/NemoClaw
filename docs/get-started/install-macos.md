---
title:
  page: "macOS Installation Guide — NemoClaw"
  nav: "macOS Installation"
description: "Detailed installation and prerequisite guidance for NemoClaw on macOS."
keywords: ["nemoclaw macos install", "nemoclaw xcode command line tools", "nemoclaw docker macos"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "macos", "nemoclaw"]
content:
  type: get_started
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# macOS Installation Guide — NemoClaw

This guide provides detailed instructions for setting up NemoClaw on macOS, especially for fresh machines.

## Prerequisites

Before installing NemoClaw, ensure your Mac meets the hardware and software requirements.

### Hardware

- **CPU:** Apple Silicon (M1, M2, M3, M4) or Intel processor.
- **Memory:** 8 GB RAM minimum (16 GB recommended).
- **Disk:** 20 GB free space.

### Software

1. **Xcode Command Line Tools:** Required for basic development utilities and system headers.
2. **Container Runtime:** Required to run the NemoClaw sandbox. Supported options include:
    - [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Recommended for most users)
    - [OrbStack](https://orbstack.dev/) (Fast and lightweight alternative)
    - [Colima](https://github.com/abiosoft/colima) (Open-source CLI-first option)
3. **Node.js:** Version 20 or later.

## Recommended Install Order

Follow this order to avoid setup failures:

### 1. Install Xcode Command Line Tools

Even if you don't plan on using Xcode, the command line tools are necessary for many development tasks.

Run the following command in your terminal:

```console
$ xcode-select --install
```

A software update popup will appear. Click **Install** and wait for the process to complete.

### 2. Install and Start a Container Runtime

Choose one of the supported runtimes. Docker Desktop is the most common choice.

- **Docker Desktop:** Download from the [official site](https://www.docker.com/products/docker-desktop/), install, and **ensure the application is running**.
- **Colima:** Install via Homebrew and start it:
  ```console
$ brew install colima docker
$ colima start
```

### 3. Verify Node.js

Check your Node.js version:

```console
$ node --version
```

If it is below version 20, install a newer version from [nodejs.org](https://nodejs.org/) or use a version manager like `nvm` or `fnm`.

### 4. Install NemoClaw

Once the prerequisites are met, run the NemoClaw installer:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

## Troubleshooting Common macOS Issues

### `xcode-select` errors

If you see errors related to `xcrun` or missing headers, try resetting the active developer directory:

```console
$ sudo xcode-select --reset
```

### Container runtime not detected

NemoClaw requires a running Docker-compatible socket.

- **Docker Desktop:** Ensure the Docker icon is visible in the menu bar and shows "Docker Desktop is running".
- **Colima:** If the socket is not found, verify Colima is active: `colima status`. Colima may use a non-standard socket path; see the [Troubleshooting guide](../reference/troubleshooting.md#colima-socket-not-detected-macos) for details.

### Permission Errors during `npm install`

If the installer fails with `EACCES` errors, do not use `sudo`. Instead, configure npm to use a directory you own. Refer to the [Troubleshooting guide](../reference/troubleshooting.md#npm-install-fails-with-permission-errors) for the fix.

## Next Steps

- [Quickstart](quickstart.md): Launch a sandbox and run your first agent.
- [Switch inference providers](../inference/switch-inference-providers.md) to use a different model or endpoint.
- [Approve or deny network requests](../network-policy/approve-network-requests.md) when the agent tries to reach external hosts.
- [Customize the network policy](../network-policy/customize-network-policy.md) to pre-approve trusted domains.
- [Monitor sandbox activity](../monitoring/monitor-sandbox-activity.md) through the OpenShell TUI.
