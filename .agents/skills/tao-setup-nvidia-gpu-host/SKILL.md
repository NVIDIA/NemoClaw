---
name: tao-setup-nvidia-gpu-host
description: >-
  Host setup for TAO GPU backends. Checks and, after user approval, installs
  NVIDIA driver branch 580, CUDA Toolkit 13.0, and NVIDIA Container Toolkit
  1.19.0 for Docker/local-Docker and Kubernetes GPU worker hosts. The
  `--check-only` path works on any Linux distribution; `--install` automates
  debian-family (Ubuntu/Debian/Pop!_OS/Mint/Zorin/Raspbian), rhel-family
  (Fedora/RHEL/Rocky/AlmaLinux), and suse-family (openSUSE/SLES) hosts, and
  prints actionable manual-install steps for everything else.
license: Apache-2.0
compatibility: Runs `--check-only` on any Linux distribution. `--install` automates Ubuntu 22.04/24.04 + Debian 12 (apt), Fedora + RHEL/Rocky/AlmaLinux 9/10 (dnf), and openSUSE Leap / SLES 15 (zypper). Requires sudo/root, internet access to NVIDIA package repositories (and download.docker.com on rhel-family), and an x86_64 or aarch64 (sbsa) host. Other distributions (Arch, Alpine, Gentoo, NixOS, …) get a clear error that names the version targets and the NVIDIA install-guide URL.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- setup
- nvidia
- cuda
- docker
- kubernetes
---

# NVIDIA GPU Host Setup

Use this setup skill before TAO workflows run on the `docker`, `local-docker`,
or `kubernetes` backend. It standardizes the host GPU runtime on:

- NVIDIA driver branch `580` (open kernel module preferred)
- CUDA Toolkit package `cuda-toolkit-13-0`
- NVIDIA Container Toolkit `1.19.0`
- Docker engine — only installed for `docker` / `local-docker` backends and
  only when Docker is missing. The package picked depends on the distro
  family (`docker.io` on Debian-family by default, `moby-engine` /
  `docker-ce` from `download.docker.com` on RHEL-family, `docker` on
  SUSE-family). Pass `--skip-docker-install` to opt out.

The check is safe and read-only by default — it works on any Linux
distribution because it only probes `nvidia-smi`, the CUDA toolkit path,
the installed container-toolkit package version (via `dpkg`/`rpm`/the
`nvidia-ctk` binary version), and the Docker daemon's NVIDIA runtime.

Installation must be explicitly authorized by the user and rerun with
`--install`. The install path is automated for these distro families:

| Family | Tested distros | Manager | Notes |
|---|---|---|---|
| debian | Ubuntu 22.04 / 24.04, Debian 12 (and derivatives Pop!_OS, Mint, Zorin, Raspbian, KDE Neon, etc. via `UBUNTU_CODENAME` / `VERSION_CODENAME`) | `apt-get` | Adds NVIDIA `cuda-keyring` + Container Toolkit `.list`. Docker via `docker.io` (override `$DOCKER_PACKAGE_DEBIAN`). |
| rhel | Fedora 39+, RHEL / Rocky / AlmaLinux 9 and 10 | `dnf` (or `yum`) | Adds NVIDIA `cuda-<distro>.repo` + Container Toolkit `.repo`. Docker via Fedora `moby-engine` when available, otherwise `docker-ce` from `download.docker.com`. |
| suse | openSUSE Leap 15, SLES 15 | `zypper` | Adds the same NVIDIA `.repo` files. Docker via the distribution `docker` package. |
| other (Arch, Alpine, Gentoo, NixOS, FreeBSD, …) | n/a | n/a | `--install` exits with a clear error listing the version targets and the NVIDIA install-guide URLs. Install manually, then rerun `--check-only`. |

## Quick Start

From the skill bank root:

```bash
# Check the local Docker backend host.
bash skills/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh --backend docker --check-only

# Install or repair after user approval (prompts for confirmation; see the note below for non-interactive runs).
bash skills/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh --backend docker --install

# Check a Kubernetes GPU worker host.
bash skills/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh --backend kubernetes --check-only
```

> ⚠️ **Note — running non-interactively (agent / skill runs):** a skill run has
> no terminal, so the installer's `Continue? [y/N]` confirmation cannot be
> answered. After running `--check-only` to preview what is missing and getting
> the user's explicit approval, append the assume-yes flag (`--yes`) to the
> `--install` command so it proceeds without a prompt. That auto-confirms
> installation of system packages (NVIDIA driver branch 580, CUDA Toolkit 13.0,
> NVIDIA Container Toolkit, and — for Docker backends — Docker) and modifies the
> host: it adds NVIDIA package repositories, may restart Docker, and adds the
> invoking user to the `docker` group, so only do this on a host you control and
> have the privileges to change. When a person runs `--install` directly at a
> terminal, the script instead prompts with the exact package list before making
> any changes.

In an installed plugin copy that exposes `skills/`, use:

```bash
bash skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh --backend docker --check-only
```

## Workflow Contract

Docker and Kubernetes workflows must run the check before submitting GPU work:

```bash
SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT:-$PWD}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
[ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT:-$PWD}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

bash "$SETUP_SCRIPT" --backend docker --check-only || {
  echo "MISSING: TAO GPU host runtime is not ready."
  echo "After user approval, run (append --yes for non-interactive agent runs):"
  echo "  bash \"$SETUP_SCRIPT\" --backend docker --install"
  exit 1
}
```

Never install silently. If the check fails, explain what is missing, ask the
user to authorize the fix, then run the install command and rerun the check.

## What The Installer Does

The installer dispatches on the detected distribution family. On every
supported family it adds NVIDIA's CUDA and Container Toolkit repositories
(if missing), installs the pinned runtime packages, optionally installs
Docker, wires the NVIDIA Docker runtime, and adds the invoking user to
the `docker` group.

Common steps (all families):

1. Adds NVIDIA's CUDA repository if missing (apt `cuda-keyring` deb,
   `cuda-<distro>.repo` for dnf/zypper).
2. Adds NVIDIA's Container Toolkit repository if missing (`.list` for apt,
   `.repo` for dnf/zypper).
3. Installs the matching kernel header / devel package for the running
   kernel.
4. Installs the driver branch 580 packages, `cuda-toolkit-13-0`, and the
   Container Toolkit pinned to `1.19.0` (the dpkg-suffixed `1.19.0-1` is
   the same upstream version expressed for apt).
5. For Docker backends and when Docker is missing, installs Docker
   (override / opt-out flags below), enables/starts the daemon, then runs
   `nvidia-ctk runtime configure --runtime=docker` and restarts Docker
   when `systemctl` is available.
6. Adds the invoking user (`$SUDO_USER` if available, else `$USER`) to the
   `docker` group so subsequent shells can run `docker` without `sudo` —
   opt out with `--skip-docker-group`. **The new group membership does not
   take effect in the current shell**: log out and back in, or run
   `newgrp docker` in each new shell.
7. Attempts `modprobe nvidia` so verification can pass before reboot.

Family-specific package selections:

| Step | debian-family | rhel-family | suse-family |
|---|---|---|---|
| Kernel headers | `linux-headers-$(uname -r)` | `kernel-devel-$(uname -r)`, `kernel-headers-$(uname -r)` | `kernel-default-devel` |
| Driver | `nvidia-driver-pinning-580`, `nvidia-open-580` (override: `$NVIDIA_DRIVER_PACKAGE_DEBIAN`) | `nvidia-driver-cuda`, `kmod-nvidia-open-dkms` (override: `$NVIDIA_DRIVER_PACKAGE_RHEL`, `$NVIDIA_DRIVER_KMOD_RHEL`) | `nvidia-open-driver-G06-signed-kmp-default` (override: `$NVIDIA_DRIVER_PACKAGE_SUSE`) |
| CUDA toolkit | `cuda-toolkit-13-0` | `cuda-toolkit-13-0` | `cuda-toolkit-13-0` |
| Container Toolkit | `nvidia-container-toolkit=1.19.0-1` + base/tools/libs | `nvidia-container-toolkit-1.19.0` + base/tools/libs | same as rhel |
| Docker | `docker.io` (override: `$DOCKER_PACKAGE_DEBIAN`) | `moby-engine`+`moby-cli` on Fedora when available, else `docker-ce docker-ce-cli containerd.io` from `download.docker.com` | `docker` |

## Verification

After installation, verify:

```bash
nvidia-smi
/usr/local/cuda-13.0/bin/nvcc --version
docker info --format '{{json .Runtimes}}' | grep nvidia
sudo docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

Expected `nvidia-smi` output includes driver `580.x` and CUDA Version `13.0`.
Expected `nvcc` output includes `release 13.0`.

## Kubernetes Notes

For self-managed Kubernetes clusters, run the host installer on every GPU
worker node or bake the same package set into the node image before installing
the NVIDIA GPU Operator or device plugin.

The workflow check also warns if `kubectl` is available but the cluster reports
no `nvidia.com/gpu` allocatable capacity. In that case, install/configure the
NVIDIA GPU Operator after the worker host runtime is ready:

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update
helm install --wait gpu-operator -n gpu-operator --create-namespace nvidia/gpu-operator
```

Managed Kubernetes providers may own driver installation through node images or
GPU Operator policy. Do not overwrite a provider-managed GPU node without user
approval and a rollback plan.

## Failure Modes

**Unsupported distribution family**: `--install` automates debian-, rhel-,
and suse-family hosts. On Arch, Alpine, Gentoo, NixOS, FreeBSD, or anything
without `/etc/os-release` (e.g. macOS), the script exits with a clear error
that lists the four version targets and the upstream NVIDIA install-guide
URLs:

- `https://docs.nvidia.com/cuda/cuda-installation-guide-linux/`
- `https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html`
- `https://docs.docker.com/engine/install/`

Install those four pieces using your distribution's package manager and
rerun the script with `--check-only` to verify. The check is universally
portable — it only queries the binaries / package databases — so once the
runtime is in place the workflow contract is satisfied regardless of the
underlying distro.

**Unsupported Ubuntu/Debian derivative**: When `ID` is e.g. `pop`, `mint`,
`zorin`, `raspbian`, or another debian-family derivative, the script maps
the host onto the upstream Ubuntu/Debian CUDA repo via `UBUNTU_CODENAME` /
`VERSION_CODENAME` (`focal`/`jammy`/`noble` → Ubuntu 20.04/22.04/24.04;
`bullseye`/`bookworm`/`trixie` → Debian 11/12/12). If the host's codename
doesn't match a known upstream release, `--install` exits with the same
manual-install guidance described above.

**Docker not installed**: `--check-only` reports `MISSING: Docker is not
installed` and prints the exact rerun command appropriate to the detected
distro family. The default `--install` path installs Docker (`docker.io` /
`moby-engine` / `docker-ce` / `docker` depending on family), enables/starts
the daemon, configures the NVIDIA runtime, and adds the invoking user to
the `docker` group. If you prefer to manage Docker yourself, install it
before rerunning the script or pass `--skip-docker-install`.

**Docker installed but `docker run` still needs sudo**: The script adds the
invoking user to the `docker` group, but Linux only refreshes group
membership on a new login session. Log out and back in, or run
`newgrp docker` in each new shell, until the new membership is active.

**Docker runtime still missing**: Restart Docker, then rerun
`nvidia-ctk runtime configure --runtime=docker`.

**Driver branch detected != 580**: The driver-branch pin is exact on
debian-family (`nvidia-open-580`). On rhel-/suse-family the script
installs the latest open driver shipped in NVIDIA's CUDA 13.0 repo for
the detected distro, which is always ≥ 580. If your host needs a stricter
pin, set `$NVIDIA_DRIVER_PACKAGE_RHEL` / `$NVIDIA_DRIVER_KMOD_RHEL` /
`$NVIDIA_DRIVER_PACKAGE_SUSE` to the exact package names you want before
running `--install`.

**Driver installed but `nvidia-smi` fails**: Load the module with
`sudo modprobe nvidia` or reboot. Secure Boot may require MOK enrollment on
systems where it is enabled.

**Kubernetes still has no GPU capacity**: Confirm the driver works on each GPU
node with `nvidia-smi`, then check the GPU Operator/device plugin pods and node
labels.
