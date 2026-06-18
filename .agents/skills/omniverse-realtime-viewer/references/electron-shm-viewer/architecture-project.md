# Electron SHM Architecture And Project

## Global Rules

- Use packages, libraries, and deployment references from the focused references
  selected for the project.
- `ovrtx` is the only renderer. Do not render USD, meshes, materials, lights,
  cameras, or scene graphs in Electron.
- WebGL is allowed only for pixel upload/blit from a server-rendered frame into
  a texture. It is not a scene renderer in this architecture.
- Keep the process boundary explicit: Python server process on one side,
  Electron main/preload/renderer processes on the other.
- Send binary pixels through SHM. Send app state through JSON
  `event_type`/`payload` messages.
- Do not send frame pixels through JSON, base64, screenshots, or generic
  Electron IPC payloads.
- Set `OVRTX_SKIP_USD_CHECK=1` before importing ovrtx or constructing
  `ovrtx.Renderer`.
- One render loop thread owns `renderer.step()`, stage reset/load, render
  product setup, and live `write_attribute()` calls.
- Use fixed server render resolution and UI-side letterboxing. Treat live resize
  as advisory unless the app intentionally reloads render products.

## Read These Skills

Reference focused references instead of duplicating their full contracts:

| Need | Read |
|---|---|
| Renderer construction, `step()`, `LdrColor`, AOVs, `omni:xform` writes | `ovrtx-rendering` |
| Camera, RenderProduct, RenderVar, RenderSettings, inline root/session stage | `stage-loading` |
| Shared JSON `event_type`/`payload` protocol and message names | `streaming-messages` |
| Orbit, pan, zoom, fit, finite camera matrices, drag threshold | `viewer-input-routing`, `camera-controls` |
| Native click picking, pickability, and selectable prim state | `viewer-input-routing`, `object-selection` |
| Hierarchy, properties, variants, bounds, root prim detection | `stage-hierarchy` |
| WebGL texture upload, BGRA/RGBA conversion, blit shader, canvas sizing | `webgl-shm-transport` |

Important distinction: reuse the message envelope and event names from
`streaming-messages`, but do not inherit its transport assumptions. In this path
React pointer events cross the preload bridge and become local JSON app messages
over the SHM control channel.

## When to Use This vs Other Paths

| You want... | Use... |
|---|---|
| Small Python desktop viewer with ovui widgets | `local-viewer` |
| React desktop UI and no Python runtime | `tauri-local-viewer` |
| React desktop UI with Python ovrtx sidecar | This skill |
| Browser client outside the desktop host | `streaming-viewer-recipe` |
| Initial architecture routing | `streaming-vs-local` |

Choose Electron + SHM when:

- The app runs on the same machine as the NVIDIA GPU.
- Existing Python ovrtx server code should be reused.
- React/shared UI components are required.
- A process boundary is useful for restart, crash isolation, or dependency
  separation.
- Raw local frame transfer matters more than simplest packaging.

Avoid Electron + SHM when:

- A minimal local viewport is enough; use `local-viewer`.
- A single native binary without Python is required; use `tauri-local-viewer`.
- The client is not on the desktop host; use `streaming-viewer-recipe`.
- A full editor shell is requested; route through `streaming-vs-local`.

## Architecture Overview

```text
Python ovrtx server process
  -> owns ovrtx.Renderer and USD/pxr query state
  -> calls renderer.step()
  -> writes BGRA/RGBA frames into POSIX shared memory
  -> sends/receives JSON app events over ovstream SHM control channel

Electron main process
  -> starts or attaches to Python server
  -> loads N-API addon wrapping libovstream_shm_client.so
  -> uses WaitFrame async worker on libuv thread pool
  -> forwards SharedArrayBuffer frame handles to renderer
  -> exposes narrow preload API through contextBridge

React renderer process
  -> useShmBackend.ts implements ViewerBackend
  -> reuses shared UI components
  -> uploads SharedArrayBuffer pixels to WebGL texture
  -> sends UI commands as JSON app messages
```

The binary path and app-state path must stay separate:

- **Binary pixels:** ovrtx frame -> SHM server -> SHM client addon ->
  `SharedArrayBuffer` -> WebGL texture upload.
- **App state:** React/preload -> Electron main/addon -> SHM control channel ->
  Python `message_router.py`, then responses/events back through the same JSON
  envelope.

## Project Skeleton

Use this shape unless the host repo already has an equivalent convention:

```text
electron-shm-usd-viewer/
  requirements.txt or pyproject.toml
  package.json
  server/
    app.py
    config.py
    runtime.py
    renderer_runtime.py
    scene_loader.py
    shm_server.py
    message_router.py
    command_queue.py
    camera_controller.py
    selection_controller.py
    render_settings.py
    scene_manager.py
    stage_queries.py
    settings_store.py
  electron/
    main.ts
    preload.ts
    pythonSidecar.ts
    shmClient.ts
    lifecycle.ts
    ipc.ts
    native/
      binding.gyp or CMakeLists.txt
      src/
        addon.cc
        shm_client.cc
        wait_frame_worker.cc
        frame_header.h
  frontend/
    src/
      App.tsx
      backend/
        ViewerBackend.ts
        useShmBackend.ts
        messages.ts
        frameTypes.ts
      viewport/
        ShmViewport.tsx
        webglBlit.ts
        letterbox.ts
      components/
        SceneTree.tsx
        PropertyPanel.tsx
        Toolbar.tsx
        RenderSettingsPanel.tsx
        StatusBar.tsx
  assets/samples/
  data/viewer-settings.json
```

Stable ownership:

- `server/app.py` sets env, constructs runtime, starts SHM, enters render loop,
  and shuts down cleanly.
- `server/renderer_runtime.py` owns ovrtx renderer, active render product, AOV
  selection, frame extraction, stage reset/load, and live attribute writes.
- `server/shm_server.py` owns ovstream SHM server lifecycle, frame publish,
  control-channel send/receive, attach/detach state, and cleanup.
- `server/message_router.py` decodes JSON, validates payloads, dispatches
  commands, and sends responses. Slow USD queries should not run in transport
  callbacks.
- `electron/main.ts` owns app lifecycle, BrowserWindow, sidecar startup, and the
  native addon instance.
- `electron/preload.ts` exposes only the viewer API, never raw Node or native
  objects.
- `frontend/src/backend/useShmBackend.ts` adapts preload calls to the shared
  `ViewerBackend` interface.
- `frontend/src/viewport/webglBlit.ts` owns texture upload and drawing only.
