# NemoClaw on DGX Spark

> **WIP** — This page is actively being updated as we work through Spark installs. Expect changes.

## Prerequisites

- **Docker** (pre-installed, v28.x)
- **Node.js 22** (installed by the install.sh)
- **OpenShell CLI** (installed via the Quick Start steps below)
- **NVIDIA API Key** from [build.nvidia.com](https://build.nvidia.com) — prompted on first run

## Quick Start

```bash
# Install OpenShell:
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh

# Clone NemoClaw:
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw

# Spark-specific setup (For details see [What's Different on Spark](#whats-different-on-spark))
sudo ./scripts/setup-spark.sh

# Install NemoClaw using the NemoClaw/install.sh:
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

## Uninstall (perform this before re-installing)

```bash
# Uninstall NemoClaw (Remove OpenShell sandboxes, gateway, NemoClaw providers, related Docker containers, images, volumes and configs)
nemoclaw uninstall
```

## Setup Local Inference (Ollama)

Use this to run inference locally on the DGX Spark's GPU instead of routing to cloud.

### Verify the NVIDIA Container Runtime

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

If this fails, configure the NVIDIA runtime and restart Docker:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify it is running:

```bash
curl http://localhost:11434
```

### Pull and Pre-load a Model

Download Nemotron 3 Super 120B (~87 GB; may take several minutes):

```bash
ollama pull nemotron-3-super:120b
```

Run it briefly to pre-load weights into unified memory, then exit:

```bash
ollama run nemotron-3-super:120b
# type /bye to exit
```

### Configure Ollama to Listen on All Interfaces

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

### Install OpenShell and NemoClaw

```bash
# If the OpenShell and NemoClaw are already installed, uninstall them. A fresh NemoClaw install will run onboard with local inference options.
nemoclaw uninstall

# Install OpenShell and NemoClaw
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

When prompted for **Inference options**, select **Local Ollama**, then select the model you pulled.

### Connect and Test

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

## What's Different on Spark

DGX Spark ships **Ubuntu 24.04 + Docker 28.x** but no k8s/k3s. OpenShell embeds k3s inside a Docker container, which hits two problems on Spark:

### 1. Docker permissions

```text
Error in the hyper legacy client: client error (Connect)
  Permission denied (os error 13)
```

**Cause**: Your user isn't in the `docker` group.
**Fix**: `setup-spark` runs `usermod -aG docker $USER`. You may need to log out and back in (or `newgrp docker`) for it to take effect.

### 2. cgroup v2 incompatibility

```text
K8s namespace not ready
openat2 /sys/fs/cgroup/kubepods/pids.max: no
Failed to start ContainerManager: failed to initialize top level QOS containers
```

**Cause**: Spark runs cgroup v2 (Ubuntu 24.04 default). OpenShell's gateway container starts k3s, which tries to create cgroup v1-style paths that don't exist. The fix is `--cgroupns=host` on the container, but OpenShell doesn't expose that flag.

**Fix**: `setup-spark` sets `"default-cgroupns-mode": "host"` in `/etc/docker/daemon.json` and restarts Docker. This makes all containers use the host cgroup namespace, which is what k3s needs.

## Manual Setup (if setup-spark doesn't work)

### Fix Docker cgroup namespace

```bash
# Check if you're on cgroup v2
stat -fc %T /sys/fs/cgroup/
# Expected: cgroup2fs

# Add cgroupns=host to Docker daemon config
sudo python3 -c "
import json, os
path = '/etc/docker/daemon.json'
d = json.load(open(path)) if os.path.exists(path) else {}
d['default-cgroupns-mode'] = 'host'
json.dump(d, open(path, 'w'), indent=2)
"

# Restart Docker
sudo systemctl restart docker
```

### Fix Docker permissions

```bash
sudo usermod -aG docker $USER
newgrp docker  # or log out and back in
```

## Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| cgroup v2 kills k3s in Docker | Fixed in `setup-spark` | `daemon.json` cgroupns=host |
| Docker permission denied | Fixed in `setup-spark` | `usermod -aG docker` |
| CoreDNS CrashLoop after setup | Fixed in `fix-coredns.sh` | Uses container gateway IP, not 127.0.0.11 |
| Image pull failure (k3s can't find built image) | OpenShell bug | `openshell gateway destroy && openshell gateway start`, re-run setup |
| GPU passthrough | Untested on Spark | Should work with `--gpu` flag if NVIDIA Container Toolkit is configured |

## Architecture Notes

```text
DGX Spark (Ubuntu 24.04, cgroup v2)
  └── Docker (28.x, cgroupns=host)
       └── OpenShell gateway container
            └── k3s (embedded)
                 └── nemoclaw sandbox pod
                      └── OpenClaw agent + NemoClaw plugin
```
