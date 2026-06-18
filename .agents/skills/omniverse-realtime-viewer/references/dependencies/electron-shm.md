# Electron SHM Dependencies

## Electron + SHM Dependencies

Purpose: local separate-process Electron viewers where a Python `ovrtx` server renders frames and Electron presents already-rendered pixels through a SharedArrayBuffer/WebGL transport. Electron does not render USD or 3D scene content.

Read `nvidia-runtime.md` for the current `ovrtx` and `ovstream`
acquisition sources before setting up Electron SHM.

Required components:

- Node.js 18+ for SharedArrayBuffer support and N-API native addons.
- Electron 28+ for COOP/COEP-compatible `BrowserWindow` configuration and `contextBridge` isolation.
- `node-gyp` plus `build-essential` for N-API native addon compilation.
- `libovstream_shm_client.so` from the `ovstream` package, available to the native addon at runtime.
- `/dev/shm` mounted with sufficient size. Defaults such as 64 MB may be too small; use at least 512 MB for a 1080p ring buffer.
- Python 3.10+ for the `ovrtx` server process.

Minimal verification:

```bash
node --version
npm --version
python3 --version
df -h /dev/shm
```

Common Electron + SHM dependency failures:

- Native addon build fails: install `node-gyp`, compiler toolchains, and headers matching the active Node/Electron ABI.
- Runtime cannot load `libovstream_shm_client.so`: install the matching `ovstream` package and expose the native library path to Electron.
- Shared memory attach fails or frames drop under load: enlarge `/dev/shm`, especially in containers.
- SharedArrayBuffer is unavailable: use Electron 28+ and configure COOP/COEP-compatible `BrowserWindow` settings.
