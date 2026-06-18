# Windows Native Setup

## Triggers

Use this skill for Windows, native Windows, WSL2, ERROR_INCOMPATIBLE_DRIVER, NVML, DLL load failed, or usd-core 24.11.

Run natively on Windows 10/11. Do not use WSL2; ovrtx needs direct Vulkan/NVML GPU access and WSL2 commonly fails with `ERROR_INCOMPATIBLE_DRIVER` or `NVML_ERROR_DRIVER_NOT_LOADED`.

## Prerequisites

- NVIDIA RTX GPU, Turing or newer.
- NVIDIA driver 535+ with CUDA 12.x.
- Python version matching the latest selected runtime wheels. Check the current
  `ovui` package files from `references/dependencies` and create the virtual
  environment with a supported Python version unless the project manifest pins a
  different compatible package set.
- Node.js 20+, npm 10+, Git.

Additional prerequisites may be required by the selected local desktop `ovui`
package or dependency build instructions:

- Visual Studio Build Tools with the MSVC C++ x64 toolchain.
- `vswhere.exe` available from Visual Studio Installer.
- Ninja installed in the active venv or visible to pip build isolation.
- Vulkan SDK when required by the current `ovui` package or dependency
  instructions.

## Install

Read `references/dependencies` first. Its `references/nvidia-runtime.md` file owns
current acquisition details for `ovrtx`, `ovstream`, `ovui`, and the
`ov-web-rtc` browser client; this Windows guide should not repeat release URLs, wheel
names, or artifact locations.

Start from the root of the generated viewer project:

```powershell
cd C:\path\to\generated-viewer
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Install NVIDIA runtimes using `references/dependencies`, then install supporting
packages:

```powershell
pip install warp-lang
pip install usd-core==24.11
if (Test-Path server\requirements.txt) { pip install -r server\requirements.txt }
```

Pin `usd-core==24.11`. Version 26.x can cause `TfType::AddAlias` schema conflicts. Even 24.11 conflicts with ovrtx in-process on Windows, so USD queries run in `pxr_worker.py`.

## Local ovui Setup

Use `references/dependencies` for the current `ovui` PyPI package guidance.
Keep the base `ovui` package and companion packages on one compatible package set.

The distribution may install `omni.ui` and `omni.ui_scene` import packages.
Verify with:

```powershell
python -c "import omni.ui as ui; import omni.ui_scene; print('ok')"
```

If `ovui-data-adapters` reports that no `setup.py` or `pyproject.toml` exists,
use a package set that includes matching package metadata. Do not patch
packaging metadata from this skill.

If PowerShell launches a `.bat` file that uses `for /f "usebackq" ... in (\`...\`)` around `python -c "..."`, quoting can be mangled before `cmd.exe` receives it. Use a small helper `.py` script for Python probes inside batch loops.

## Stage Syntax Check

If using `samples/stage01.usda`, `clippingRange` must be:

```usda
float2 clippingRange = (0.1, 10000)
```

Not separate `float clippingRange.near` and `.far` attributes.

## Run

```powershell
cd frontend
npm install
npm run dev
```

```powershell
cd server
python ov_web_viewer_server.py --stage ..\samples\stage01.usda --port 49100
```

Open:

```text
http://localhost:3000?server=127.0.0.1&signalingport=49100
```

First launch can spend 5 to 10 minutes compiling RTX shaders after `Stage loaded successfully`, with many UJITSO material warnings. Do not kill it; cached shaders make later launches faster.

## Architecture

Windows keeps `pxr` and `ovrtx` in separate processes:

```text
ov_web_viewer_server.py
  ovrtx.Renderer
  ovstream.Server
  PxrWorkerClient -> pxr_worker.py -> pxr.Usd
```

The main process never imports `pxr`; USD hierarchy, variants, and property queries use newline-delimited JSON over stdin/stdout.

ovrtx also needs inline root/session data with a camera, RenderProduct, RenderVar, and RenderSettings. Missing this causes `Unable to find RenderProduct prim`.

## WebRTC Rules

Server:

```python
config.webrtc_signal_port = 49100
config.webrtc_public_ip = "127.0.0.1"
```

Frontend:

```typescript
return { server, signalingPort }; // no mediaServer/mediaPort
```

The client must use `server`, not `signalingServer`, and must not set media fields. Callback registration must happen before `server.start()`. Data-channel messages may arrive wrapped in `{messageType,messageRecipient,data}` and must be unwrapped. On connect, push `openStageResult` and root `getChildrenResult` after about 300 ms so the frontend sees already-loaded state.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ERROR_INCOMPATIBLE_DRIVER` / `NVML_ERROR_DRIVER_NOT_LOADED` | run native Windows, not WSL2 |
| `_tf` DLL import failure | keep pxr in worker subprocess |
| `TfType::AddAlias` conflict | pin `usd-core==24.11` |
| `OSError: cannot load library ovstream` | remove wrong `OVSTREAM_LIB_PATH`; use the current `ovstream` package from `references/dependencies` |
| `cannot import name 'VIEWPORT_CAMERA_POSE_SOURCE'` | install local UI packages from the same package set |
| `Neither 'setup.py' nor 'pyproject.toml' found` under `ovui-data-adapters` | use an `ovui` package set that includes matching package metadata |
| Native UI package requires a compiler toolchain | follow the current `ovui` package/build instructions |
| `TypeError: a coroutine was expected` from `ui.run` | pass an async render loop coroutine, not a plain callback |
| stuck "Loading stage..." | remove `mediaServer`/`mediaPort` |
| `Previous session is already running` | reduce reconnects, add delay |
| `VideoEncoder was not deinitialized` | non-fatal shutdown-order warning |
| `Unable to find RenderProduct prim` | use `stage-loading` wrapper/session stage |
| red/blue swapped | apply RGBA-to-BGRA warp swap before streaming |

See also: `streaming-server`, `streaming-client`, `streaming-lifecycle`, `stage-hierarchy`, `stage-loading`.
