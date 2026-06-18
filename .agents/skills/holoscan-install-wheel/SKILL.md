---
name: holoscan-install-wheel
version: "1.0.0"
description: "Install Holoscan SDK Python wheel via pip into a venv. Use for Python installs; not for native C++/apt or Conda installs."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - install
    - pip
    - wheel
    - python
---

# Holoscan pip Wheel Installation

## Purpose

Install the Holoscan SDK Python bindings via the `holoscan-cu12` / `holoscan-cu13` pip wheel into a virtual environment, and verify with `hello_world` and `video_replayer`.

## Prerequisites

- Linux x86_64 with NVIDIA GPU + driver (`nvidia-smi`).
- CUDA Toolkit on `PATH` matching the host CUDA major (12 or 13).
- Python 3.10–3.13 with `venv` available.
- Network access to PyPI and `docs.nvidia.com`.

## Limitations

- Python only. For C++ headers/libs, pair with `/holoscan-install-debian`.
- `holoscan-cu12` and `holoscan-cu13` are mutually exclusive — wheel must match host CUDA driver.
- `video_replayer` data ships only with the Debian package; without it, set `HOLOSCAN_INPUT_PATH` to a directory containing `racerx/`.
- `ulimit -s 32768` is recommended in every shell that runs Holoscan — without it some apps emit a stack-size warning or, in rarer cases, segfault.

## Step 0: Consult the Official Install Instructions

Always fetch the pip-wheel section of `https://docs.nvidia.com/holoscan/sdk-user-guide/sdk_installation.html` before installing. Extract: exact wheel package names (`holoscan-cu12`, `holoscan-cu13`), the supported Python range for the current release, prerequisites that must be on `PATH` (CUDA Toolkit), and any optional extras (LibTorch / ONNX Runtime version pins). If the doc disagrees with anything below, the doc wins.

You need the CUDA variant already determined. If not known, run `nvidia-smi 2>&1 | head -5` first.

**CUDA variant rule — pick the pip package:**

| nvidia-smi CUDA Version | pip package |
|------------------------|-------------|
| 13.x+ | `holoscan-cu13` |
| 12.x (any GPU) | `holoscan-cu12` |

Prerequisites: CUDA Toolkit on PATH, Python 3.10–3.13. Optional extras: LibTorch 2.11.0+, ONNX Runtime 1.22.0+.

Always install into a Python virtual environment — this avoids system-package conflicts and is required on Ubuntu 24.04 (which blocks system-wide pip entirely).

## Step 1: Create and Activate the venv

Check if one exists first:

```bash
ls ~/holoscan/venv 2>/dev/null && echo "exists" || echo "missing"
```

If missing:
```bash
python3 -m venv ~/holoscan/venv
```

Then activate:
```bash
source ~/holoscan/venv/bin/activate
```

## Step 2: Install

```bash
pip install holoscan-cu12   # or holoscan-cu13
```

## Step 3: Verify

The venv must be active for all commands below.

```bash
# Basic import — expected: version string, e.g. "4.1.0"
# The stack-size RuntimeWarning is harmless; ulimit -s 32768 suppresses it.
python3 -c "import holoscan; print(holoscan.__version__)"

# Fetch Python examples from GitHub at the installed version tag.
# These are official NVIDIA examples, fetched over HTTPS and pinned to the tag
# matching the installed wheel (v${SDK_VER}). Before running them, tell the user
# you're about to download and execute remote example scripts from this URL. If
# they decline or GitHub is unreachable, skip to browsing the examples in Step 4.
SDK_VER=$(python3 -c "import holoscan; print(holoscan.__version__)")
BASE="https://raw.githubusercontent.com/nvidia-holoscan/holoscan-sdk/v${SDK_VER}/examples"

# hello_world — expected: "Hello World!"
curl -fsSL "${BASE}/hello_world/python/hello_world.py" -o /tmp/hs_hello_world.py
ulimit -s 32768 && python3 /tmp/hs_hello_world.py

# video_replayer (10 frames, headless) — expected: "Graph execution finished."
# Always run headless: works with or without a display, avoids GUI failure modes over SSH.
curl -fsSL "${BASE}/video_replayer/python/video_replayer.py" -o /tmp/hs_video_replayer.py
curl -fsSL "${BASE}/video_replayer/python/video_replayer.yaml" -o /tmp/hs_video_replayer.yaml
python3 -c "
c = open('/tmp/hs_video_replayer.yaml').read()
c = c.replace('count: 0','count: 10').replace('repeat: true','repeat: false').replace('realtime: true','realtime: false')
c = c.replace('holoviz:\n  width: 854','holoviz:\n  headless: true\n  width: 854')
open('/tmp/hs_video_replayer_run.yaml','w').write(c)"
ulimit -s 32768 && HOLOSCAN_INPUT_PATH=/opt/nvidia/holoscan/data \
  python3 /tmp/hs_video_replayer.py --config /tmp/hs_video_replayer_run.yaml
```

Note: `video_replayer` needs the racerx data files. These ship with the Debian package at `/opt/nvidia/holoscan/data`. If the Debian package is not installed, run `sudo /opt/nvidia/holoscan/examples/download_example_data` first (requires the apt package to be installed for that script), or set `HOLOSCAN_INPUT_PATH` to wherever the data lives.

## Step 4: Remind the User

They must activate the venv in each new shell session:

```bash
source ~/holoscan/venv/bin/activate
ulimit -s 32768   # suppress stack-size warning
```

Then offer next steps:
- Explore Python examples at `https://github.com/nvidia-holoscan/holoscan-sdk/tree/v<VERSION>/examples`
- Walk through a specific example: `/explain-example`
- Start building a custom Holoscan application

## Troubleshooting

- **`pip install holoscan-cu12` errors with "externally-managed-environment".** Ubuntu 24.04 blocks system-wide pip. Create and activate the venv from Step 1 first.
- **`ImportError` / wrong CUDA at `import holoscan`.** Wheel variant doesn't match host CUDA. Uninstall and reinstall the matching one: `pip uninstall -y holoscan-cu13 && pip install holoscan-cu12` (or vice versa).
- **`RuntimeWarning: stack size ...`.** Harmless, but set `ulimit -s 32768` in the current shell to silence it.
- **Segmentation fault when running an example.** `ulimit -s 32768` wasn't set. Set it before `python3 ...`.
- **`video_replayer` can't find `racerx/`.** `HOLOSCAN_INPUT_PATH` isn't pointing at a directory containing it. Install the Debian package for `/opt/nvidia/holoscan/data`, or set `HOLOSCAN_INPUT_PATH` to wherever the data lives.
- **`source: no such file: ~/holoscan/venv/bin/activate` in a new shell.** Venv wasn't created or path differs. Re-run Step 1 or correct the path.
