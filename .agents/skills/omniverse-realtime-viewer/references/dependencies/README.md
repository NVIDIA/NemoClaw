# Dependencies

## Triggers

Use this skill for install, setup, dependency verification, package cache,
ovrtx install, ovstream install, ovui install, NVIDIA runtime acquisition,
supplemental dependency documentation, generated local viewer UI, OpenUSD/pxr
setup, Warp, NumPy, React/Vite, WebRTC client packages, Electron SHM packages,
Windows setup prerequisites, or environment troubleshooting for Omniverse
Realtime Viewer apps.

This skill is the source of truth for NVIDIA runtime dependency acquisition.
Other skills should point back here instead of repeating package URLs, release
URLs, registry paths, wheel names, artifact locations, or
ovrtx/ovui/ovstream repository URLs.

## How To Use

Start here before writing viewer code. Choose the references that match the selected delivery path and load only those details.

| Need | Read |
|---|---|
| NVIDIA runtime dependency source of truth: `ovrtx`, `ovui`, `ovstream`, and the `ov-web-rtc` browser client | `nvidia-runtime.md` |
| Baseline setup, cache paths, package matrix, global requirements | `quick-setup.md` |
| `ovrtx` install, renderer plugin paths, GPU validation | `ovrtx.md` |
| `ovstream`, native streaming libraries, WebRTC server setup | `ovstream.md` |
| React/Vite client and WebRTC browser package setup | `frontend.md` |
| Electron + shared-memory local transport dependencies | `electron-shm.md` |
| Local `ovui`, `usd-core`/`pxr`, Warp, NumPy | `local-openusd-gpu.md` |
| Environment variables, verification commands, failure index | `environment-validation.md` |

## Path Selection

- For browser streaming, read `nvidia-runtime.md`, `quick-setup.md`, `ovrtx.md`, `ovstream.md`, `frontend.md`, and `environment-validation.md`.
- For lightweight local `ovui` apps, read `nvidia-runtime.md`, `quick-setup.md`, `ovrtx.md`, `local-openusd-gpu.md`, and `environment-validation.md`.
- For Electron + SHM apps, read `nvidia-runtime.md`, `quick-setup.md`, `ovrtx.md`, `electron-shm.md`, `frontend.md`, and `environment-validation.md`.
- For Tauri/Rust or C++ native apps, read `nvidia-runtime.md`, `quick-setup.md`, `ovrtx.md`, and the delivery skill's own build requirements.
- For Windows-native work, also read `windows-native-setup` after the dependency reference that matches the selected path.

## Critical Rules

- Do not guess install commands or package sources. Use `nvidia-runtime.md` for NVIDIA runtime acquisition.
- Do not hard-code ovrtx, ovui, or ovstream GitHub repository URLs in downstream
  skills. Use `nvidia-runtime.md` so dependency locations can be
  updated in one place.
- Keep `ovrtx`, `ovui`, `ovui-data-adapters`, and local UI companion packages on compatible revisions.
- Set `OVRTX_SKIP_USD_CHECK=1` before importing or constructing `ovrtx` components where the selected reference requires it.
- Keep `usd-core`/`pxr` import order consistent with the selected delivery path.
- Do not add browser 3D renderer dependencies as a fallback for missing GPU or `ovrtx` packages.
- For generated browser-streamed viewers, dependency setup is part of completion. Attempt server runtime installation and verification before declaring the app ready unless the user explicitly opts out or the platform is unsupported.
- Treat vendored packages and local caches as setup aids, not redistribution approval.

See also: `ovrtx-rendering`, `ovui-local-viewer-recipe`, `local-viewer`, `streaming-server`, `streaming-client`, `electron-shm-viewer`, `stage-hierarchy`, and `windows-native-setup`.
