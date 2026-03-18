# NemoClaw on DGX Spark

## Quick Start

```bash
# One-command install
curl -fsSL https://nvidia.com/nemoclaw.sh | sudo bash

# Or clone and install manually
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
sudo npm install -g .

# Spark-specific setup (configures Docker for cgroup v2, then runs normal setup)
nemoclaw setup-spark
```

That's it. `setup-spark` handles everything below automatically.

## What's Different on Spark

DGX Spark ships **Ubuntu 24.04 (Noble) + Docker 28.x/29.x** on **aarch64 (Grace CPU + GB10 GPU)** but no k8s/k3s. OpenShell embeds k3s inside a Docker container, which hits two problems on Spark:

### 1. Docker permissions

```
Error in the hyper legacy client: client error (Connect)
  Permission denied (os error 13)
```

**Cause**: Your user isn't in the `docker` group.
**Fix**: `setup-spark` runs `usermod -aG docker $USER`. You may need to log out and back in (or `newgrp docker`) for it to take effect.

### 2. cgroup v2 incompatibility

```
K8s namespace not ready
openat2 /sys/fs/cgroup/kubepods/pids.max: no
Failed to start ContainerManager: failed to initialize top level QOS containers
```

**Cause**: Spark runs cgroup v2 (Ubuntu 24.04 default). OpenShell's gateway container starts k3s, which tries to create cgroup v1-style paths that don't exist. The fix is `--cgroupns=host` on the container, but OpenShell doesn't expose that flag.

**Fix**: `setup-spark` sets `"default-cgroupns-mode": "host"` in `/etc/docker/daemon.json` and restarts Docker. This makes all containers use the host cgroup namespace, which is what k3s needs.

## Prerequisites

These should already be on your Spark:

- **Docker** (pre-installed, v28.x)
- **Node.js 22** — if not installed:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **OpenShell CLI**:
  ```bash
  ARCH=$(uname -m)  # aarch64 on Spark
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/openshell-linux-${ARCH}" -o /usr/local/bin/openshell
  chmod +x /usr/local/bin/openshell
  ```
- **NVIDIA API Key** from [build.nvidia.com](https://build.nvidia.com) — prompted on first run

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

### Then run the onboard wizard

```bash
nemoclaw onboard
```

## Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| cgroup v2 kills k3s in Docker | Fixed in `setup-spark` | `daemon.json` cgroupns=host |
| Docker permission denied | Fixed in `setup-spark` | `usermod -aG docker` |
| CoreDNS CrashLoop after setup | Fixed in `fix-coredns.sh` | Uses container gateway IP, not 127.0.0.11 |
| Image pull failure (k3s can't find built image) | OpenShell bug | `openshell gateway destroy && openshell gateway start`, re-run setup |
| GPU passthrough | Untested on Spark | Should work with `--gpu` flag if NVIDIA Container Toolkit is configured |
| `pip install` fails with system packages | Known | Use `--break-system-packages` or a venv for Python packages inside the sandbox |
| Port 3000 conflict with AI Workbench | Known | AI Workbench Traefik proxy uses port 3000 (and 10000); use a different port for other services |
| Network policy blocks NVIDIA cloud API | By design | Ensure `integrate.api.nvidia.com` is in the sandbox network policy if using cloud inference |

## Verifying Your Install

```bash
# Check sandbox is running
openshell sandbox list
# Should show: nemoclaw  Ready

# Test the agent
openshell sandbox connect nemoclaw
# Inside sandbox:
nemoclaw-start openclaw agent --agent main --local -m 'hello' --session-id test

# Monitor network egress (separate terminal)
openshell term
```

## Using Local LLMs

DGX Spark has 128 GB unified memory shared between CPU and GPU. You can run local models alongside the sandbox:

```bash
# Build llama.cpp for GB10 (sm_121)
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
PATH=/usr/local/cuda/bin:$PATH cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=121
cmake --build build --config Release -j$(nproc)

# Run a model (e.g. Nemotron-3-Super-120B Q4_K_M ~78 GB)
./build/bin/llama-server --model <path-to-gguf> --host 0.0.0.0 --port 8000 \
  --n-gpu-layers 999 --ctx-size 32768
```

Then configure your sandbox to use the local model by updating `~/.openclaw/openclaw.json` inside the sandbox with the local provider URL.

> **Note**: Some NIM containers (e.g., Nemotron-3-Super-120B-A12B) ship native arm64 images and run on the Spark. However, many NIM images are amd64-only and will fail with `exec format error`. Check the image architecture before pulling. GGUF models with llama.cpp are a reliable alternative for models without arm64 NIM support.

## Architecture Notes

```
DGX Spark (Ubuntu 24.04, aarch64, cgroup v2, 128 GB unified memory)
  └── Docker (28.x/29.x, cgroupns=host)
  │    └── OpenShell gateway container (k3s embedded)
  │         └── nemoclaw sandbox pod
  │              └── OpenClaw agent + NemoClaw plugin
  └── llama-server (optional, local inference on GB10 GPU)
```
