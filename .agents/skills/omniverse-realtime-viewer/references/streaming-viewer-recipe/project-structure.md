# Streaming Project Structure

## Pattern, Not Fixed File Layout

A streaming Omniverse Realtime Viewer is two processes: a Python server owns
USD, ovrtx rendering, stage state, and frame streaming; a browser client owns
DOM UI, connection state, and app-level commands. The file tree below is a
worked layout, not a required package shape. Reorganize modules to match the
host repo as long as the contracts remain intact: one render thread owns ovrtx
mutation, video frames use the streaming path, JSON messages stay on the data
channel, and UI input follows the selected transport's input channel.

## Global Rules

- *Before writing any code*, read `references/dependencies`. Its
  `references/nvidia-runtime.md` file owns acquisition details for `ovrtx`,
  `ovstream`, `ovui`, and the `ov-web-rtc` client; do not repeat those locations
  in project structure guidance.
- *NEVER use WebGL, Three.js, Babylon.js, or any client-side 3D renderer.* All USD rendering is done server-side by `ovrtx`. The browser receives a WebRTC video stream; it displays `<video>`, not `<canvas>` with a 3D scene graph. ovrtx requires an NVIDIA GPU. Do NOT substitute a browser renderer.
- For deployment work, read `references/cloud-deployment` and use the supported
  paths documented there, such as OKAS 1 or Brev.
- Keep the streaming app split into a Python server process and a React browser client. The server owns USD, ovrtx, ovstream, picking, camera state, and scene mutations. The browser owns DOM UI, connection state, and app-level message sends.
- Do not send rendered pixels through the JSON data channel. Only stream video through ovstream and use JSON messages for app state and commands.
- Do not forward mouse, keyboard, wheel, or touch input manually as JSON. The WebRTC browser library forwards input through NVST's native input channel as binary `InputEvent` structs; handle them on the server through the ovstream input callback. For SHM Python clients, use `ovstream.ShmClient.send_input_event()`; C clients use `ovstream_shm_client_send_input_event()`. Do not use JSON `mouseInput`. Use `viewer-input-routing` for button normalization, viewport ownership, and click-vs-drag dispatch.
- Make one render thread the sole owner of `renderer.step()`, `open_usd()`, `open_usd_from_string()`, reference add/remove APIs, `reset_stage()`, native pick queries, selection outline writes, and live `write_attribute()` calls. Other callbacks enqueue work for that render thread.
- Register all ovstream callbacks before starting the server. Early connection and data-channel events can otherwise be dropped.
- Set `OVRTX_SKIP_USD_CHECK=1` before any ovrtx work. Keep import order disciplined: initialize ovrtx first in the streaming server process. Use ovrtx `query_prims` for basic runtime prim discovery; import `pxr` only for USD features not covered by native ovrtx queries.
- Treat stream resolution as a server-renderer contract. Use a fixed server render size, typically 1920x1080, and display the browser video with `object-fit: contain`; NVST handles letterbox coordinate mapping.
- Never modify the user USD file when adding viewer camera, render products, render vars, settings, selection metadata, or inline session data.

## 1. Create The Project Skeleton

Create a two-process project with a server package and a frontend app. Use this structure unless the host repo already has an equivalent convention:

```text
streaming-usd-viewer/
  README.md
  requirements.txt or pyproject.toml
  server/
    __init__.py
    ov_web_viewer_server.py
    config.py
    runtime.py
    renderer_runtime.py
    scene_loader.py
    stream_server.py
    frame_converter.py
    message_router.py
    input_router.py
    camera_controller.py
    selection_controller.py
    scene_manager.py
    render_settings.py
    stage_queries.py
    settings_store.py
    assets.py
  frontend/
    package.json
    index.html
    vite.config.ts
    src/
      main.tsx
      App.tsx
      streaming/
        StreamingProvider.tsx
        streamingConfig.ts
        messages.ts
      components/
        Viewport.tsx
        Toolbar.tsx
        ScenePicker.tsx
        StageTree.tsx
        PrimInfoPanel.tsx
        RenderSettingsPanel.tsx
        StatusBar.tsx
      types/
        messages.ts
        usd.ts
      styles.css
  assets/
    samples/
  data/
    viewer-settings.json
```

Do this:

- Create the server and frontend files above directly in the generated app.
- Keep all renderer and USD state in `server/`. Keep React state and browser UI in `frontend/src/`.
- Put sample USD files under `assets/samples/` or accept an absolute configured asset root. Do not hard-code developer machine paths.
- Persist cross-scene viewer settings under `data/viewer-settings.json` or a user-configurable settings path.

Critical contracts:

- `server/ov_web_viewer_server.py` is the process entry point only. It parses config, constructs runtime objects, starts ovstream, enters the render loop, and shuts down cleanly. If a generated project uses a different entry-point name, update deployment commands and templates consistently.
- `server/renderer_runtime.py` owns the ovrtx renderer, current render product path, frame stepping, frame extraction, and live attribute writes.
- `server/scene_loader.py` owns viewer camera/render-product/render-var injection and never mutates user USD files.
- `server/stream_server.py` owns ovstream initialization, callback registration, start/stop, send guards, and video frame submission.
- `server/message_router.py` owns data-channel message unwrapping, event dispatch, request validation, and response sends.
- `server/input_router.py` owns ovstream input events and translates them to camera, selection, and keyboard actions.
- `frontend/src/streaming/StreamingProvider.tsx` owns AppStreamer connection lifecycle and exposes status plus a guarded send helper.
- `frontend/src/types/messages.ts` and `server/config.py` must agree on exact event names.

Decision points:

- If the user asks for the quickest local demo, use Vite for the frontend and run it separately from the Python server.
- If the user asks for a packaged deployment, keep the same server/client boundary and read `references/cloud-deployment` before adding deployment files.
- If the user asks for server-side viewport overlays composited into the video, add overlay modules after the core stream works; see `references/viewport-overlays` for the full contract.
- If the user asks for S3, MinIO, or cloud asset browsing, keep asset discovery behind `server/assets.py`; see `references/cloud-assets` for the full contract.

Common failure modes:

- Putting renderer code in React creates an impossible browser dependency path. Keep rendering server-side.
- Mixing message names across server and client silently breaks UI updates. Define the names once and route every message through the same table.
- Adding USD query code inside streaming callbacks can stall data-channel threads. Queue slow work or isolate it in `stage_queries.py`.

Read for depth: see `references/usd-viewer-app`, `references/streaming-server`, `references/streaming-client`, and `references/streaming-messages` for the full contracts.
