# Streaming vs Local Omniverse Realtime Viewer

Use this before choosing the app shell. Local lightweight, Tauri/Rust, Electron + SHM, and streaming paths can share USD stages, renderer concepts, storage resolution, camera math, selection logic, and query helpers, but they optimize for different users and deployments.

Focused viewer paths in this skill package separate lightweight viewers from the
full-editor shell. If the user explicitly requires an editor shell with docking,
undo, transform gizmos, and editor lifecycle, read `ovwidgets-editor-shell`.

## Choose Tauri/Rust When

Use a Tauri 2.0 desktop app with Rust FFI to OVRTX when:

- The user runs on the GPU workstation but you need web-technology UI (React).
- No Python runtime dependency is acceptable.
- You want to share UI components or styling with the WebRTC streaming Omniverse Realtime Viewer.
- The target is a packaged desktop binary (.exe/.app) rather than a script.
- A ViewerBackend interface must be shared across local and web paths.

Architecture:

```text
React WebView (Vite/Tauri)
  -> useTauriBackend.ts (ViewerBackend)
  -> Tauri IPC invoke / Channel
  -> Rust render thread
  -> ovrtx C FFI (step/map/write)
  -> CPU-mapped RGBA -> binary push to WebView
```

See skill: `tauri-local-viewer`

## Choose Electron + SHM When

Use `electron-shm-viewer` when:

- The app runs locally on the GPU workstation.
- The renderer should stay in a separate Python process (not embedded in the UI process).
- The UI should be Electron + React, sharing components with streaming and Tauri frontends.
- Python is acceptable for the server, but should not run inside the UI process.
- You want raw local frames without WebRTC, video codecs, or network transport.
- The same JSON `event_type`/`payload` protocol as streaming is needed, but over IPC/local transport.
- The frontend uses `useShmBackend` behind the same `ViewerBackend` interface.

Architecture:

```text
Electron React renderer
  -> useShmBackend.ts (ViewerBackend)
  -> Electron preload / IPC
  -> N-API C++ addon
  -> POSIX SHM (/dev/shm)
  -> Python ovrtx render server
  -> ovrtx renderer.step()
```

See skill: `electron-shm-viewer`

## Choose Local Lightweight When

Use `local-viewer` when the user runs on the GPU workstation and wants a focused app:

- Full desktop interactivity without a network stack.
- Header, viewport, narrow sidebar, scene switching, picking, info display, and settings.
- Access through local monitor, Xvfb, VNC, or similar.
- One operator or developer workflow.

```text
python -m local_app
  -> ovui standalone GLFW window
  -> ImageBridge/ImageWithProvider
  -> ovrtx renderer
  -> local GPU framebuffer
```

## Full Editor Requests

Do not route full-editor requests to the lightweight `local-viewer` path.

For a focused Omniverse Realtime Viewer that needs inspector-style features,
combine `local-viewer` with focused references:

- `stage-hierarchy` for the hierarchy tree and variants.
- `prim-info-display` for selected prim properties.
- `selection-feedback` and `selection-animation` for visual selection state.
- `render-settings` and `viewport-overlays` for controls and viewport UI.

Choose `ovwidgets-editor-shell` only when the requested experience truly needs
full-editor capabilities:

- Built-in stage browser, property inspector, layer/content windows, selection outline, transform gizmos, camera inertia, and undo.
- Docking, shortcuts, themes, settings, status bar, and editor lifecycle.

## Choose Streaming When

Use `ovrtx + ovstream + WebRTC + React` when the Omniverse Realtime Viewer must run remotely:

- Browser clients connect to a GPU host.
- Remote access, web UI, auth, routing, embedding, or service deployment matters.
- Input travels over the NVST native input channel; app state travels over the WebRTC data channel.
- Frames must be encoded/transported to another machine.

```text
React/Vite frontend
  <-> WebRTC signaling/data/video
  <-> ovstream server
  <-> Python render loop
  <-> ovrtx renderer
  <-> CUDA/NVENC
```

## Shared Pieces

- USD stage assets and composition patterns.
- ovrtx concepts: camera prims, render products, `LdrColor`, `renderer.step()`, and `write_attribute()`.
- Optional S3-compatible asset sync to a local cache.
- Stage query logic, picking/highlight concepts, camera math, and transform-authoring conventions.
- GPU/display/headless environment setup, `OVRTX_SKIP_USD_CHECK`, and stale GPU process checks.

## Differences

| Concern | Local lightweight | Tauri/Rust | Streaming |
|---|---|---|---|
| UI | ovui lightweight shell | React WebView (Vite) | React/Vite, optional server ovui overlays |
| Language | Python | Rust + TypeScript | Python + TypeScript |
| Transport | local framebuffer | Tauri binary IPC Channel | WebRTC video + data channel |
| Interaction | direct in-process API calls | WebView events -> Tauri invoke/direct native calls | NVST native input channel -> binary `InputEvent` structs |
| Panels | local sidebar/panels | React components via ViewerBackend | React components via JSON server APIs |
| Lifecycle | local app loop | Tauri + render thread | server owns renderer + frontend connection |

## Decision Rule

Start streaming if the GPU is remote, the user must stay in a browser, or the Omniverse Realtime Viewer must integrate with a web product.

Start Tauri if the app runs on the GPU workstation, needs a web-tech UI (React), wants to share components with the streaming path, and should ship as a native binary without Python.

Start Electron + SHM for local GPU apps that need React/Electron UI, process isolation, Python ovrtx server, and raw local frames without WebRTC.

Start local lightweight (Python/ovui) for a focused viewer without editor affordances.

For full editor shell requests, use this skill only for preliminary routing.
Then follow the full-editor guidance provided by the current `ovui` dependency
guidance if it is available; otherwise state that this skill package does not define
a full-editor implementation path.

Choose the renderer topology deliberately. A Tauri app should not bring in ovstream or ovui. An Electron SHM app should not bring in ovstream WebRTC, NVENC, or browser streaming unless it is also intentionally exposing a remote co-viewing stream. A streaming app should not depend on Tauri IPC. A local ovui app should not bring in WebRTC.

## Input Path Contract

- WebRTC: use NVST's native input channel. Browser mouse, keyboard, wheel, and touch input reaches `server.on_input` as binary `InputEvent` structs; do not encode camera control as JSON.
- SHM: use `ovstream.ShmClient.send_input_event()` from Python, or `ovstream_shm_client_send_input_event()` from C, to send `InputEvent` structs. Do not use JSON `mouseInput` for SHM camera control.
- In-process: call the Python/C++ camera, selection, and settings APIs directly from the local UI/event loop.

Read `viewer-input-routing` before implementing any path that handles camera
gestures, click picking, viewport input ownership, or transport button ids.

## Streaming Loop Skeleton

```python
renderer = ovrtx.Renderer(...)
server = ovstream.Server()
server.on_message = handle_message
server.on_input = handle_input
server.start(config)
while running:
    products = renderer.step(render_products={render_product}, delta_time=dt)
    with products as ctx:
        stream_ldr_color(ctx[render_product])
```

Keep shared code below the shell boundary: stage resolution, storage sync, USD metadata queries, camera math, and renderer setup. Keep UI state, input routing, and lifecycle in the chosen shell.

## Gotchas

- Local import order: set `OVRTX_SKIP_USD_CHECK=1`, import `pxr`, then import ovrtx/ovui as the selected local skill describes.
- Streaming import order can differ, especially when `pxr` is isolated in a worker.
- `LdrColor` casing is required in all paths.
- Browser media ports are negotiated by WebRTC; do not manually invent frontend media-port settings.
- Local frame readback may be hidden inside a widget; streaming must explicitly map/copy/encode frames.
- Tauri frame delivery is raw RGBA binary Channel push — no JPEG/base64 encoding.
- Kill stale Python GPU processes before diagnosing renderer hangs.

See also: `tauri-local-viewer`, `local-viewer`, `dependencies`, `viewer-input-routing`, `streaming-client`, `streaming-server`.
