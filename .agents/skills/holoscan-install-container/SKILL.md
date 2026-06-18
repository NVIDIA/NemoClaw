---
name: holoscan-install-container
version: "1.0.0"
description: "Install Holoscan SDK via the NGC Docker container. Use for container-based installs; not for native apt/pip/Conda installs."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - install
    - container
    - docker
    - ngc
---

# Holoscan NGC Container Installation

## Purpose

Pull and verify the official Holoscan SDK container from NGC (`nvcr.io/nvidia/clara-holoscan/holoscan`), selecting the right CUDA/arch tag for the host GPU and validating with the bundled Python and C++ examples.

## Prerequisites

- Linux host with an NVIDIA GPU and a working driver (`nvidia-smi`).
- Docker installed and the user in the `docker` group (or `sudo`).
- NVIDIA Container Toolkit installed (`docker run --gpus all` works).
- ~10–20 GB free disk for the image pull.
- Network access to `nvcr.io` and `docs.nvidia.com`.

## Limitations

- Container images cover only the tag matrix below — no Conda/pip env inside.
- GUI examples require X11 forwarding; this skill runs Holoviz headless to avoid that.
- Tag suffix must match the host GPU/driver (cuda13 / cuda12-dgpu / cuda12-igpu) — wrong suffix → CUDA init failures.

## Instructions

- Container repo: `nvcr.io/nvidia/clara-holoscan/holoscan`.
- The doc page at https://docs.nvidia.com/holoscan/sdk-user-guide/sdk_installation.html is canonical — fetch it if anything below disagrees.
- Work through the steps below in order: pick the tag, verify GPU passthrough and pull, verify with the six examples, then hand off the launch command.

## Step 1: Pick the tag

Tag = `<version>-<suffix>`, e.g. `v4.1.0-cuda13`. Get the current SDK version from the doc page above; pick the suffix from `nvidia-smi` (the "CUDA Version" field, top-right of the table header):

| `nvidia-smi` CUDA Version | Suffix |
|---|---|
| 13.x+ | `cuda13` |
| 12.x, Ampere/Ada dGPU | `cuda12-dgpu` |
| 12.x, ARM64 iGPU (nvgpu) | `cuda12-igpu` |

The "CUDA Forward Compatibility mode ENABLED" banner is expected — not an error — when the container ships a newer CUDA minor version than the host driver supports. The forward-compat shim lets the container's CUDA runtime work against the older host driver within the same major version.

## Step 2: Verify GPU passthrough, then pull

```bash
docker run --rm --gpus all ubuntu:22.04 nvidia-smi 2>&1 | tail -5
```

If Docker is missing → install from https://docs.docker.com/engine/install/. If GPU passthrough fails → install the NVIDIA Container Toolkit per https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html, then retry.

Pull (~10–20 GB — warn the user before starting):

```bash
docker pull nvcr.io/nvidia/clara-holoscan/holoscan:<TAG>
```

## Step 3: Verify with six examples

Tests cover: bare Python binding (1a), bare C++ runtime (1b, 2a), Python + Holoviz/Vulkan (2b, 3a), and C++ + Holoviz/Vulkan (3b). Holoviz examples always run headless (inject `headless: true` into the YAML) — this works whether or not a display is attached and avoids GUI failure modes over SSH.

```bash
IMG=nvcr.io/nvidia/clara-holoscan/holoscan:<TAG>
RUN=(docker run --rm --runtime=nvidia --gpus all --cap-add CAP_SYS_PTRACE --ipc=host --ulimit memlock=-1 --ulimit stack=67108864)

# 1a. hello_world (Python) — expect "Hello World!"
"${RUN[@]}" "$IMG" bash -c \
  "ulimit -s 32768 && python3 /opt/nvidia/holoscan/examples/hello_world/python/hello_world.py"

# 1b. hello_world (C++) — expect "Hello World!"
"${RUN[@]}" "$IMG" bash -c \
  "ulimit -s 32768 && /opt/nvidia/holoscan/examples/hello_world/cpp/hello_world"

# 2a. tensor_interop (C++) — expect tensors doubling each pass, "Graph execution finished."
"${RUN[@]}" "$IMG" bash -c \
  "ulimit -s 32768 && /opt/nvidia/holoscan/examples/tensor_interop/cpp/tensor_interop"

# 2b. tensor_interop (Python, 10 frames) — Holoviz, headless. The YAML has no
#     headless field by default, so inject one under `holoviz:`. Expect
#     "message received (count: 10)".
"${RUN[@]}" "$IMG" bash -c "
  ulimit -s 32768
  sed -e 's/count: 0/count: 10/' \
      -e 's/repeat: true/repeat: false/' \
      -e 's/realtime: true/realtime: false/' \
      -e 's/^holoviz:/holoviz:\n  headless: true/' \
      /opt/nvidia/holoscan/examples/tensor_interop/python/tensor_interop.yaml > /tmp/ti.yaml
  cd /opt/nvidia/holoscan/examples/tensor_interop/python
  python3 tensor_interop.py --config /tmp/ti.yaml
"

# 3a. video_replayer (Python, 10 frames) — Holoviz, headless. Inject `headless: true`
#     under `holoviz:` (above `width: 854`). Same sed works for the C++ YAML in 3b —
#     both files share the same `holoviz:` section shape.
"${RUN[@]}" "$IMG" bash -c "
  ulimit -s 32768
  sed -e 's/count: 0/count: 10/' \
      -e 's/repeat: true/repeat: false/' \
      -e 's/realtime: true/realtime: false/' \
      -e 's/^  width: 854/  headless: true\n  width: 854/' \
      /opt/nvidia/holoscan/examples/video_replayer/python/video_replayer.yaml > /tmp/vr.yaml
  cd /opt/nvidia/holoscan/examples/video_replayer/python
  HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data python3 video_replayer.py --config /tmp/vr.yaml
"

# 3b. video_replayer (C++, 10 frames) — same headless injection as 3a. The C++
#     YAML hard-codes `directory: "../data/racerx"`, but HOLOSCAN_INPUT_PATH
#     overrides it, so we don't need to patch that field.
"${RUN[@]}" "$IMG" bash -c "
  ulimit -s 32768
  sed -e 's/count: 0/count: 10/' \
      -e 's/repeat: true/repeat: false/' \
      -e 's/realtime: true/realtime: false/' \
      -e 's/^  width: 854/  headless: true\n  width: 854/' \
      /opt/nvidia/holoscan/examples/video_replayer/cpp/video_replayer.yaml > /tmp/vr_cpp.yaml
  cd /opt/nvidia/holoscan/examples/video_replayer/cpp
  HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data ./video_replayer --config /tmp/vr_cpp.yaml
"
```

## Step 4: Launch command

- Read https://catalog.ngc.nvidia.com/orgs/nvidia/teams/clara-holoscan/containers/holoscan.
- Explain the docker flags below to the user.
- Refer the user to that link for additional flags (e.g., how to mount V4L2 video devices).

```bash
docker run -it --rm \
  --runtime=nvidia --gpus all --cap-add CAP_SYS_PTRACE \
  --ipc=host --ulimit memlock=-1 --ulimit stack=67108864 \
  nvcr.io/nvidia/clara-holoscan/holoscan:<TAG>
# Examples: /opt/nvidia/holoscan/examples/
# Mount files: -v /host/path:/container/path
# GUI examples: add -v /tmp/.X11-unix:/tmp/.X11-unix -e DISPLAY=$DISPLAY
```

Next:
- Explore: `ls /opt/nvidia/holoscan/examples/`
- Walk through one: `/holoscan-explain-example`

## Troubleshooting

- **`docker: Error response from daemon: could not select device driver "nvidia"`.** NVIDIA Container Toolkit is missing or not configured. Install per the link in Step 2 and restart Docker.
- **CUDA init failure inside the container.** Tag suffix doesn't match the host. Re-check `nvidia-smi` CUDA Version and the table in Step 1.
- **Segmentation fault when launching an example.** `ulimit -s 32768` wasn't applied inside the container. Use the `bash -c "ulimit -s 32768 && ..."` pattern shown in Step 3.
- **Holoviz example hangs / no window over SSH.** YAML wasn't patched to `headless: true`. Use the `sed` injection shown in Step 3.
- **`video_replayer` can't find data.** Set `HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data` — overrides the YAML's hard-coded path.
