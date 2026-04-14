<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Windows Prerequisites

NemoClaw runs inside Windows Subsystem for Linux (WSL 2) on Windows.
Complete these steps before following the Quickstart (see the `nemoclaw-user-get-started` skill).
Linux and macOS users do not need this page and can go directly to the Quickstart.

> **Note:** This guide has been tested on x86-64.

## Prerequisites

Verify the following before you begin:

- Windows 10 (build 19041 or later) or Windows 11.
- Hardware requirements are the same as the Quickstart (see the `nemoclaw-user-get-started` skill).

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

If you plan to select Ollama as your inference provider during onboarding, install it inside WSL before running the NemoClaw installer:

```console
$ curl -fsSL https://ollama.com/install.sh | sh
```

If Ollama is also running on the Windows side, quit it before running `nemoclaw onboard` (system tray > right-click > Quit).
The Windows and WSL instances bind to the same port and conflict.

The onboarding process starts Ollama in WSL if it is not already running.
You can also start it yourself beforehand with `ollama serve`.

## Next Step

Your Windows environment is ready.
Open a WSL terminal (type `wsl` in PowerShell, or open Ubuntu from Windows Terminal) and continue with the Quickstart (see the `nemoclaw-user-get-started` skill) to install NemoClaw and launch your first sandbox.

All NemoClaw commands run inside WSL, not in PowerShell.

## Troubleshooting

For Windows-specific troubleshooting, see the Windows Subsystem for Linux section (see the `nemoclaw-user-reference` skill) in the Troubleshooting guide.
