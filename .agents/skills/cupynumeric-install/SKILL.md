---
name: cupynumeric-install
description: Install and verify cuPyNumeric for Python — requirements, commands, verification. Source builds are out of scope.
license: CC-BY-4.0 OR Apache-2.0
compatibility: linux-x86_64, linux-aarch64, darwin-aarch64, wsl-x86_64
metadata:
  author: "NVIDIA Corporation <legate@nvidia.com>"
  version: "2.0.0"
  tags:
    - cupynumeric
    - legate
    - numpy
    - installation
    - conda
    - gpu
    - distributed-computing
  upstream: https://github.com/nv-legate/cupynumeric
  docs: https://docs.nvidia.com/cupynumeric/latest/installation.html
---

# cuPyNumeric Install (user)

## Purpose

Use this skill to install cuPyNumeric for *use* from Python and to verify the install actually works (including GPU usage). Apply it whenever a user wants cuPyNumeric running via conda or pip. Do not use it to build from source (to modify or contribute) — that is out of scope.

## Mandatory rules

- **Never run installs.** Do not run `pip install`, `conda install`, or any installer. Print the command; let the user run it.
- **Always isolate.** No installs into base conda, system Python, or shared global envs.
- **Detect before recommending.** Read-only `--version` checks are fine.

## Prerequisites

Confirm these system requirements before recommending any install:

- **GPU**: Compute Capability ≥ 7.0 (Volta+). CPU-only also supported.
- **CUDA**: 12.2+.
- **OS**: Linux (x86_64 / aarch64), macOS aarch64 (pip wheels only), Windows via WSL.
- **Python**: 3.11 through 3.14 on Linux; 3.11 through 3.13 on macOS aarch64.
- **conda**: ≥ 24.1 (conda path only).
- **Package manager**: conda (upstream-recommended) or pip. If neither is present, bootstrap one first (see Instructions).

## Instructions

Follow these steps in order: confirm the prerequisites, ask the scoping questions, install via the chosen path, then verify.

### Ask before installing

1. **Package manager?** Check `conda --version` and `pip --version`. Prefer conda (upstream-recommended); fall back to pip.
1. **Env target?** GPU machine, CPU-only laptop, cloud, container, or remote/server.
1. **CUDA version?** Ask only when forcing the GPU variant on a host without a visible GPU. Check with `nvidia-smi` / `nvcc --version`.

### Bootstrap — install a package manager first

If neither `conda` nor `pip` is available, install one. **Provide the command and the docs link; do not run it** — `curl | bash` requires user trust.

#### Recommended: Miniforge (full conda, conda-forge default)

```bash
curl -L -O "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh"
bash "Miniforge3-$(uname)-$(uname -m).sh"
```

Docs: https://github.com/conda-forge/miniforge

#### Alternative: Python + pip

Install Python from your OS package manager (apt/dnf/brew) or https://www.python.org/downloads/. If pip is missing on an existing Python: `python -m ensurepip --upgrade`.

After installing, **open a new shell** so the binary is on PATH.

### Install — conda path

```bash
conda create -n cupynumeric -c conda-forge -c legate cupynumeric
conda activate cupynumeric
```

Into an existing env: `conda install -c conda-forge -c legate cupynumeric`.

conda auto-selects the GPU vs CPU variant from whether `nvidia-smi` works at install time. To override that, see below.

#### Force the GPU variant

Set `CONDA_OVERRIDE_CUDA` only when no GPU is visible at install time (e.g. building a container for a GPU host). Use the runtime host's CUDA version:

```bash
CONDA_OVERRIDE_CUDA="12.2" conda install -c conda-forge -c legate cupynumeric
```

#### Nightly (less validated)

```bash
conda install -c conda-forge -c legate-nightly cupynumeric
```

### Install — pip path

```bash
python -m venv .venv
source .venv/bin/activate
pip install nvidia-cupynumeric
```

### Verify

#### Smoke test (always run)

Run a self-contained script through the `legate` launcher — no repo checkout needed.

```bash
TMP=$(mktemp -d)
cat > "$TMP/smoke.py" <<'EOF'
import cupynumeric as np
a = np.arange(10)
b = np.ones((4, 4))
print("sum:", a.sum())            # expect 45
print("matmul:", (b @ b).sum())   # expect 64.0
EOF
legate "$TMP/smoke.py"
rm -rf "$TMP"
```

Expect `sum: 45` and `matmul: 64.0`. If `legate` is missing, the env is not activated — see Troubleshooting.

#### GPU usage check (mandatory when a supported GPU is present)

A passing smoke test does **not** prove GPU usage — a CPU-variant install on a GPU box produces correct results too. Run both steps.

**1. Force a GPU launch.** `legate --gpus N` requests N GPUs; fails fast if no GPU is visible or the CPU variant is installed.

```bash
TMP=$(mktemp -d)
cat > "$TMP/check.py" <<'EOF'
import cupynumeric as np
print(np.ones((4096, 4096)).sum())
EOF
legate --gpus 1 "$TMP/check.py"
rm -rf "$TMP"
```

Expect `16777216.0`. If you see `CUDA driver`, `libcudart`, or `no GPUs available`, the CPU variant is installed; reinstall with `CONDA_OVERRIDE_CUDA`.

**2. Confirm the GPU was touched.** Run a deadline-bounded matmul loop alongside `nvidia-smi`, all from one shell — no second-terminal race:

```bash
TMPDIR_GPU=$(mktemp -d)
SCRIPT="$TMPDIR_GPU/cupynumeric_gpu_check.py"
cat > "$SCRIPT" <<'EOF'
import cupynumeric as np, time
a = np.ones((10000, 10000))
deadline = time.time() + 20
iters = 0
while time.time() < deadline:
    b = a @ a
    _ = float(b.sum())   # force sync so the matmul actually runs
    iters += 1
print("iters:", iters)
EOF
legate --gpus 1 "$SCRIPT" &
WORKLOAD=$!
sleep 5                                     # buffer for Legate startup
for _ in $(seq 10); do                      # 10 samples at 1s — covers slow startup
  nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
  sleep 1
done
wait "$WORKLOAD"
rm -rf "$TMPDIR_GPU"
```

Expect `memory.used` in the GiB range across most samples and non-trivial `utilization.gpu` in several. If both stay at baseline across every sample, the GPU variant is not installed — check `conda list cupynumeric` for `*_gpu` (not `*_cpu`).

#### Deeper recipes

See [verification_examples.md](references/verification_examples.md) for multi-GPU checks, CPU fallback, container, and troubleshooting.

## Limitations

- **Don't mix conda and pip in one env.** Mixing overrides the first install and breaks at import. To switch, run `pip uninstall nvidia-cupynumeric` or `conda remove cupynumeric` first.
- **Use the `legate` launcher for multi-GPU / multi-rank runs.** Plain `python` runs single-process: `legate --gpus 2 script.py`.
- **Force the GPU variant on a CPU-only host with `CONDA_OVERRIDE_CUDA`.** conda otherwise auto-selects the CPU or GPU variant from `nvidia-smi` at install time.
- **Require Volta or newer.** Pascal (GTX 10xx / P100) is unsupported.
- **Verify `conda --version` ≥ 24.1.** Older releases silently break variant selection.
- **Treat multi-node / MPI / UCX as out of scope.** Defer to https://docs.nvidia.com/legate/latest/networking-wheels.html and https://docs.nvidia.com/legate/latest/mpi-wrapper.html.

## Troubleshooting

- **`ModuleNotFoundError: No module named 'cupynumeric'`** → Run `which python` and `pip list | grep cupynumeric` (or `conda list | grep cupynumeric`) from the same shell to find the env mismatch.
- **`ImportError` mentioning CUDA / `libcudart`** → Reinstall with `CONDA_OVERRIDE_CUDA="<your-cuda-version>"`; the CPU variant is on a GPU box, or CUDA versions are mismatched.
- **`legate: command not found`** → Activate the env, then run `which legate` to confirm.
- **Slower than NumPy on a laptop** → Expect this for small problems (Legate per-task overhead). See the cuPyNumeric FAQ.

## See also

- [references/verification_examples.md](references/verification_examples.md) — verification + troubleshooting recipes.
- Upstream docs: https://docs.nvidia.com/cupynumeric/latest/installation.html
- Legate requirements: https://docs.nvidia.com/legate/latest/installation.html
