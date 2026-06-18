# Riva NIM Setup

> **Agent:** Announce each step before presenting it: **Step N/7 — Step Title** (e.g., "**Step 1/7 — Install NVIDIA Drivers**").
>
> **Source of truth.** This skill describes the install workflow and command shapes, which are stable. For per-release minimums — driver version, supported OS list, WSL2 supported models, glibc minimum — **fetch or open the canonical doc page and answer from that.** See [Looking up current information](#looking-up-current-information) below.

## Purpose

Prepare a Linux x86_64 system to run NVIDIA Riva Speech NIM containers. Covers NVIDIA driver installation, Docker setup, NVIDIA Container Toolkit, NGC authentication, and the Riva Python client. Follow the 7 steps in order — this setup only needs to be done once per machine.

## Looking up current information

| Question type | Fetch this page |
|---|---|
| **Minimum driver version, supported GPUs, glibc minimum, supported OSes, WSL2 driver / OS minimums and supported model subset** | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| **Per-model VRAM requirements** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html (TTS / NMT analogs) |
| **Container Toolkit install (latest steps)** | https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html |
| **Docker engine install (per distro)** | https://docs.docker.com/engine/install/ |
| **CUDA install guide for Linux (driver-only on host)** | https://docs.nvidia.com/cuda/cuda-installation-guide-linux |
| **Generate NGC API key** | https://org.ngc.nvidia.com/setup/api-keys |

**Do not infer driver-version or OS minimums from this skill's text.** The prerequisites page is the contract.

## Hardware Requirements

Key invariants (stable):

- CPU: x86_64 only
- NVIDIA AI Enterprise license required for self-hosting
- Install **driver only** — CUDA toolkit is bundled inside the NIM container

For minimum driver / OS / glibc / GPU compute capability — **fetch the prerequisites page**. These rotate per release.

## Instructions

Follow the 7 steps below in order. Steps 1–3 require root/sudo. Steps 4–7 run as a normal user. Complete all steps before attempting to pull or run any Riva NIM container.

### Cache directory ownership

When a Riva NIM command exports model artifacts to a mounted host directory, create the directory and run `sudo chown 1000:1000 <directory>` because the NIM container runs as nvs:1000 inside and needs write access to the mount. Avoid world-writable modes; they let any local user replace exported model artifacts. Avoid `-u $(id -u):$(id -g)` on the `docker run`; `/opt/nim/workspace` inside the container is not writable to arbitrary UIDs.

## Step 1 — Install NVIDIA Drivers

Install drivers via package manager. Skip the CUDA toolkit — it is bundled inside the NIM container.

```bash
# Verify installed driver version
nvidia-smi
```

Check the minimum required driver version on the prerequisites page (cited above) before installing. See the [CUDA installation guide for Linux](https://docs.nvidia.com/cuda/cuda-installation-guide-linux) for package manager install steps.

## Step 2 — Install Docker

Install Docker Engine for your distro: https://docs.docker.com/engine/install/

After install, allow your user to run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
# Log out and back in for this to take effect
```

## Step 3 — Install NVIDIA Container Toolkit

The Container Toolkit lets Docker containers access the host GPU.

```bash
# Install (see full guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify GPU access inside a container:

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

The output must show your driver version and GPU(s). If it does, the environment is ready.

## Step 4 — NGC API Key

1. Open https://org.ngc.nvidia.com/setup/api-keys
2. Create a key with at least **NGC Catalog** under **Services Included**
3. Export it in your terminal:

```bash
export NGC_API_KEY=${your-key-value}
```

To persist across sessions:

```bash
# Bash
echo "export NGC_API_KEY=${your-key-value}" >> ~/.bashrc

# Zsh
echo "export NGC_API_KEY=${your-key-value}" >> ~/.zshrc
```

> **Security note:** Storing credentials in `~/.bashrc` or `~/.zshrc` saves them in plaintext. Any process with read access to those files can extract the key. For production, use a credential manager or a dedicated `.env` file with `chmod 600` permissions and `source` it instead.

## Step 5 — Docker Login to nvcr.io

```bash
echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
```

- Username is the **literal string** `$oauthtoken` (not your NGC username)
- Password is the value of `NGC_API_KEY`

After this, `docker pull nvcr.io/nim/nvidia/<image>:<tag>` will succeed.

## Step 6 — Install Riva Python Client

Required to run the sample inference scripts from `python-clients/`.

```bash
pip install nvidia-riva-client
```

Verify:

```bash
python3 -c "import riva.client; print('Riva client OK')"
```

## Step 7 — Clone Client Repos (Optional)

Sample scripts live in the public repos. Clone whichever you need:

```bash
# Python clients and sample scripts
git clone https://github.com/nvidia-riva/python-clients

# C++ clients (requires Bazel)
git clone https://github.com/nvidia-riva/cpp-clients

# WebSocket bridge (AudioCodes / telephony)
git clone https://github.com/nvidia-riva/websocket-bridge
```

## Examples

**Verify GPU access inside a container (after Step 3):**

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

**Verify Riva Python client (after Step 6):**

```bash
python3 -c "import riva.client; print('Riva client OK')"
```

**Log in to nvcr.io (Step 5):**

```bash
echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
```

## Troubleshooting

- **Username must be `$oauthtoken` literally** — not your NGC username or email.
- **Driver-only install** — do NOT install the CUDA toolkit separately; the NIM container brings its own.
- **Group change requires logout** — `usermod -aG docker` only takes effect after re-login.
- **`glibc` check** — run `ld -v` and compare against the minimum on the prerequisites page (older Ubuntu releases may not meet the requirement).
- **WSL2 on Windows** — use Podman instead of Docker; the supported driver / Ubuntu version / model subset rotate per release. Fetch the prerequisites page for current minimums.

## Limitations

- x86_64 architecture only — WSL2 on Windows requires Podman instead of Docker and supports only a subset of NIMs (verify on prerequisites page)
- NVIDIA AI Enterprise license required for self-hosting Riva NIMs
- Do not install the CUDA toolkit separately — it is bundled inside the NIM container
- Group membership changes (`docker` group) require logout/login to take effect
