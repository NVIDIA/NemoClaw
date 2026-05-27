<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Prepare macOS for NemoClaw

Use this page when you are preparing a Mac for the first time.
Complete these steps before following the Quickstart (use the `nemoclaw-user-get-started` skill).
Linux users can go directly to the Quickstart.
Windows users should use the Windows preparation guide (use the `nemoclaw-user-get-started` skill).

**Note:**

NemoClaw supports both Apple Silicon and Intel Macs through the Docker-driver OpenShell gateway path.
Apple Silicon is the most commonly tested macOS path.

## Prerequisites

Verify the following before you begin:

- macOS on Apple Silicon or Intel.
- Hardware requirements are the same as the Quickstart (use the `nemoclaw-user-get-started` skill).
- Administrator access for installing developer tools and a container runtime.
- A running container runtime: Docker Desktop or Colima.

## Install Xcode Command Line Tools

Install Apple's command line developer tools:

```bash
xcode-select --install
```

The installer and Node.js toolchain rely on these tools.
If the command reports that tools are already installed, continue to the next step.

## Choose a Container Runtime

NemoClaw needs Docker-compatible container access.
Use one of the tested options below.

### Option 1: Docker Desktop

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start the application.
Wait until Docker reports that it is running, then verify it from a terminal:

```bash
docker info
```

Docker Desktop is the simplest macOS path for most first-time users.
If `docker info` cannot connect, open Docker Desktop and wait for startup to finish before retrying.

### Option 2: Colima

Install Colima and Docker CLI with Homebrew:

```bash
brew install colima docker
```

Start Colima with enough resources for the sandbox image build:

```bash
colima start --cpu 4 --memory 8 --disk 40
```

Then verify Docker access:

```bash
docker info
```

**Tip:**

Default Colima resources are often too small for the sandbox image build.
If onboarding stalls or the build is killed, increase CPU, memory, and disk before retrying.

NemoClaw checks the common Colima socket locations automatically.
If Colima is running but Docker is still unreachable, see the Colima socket troubleshooting entry (use the `nemoclaw-user-reference` skill).

## Install Node.js

NemoClaw requires Node.js 22.16 or later and npm 10 or later.
You can install Node.js with Homebrew:

```bash
brew install node@22
```

If Homebrew does not put Node.js on your `PATH`, add its shell environment output to your shell profile as directed by `brew`.
You can also use `nvm`, `fnm`, or another Node.js version manager as long as `node --version` and `npm --version` resolve in the terminal where you run the installer.

Verify the versions:

```bash
node --version
npm --version
```

## Set Up Local Inference with Ollama (Optional)

If you plan to select Ollama during onboarding, install it before running the NemoClaw installer:

```bash
brew install ollama
```

Start Ollama:

```bash
ollama serve
```

Keep the Ollama process running in another terminal, or configure it as a background service with your preferred macOS service manager.
During onboarding, NemoClaw can also guide you through Ollama install or upgrade prompts when it detects a missing or unsupported host installation.

Do not run multiple Ollama daemons on port `11434`.
If another local model runtime already uses that port, stop it or move one of the services before running `nemoclaw onboard`.

## Next Step

Your macOS environment is ready.
Continue with the Quickstart (use the `nemoclaw-user-get-started` skill) to install NemoClaw and launch your first sandbox:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Run the command from the terminal where `node`, `npm`, and `docker` are available.

## Troubleshooting

For macOS-specific troubleshooting, refer to the macOS first-run failures (use the `nemoclaw-user-reference` skill) and Colima socket (use the `nemoclaw-user-reference` skill) sections in the Troubleshooting guide.

Common checks:

- Open Docker Desktop or start Colima before running the installer.
- Re-run `xcode-select --install` if developer tools are missing or broken after a macOS upgrade.
- Use `docker info` from the same terminal where you run the installer.
- Increase Colima resources if the sandbox image build stalls or exits unexpectedly.
