---
name: holoscan-install-debian
version: "1.0.0"
description: "Install Holoscan SDK natively on Ubuntu via apt. Use for C++ installs on Ubuntu; pair with /holoscan-install-wheel for Python."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - install
    - debian
    - apt
    - ubuntu
---

# Holoscan Debian/apt Installation

## Purpose

Install the Holoscan SDK C++ runtime + headers on Ubuntu using NVIDIA's apt repo, selecting the right `holoscan-cuda-*` package for the host's CUDA driver and verifying with the bundled C++ examples.

## Prerequisites

- Ubuntu x86_64 (22.04 / 24.04) or ARM64 (Jetson / IGX) with an NVIDIA GPU and working driver (`nvidia-smi`).
- `sudo` and network access to `developer.download.nvidia.com` and `docs.nvidia.com`.
- `cuda-keyring` package (Step 2 installs it if missing).

## Limitations

- No Python bindings from apt — pair with `/holoscan-install-wheel` if the user needs Python.
- Ubuntu-only. Other distros must use the container or wheel install.
- Package variant must match the host CUDA driver (`holoscan-cuda-12` vs `holoscan-cuda-13`); wrong variant → "CUDA driver version is insufficient".

## Step 0: Consult the Official Install Instructions

Fetch the Debian/apt section of `https://docs.nvidia.com/holoscan/sdk-user-guide/sdk_installation.html` before installing. Extract:

- Exact package names (`holoscan-cuda-12`, `holoscan-cuda-13`, `holoscan`)
- Supported Ubuntu versions
- The cuda-keyring URL for the right distro

If the doc disagrees with anything below, the doc wins.

Determine OS version and CUDA variant if not already known — run in parallel:

```bash
lsb_release -a 2>/dev/null || cat /etc/os-release
nvidia-smi 2>&1 | head -5
```

**CUDA variant rule — pick the apt package:**

| nvidia-smi CUDA Version | Package |
|------------------------|---------|
| 13.x+ | `holoscan-cuda-13` |
| 12.x (on IGX) | `holoscan` |
| 12.x (not on IGX) | `holoscan-cuda-12` |
| 12.x (nvgpu) | `holoscan-cuda-12` |

## Step 1: Prerequisites Check

```bash
dpkg -l | grep cuda-keyring
dpkg -l | grep -E "holoscan-cuda-(12|13)|^ii  holoscan "
apt-cache show holoscan-cuda-13 holoscan-cuda-12 2>/dev/null | grep -E "^(Package|Version)"
```

Decision rules based on what Step 1 found:

- Skip the keyring step if `cuda-keyring` is already installed.
- Skip `apt-get update` if the repo is already configured and the package is visible in `apt-cache show`.
- **Skip Step 2 entirely** and proceed directly to Step 3 if the correct package variant is already installed (e.g. `holoscan-cuda-12` when targeting cu12).

## Step 2: Install

Skip this step if the package is already installed (detected in Step 1) or if user is on IGX platform.

```bash
# If cuda-keyring missing (adjust ubuntu2204/ubuntu2404 as needed) and not on IGX platform:
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb && sudo apt-get update

sudo apt-get install -y holoscan-cuda-12   # or holoscan-cuda-13
```

## Step 3: Verify

Set the env once for the rest of this step, then run the three C++ checks:

```bash
HS=/opt/nvidia/holoscan
export LD_LIBRARY_PATH=$HS/lib
export HOLOSCAN_INPUT_PATH=$HS/data
ulimit -s 32768

ls $HS/examples/{hello_world,tensor_interop,video_replayer}/

# hello_world — expected: "Hello World!"
$HS/examples/hello_world/cpp/hello_world

# tensor_interop — expected: tensors doubling each pass, "Graph execution finished."
# If "CUDA driver version is insufficient": swap package variant:
#   sudo apt-get remove -y holoscan-cuda-13 && sudo apt-get install -y holoscan-cuda-12
$HS/examples/tensor_interop/cpp/tensor_interop

# video_replayer (10 frames, headless) — expected: Vulkan selects NVIDIA GPU, "Graph execution finished."
# Always run headless: works with or without a display, avoids GUI failure modes over SSH.
ls $HS/data/racerx 2>/dev/null || sudo $HS/examples/download_example_data
python3 -c "
c=open('$HS/examples/video_replayer/cpp/video_replayer.yaml').read()
c=c.replace('count: 0','count: 10').replace('repeat: true','repeat: false').replace('realtime: true','realtime: false')
c=c.replace('  width: 854','  headless: true\n  width: 854')
open('/tmp/vr.yaml','w').write(c)"
$HS/examples/video_replayer/cpp/video_replayer --config /tmp/vr.yaml
```

## Step 4: Give the User the Reusable Env Snippet

Once verified, share this snippet with user and suggest adding it to their shell startup file (e.g., `~/.bashrc`) if they want it to persist across sessions:

```bash
export LD_LIBRARY_PATH=/opt/nvidia/holoscan/lib:${LD_LIBRARY_PATH}
export HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data
ulimit -s 32768
```

Then offer next steps:
- Add Python support: `/holoscan-install-wheel`
- Explore examples: `ls /opt/nvidia/holoscan/examples/`
- Walk through a specific example: `/explain-example`
- Start building a custom Holoscan application

## Troubleshooting

- **`python3 -c "import holoscan"` fails after apt install.** Expected — the Debian package has been C++ only since v3.0.0. Run `/holoscan-install-wheel` to add Python bindings.
- **"CUDA driver version is insufficient" when running an example.** Wrong package variant. Re-check `nvidia-smi` CUDA Version and swap variants: `sudo apt-get remove -y holoscan-cuda-13 && sudo apt-get install -y holoscan-cuda-12` (or vice versa).
- **`E: Unable to locate package holoscan-cuda-12`.** `cuda-keyring` not installed or repo not yet pulled. Run the keyring + `apt-get update` block in Step 2 (adjust `ubuntu2204`/`ubuntu2404` to match the host).
- **Segmentation fault when launching an example.** `ulimit -s 32768` not set in the current shell. Prepend it to the command (Step 3 pattern).
- **`error while loading shared libraries: libholoscan_core.so`.** `LD_LIBRARY_PATH` is unset. Use the env snippet from Step 4 — `export LD_LIBRARY_PATH=/opt/nvidia/holoscan/lib`.
- **`video_replayer` can't find data.** Set `HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data`, or run `sudo /opt/nvidia/holoscan/examples/download_example_data` to fetch the `racerx` dataset.
