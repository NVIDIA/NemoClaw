# Installation: Verification Examples

## Verify Python Installation

```python
import cupynumeric as np
print(f"sum(arange(10)) = {np.arange(10).sum()}")   # expect 45

import legate
print(f"legate version: {legate.__version__}")
```

## Verify the legate Launcher Works

Write a self-contained script and drive it through the launcher in two placements (default and GPU-pinned). For a CPU-only run, see "Verify CPU-Only Fallback" below.

```bash
TMP=$(mktemp -d)
cat > "$TMP/launcher_check.py" <<'EOF'
import cupynumeric as np
a = np.arange(10)
b = np.ones((4, 4))
print("sum:", a.sum())            # expect 45
print("matmul:", (b @ b).sum())   # expect 64.0
EOF

# Default placement — exercises the full Legate launcher path
legate "$TMP/launcher_check.py"

# Pin to one GPU explicitly
legate --gpus 1 "$TMP/launcher_check.py"

rm -rf "$TMP"
```

## Verify GPU Is Being Used

Follow the two-step pattern in SKILL.md → "GPU usage check". The commands below are supplementary:

```bash
# Continuous sampling while a problem runs
nvidia-smi dmon -s u -c 5      # 5 utilization samples

# Verbose Legate startup for clues if the GPU isn't being touched
TMP=$(mktemp -d) && cat > "$TMP/v.py" <<'EOF'
import cupynumeric as np
np.ones((1024, 1024)).sum()
EOF
legate --gpus 1 --verbose "$TMP/v.py" 2>&1 | head -40
rm -rf "$TMP"
```

Expect one of these when `legate --gpus 1` fails (GPU variant missing or GPU not visible):

- `CUDA driver version is insufficient`
- `cannot open shared object file: libcudart.so.*`
- `No GPUs available` / `requested 1 GPU but only 0 found`

Diagnose an unused GPU:

```bash
# 1. Confirm conda picked the GPU variant. Look for *_gpu (not *_cpu) in the Build column.
conda list cupynumeric
conda list legate

# 2. CUDA reachable?
nvidia-smi
nvcc --version
python -c "import legate; print(legate.__version__)"
```

## Check System Requirements

```bash
nvidia-smi
nvcc --version
nvidia-smi --query-gpu=compute_cap --format=csv,noheader      # need >= 7.0
python --version                                                # need 3.11+ (Linux: 3.11–3.14; macOS aarch64: 3.11–3.13)
conda --version                                                 # need >= 24.1 for conda path
nvidia-smi --query-gpu=memory.total,memory.free --format=csv
```

## Check Package Versions

```bash
pip show nvidia-cupynumeric
pip show legate
conda list cupynumeric
conda list legate
```

```python
import importlib.metadata
# PyPI dist name: 'nvidia-cupynumeric'. Import name: 'cupynumeric'.
for dist in ("nvidia-cupynumeric", "legate"):
    try:
        print(f"{dist}: {importlib.metadata.version(dist)}")
    except importlib.metadata.PackageNotFoundError:
        print(f"{dist}: not installed via pip")
```

## Verify CPU-Only Fallback

```bash
TMP=$(mktemp -d)
cat > "$TMP/cpu.py" <<'EOF'
import cupynumeric as np
print('mean =', np.arange(1_000_000).mean())
EOF

# Via LEGATE_CONFIG env var
LEGATE_CONFIG="--cpus 4" python "$TMP/cpu.py"

# Or with the launcher directly
legate --cpus 4 "$TMP/cpu.py"

rm -rf "$TMP"
```

## Detect Which Package Manager Is Available

```bash
conda --version 2>/dev/null  && echo "conda available"
pip --version 2>/dev/null    && echo "pip available"
```

## Troubleshooting Commands

```bash
# Active Python
which python
python -c "import sys; print(sys.executable)"

# Is cupynumeric installed in the active env?
pip list 2>/dev/null | grep -i cupynumeric
conda list 2>/dev/null | grep -i cupynumeric

# Underlying runtime present?
python -c "import legate; print(f'legate: {legate.__version__}')"

# legate launcher resolves?
which legate
legate --help | head -20

# Quick smoke test (catches CUDA / libcudart errors early)
TMP=$(mktemp -d)
cat > "$TMP/s.py" <<'EOF'
import cupynumeric as np
print(np.arange(5).sum())
EOF
python "$TMP/s.py"
rm -rf "$TMP"
```

## Container Sanity Check

```bash
# GPU access inside the container
docker run --rm --gpus all <your-image> nvidia-smi

# cupynumeric import + GPU run (mount a host-side script)
TMP=$(mktemp -d)
cat > "$TMP/check.py" <<'EOF'
import cupynumeric as np
print('sum =', np.arange(10).sum())
EOF
docker run --rm --gpus all -v "$TMP:/work" <your-image> legate --gpus 1 /work/check.py
rm -rf "$TMP"
```

______________________________________________________________________

## Additional References

| Topic | Resource |
|-------|----------|
| Installation Guide | [cuPyNumeric Installation](https://docs.nvidia.com/cupynumeric/latest/installation.html) |
| FAQ | [cuPyNumeric FAQ](https://docs.nvidia.com/cupynumeric/latest/faqs.html) |
| Legate Requirements | [Legate Installation](https://docs.nvidia.com/legate/latest/installation.html) |
| Multi-node networking | [Networking with Legate Wheels](https://docs.nvidia.com/legate/latest/networking-wheels.html) |
| MPI wrapper | [Legate MPI Wrapper](https://docs.nvidia.com/legate/latest/mpi-wrapper.html) |
| Source repo | https://github.com/nv-legate/cupynumeric |
