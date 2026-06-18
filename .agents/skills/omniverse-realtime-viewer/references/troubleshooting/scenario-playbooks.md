<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Troubleshooting Scenario Playbooks

## Server Startup

Check first:

- `OVRTX_SKIP_USD_CHECK=1` is set before ovrtx is imported or constructed.
- `OVRTX_BIN_PATH` points at the ovrtx `bin` directory when renderer plugins or MDL materials fail.
- `OVSTREAM_LIB_PATH` points at the native ovstream library directory when `ovstream` cannot import.
- The process uses one USD import strategy: ovrtx-first for streaming, documented local-viewer ordering for lightweight local paths, or a separate `pxr` worker on Windows.
- A GPU is visible and the selected CUDA device is not already held by a stale Omniverse Realtime Viewer process.
- Signaling and media ports are available.

Logs to inspect:

- Python server stdout/stderr, including ovrtx construction and ovstream initialize logs.
- Any app log file configured by the generated viewer, commonly under `logs/` or the current working directory.
- `pxr_worker.py` stderr if hierarchy/properties run in a subprocess.
- Native crash output from the terminal that launched the server.

Usual fixes:

- Set the environment before launching Python, then fully restart the server.
- Move ovrtx bundled plugin libraries first in the dynamic library path if another USD build is loaded.
- Kill stale GPU Omniverse Realtime Viewer processes after a renderer crash or hang.
- Change the signaling port if another process owns it.

## Server-Side Diagnostics

Run these from the server machine:

```bash
nvidia-smi
ps -ef | rg 'python|ovstream|viewer|vite'
ss -ltnup | rg '49100|47999|8554'
lsof -iTCP:49100 -sTCP:LISTEN
env | rg 'OVRTX|OVSTREAM|LD_LIBRARY_PATH|PATH'
```

Interpretation:

- `nvidia-smi` shows whether the GPU is visible and which PIDs still own GPU memory.
- `ps` identifies duplicate servers, stale renderers, and runaway frontend dev servers.
- `ss`/`lsof` confirms whether signaling port `49100`, WebRTC media UDP, or RTSP port `8554` is already bound.
- Environment output confirms whether the launched process actually received the paths you set in the shell.

## Browser Cannot Connect

Check first:

- The server was started before the frontend connects.
- The frontend uses `server` and `signalingPort`, not `signalingServer`.
- The frontend uses standalone ovstream Direct config: `server` and
  `signalingPort`.
- The frontend does not set `mediaServer`, `mediaPort`, `signalingPath`, or
  auth/session fields in `DirectConfig`. If an orchestrator launches the
  container, map its exposed endpoint to `server` and `signalingPort`.
- Local development uses `webrtc_public_ip=127.0.0.1` or an explicitly reachable LAN IP.
- Only one WebRTC client is connected unless the server intentionally replaces the old session.

Logs to inspect:

- Browser console for WebSocket/signaling errors.
- Browser Network tab for the signaling request and WebSocket upgrade. If
  `POST /sign_in` returns HTTP 501, verify the frontend did not follow a
  Kit/OVC/NVCF/GFN client profile or inject auth/session fields before changing
  the ovrtx or ovstream server.
- Server logs for connection callbacks.
- `chrome://webrtc-internals` or `edge://webrtc-internals` for ICE, DTLS, and media state.

Usual fixes:

- Match frontend host/port to the server's WebRTC signaling config.
- Remove `mediaPort` from frontend config.
- Reduce aggressive reconnect settings when logs show repeated previous-session messages.
- Close the old browser tab or restart the ovstream server if the previous session is stuck.

## Video Does Not Stream

Check first:

- `server.on_connection`, `server.on_message`, and `server.on_input` are registered before `server.start()`.
- The render loop is calling `renderer.step()` with the exact active RenderProduct path.
- `LdrColor` exists in the returned render vars.
- The app submits BGRA8 frames to ovstream, not ovrtx RGBA8.
- CUDA or CPU frame buffers stay alive until `stream_video()` returns.
- Render var data is copied while the owning `RenderProductSetOutputs` is still alive; frame views are not held across later `renderer.step()` calls.
- Stream width, height, and pitch match the frame buffer.
- The `<video>` element exists before `AppStreamer.connect()`.
- On cold start, the first `renderer.step()` may spend 2-5 minutes compiling RTX shaders or pipelines before producing a frame.

Logs to inspect:

- Server frame counters and render product names.
- ovrtx logs for first-run shader or pipeline compilation progress.
- ovstream warnings from the log callback.
- Browser media element errors in the console.
- WebRTC internals inbound video stats: frames decoded, frames dropped, resolution, bitrate.

Usual fixes:

- Fix RenderProduct/session layer setup before changing WebRTC code.
- Add or repair RGBA-to-BGRA conversion when red and blue are swapped.
- Keep browser streaming at the configured fixed resolution. If that startup configuration changes, restart/reconnect instead of resizing the live stream.
- Copy frame data inside the same render-loop step when passing it to an encoder, stream, UI bridge, or worker queue.
- Use at least a 300 second timeout for the first rendered frame on a cold cache, then expect later steps to be much faster.

## Local ovui Window Is Black Or Blank

Use this for local desktop viewers where ovrtx renders in-process and ovui
presents copied RGBA frames.

Check first:

- Save a direct ovrtx `LdrColor` artifact from the same RenderProduct and
  RenderVar path used by the window.
- Push a synthetic RGBA gradient through the exact ovui provider/widget path and
  capture a desktop screenshot of the window.
- Verify the image widget has nonzero computed size, visible opacity, and is not
  covered by an opaque overlay.
- Verify ovui style colors use `0xAARRGGBB`, not another byte order.
- Verify only one owner calls `renderer.step()`, and no step overlaps
  `open_usd*`, reference mutation, or `reset_stage()`.

Interpretation:

- Direct `LdrColor` is blank: debug scene loading, camera path, render product,
  render var source, camera transform, stage lighting, and material/plugin
  resolution.
- Direct `LdrColor` is nonblank but the synthetic ovui frame is blank: debug
  ovui presentation, provider updates, widget layout, and main-loop stepping.
- Direct `LdrColor` is nonblank and the synthetic frame paints, but live frames
  stay blank: debug copied-frame lifetime, provider update calls, and whether
  the ovui loop is presenting the latest copied frame.

Usual fixes:

- Prove presentation with the synthetic frame before changing camera or USD
  composition.
- If dynamic byte-provider updates do not paint in the active build, validate
  with a known-good ovui-native path such as a `RasterImageProvider`
  screenshot/frame fallback.
- Render or warm up one direct ovrtx frame before entering the long-running ovui
  loop when startup ordering is unstable.
- Move continuous rendering into one render worker that owns renderer mutation;
  let the ovui/main loop present only the latest copied RGBA frame.

## Electron SHM Viewer

Use this for local separate-process Electron viewers where the Python server owns `ovrtx` rendering and Electron only presents already-rendered pixels through SharedArrayBuffer and WebGL texture upload.

Check first:

- Black viewport in Electron: check the canvas `desynchronized` context flag and remove it under Xvfb, verify SAB delivery, and log frame sequence numbers on both sides.
- Wrong colors: BGRA/RGBA swap was not applied, or `GL_BGRA_EXT` is not available.
- SHM segment not found: server was not started with `--shm`, or the stream name does not match the Electron client.
- N-API addon won't build: `node-gyp` is missing, the Node ABI does not match Electron, or `libovstream_shm_client.so` is missing.
- SharedArrayBuffer unavailable: COOP/COEP headers are missing in Electron `BrowserWindow` `webPreferences`.
- Electron shows "SHM connected" but no frames: AsyncWorker vs ThreadSafeFunction issue in Electron; use TSFN for frame callbacks.
- Frame stutter at >30fps: check the frame pacing throttle and confirm the renderer updates with `texSubImage2D` instead of reallocating with `texImage2D`.

Logs to inspect:

- Python server startup arguments, especially `--shm`, stream name, frame size, ring-buffer size, and frame counters.
- Native N-API addon build logs for ABI, include path, and `libovstream_shm_client.so` resolution errors.
- Electron main-process logs for BrowserWindow isolation, preload setup, and native addon load failures.
- Electron renderer logs for SAB byte length, frame sequence numbers, pixel format, and WebGL extension availability.

Usual fixes:

- Start the server in SHM mode with the same stream name the Electron client uses.
- Configure Electron so SharedArrayBuffer is available through the isolated preload/contextBridge path.
- Use ThreadSafeFunction for native-to-JavaScript frame notifications instead of relying on AsyncWorker callbacks.
- Remove the desynchronized canvas context flag when running under Xvfb.
- Apply the expected BGRA/RGBA conversion path or use `GL_BGRA_EXT` only after checking support.
- Reuse the WebGL texture with `texSubImage2D` and throttle presentation to the intended frame rate.

## Data Channel Does Not Work

Check first:

- Frontend sends only after streaming status is connected.
- Server send helper checks that a client is connected before `send_message`.
- The server unwraps browser library messages that contain `messageType`, `messageRecipient`, and nested `data`.
- Exact event names match on both sides: `openStageResult`, `getChildrenResult`, `stageSelectionChanged`, `getPropertiesResponse`.
- The frontend `onCustomEvent` router is registered before responses arrive, or the server proactively pushes state on connect.
- Slow USD queries are not running directly inside ovstream callback threads.

Logs to inspect:

- Raw incoming data-channel messages on the server before dispatch.
- Frontend `onCustomEvent` payloads.
- Browser console for JSON parse errors.
- Server handler map misses or "unknown event" warnings.

Usual fixes:

- Unwrap the AppStreamer envelope before reading `event_type`.
- Add one shared message-name reference and update both frontend and server routers.
- Push current stage, hierarchy root, selection, loading state, and render settings after a reconnect.
- Queue slow work for the render/runtime thread.

## Frame Looks Wrong

Check first:

- Red/blue swapped means ovrtx RGBA was sent to ovstream without BGRA conversion.
- Black frame means invalid camera relation, bad camera transform, missing resolution, wrong RenderVar `sourceName`, or wrong RenderProduct path.
- Magenta materials mean MDL resolver paths are wrong, usually missing `OVRTX_BIN_PATH` or plugin library path.
- Frozen frame means `renderer.step()` stopped, a buffer lifetime bug exists, or the browser is still connected to an old session.
- Invalid output-handle errors usually mean a frame or mapped render var view outlived its `RenderProductSetOutputs`.
- Stale GPU hangs after crashes usually mean an old Python process still owns GPU resources.
- GPU utilization can show 0% during first-run shader compilation; inspect logs before assuming a graphics hang.

Logs to inspect:

- ovrtx warnings about RenderProduct, RenderVar, camera, material, and MDL resolution.
- Per-frame counters on the render loop and stream submission.
- `nvidia-smi` process and memory output.
- Browser WebRTC internals for decoded frame count.

Usual fixes:

- Repair stage-loading inline/session data before tuning quality settings.
- Set `OVRTX_BIN_PATH` and put ovrtx plugin libraries first.
- Copy mapped render vars before leaving the step context, and never reuse frame views across steps.
- Restart the Python process after native-library or import-order changes.
- Kill stale render PIDs before relaunching.

## Scene Will Not Load

Check first:

- The requested path exists from the server process, not just from the browser.
- Asset root, allowed schemes, cache path, and user-provided path validation agree.
- Inline root sublayer paths resolve from the server process and preserve relative asset resolution.
- The viewer creates Camera -> RenderProduct -> RenderVar -> RenderSettings data for every load.
- `reset_stage()` and `open_usd*()` do not run concurrently with `renderer.step()`.

Logs to inspect:

- `openStageRequest` URL and resolved server path.
- pxr stage-open or worker errors.
- ovrtx stage load and RenderProduct errors.
- Missing texture, sublayer, and asset resolver warnings.

Usual fixes:

- Resolve paths on the server and send clear `openStageResult` errors to the frontend.
- Keep generated inline/session content stable until the load operation completes and a valid frame is produced.
- Rebuild session render prims after every reset.
- Write wrapper files near the source asset or preserve directory structure in the cache.

## Camera Does Not Move

Check first:

- In WebRTC streaming, camera input is handled from NVST/ovstream `InputEvent` callbacks, not JSON.
- In SHM streaming, camera input must use `ovstream.ShmClient.send_input_event()` from Python, or `ovstream_shm_client_send_input_event()` from C, not JSON `mouseInput`.
- In in-process apps, camera input should call the Python/C++ camera APIs directly.
- Mouse coordinates are converted through the rendered image rect, including letterboxing.
- The camera path used by controls is the same path referenced by the RenderProduct.
- Live transform writes target `omni:xform`, not authored `xformOp:*`.
- Writes use the correct transform semantic and create attributes that may not already exist.
- Orbit/pan/zoom state remains finite after scene switch or camera restore.

Logs to inspect:

- Input callback event type, button/wheel state, and coordinates.
- Camera controller target, distance, azimuth/elevation, and matrix values.
- Renderer write errors or silent skipped writes.

Usual fixes:

- Route input events to a render-thread command queue.
- Write `omni:xform` with create-new prim mode for viewer camera updates.
- Refit the camera to stage bounds after invalid restore state.
- Keep drag threshold logic from turning every click into a camera move or every drag into a selection.

## Picking Does Not Work

Check first:

- The native pick query was enqueued for the same RenderProduct that is stepped next.
- The next frame contains the synthetic `ovrtx_pick_hit` render var and its params pass validation.
- Picked `primPath` ids are resolved through the renderer path dictionary before publishing UI state.
- Pixel coordinates are render pixels, not full DOM/widget pixels when letterboxed.
- Pending pick state and selectable path sets are cleared after scene reset.
- Tree selection expands Xform/Scope paths to descendant mesh paths for highlight feedback.

Logs to inspect:

- Pick click coordinates before and after viewport-to-render mapping.
- Pick-hit params and resolved prim paths.
- Selected prim path, mesh expansion result, and `stageSelectionChanged` payload.

Usual fixes:

- Pin the picking RenderProduct to CUDA-visible GPU 0 when required by the active ovrtx build.
- Use `renderer.query_prims` or native pickability APIs to refresh selectable paths after scene switches.
- Avoid selecting on left-button release if the drag threshold was exceeded.

## Hierarchy, Prim Info, And Variants

Check first:

- Direct `pxr` imports follow the process import discipline, or USD queries run in a subprocess worker.
- Worker protocol is one JSON object per line and logs go to stderr, not stdout.
- USD values are serialized into JSON-safe primitives before sending to React.
- Frontend route names match the active protocol: `getChildrenResult`, `getPropertiesResponse`, `getVariantsResponse`.
- Variant changes refresh children, properties, selection expansion, pickability filters, and selected paths that may have changed.

Logs to inspect:

- Worker request and response IDs.
- Frontend custom-event router output.
- Serialization failures for large arrays, matrices, asset paths, or unknown pxr values.

Usual fixes:

- Move pxr queries into a worker on Windows or when USD registry conflicts appear.
- Cap large arrays in property payloads.
- Re-query affected subtree and selected prim info after variant edits.

## Scene Switching And Persistent State

Check first:

- Scene switch clears selection, info panel, hierarchy cache, pending pick state, animation bindings, and native selection outline state before the new load.
- Settings are stored in app JSON and reapplied after each load, not authored into user USD files.
- Native selection outline groups are cleared after every stage load when selection feedback is present.
- Scene switches should reuse the configured fixed stream/render resolution. For local Omniverse Realtime Viewers or explicit startup configuration changes, rebuild derived buffers, letterbox math, and pick coordinate mapping together.

Logs to inspect:

- Stage lifecycle state: idle, loading, streaming, error, shutting down.
- Active settings snapshot before and after load.
- Concurrent render-step and reset attempts.

Usual fixes:

- Serialize stage mutation through the render thread.
- Rebuild all derived state after `reset_stage()`.
- Send fresh initial state to reconnecting clients.

## Frontend Diagnostics

Use these browser tools:

- Console: AppStreamer errors, JSON parse failures, unhandled custom events, media element errors, React state warnings.
- Network tab: signaling request, WebSocket upgrade, failed CORS/proxy requests,
  and any `POST /sign_in` 501 response that indicates the wrong standalone
  ovstream Direct client profile.
- `chrome://webrtc-internals` or `edge://webrtc-internals`: ICE candidate pair, connection state, bytes received, frames decoded, frame size, frame rate.
- React DevTools: connection status, current scene URL, selected prim, hierarchy cache, settings state.

What to look for:

- Connected state but zero decoded frames points at stream submission or media negotiation.
- Decoded frames increasing but black video points at renderer or scene setup.
- Custom events arriving but UI unchanged points at frontend reducer/state wiring.
- No custom events arriving points at data-channel send/receive, envelope unwrapping, or server send guard.

## Recovery Patterns

Restart the Python server when:

- Environment variables, dynamic library paths, import order, ovstream native libraries, or ovrtx plugin paths changed.
- The renderer crashed, hung, or left stale GPU memory in `nvidia-smi`.
- Callback registration order or WebRTC server configuration changed.
- Fixed stream resolution configuration, codec, or native frame buffer allocation changed.

Restart or reconnect the browser when:

- AppStreamer config changed.
- A previous WebRTC session is stuck.
- The video element or frontend connection provider was rebuilt.

Fix code before restarting repeatedly when:

- Event names do not match.
- Renderer stage mutation races with `renderer.step()`.
- Scene wrappers are written to paths that break relative asset resolution.
- Camera writes target `xformOp:*` instead of `omni:xform`.
- Picking uses DOM coordinates or `[x, y]` buffer indexing.
