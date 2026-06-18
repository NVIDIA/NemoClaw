---
name: cuopt-install
version: "26.08.00"
description: Install cuOpt for Python, C, or server via pip, conda, or Docker; verify the install. For building cuOpt from source, see cuopt-developer.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - install
    - deployment
    - python
    - server
---

# cuOpt Install (user)

Install cuOpt to *use* it from Python, C, or as a REST server. For building cuOpt from source to contribute or modify it, see `cuopt-developer`.

## System requirements

- **GPU**: NVIDIA Compute Capability ≥ 7.0 (Volta or newer). Examples: V100, A100, H100, RTX 20xx/30xx/40xx. Not supported: GTX 10xx (Pascal).
- **CUDA**: 12.x or 13.x. The package CUDA suffix must match the runtime CUDA (e.g. `cuopt-cu12` / `libcuopt-cu12` with CUDA 12).
- **Driver**: NVIDIA driver compatible with the CUDA version.
- `cuopt-cuXX` (Python) depends on `libcuopt-cuXX` (C), so installing the Python package also installs the C library and headers. Installing `libcuopt-cuXX` on its own does **not** install the Python API.

## Required questions

Ask these if not already clear:

1. **Interface** — Python, C, or REST server? Server can be called from any language via HTTP.
2. **CUDA version** — What is installed? Check with `nvcc --version` or `nvidia-smi`.
3. **Package manager** — pip, conda, or Docker preferred?
4. **Environment** — Local machine with GPU, cloud instance, Docker/Kubernetes, or remote/server (no local GPU)?

## Python API

**Choose one** — do not run both. The second install would override the first and can cause CUDA / package mismatch.

### pip

- **CUDA 13.x:**
  ```bash
  pip install --extra-index-url=https://pypi.nvidia.com cuopt-cu13
  ```
- **CUDA 12.x:**
  ```bash
  pip install --extra-index-url=https://pypi.nvidia.com 'cuopt-cu12==26.2.*'
  ```

### conda

```bash
conda install -c rapidsai -c conda-forge -c nvidia cuopt
```

### Verify

```python
import cuopt
print(cuopt.__version__)
from cuopt import routing
dm = routing.DataModel(n_locations=3, n_fleet=1, n_orders=2)
```

## C API

The C API ships in `libcuopt-cuXX`, which is also pulled in as a dependency of `cuopt-cuXX` — so if you already installed the Python package, the C library and headers are already present. Install `libcuopt` standalone only when you want the C API without Python. **Choose one** of pip or conda — do not run both.

### pip

- **CUDA 13.x:**
  ```bash
  pip install --extra-index-url=https://pypi.nvidia.com libcuopt-cu13
  ```
- **CUDA 12.x:**
  ```bash
  pip install --extra-index-url=https://pypi.nvidia.com 'libcuopt-cu12==26.2.*'
  ```

### conda

```bash
conda install -c rapidsai -c conda-forge -c nvidia libcuopt
```

### Verify

See [`references/verification_examples.md`](references/verification_examples.md)
for the canonical C-API header/library `find` commands (conda and pip/venv variants).

## Server (REST)

### pip

```bash
pip install --extra-index-url=https://pypi.nvidia.com cuopt-server-cu12 cuopt-sh-client
```

### conda

```bash
conda install -c rapidsai -c conda-forge -c nvidia cuopt-server cuopt-sh-client
```

### Docker

```bash
docker pull nvidia/cuopt:latest-cuda12.9-py3.13
docker run --gpus all -it --rm -p 8000:8000 nvidia/cuopt:latest-cuda12.9-py3.13
```

### Verify

```bash
python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000 &
sleep 5
curl -s http://localhost:8000/cuopt/health | jq .
```

## Common Issues

- `No module named 'cuopt'` → check `pip list | grep cuopt`, `which python`, reinstall with the correct extra-index-url.
- CUDA not available → run `nvidia-smi` and `nvcc --version`; ensure the package CUDA suffix (`cu12` vs `cu13`) matches the installed CUDA.
- Python vs C → `cuopt-cuXX` pulls in `libcuopt-cuXX` as a transitive dependency, so the C library (`libcuopt.so`) and headers (`cuopt_c.h`) are already available after installing the Python package. The reverse is **not** true: `libcuopt-cuXX` alone does not install the Python bindings.

## See also

- [verification_examples.md](references/verification_examples.md) — full verification recipes for Python, C, server, and Docker.
- `cuopt-developer` — build cuOpt from source and contribute to the codebase.
