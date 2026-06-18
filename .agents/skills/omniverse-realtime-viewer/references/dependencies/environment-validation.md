# Environment And Validation

## Environment Variable Summary

Set before any ovrtx work:

```bash
export OVRTX_SKIP_USD_CHECK=1
```

Set when renderer plugins or MDL libraries do not resolve:

```bash
export OVRTX_BIN_PATH="$(python3 -c 'import ovrtx, os; print(os.path.join(os.path.dirname(ovrtx.__file__), "bin"))')"
export LD_LIBRARY_PATH="$OVRTX_BIN_PATH/plugins${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

Use `nvidia-runtime.md` for current NVIDIA runtime acquisition
locations. Do not keep separate `ovstream` source URLs or cache controls here.

Set only when an ovstream install cannot locate SDK libraries automatically:

```bash
export OVSTREAM_LIB_PATH=/absolute/path/to/ovstream/native/libs
```

Set for local UI under a known display:

```bash
export DISPLAY=${DISPLAY:-:0}
```

Set when the default home cache is not writable:

```bash
export XDG_CACHE_HOME="$PWD/.cache"
export CUDA_CACHE_PATH="$PWD/.cache/cuda"
export __GL_SHADER_DISK_CACHE_PATH="$PWD/.cache/gl"
export npm_config_cache="$PWD/.cache/npm"
```

## Verification Checklist

Run these checks after installation:

1. Confirm GPU and driver are visible with `nvidia-smi`.
2. Confirm Python is the expected interpreter inside the virtual environment.
3. Confirm `OVRTX_SKIP_USD_CHECK=1` is set before renderer imports.
4. Confirm `ovrtx` imports and renderer construction succeeds on the target GPU.
5. Confirm `OVRTX_BIN_PATH` resolves to the installed ovrtx `bin` directory when plugin resolution fails.
6. Confirm `pxr` imports only in the selected query subprocess.
7. Confirm `usd-core` is exactly `24.11`.
8. Confirm `ovstream.initialize()` and `ovstream.shutdown()` work for streaming Omniverse Realtime Viewers.
9. Confirm `warp` can see CUDA devices when using CUDA conversion paths.
10. Confirm `@nvidia/ov-web-rtc` appears in `npm ls` when building a browser
    streaming frontend.
11. If the app imports local viewer UI components, confirm
    `frontend/src/viewer-ui/` exists and exports the referenced components and
    `ViewerBackend` types.
12. Confirm `omni.ui` imports only when building a local desktop Omniverse Realtime Viewer with prebuilt local UI packages.
13. Confirm `.cache/` is writable when running in containers, CI, or shared environments.

For generated browser-streamed viewers, add these readiness checks before
reporting completion:

1. Start the Python server from the generated run wrapper or equivalent command.
2. Wait for `/healthz` to return `200 ok`; if it does not, capture the server log.
3. Confirm the log contains a first-frame message after render-var mapping and
   RGBA-to-BGRA conversion.
4. Run the frontend build and browser smoke check only after the server runtime
   proof above has passed or has produced a concrete failure report.

## Failure Mode Index

- Wrong Python package index: `ovrtx` install fails or pulls nothing. Use NVIDIA PyPI for `ovrtx`; use PyPI for `numpy`, `warp-lang`, and `usd-core==24.11`.
- Incorrect ovstream acquisition: use the current PyPI package source in `nvidia-runtime.md`.
- Platform mismatch: wheel is unavailable or native import fails. Confirm OS, architecture, Python version, GPU driver, and package wheel tags.
- Import order issue: USD registry, `_tf`, duplicate debug symbol, or MDL resolver errors. Set `OVRTX_SKIP_USD_CHECK`, construct `ovrtx.Renderer` first, and isolate `pxr` in a subprocess.
- Native library path issue: `CRenderApi`, MDL, ovstream native, or plugin load failures. Set `OVRTX_BIN_PATH`, dynamic library path, or `OVSTREAM_LIB_PATH` as appropriate.
- GPU access issue: renderer or streaming initialization fails despite successful imports. Verify `nvidia-smi`, container GPU devices, driver support, RTX cores, and NVENC.
- Display issue: local desktop UI cannot open a window. Verify `DISPLAY` and X server availability.
- Cache permission issue: Warp, CUDA shader caching, GL shader caching, or npm fails under `~/.cache`. Set project-local cache paths and ignore `.cache/`.
- Frontend registry issue: npm cannot resolve the NVIDIA package. Check package
  spelling, the `@nvidia` registry in `.npmrc`, lockfile, and proxy
  configuration.
- Local viewer UI issue: TypeScript cannot resolve `ViewerBackend`, `StageTree`,
  `Inspector`, or related local viewer UI imports. Generate
  `frontend/src/viewer-ui/` from `viewer-backend-interface`, or update imports to the
  app's actual local module path.

See also: `ovrtx-rendering`, `local-viewer`, `streaming-server`, `streaming-client`, `stage-hierarchy`, and `windows-native-setup`.
