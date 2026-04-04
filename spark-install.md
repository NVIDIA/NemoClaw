# NemoClaw on DGX Spark

> **WIP** — This page is actively being updated as we work through Spark installs. Expect changes.

This guide walks you through installing and running NemoClaw on an NVIDIA DGX Spark. DGX Spark ships with Ubuntu 24.04 and Docker pre-installed, and current OpenShell releases no longer require a Spark-specific Docker cgroup workaround.

## Prerequisites

Before starting, make sure you have:

- **Docker** (pre-installed on DGX Spark, v28.x/29.x)
- **Node.js 22** (installed automatically by the NemoClaw installer)
- **OpenShell CLI** (installed automatically during NemoClaw onboarding if missing)
- **API key** (cloud inference only) — the onboarding wizard prompts for a provider and key during setup. For example, an NVIDIA API key from [build.nvidia.com](https://build.nvidia.com) for NVIDIA Endpoints, or an OpenAI, Anthropic, or Gemini key for those providers. **If you plan to use local inference with Ollama instead, no API key is needed** — see [Local Inference with Ollama](#local-inference-with-ollama) to set up Ollama before installing NemoClaw.

## Quick Start

```bash
# Clone NemoClaw:
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw

# Install NemoClaw. The standard installer and onboarding flow handle the
# OpenShell CLI and current DGX Spark cgroup behavior automatically:
./install.sh

# Alternatively, you can use the hosted install script:
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

## Verifying Your Install

```bash
# Check sandbox is running
nemoclaw my-assistant connect

# Inside the sandbox, talk to the agent:
openclaw agent --agent main --local -m "hello" --session-id test
```

## Uninstall

To remove NemoClaw and start fresh (e.g., to switch inference providers):

```bash
# Remove OpenShell sandboxes, gateway, NemoClaw providers, related Docker containers, images, volumes and configs
nemoclaw uninstall
```

## Local Inference with Ollama

Use this to run inference locally on the DGX Spark's GPU instead of routing to cloud.

### 1. Verify the NVIDIA Container Runtime

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

If this fails, configure the NVIDIA runtime and restart Docker:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### 2. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify it is running:

```bash
curl http://localhost:11434
```

### 3. Pull and Pre-load a Model

Download Nemotron 3 Super 120B (~87 GB; may take several minutes):

```bash
ollama pull nemotron-3-super:120b
```

Run it briefly to pre-load weights into unified memory, then exit:

```bash
ollama run nemotron-3-super:120b
# type /bye to exit
```

### 4. Configure Ollama to Listen on All Interfaces

By default Ollama binds to `127.0.0.1`, which is not reachable from inside the sandbox container. Configure it to listen on all interfaces:

> **Note:** `OLLAMA_HOST=0.0.0.0` exposes Ollama on your network. If you're not on a trusted LAN, restrict access with host firewall rules (`ufw`, `iptables`, etc.).

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf

sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Verify Ollama is listening on all interfaces:

```bash
sudo ss -tlnp | grep 11434
```

### 5. Install (or Reinstall) NemoClaw with Local Inference

If you have **not installed NemoClaw yet**, continue with the [Quick Start](#quick-start) steps above. When the onboarding wizard prompts for **Inference options**, select **Local Ollama** and choose the model you pulled.

If NemoClaw is **already installed** with a cloud provider and you want to switch to local inference, uninstall and reinstall:

```bash
nemoclaw uninstall
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

When prompted for **Inference options**, select **Local Ollama**, then select the model you pulled.

### 6. Connect and Test

```bash
# Connect to the sandbox
nemoclaw my-assistant connect
```

Inside the sandbox, first verify `inference.local` is reachable directly (must use HTTPS — the proxy intercepts `CONNECT inference.local:443`):

```bash
curl -sf https://inference.local/v1/models
# Expected: JSON response listing the configured model
# Exits non-zero on HTTP errors (403, 503, etc.) — failure here indicates a proxy routing regression
```

Then talk to the agent:

```bash
openclaw agent --agent main --local -m "Which model and GPU are in use?" --session-id test
```

## Troubleshooting

### Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| cgroup v2 kills k3s in Docker | Resolved in current OpenShell releases | Use the standard installer and onboard flow |
| Docker permission denied | Host-specific | Ensure your user can access the Docker daemon |
| CoreDNS CrashLoop after setup | Fixed in `fix-coredns.sh` | Uses container gateway IP, not 127.0.0.11 |
| Image pull failure (k3s can't find built image) | OpenShell bug | `openshell gateway destroy && openshell gateway start`, re-run setup |
| GPU passthrough | Untested on Spark | Should work with `--gpu` flag if NVIDIA Container Toolkit is configured |
| `pip install` fails with system packages | Known | Use a venv (recommended) or `--break-system-packages` (last resort, can break system tools) |
| Port 3000 conflict with AI Workbench | Known | AI Workbench Traefik proxy uses port 3000 (and 10000); use a different port for other services |
| Network policy blocks NVIDIA cloud API | By design | Ensure `integrate.api.nvidia.com` is in the sandbox network policy if using cloud inference |

### Manual Setup

If onboarding reports that Docker is missing or unreachable, fix Docker access on the host and rerun `nemoclaw onboard`.

## Technical Reference

### Web Dashboard

The OpenClaw gateway includes a built-in web UI. Access it at:

```text
http://127.0.0.1:18789/#token=<your-gateway-token>
```

Find your gateway token in `~/.openclaw/openclaw.json` under `gateway.auth.token` inside the sandbox.

> **Important**: Use `127.0.0.1` (not `localhost`) — the gateway's origin check requires an exact match. External dashboards like Mission Control cannot currently connect due to the gateway resetting `controlUi.allowedOrigins` on every config reload (see [openclaw#49950](https://github.com/openclaw/openclaw/issues/49950)).

### NIM Compatibility on arm64

Some NIM containers (e.g., Nemotron-3-Super-120B-A12B) ship native arm64 images and run on the Spark. However, many NIM images are amd64-only and will fail with `exec format error`. Check the image architecture before pulling. For models without arm64 NIM support, consider using Ollama or [llama.cpp](https://github.com/ggml-org/llama.cpp) with GGUF models as alternatives.

### What's Different on Spark

DGX Spark ships **Ubuntu 24.04 (Noble) + Docker 28.x/29.x** on **aarch64 (Grace CPU + GB10 GPU, 128 GB unified memory)** but no k8s/k3s. OpenShell embeds k3s inside a Docker container, so the main Spark-specific concerns today are Docker access and using a current OpenShell release.

#### Docker permissions

```text
Error in the hyper legacy client: client error (Connect)
  Permission denied (os error 13)
```

**Cause**: Your user isn't in the `docker` group.
**Fix**: Grant your user access to the Docker daemon, then rerun `nemoclaw onboard`. You may need to log out and back in (or `newgrp docker`) for group membership changes to take effect.

#### cgroup v2 incompatibility (resolved)

```text
K8s namespace not ready
openat2 /sys/fs/cgroup/kubepods/pids.max: no
Failed to start ContainerManager: failed to initialize top level QOS containers
```

**Cause**: Spark runs cgroup v2 (Ubuntu 24.04 default). OpenShell's gateway container starts k3s, which tries to create cgroup v1-style paths that don't exist without host cgroup namespace access.

**Fix**: Recent OpenShell versions set `cgroupns=host` on the gateway container directly ([OpenShell PR #329](https://github.com/NVIDIA/OpenShell/pull/329)). No `default-cgroupns-mode=host` or other `daemon.json` workaround is needed. The standard NemoClaw installer/onboarding flow installs the current OpenShell CLI automatically when it is missing. If you are on an older OpenShell version, upgrade with:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

### Architecture

```text
DGX Spark (Ubuntu 24.04, aarch64, cgroup v2, 128 GB unified memory)
  └── Docker (28.x/29.x)
       └── OpenShell gateway container
            └── k3s (embedded)
                 └── nemoclaw sandbox pod
                      └── OpenClaw agent + NemoClaw plugin
```
