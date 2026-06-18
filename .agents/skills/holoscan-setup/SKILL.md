---
name: holoscan-setup
version: "1.0.0"
description: "Guides Holoscan SDK installation: inspects the host, assesses platform compatibility, recommends an install method, and delegates to the matching install skill."
license: Apache-2.0
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  github-url: "https://github.com/nvidia-holoscan/holoscan-sdk"
  tags:
    - holoscan
    - installation
    - nvidia
    - sdk
    - setup
---

# Holoscan SDK Setup

## Purpose

Determines the correct Holoscan SDK installation method for the current host by inspecting hardware, OS, CUDA driver, and existing tooling, then delegates to a method-specific install skill. Covers NGC container, Debian/apt, pip wheel, Conda, and source builds across Ubuntu, RHEL, IGX Orin, Jetson, and DGX Spark / Grace-Hopper platforms.

## Prerequisites

- Linux host (Ubuntu 22.04/24.04, RHEL 9.x, IGX Orin, Jetson, or DGX Spark / Grace-Hopper)
- NVIDIA GPU with a working driver (`nvidia-smi` returns a CUDA Version)
- Network access to `docs.nvidia.com` and NGC
- One of: Docker + NVIDIA Container Toolkit, `apt`, Python 3.10–3.13 with `pip`, Conda, or a build toolchain — depending on chosen method

## Available Scripts

| Script | Purpose | Arguments |
|--------|---------|-----------|
| `scripts/check_conda.sh` | Detects Conda installs even when not on PATH (searches `~/miniconda3`, `~/miniforge3`, `~/anaconda3`, `~/mambaforge`, `/opt/conda`, and shell rc files); reports envs and which have `holoscan` importable. | none |
| `scripts/check_ngc_image.sh` | Checks whether the NGC Holoscan container image for a given CUDA tag suffix is pulled or available. | `<cuda-tag-suffix>` — one of `cuda13`, `cuda12-dgpu`, `cuda12-igpu` |

Invoke scripts with `run_script("scripts/check_conda.sh")` and `run_script("scripts/check_ngc_image.sh", "cuda13")`. Trust the script output over bare commands such as `which conda` or `docker images`.

## Instructions

Be conversational and step-by-step — do not front-load all the information. Complete each step and report back before moving on.

### Workflow rules (must follow)

1. End Step 5 with a **bolded one-line recommendation** that names the method (e.g. `**Recommendation:** NGC Container — bundles all deps, fastest path to a working install.`).
2. For a first-time user on a supported x86_64 host with Docker available, that recommendation **must** be **NGC Container**.
3. After the recommendation, **stop and ask** which method to use. Do not paste `docker pull`, `docker run`, `apt install`, `pip install`, or other install commands in that turn — those belong to the delegated install skill in Step 6.
4. If the container path is in play, verify Docker + GPU passthrough **yourself** in Step 4 (run the command shown there). Do not ask the user to run `nvidia-smi` or `docker --version` for you.

### Step 1: Read the Docs First

Fetch `https://docs.nvidia.com/holoscan/sdk-user-guide/` then `sdk_installation.html` to get the current release's supported platforms, package names, and install requirements. Do not rely on hardcoded assumptions.

### Step 2: Inspect the Machine

Run in parallel:

```bash
uname -a && (lsb_release -a 2>/dev/null || cat /etc/os-release)
uname -m
nvidia-smi 2>&1 | head -10
nproc && free -h | head -2
```

**Key:** Read the "CUDA Version" field from `nvidia-smi` (top-right of the table header) — this is the *maximum* CUDA version the driver supports, and drives `cuda12` vs `cuda13` package selection.

### Step 3: Assess Compatibility

| Platform | Methods Available |
|----------|-------------------|
| Ubuntu 22.04/24.04, x86_64 | Container, Debian/apt, pip wheel, Conda, Source |
| RHEL 9.x, x86_64 | Container only |
| IGX Orin (ARM64) | Container, Debian/apt, Source |
| Jetson AGX Orin / Orin Nano | Container, Debian/apt (iGPU) |
| Jetson AGX Thor | Container, Debian/apt |
| DGX Spark / Grace-Hopper | Container (check docs for OS requirements) |
| Other Linux, x86_64 | Container may work; pip wheel if glibc ≥ 2.35 |

### Step 4: Check Tools and Present Options

Run in parallel:

```bash
docker --version 2>&1 | head -1; python3 --version 2>&1; pip3 --version 2>&1
dpkg -l | grep holoscan || true
pip3 show holoscan 2>/dev/null | grep -E "^(Name|Version)" || true
~/holoscan/venv/bin/pip show holoscan 2>/dev/null | grep -E "^(Name|Version)" | sed 's/^/venv: /' || true
```

Then verify GPU passthrough yourself — do **not** ask the user to run this:

```bash
docker run --rm --gpus all ubuntu:22.04 nvidia-smi 2>&1 | tail -5 || true
```

Interpret the result for the Status column in Step 5:
- `docker` missing → container row Status `✗ — Docker not installed`.
- Docker present but `could not select device driver "nvidia"` → `✗ — NVIDIA Container Toolkit missing`.
- `nvidia-smi` output appears → `✓`.

Then invoke the detection scripts via `run_script`:

- `run_script("scripts/check_conda.sh")` — see Available Scripts above for why this is preferred over `conda --version`.
- `run_script("scripts/check_ngc_image.sh", "<cuda-tag-suffix>")` — replace `<cuda-tag-suffix>` with the tag determined from Step 2 (e.g. `cuda13`, `cuda12-dgpu`, `cuda12-igpu`).

If Holoscan is already installed, note the version and ask whether to upgrade or verify the existing install.

**CUDA variant rule** (canonical reference — apply this in all steps below):

| nvidia-smi CUDA Version | Native packages | Container tag |
|------------------------|-----------------|---------------|
| 13.x+ | `holoscan-cu13` / `holoscan-cuda-13` | `cuda13` |
| 12.x, Blackwell GPU | `holoscan-cu12` / `holoscan-cuda-12` | `cuda13` (Forward Compat) or `cuda12-dgpu` |
| 12.x, Ampere/Ada dGPU | `holoscan-cu12` / `holoscan-cuda-12` | `cuda12-dgpu` |
| ARM64 iGPU (Jetson, IGX) | `holoscan` | `cuda12-igpu` |

Native installs treat the driver CUDA version as a hard ceiling. Containers support Forward Compatibility (banner saying "CUDA Forward Compatibility mode ENABLED" is expected, not an error).

### Step 5: Present Options and Recommend

Always present **all methods** in the table — never omit a row. Use the Status column to indicate availability on the host (unavailable methods show ✗ with a short reason). Use this table format:

| Method | Best for | Status |
|--------|----------|--------|
| **NGC Container** | All deps bundled (CUDA, TensorRT, LibTorch, ONNX Runtime, Vulkan); C++ + Python. Needs Docker + NVIDIA Container Toolkit. | ✓/✗ based on docker presence |
| **Debian/apt** | Native Ubuntu; C++ only | ✓/✗ if package is installed |
| **pip wheel** | Python-only projects; needs CUDA Toolkit on PATH; Python 3.10–3.13. | ✓/✗ if wheel is installed in virtual env at ~/holoscan/venv |
| **Conda** | CUDA 13 only; good if already in a conda environment. | ✓/✗ based on `check_conda.sh` output (not just `which conda`) |
| **Source** | Modifying SDK internals, custom CMake flags, debug symbols, unsupported platform, or unreleased branch. | ✓/✗ if already cloned at ~/holoscan/holoscan-sdk |

After the table, end the turn with this exact two-line shape:

> **Recommendation:** `<method>` — `<one-line why>`
>
> **Which method would you like to use?** (container / apt / wheel / conda / source)

If the user is new to Holoscan and the host is a supported x86_64 platform with Docker available, recommend **NGC Container**. For RHEL 9 or other container-only hosts, recommend container. For Python-only projects on a Docker-less host, recommend pip wheel.

Do **not** include `docker pull`, `docker run`, `apt install`, or `pip install` commands in this turn — those live in the install skill invoked in Step 6. Keep this response short to avoid being truncated mid-table.

### Step 6: Delegate to the Install Skill

Once a method is picked, invoke the corresponding skill — do not repeat the install steps inline:

| Method | Skill to invoke |
|--------|-----------------|
| NGC Container | `/holoscan-install-container` |
| Debian/apt | `/holoscan-install-debian` |
| pip wheel | `/holoscan-install-wheel` |
| Conda | `/holoscan-install-conda` |
| Source | `/holoscan-install-source` |

Pass the CUDA variant (cu12/cu13/igpu) and any other relevant facts from Steps 2–4 as context when invoking the skill.

The install skill owns the full command set — including the recommended container flags (`--gpus all`, `--ipc=host`, `--ulimit memlock=-1`, `--ulimit stack=67108864`, inner `ulimit -s 32768`) and verification examples. Do not restate them from `holoscan-setup`; delegate and let the install skill produce them.

### Step 7: Summary

If installation was successful and tests were run, print a table summary of test results.

## Limitations

- RHEL 9.x supports the NGC container method only — native packages are not published.
- Conda packages are CUDA 13 only; CUDA 12 hosts must use container, apt, pip wheel, or source.
- Debian/apt installs C++ only since Holoscan v3.0.0; Python support requires an additional pip wheel install.
- pip wheel requires glibc ≥ 2.35 and Python 3.10–3.13.
- Native installs cannot exceed the driver's reported CUDA Version; only containers can use CUDA Forward Compatibility.
- DGX Spark / Grace-Hopper OS requirements change between releases — always re-check `sdk_installation.html`.

## Troubleshooting

- **`conda --version` says "command not found" but Conda is installed** — common in zsh setups with lazy-loaded conda or when only `.bashrc` ran `conda init`. Use `run_script("scripts/check_conda.sh")`; it searches install dirs and rc files.
- **`nvidia-smi` shows a lower CUDA Version than expected** — that field is the driver's max supported CUDA, not the installed toolkit. Upgrade the driver before installing a newer-CUDA package.
- **Debian install succeeds but `import holoscan` fails in Python** — apt installs C++ only since v3.0.0. Follow up with `/holoscan-install-wheel`.
- **`pip install holoscan` fails with glibc errors** — host glibc is < 2.35. Use container or apt instead.
- **`check_ngc_image.sh` reports image missing** — confirm NGC login (`docker login nvcr.io`) and that the tag suffix matches the CUDA variant rule in Step 4.
