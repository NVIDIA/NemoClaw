---
name: holoscan-install-conda
version: "1.0.0"
description: "Install Holoscan SDK v4.3+ via Conda in a CUDA 13 environment. Use for Conda installs; redirect CUDA 12 hosts to container/wheel."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - install
    - conda
    - cuda
---

# Holoscan Conda Installation

## Purpose

Install the Holoscan SDK (Python runtime and/or C++ dev headers) into a Conda environment on Linux x86_64, using conda-forge + rapidsai with a correctly pinned CUDA metapackage.

## Prerequisites

- Linux x86_64 with an NVIDIA GPU and CUDA 13 driver (check `nvidia-smi`).
- `conda` (Miniforge preferred). Step 1 installs it if missing.
- Network access to conda-forge, rapidsai, and `docs.nvidia.com`.

## Limitations

- **CUDA 13 only** (since v4.3.0 — earlier releases were CUDA 12). If the user has a CUDA 12 driver, redirect to `/holoscan-install-container` or `/holoscan-install-wheel` instead.
- Linux x86_64 only — no aarch64/iGPU support on conda-forge.
- `ulimit -s 32768` is recommended in every shell that runs Holoscan — without it, some apps **may** segfault.

## Step 0: Consult the Official Install Instructions

Always fetch the current Conda section of `https://docs.nvidia.com/holoscan/sdk-user-guide/sdk_installation.html` before installing — package names, channel selection, and the runtime/dev split can change between releases. Specifically extract:

- The exact runtime package name (e.g. `holoscan` for Python bindings).
- The C++ dev package name and whether the user needs it. As of v4.1.0, `libholoscan-dev` is a separate package containing headers and CMake config — install it whenever the user wants to develop C++ apps. Without it, `find_package(holoscan)` fails and there are no headers to `#include`.
- Supported Python versions for the current release (3.10–3.13 for v4.3).
- The current `cuda-version` pin (v4.3 → `13`).

`rmm` and `ucxx` are distributed via the `rapidsai` channel; `holoscan`, `libholoscan`, and `libholoscan-dev` come from `conda-forge`.

If the doc disagrees with anything below, the doc wins — update the install commands accordingly and tell the user.

## Step 1: Prerequisites Check

```bash
conda --version 2>&1
nvidia-smi 2>&1 | head -5
```

If `conda` is not found, install Miniforge silently (preferred over Miniconda for conda-forge):

```bash
wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh -O /tmp/Miniforge3.sh
bash /tmp/Miniforge3.sh -b -p ~/miniforge3
source ~/miniforge3/etc/profile.d/conda.sh
conda --version
```

The `-b` flag installs non-interactively without modifying `.bashrc`. Users must `source ~/miniforge3/etc/profile.d/conda.sh` in each new shell (or add it to their shell RC file) to make `conda` available.

## Step 2: Create Environment and Install

### Package roles

- `libholoscan` — C++ runtime symbols (`libholoscan_core.so`). Auto-pulled as a dependency.
- `holoscan` — Python bindings.
- `libholoscan-dev` — C++ headers, `libholoscan_core.so` symlink, and `holoscan-config.cmake` for `find_package(holoscan)`.
- `rmm` — RAPIDS Memory Manager (rapidsai channel). Undeclared runtime dep of `holoscan`; `import holoscan` fails without it.
- `ucxx` — UCX Python bindings (rapidsai channel), needed for distributed/multi-process apps.
- `cuda-version=13` — pins the CUDA 13 metapackage so the solver picks compatible CUDA runtime libs.

Create the environment first:

```bash
source ~/miniforge3/etc/profile.d/conda.sh   # if conda not yet on PATH
conda create -n holoscan python=3.13 -y
conda activate holoscan
```

Then pick one of the variants below based on the user's goal.

Pick the packages for the user's goal — Python-only needs `holoscan`, C++ dev needs `libholoscan-dev`, both works for combined use:

```bash
conda install <packages> rmm ucxx cuda-version=13 -c rapidsai -c conda-forge -y
```

For C++ development, also install the toolchain:

```bash
conda install -c conda-forge cxx-compiler cmake ninja -y
```

Verify Python installs with `python3 -c "import holoscan; print(holoscan.__version__)"`. Verify C++ dev installs with `ls "$CONDA_PREFIX/include/holoscan"`.

## Step 3: Run Python Tests

`ulimit -s 32768` is recommended — without it, some Holoscan apps may segfault on startup.

`video_replayer` is a display app that loops forever by default. Always patch its YAML to
stop after 10 frames (`count: 10`, `repeat: false`, `realtime: false`) and to run headless
(`headless: true`) — headless works with or without a display attached and avoids GUI
failure modes over SSH, so we don't branch on `$DISPLAY`.

Download scripts and YAML configs, patch the YAML, then run:

```bash
source ~/miniforge3/etc/profile.d/conda.sh
conda activate holoscan
ulimit -s 32768

SDK_VER=$(python3 -c "import holoscan; print(holoscan.__version__)")
BASE="https://raw.githubusercontent.com/nvidia-holoscan/holoscan-sdk/v${SDK_VER}/examples"

curl -fsSL "${BASE}/hello_world/python/hello_world.py"         -o /tmp/hs_hello_world.py
curl -fsSL "${BASE}/video_replayer/python/video_replayer.py"   -o /tmp/hs_video_replayer.py
curl -fsSL "${BASE}/video_replayer/python/video_replayer.yaml" -o /tmp/video_replayer.yaml

# Patch video_replayer.yaml — 10 frames, headless.
python3 -c "
c = open('/tmp/video_replayer.yaml').read()
c = c.replace('count: 0', 'count: 10')
c = c.replace('repeat: true', 'repeat: false')
c = c.replace('realtime: true', 'realtime: false')
c = c.replace('  width: 854', '  headless: true\n  width: 854')
open('/tmp/video_replayer.yaml', 'w').write(c)"

# hello_world — no display, no data needed; expected: "Hello World!"
python3 /tmp/hs_hello_world.py

# video_replayer — needs racerx data; expected: frames rendered, "Graph execution finished."
HOLOSCAN_INPUT_PATH=/path/to/holoscan/data python3 /tmp/hs_video_replayer.py
```

`HOLOSCAN_INPUT_PATH` must point to the directory containing a `racerx/` subdirectory.
If the user has the SDK source repo that is `~/repos/holoscan-sdk/data`; otherwise download
with the `download_ngc_data` script from the Debian or source install tree.

## Step 4: Remind the User

They must do the following in each new shell session:

```bash
source ~/miniforge3/etc/profile.d/conda.sh   # if Miniforge was installed with -b
conda activate holoscan
ulimit -s 32768   # recommended — prevents segfaults in some apps
```

Consider adding these lines to `~/.bashrc` or `~/.zshrc` to avoid repeating them.

Then offer next steps:
- Explore C++ and Python examples at `https://github.com/nvidia-holoscan/holoscan-sdk/tree/v<VERSION>/examples`
- Walk through a specific example: `/explain-example`
- Start building a custom Holoscan application

## Troubleshooting

- **`ImportError: librmm.so: cannot open shared object file`.** `rmm` was not installed. Re-run the Step 2 `conda install` line — `rmm` is an undeclared runtime dependency of `holoscan`.
- **Solver picks an older `holoscan` build than expected.** Channel order may be wrong. Use `-c rapidsai -c conda-forge` (rapidsai first) — that's the order in the official install command, and under strict channel priority a conda-forge-first ordering can lock the solver to an older `holoscan` build.
- **Segmentation fault on app startup.** Set `ulimit -s 32768` in the current shell before running any Holoscan app. Not all apps trip this, but the larger stack avoids the failure mode.
- **`find_package(holoscan)` fails when building C++ apps.** Install `libholoscan-dev` (headers + CMake config are in a separate package since v4.1.0).
- **`conda: command not found` in a new shell.** Miniforge was installed with `-b` and did not patch `.bashrc`. Run `source ~/miniforge3/etc/profile.d/conda.sh` or add it to your shell RC file.
