---
name: holoscan-install-source
version: "1.0.0"
description: "Build Holoscan SDK from source via the in-tree ./run script. Use only when published packages don't meet the user's needs."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - install
    - source
    - build
    - cmake
---

# Holoscan SDK — Build from Source

## Purpose

Build the Holoscan SDK from the `nvidia-holoscan/holoscan-sdk` source tree using its `./run` script (which builds inside a Docker container), producing a local install tree consumable as a CMake dependency.

## Prerequisites

- Linux host with NVIDIA GPU + driver (`nvidia-smi`).
- `git`, Docker with NVIDIA Container Toolkit (`docker run --gpus all` works), and `docker-buildx-plugin`.
- ~20 GB free disk for the build container + build/install trees.
- 10–30 min for a clean first build.

## Limitations

- Only recommended when published packages (Conda / container / apt / wheel) don't fit — debug symbols, custom CMake options, or unsupported configs.
- Still requires Docker — the `./run` script builds inside a container; this is not a true bare-metal build.
- Cross-compiling to aarch64 needs `qemu-user-static` on the host.

## Step 0: Consult the Official Install Instructions

Always fetch the "Build from Source" section of `https://docs.nvidia.com/holoscan/sdk-user-guide/sdk_installation.html` (and the linked GitHub `README.md` / `DEVELOP.md` for the chosen tag) before building. Extract: required `./run` flags for the target architecture and CUDA major, supported branches/tags, any Dockerfile patches called out for the release, and the test names recommended for verification. If the doc disagrees with anything below, the doc wins.

## Step 1: Prerequisites

Check that git and Docker (with GPU passthrough) are available:

```bash
git --version
docker --version
docker run --rm --gpus all ubuntu:22.04 nvidia-smi
```

- If Docker is missing → help install from https://docs.docker.com/engine/install/
- If GPU passthrough fails → install NVIDIA Container Toolkit:
  ```bash
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
  ```
- If Docker buildx is missing: `sudo apt-get install docker-buildx-plugin`

## Step 2: Clone the Repository

Clone repo to ~/holoscan/holoscan-sdk if needed

```bash
mkdir -p ~/holoscan/
git clone https://github.com/nvidia-holoscan/holoscan-sdk.git
cd ~/holoscan/holoscan-sdk
```

To build a specific release tag (recommended for stability):

```bash
git tag | grep -E '^v[0-9]' | sort -V | tail -5   # list recent tags
git checkout v<VERSION>                             # e.g. v4.1.0
```

## Step 3: Build

The `./run build` script handles container creation, CMake configuration, compilation, and install in one step. Warn the user this takes **10–30 minutes** on first run (downloads base image + compiles).

```bash
./run build
```

Common options:

| Flag | Purpose |
|------|---------|
| `--type debug` | Debug build (symbols, no optimization) |
| `--type RelWithDebInfo` | Release + debug symbols |
| `--arch aarch64` | Cross-compile for ARM64 (needs `sudo apt install qemu-user-static`) |
| `--gpu igpu` | iGPU build for Jetson/IGX |
| `--dryrun` | Preview commands without executing |

If CMake cache errors occur after changing options:

```bash
./run clear_cache && ./run build
```

Output lands in these folders, and can be retrieved with `./run get_build_dir` and `./run get_install_dir`
* Build dir: `build-cu<N>-<arch>/`
* Install dir: `install-cu<N>-<arch>/`.

## Step 4: Run Tests

Run the following tests
* EXAMPLE_CPP_HELLO_WORLD_TEST
* EXAMPLE_PYTHON_HELLO_WORLD_TEST
* EXAMPLE_CPP_TENSOR_INTEROP_TEST
* EXAMPLE_PYTHON_TENSOR_INTEROP_TEST
* EXAMPLE_CPP_VIDEO_REPLAYER_TEST
* EXAMPLE_PYTHON_VIDEO_REPLAYER_TEST

```bash
./run test
```

To run all six required tests at once, use a single-quoted regex (the `|` must be quoted to prevent bash from treating it as a pipe):

```bash
./run test --options "-R 'EXAMPLE_CPP_HELLO_WORLD_TEST|EXAMPLE_PYTHON_HELLO_WORLD_TEST|EXAMPLE_CPP_TENSOR_INTEROP_TEST|EXAMPLE_PYTHON_TENSOR_INTEROP_TEST|EXAMPLE_CPP_VIDEO_REPLAYER_TEST|EXAMPLE_PYTHON_VIDEO_REPLAYER_TEST' --output-on-failure"
```

Run a specific test by name or regex:

```bash
./run test --name <test_name>
./run test --options "-R '<regex>' --output-on-failure"
./run test --verbose
```

**Important:** Always single-quote the regex string when it contains `|` — without quotes, bash interprets `|` as a pipe and the command fails with `command not found`.

Expected: all tests pass. Note any failures and report them to the user before continuing.

## Step 5: Point Applications at the Install Tree

Once built, applications can use the install tree as a CMake dependency. Give the user this path:

```
/path/to/holoscan-sdk/install-cu<N>-<arch>/
```

They can set `Holoscan_ROOT` or `CMAKE_PREFIX_PATH` to this directory when building their own applications.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `bash: <TEST_NAME>: command not found` when running tests | The regex contains `\|` — wrap it in single quotes: `--options "-R '<regex>'"` |
| CMake cache errors after option change | `./run clear_cache && ./run build` |
| Docker buildx not found | `sudo apt-get install docker-buildx-plugin` |
| GPU not visible inside build container | Verify NVIDIA Container Toolkit and re-run `sudo nvidia-ctk runtime configure --runtime=docker` |
| Cross-compile fails (aarch64) | Install qemu: `sudo apt-get install qemu-user-static` |
