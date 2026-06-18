# Dependency Quick Setup

## Quick Setup

Before choosing install commands for NVIDIA runtimes, read
`nvidia-runtime.md`. It is the source of truth for `ovrtx`, `ovui`,
`ovstream`, the `ov-web-rtc` browser client, and the current package guidance and
supplemental documentation for dependency-owned skills, samples, renderer
examples, widgets, and release notes. For `ovstream`, use the supplemental
GitHub repository in `nvidia-runtime.md` when the task needs library-owned
skills, samples, or transport-specific examples.

Start every Python app from a clean environment:

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install --upgrade pip setuptools wheel
```

Inside a generated app, install server dependencies through the checked-in
project manifests and the current NVIDIA runtime guidance:

```bash
python3 -m pip install -r server/requirements.txt
```

Use `nvidia-runtime.md` for current NVIDIA runtime locations instead
of copying release URLs or registry paths into app-specific setup notes.

For a generated frontend:

```bash
cd frontend
npm install
```

Use Node.js 20+ and npm 10+ for frontend installs. The WebRTC client package
declares those engine requirements. Use `nvidia-runtime.md` for the current
`@nvidia/ov-web-rtc` package and standalone `ovstream` Direct guidance.

Shared viewer UI is generated as local frontend code when needed. Do not add a
package dependency for it; use `viewer-backend-interface` to create
`frontend/src/viewer-ui/`.

Use one Python virtual environment per Omniverse Realtime Viewer app. Avoid mixing native wheels or shared libraries from multiple Omniverse Realtime Viewer experiments in a single environment.

## Local Cache Configuration

Set project-local cache paths before installing dependencies or running generated viewers when the default home cache may not be writable:

```bash
mkdir -p .cache/cuda .cache/gl .cache/warp .cache/npm
export XDG_CACHE_HOME="$PWD/.cache"
export CUDA_CACHE_PATH="$PWD/.cache/cuda"
export __GL_SHADER_DISK_CACHE_PATH="$PWD/.cache/gl"
export npm_config_cache="$PWD/.cache/npm"
```

For npm, either keep `npm_config_cache` in the environment or pass the cache path explicitly:

```bash
npm --cache ./.cache/npm install
```

For Warp, set the kernel cache directory before `wp.init()` or before launching kernels:

```python
import warp as wp

wp.config.kernel_cache_dir = "./.cache/warp"
wp.init()
```

Why: containers, CI runners, shared workspaces, and restricted service users may not be able to write the default `~/.cache`. A project-local `.cache/` keeps CUDA, GL shader, Warp kernel, and npm cache writes under the app directory and makes cache permissions explicit.

When scaffolding a generated viewer, create an app-root `.gitignore` so the
project-local `.cache/`, virtual environment, npm install output, build output,
logs, and Python bytecode stay untracked. Include at least `.venv/`, `.cache/`,
`node_modules/`, `dist/`, `__pycache__/`, `*.log`, and `logs/`.

## Dependency Matrix

| Dependency | Acquisition path | Needed by |
|---|---|---|
| `ovrtx` | See `nvidia-runtime.md` for the current package guidance and supplemental documentation. | Streaming and local Omniverse Realtime Viewers |
| `ovstream` | See `nvidia-runtime.md` for the current PyPI package and supplemental documentation. | Streaming server only |
| `usd-core` | `server/requirements.txt`, pinned exactly to `usd-core==24.11` | USD query subprocesses |
| `warp-lang` | `server/requirements.txt`, or `pip install warp-lang` | CUDA frame conversion and GPU utilities |
| `numpy` | `server/requirements.txt`, or `pip install numpy` | Camera math, matrices, CPU arrays |
| `ov-web-rtc client` / `@nvidia/ov-web-rtc` | See `nvidia-runtime.md`; use standalone `ovstream` Direct guidance. | Browser streaming client |
| Local viewer UI module | Generated from `viewer-backend-interface` under `frontend/src/viewer-ui/` when needed | Shared frontend controls and UI contracts |
| `ovui` | See `nvidia-runtime.md` for the current PyPI package and supplemental documentation. | Local desktop Omniverse Realtime Viewers, not streaming |

Do not install alternate browser streaming package names, hard-code browser
client versions in skill docs, or use ad hoc frontend archives. Use
`nvidia-runtime.md` for `ovui` and streaming native runtime setup.

## Global Requirements

- Use Linux x86_64 for the common supported streaming sample path.
- Use an NVIDIA GPU with RTX cores for `ovrtx`.
- Use an NVIDIA GPU and driver with NVENC support for `ovstream`.
- Use an NVIDIA driver that supports the installed GPU and CUDA driver API.
- CUDA compute capability 7.0 or newer is recommended.
- Use one Python environment per app to avoid mixing native libraries.
- Set `OVRTX_SKIP_USD_CHECK=1` before any `ovrtx` work.
- Keep `pxr` work out of the process that owns `ovrtx.Renderer`; use a subprocess.
- Put ovrtx's bundled plugin libraries first in the dynamic library path when plugin or MDL resolution fails.
- Use a real display for local desktop UI apps; streaming Omniverse Realtime Viewers do not need an `ovui` window.

Verify the GPU before installing renderer or streaming packages:

```bash
nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv
```

Verify Python architecture and version:

```bash
python3 -c "import platform, sys; print(platform.platform()); print(sys.version)"
```
