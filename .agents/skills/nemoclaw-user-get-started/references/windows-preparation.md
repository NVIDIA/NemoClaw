<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Prepare Windows for NemoClaw

You can run NemoClaw inside Windows Subsystem for Linux (WSL 2) on Windows.
Complete these steps before following the Quickstart (use the `nemoclaw-user-get-started` skill).
Linux and macOS users do not need this page and can go directly to the Quickstart.

> **Note:** This guide has been tested on x86-64.

## Prerequisites

Verify the following before you begin:

- Windows 10 (build 19041 or later) or Windows 11.
- Hardware requirements are the same as the Quickstart (use the `nemoclaw-user-get-started` skill).

## Enable WSL 2

Open an elevated PowerShell (Run as Administrator):

```console
$ wsl --install --no-distribution
```

This enables both the Windows Subsystem for Linux and Virtual Machine Platform features.

Reboot if prompted.

## Install and Register Ubuntu

After reboot, open an elevated PowerShell again:

```console
$ wsl --install -d Ubuntu
```

Let the distribution launch and complete first-run setup (pick a Unix username and password), then type `exit` to return to PowerShell.

> **Warning:** Do not use the `--no-launch` flag.
> The `--no-launch` flag downloads the package but does not register the distribution with WSL.
> Commands like `wsl -d Ubuntu` fail with "There is no distribution with the supplied name" until the distribution has been launched at least once.

Verify the distribution is registered and running WSL 2:

```console
$ wsl -l -v
```

Expected output:

```text
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

## Install Docker Desktop

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 backend (the default on Windows 11).

After installation, open Docker Desktop Settings and confirm that WSL integration is enabled for your Ubuntu distribution (Settings > Resources > WSL integration).

Verify from inside WSL:

```console
$ wsl
$ docker info
```

`docker info` prints server information.
If you see "Cannot connect to the Docker daemon", confirm that Docker Desktop is running and that WSL integration is enabled.

## Set Up Local Inference with Ollama (Optional)

If you plan to select Ollama as your inference provider during onboarding, use one Ollama instance that WSL can reach.
You can install Ollama inside WSL yourself:

```console
$ curl -fsSL https://ollama.com/install.sh | sh
```

If Ollama is installed but not already running in WSL, the onboarding process starts it for you.
You can also start it yourself beforehand with `ollama serve`.

You can also use Ollama for Windows.
During onboarding, NemoClaw can use an already-running Windows-host daemon, start or restart an installed daemon, or install Ollama on the Windows host.
When Ollama runs on the Windows host, NemoClaw detects it from WSL through `host.docker.internal` and pulls missing models through the Ollama HTTP API.
Do not run both the Windows and WSL Ollama instances on port `11434` at the same time.
Use one instance, or move one of them to a different port before running `nemoclaw onboard`.

## Next Step

Your Windows environment is ready.
Open a WSL terminal (type `wsl` in PowerShell, or open Ubuntu from Windows Terminal) and continue with the Quickstart (use the `nemoclaw-user-get-started` skill) to install NemoClaw and launch your first sandbox.

All NemoClaw commands run inside WSL, not in PowerShell.

## Troubleshooting

For Windows-specific troubleshooting, refer to the Windows Subsystem for Linux section (use the `nemoclaw-user-reference` skill) in the Troubleshooting guide.
