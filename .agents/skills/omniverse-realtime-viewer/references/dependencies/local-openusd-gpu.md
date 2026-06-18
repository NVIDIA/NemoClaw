# Local Desktop, OpenUSD, And GPU Utilities

## Local Desktop Viewer Note

The streaming Omniverse Realtime Viewer dependency path does not require `ovui`. Do not add `ovui` to a browser-streamed Omniverse Realtime Viewer just to satisfy rendering, selection, or overlay requirements; rendering is server-side `ovrtx` and browser delivery is `ovstream`.

For a selected local desktop Omniverse Realtime Viewer, read
`nvidia-runtime.md` for the latest-version `ovui` PyPI package guidance.
Keep all local UI packages from the same compatible package set. For ovui-owned skills,
widget samples, `ovwidgets`, or headless overlay examples, also use the current
ovui repository pointer in `nvidia-runtime.md` and inspect that
repo's `skills/`, samples, and widget code. If local validation cannot complete
in the current environment, document the runtime requirement and continue
scaffolding the expected local Omniverse Realtime Viewer integration rather than
adding local install instructions here.

Minimal verification when `ovui` is already installed:

```bash
python3 -c "import omni.ui as ui; print('ovui OK')"
```

Common local-only failures:

- `ModuleNotFoundError: omni.ui`: local desktop UI packages are not installed in the active environment.
- Window does not open in CI or remote shells: no real display is available; use a configured X display or desktop session.
- UI frame does not resize with the OS window: app code did not configure the local window shell correctly; read `references/local-viewer`.

## usd-core / pxr

Purpose: direct USD queries for hierarchy, properties, variants, bounds, authored cameras, and metadata.

Package: PyPI package `usd-core`.

Install exactly version `24.11`:

```bash
python3 -m pip install usd-core==24.11
```

Why this pin is required:

- Newer `usd-core` versions can cause `TfType::AddAlias` schema conflicts in the viewer stack.
- `ovrtx` bundles its own USD C++ libraries.
- `usd-core` ships a separate USD runtime.
- Loading both USD runtimes in one process can produce linker-level conflicts, duplicate registry state, duplicate debug symbols, and plugin/type alias errors.

Required process contract:

1. In the main renderer process, set `OVRTX_SKIP_USD_CHECK=1` before imports.
2. Import `ovrtx` and construct `ovrtx.Renderer` first.
3. Do not import `pxr` in that renderer process.
4. Run all `pxr` work in a subprocess, such as `server/pxr_worker.py`.
5. Communicate with the subprocess through JSON, files, pipes, or another explicit IPC boundary.

Verify `pxr` only in the intended query process or subprocess:

```bash
python3 -c "from pxr import Usd, UsdGeom, Sdf, Gf; print('pxr OK')"
```

Verify package metadata:

```bash
python3 -m pip show usd-core
```

Common failure modes:

- `_tf` import failure: Python version, wheel tag, platform, or shared library resolution mismatch.
- `TfType::AddAlias` schema conflict: `usd-core` is not pinned to `24.11`, or conflicting USD runtimes are loaded.
- Duplicate USD registry or debug symbol errors with ovrtx: `pxr` was imported in the renderer process; move queries to a subprocess.
- Slow hierarchy queries: app logic is traversing too much USD on the UI/render path; read `references/stage-hierarchy`.

## warp-lang

Purpose: CUDA buffer operations and GPU utility kernels, especially RGBA to BGRA conversion before streaming.

Package: PyPI package `warp-lang`.

Install:

```bash
python3 -m pip install warp-lang
```

Verify import:

```bash
python3 -c "import warp as wp; print('warp OK', wp.__version__)"
```

Verify CUDA devices visible to Warp:

```bash
python3 -c "import warp as wp; wp.init(); print(wp.get_devices())"
```

Common failure modes:

- `ModuleNotFoundError: warp`: package name is `warp-lang`, import name is `warp`.
- CUDA device list is empty: driver or container GPU access is missing.
- CUDA conversion code fails after package install: verify the app passes valid CUDA buffers and keeps lifetimes stable.

## numpy

Purpose: matrices, camera math, CPU frame copies, serialized values, and general numeric utilities.

Package: PyPI package.

Install:

```bash
python3 -m pip install numpy
```

Verify import:

```bash
python3 -c "import numpy as np; print('numpy OK', np.__version__)"
```

Common failure modes:

- ABI errors after upgrading packages: recreate the virtual environment or reinstall compiled packages.
- Camera math produces invalid transforms: this is usually app logic, not install; validate finite arrays and matrix layout through `references/camera-controls`.
