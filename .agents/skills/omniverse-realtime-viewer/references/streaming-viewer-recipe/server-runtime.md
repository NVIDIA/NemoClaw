# Streaming Server Runtime

## 2. Install Dependencies And Configure The Environment

*Read `references/dependencies` FIRST.* Its `references/nvidia-runtime.md` file is
the source of truth for NVIDIA runtime locations. Do not guess install paths and
do not repeat `ovstream`, `ovui`, `ovrtx`, or `ov-web-rtc` client acquisition
details in this recipe.

Do this on the server side:

- Install `ovrtx` using the package guidance in `references/dependencies`.
- Install `ovstream` using the current package guidance in `references/dependencies`.
  If `ovstream.initialize()` reports missing native StreamSDK libraries, follow
  the current dependency guidance.
- Install `warp-lang` for CUDA-side channel conversion (`pip install warp-lang`).
- Install `numpy` for matrices and camera math (`pip install numpy`).
- Install `usd-core==24.11` only when the server process needs direct `pxr` queries. Pin to 24.11 — newer versions cause TfType schema conflicts with ovrtx. Prefer subprocess query mode on Windows or when USD registry conflicts appear.

For generated browser viewers, create app-local setup and run wrappers rather
than pointing users at repo-level scripts. The setup wrapper should install the
server dependencies above, run the verification checks from
`references/dependencies/environment-validation.md`, and fail with the exact
command that did not pass. The run wrapper should set `OVRTX_SKIP_USD_CHECK`,
derive `OVRTX_BIN_PATH` from the installed `ovrtx` package when needed, preserve
the selected ovstream package layout, start the server, and write logs to a
known project-local path.

Do this on the frontend side:

- Create a Vite React app (`npm create vite@latest frontend -- --template react-ts`).
- Configure and install `@nvidia/ov-web-rtc` using `references/dependencies`.
  Use only the standalone `ovstream` Direct connection pattern from
  `streaming-client`; do not use Kit, OVC, NVCF, or GFN client connection
  profiles in the browser WebRTC config. If OKAS or another orchestrator
  launches the container, convert its exposed endpoint into Direct `server` and
  `signalingPort` values.
- Add normal UI dependencies only when they are part of the requested UI. Keep the core connection path dependency-light.

Set these environment contracts before starting the server:

- `OVRTX_SKIP_USD_CHECK=1` must be set before ovrtx is imported or the renderer is constructed.
- `OVRTX_BIN_PATH` must point at the ovrtx `bin` directory when materials or renderer plugins fail to resolve.
- The ovrtx plugin library path must be first in the dynamic library path if another USD build is present.
- `OVSTREAM_LIB_PATH` must point at the ovstream native library directory when the Python binding cannot find native libraries.
- If `ovstream` native libraries are not found, use the current runtime
  guidance from `references/dependencies` instead of copying stale fallback
  library paths from older recipes.

Decision points:

- If the target is local development, use WebRTC signaling port `49100`, stream port defaulting through ovstream, and public IP `127.0.0.1`.
- If the target is LAN access, expose signaling host and port through frontend URL parameters and environment variables.
- If the target is cloud deployment, do not invent a new deployment model in this recipe; read `references/cloud-deployment` and keep to supported paths.
- If running on Windows with `pxr` imports for advanced USD inspection, prefer a separate USD query subprocess rather than importing `pxr` in the ovrtx render process.

Common failure modes:

- `usd-core detected`, duplicate USD debug symbols, `_tf` import failures, or MDL resolver crashes usually mean import order or library path is wrong.
- Magenta materials usually mean `OVRTX_BIN_PATH` or plugin library path is missing.
- ovstream import or initialize failure usually means native StreamSDK libraries are missing, `OVSTREAM_LIB_PATH` points at the wrong layout, the platform build does not match, or GPU/driver support is missing.
- `No matching distribution found for ovrtx`: wrong package guidance, unsupported platform, or unsupported Python version; re-check `references/dependencies`.
- ovstream package not found: wrong package source, stale package metadata, wrong platform tag, or network/proxy issue; re-check `references/dependencies`.

Read for depth: see `references/dependencies` for install commands, `references/ovrtx-rendering` and `references/streaming-server` for the full environment and native library contracts.

## 3. Build The Server Runtime Shell

Do this:

- In `server/ov_web_viewer_server.py`, parse width, height, target FPS, signaling port, public IP, initial scene URL/path, asset root, and settings path.
- Construct a single application runtime object that owns the renderer runtime, scene manager, stream server, message router, input router, settings store, and command queue.
- Follow the canonical startup order: set env, construct an ovrtx renderer with native selection outline support when needed, load the initial stage through `open_usd()` or `open_usd_from_string()`, warm up the renderer, initialize ovstream, register callbacks, start readiness health, then start the render loop.
- Initialize ovstream once, create a WebRTC server, register `on_connection`, `on_message`, and `on_input`, then start the server.
- Enter one render loop that drains queued commands, updates camera/selection/settings state, steps ovrtx when a scene is loaded, converts the frame to BGRA, and submits video to ovstream.
- On shutdown, stop streaming, close the ovstream server, close renderer resources if exposed by the API, and call ovstream shutdown exactly once for each initialize call.

Canonical startup sequence:

```text
set OVRTX_SKIP_USD_CHECK=1
import ovrtx and construct Renderer(RendererConfig(sync_mode=True, selection_outline_enabled=True))
load initial stage:
  build an inline root USDA that sublayers the user stage and authors viewer render config
  renderer.open_usd_from_string(inline_root_usda)
  bind /OVCamera omni:xform
  initialize native selection outline styles and clear outline groups
warm up renderer:
  write camera transform
  step /Render/OVServer/ViewportTexture0 several frames
  probe render vars and allocate persistent BGRA stream buffer
initialize ovstream and register callbacks:
  on_connection -> push_initial_state
  on_message -> JSON app protocol
  on_input -> raw mouse/keyboard input routed through viewer-input-routing
start /healthz:
  503 until first valid frame
  200 after first successful converted frame
start render loop thread
```

Critical contracts:

- Register callbacks before `server.start()`.
- Keep callbacks fast. They may be called from StreamSDK internal threads.
- Do not call renderer load/reset/step/write APIs directly from ovstream callbacks. Enqueue work for the render loop.
- Guard `send_message` with the connected-client state.
- Maintain explicit runtime states: starting, idle/no scene, loading, streaming, error, shutting down.
- Keep the most recent loaded stage URL, root hierarchy summary, selection, render settings, and loading state in server memory so a newly connected browser can receive initial state.
- Readiness is not liveness: `/healthz` must return `503 not ready` until the render loop has produced and copied the first valid frame, then `200 ok`.
- Readiness must not depend on an active browser client or on `stream_video()` succeeding. Before any client connects, frame submission can no-op or raise transient no-client/disconnect errors depending on the selected ovstream build.

Decision points:

- If no initial scene is configured, start the server in idle state and let the frontend send `openStageRequest`.
- If an initial scene is configured, load it before or during the first render loop iteration, then push state when the client connects.
- If one client is already connected and a second browser connects, follow ovstream's one-client WebRTC constraint. Either reject the new client clearly or replace the old session intentionally.
- If the render loop falls behind target FPS, prefer dropping frames or reducing render quality over running concurrent renderer steps.

Common failure modes:

- Registering callbacks after `start()` causes missed connection and data-channel events.
- Calling `renderer.step()` during `reset_stage()`, `open_usd*()`, or reference mutation causes races, stale buffers, or crashes.
- Sending messages while no client is connected silently loses important state unless the runtime pushes initial state after connection.

Read for depth: see `references/streaming-server` and `references/streaming-lifecycle` for the full lifecycle contract.

## 4. Construct The ovrtx Renderer

Do this:

- Create the renderer in `server/renderer_runtime.py` after environment variables are set.
- Use synchronous rendering first. Add asynchronous rendering only after buffer lifetime, readiness, and stream pacing are explicitly handled.
- Store the active render product path, stream width, stream height, current frame index, and whether a valid stage is loaded.
- Expose render-loop-only operations for loading a scene, resetting the stage, stepping a frame, mapping render vars, enqueueing and decoding pick queries, setting selection outline groups, and writing live attributes.

Critical contracts:

- The application calls `renderer.step()` explicitly. ovrtx does not run a hidden app loop for the viewer.
- Pass the exact viewer RenderProduct path to every step call.
- Extract `LdrColor` from the returned frame. This is RGBA8 from ovrtx.
- For AOVs, handle both single-tensor and multi-tensor render var outputs. Single-tensor outputs are consumed directly through DLPack; multi-tensor outputs must select a named image tensor and read params separately. Image tensors are channel-last (`H x W x C`), not channel-first.
- Map CUDA buffers for streaming. Avoid CPU round trips in the normal streaming path.
- Keep mapped or converted frame buffers alive until `stream_video()` returns.
- Use `write_attribute` for live camera transforms and other live state. Write `omni:xform`, not authored `xformOp:*`, for interactive updates.
- Use the correct transform semantic and create-new prim mode for attributes that may not already exist in Fabric.

Decision points:

- If the app only needs basic video streaming, start with `LdrColor` only.
- Object selection uses native pick queries. Do not add segmentation render vars just to make picking work.
- If render settings include debug segmentation view, keep both render vars available and switch the streamed image source intentionally.
- If the renderer reports stale GPU hangs after a crash, inspect running Python GPU processes before changing code.

Common failure modes:

- `Unable to find RenderProduct prim` means scene setup did not create the path used by `renderer.step()`.
- Black frame usually means camera relation, render product resolution, render var source, or camera transform is invalid.
- Red/blue color swap means ovrtx RGBA was submitted to ovstream without BGRA conversion.
- Live camera changes doing nothing usually means the app wrote `xformOp:transform` instead of `omni:xform`, or used existing-only prim mode.

Read for depth: see `references/ovrtx-rendering` for the full renderer construction, frame extraction, and live attribute contract.

## 5. Implement Scene Loading

Do this in `server/scene_loader.py` and call it only from the render loop:

- Resolve the requested URL/path against the configured asset root, allowed schemes, and security policy.
- Create viewer-owned camera, RenderProduct, RenderVar, and RenderSettings data in one inline root USDA string when the user stage lacks viewer render config.
- Load the user stage without modifying it.
- Store the viewer camera path and render product path in runtime state.
- Reset selection, native selection outline groups, hierarchy cache, pending pick queries, and loading progress for the new stage.
- Fit the camera to the stage bounds unless the user requested preserving the current camera or using an authored stage camera.

Critical contracts:

- Every loaded stage needs Camera -> RenderProduct -> RenderVar -> RenderSettings wiring that ovrtx can find.
- The viewer camera path must be the same path used by camera controls when writing `omni:xform`.
- Do not inject lights unless the user explicitly asks for viewer-controlled lighting. User stages usually own their lighting.
- Include segmentation render vars only for explicit debug/AOV display modes, not for picking.
- Prefer `renderer.open_usd_from_string()` for inline roots that sublayer the user USD and author viewer render config. This avoids temporary file lifetime issues while preserving relative asset resolution through the sublayer path.
- Do not call reference or layer-add APIs after a stage is already loaded unless the renderer has been reset to an empty stage and the operation is part of the serialized load path.

Decision points:

- Use a single inline root USDA string with `subLayers = [@user_scene@]` when the user file needs viewer camera/render-product/render-var data.
- If the user stage has an authored camera and the requested policy is `stage-camera`, copy its focal length, apertures, clipping range, and transform into the viewer camera.
- If the user requests persistent camera across scene switches, keep camera state but sanitize and refit only when the old state is invalid for the new bounds.
- If the user requests viewer lighting controls, add explicit viewer-owned light prims only with a verified live apply path or an explicit reload/profile workflow; otherwise leave lighting untouched and omit live lighting controls.

Common failure modes:

- Inline roots that omit or misquote the user sublayer path fail composition or break relative asset resolution.
- Camera path mismatch makes input appear connected but the view never moves.
- A stage-load operation that reports an error must not be treated as a successful load just because the enqueue call returned.

Read for depth: see `references/stage-loading`, `references/render-settings`, `references/selection-feedback`, and `references/stage-hierarchy` for the full contracts.

## 6. Build Frame Streaming

Do this in `server/stream_server.py` and `server/frame_converter.py`:

- Start ovstream in WebRTC mode.
- Configure width, height, target FPS, signaling port, optional public IP, and video codec policy.
- For each rendered frame, map `LdrColor` on CUDA, convert RGBA8 to BGRA8 on CUDA, wrap the CUDA buffer as an ovstream video frame, and submit it.
- Pace the render loop to target FPS while allowing command queue work to run between frames.
- Send loading and error state messages even when video frames are temporarily unavailable.
- Log the first valid converted BGRA frame and set readiness before depending on browser connection state. This lets validation distinguish renderer/frame-conversion failures from WebRTC negotiation failures.

Critical contracts:

- ovstream expects BGRA8 for raw CUDA frames; ovrtx `LdrColor` is RGBA8.
- Avoid CPU readback in the normal path. CPU readback is acceptable only for debugging screenshots or tests.
- `stream_video()` does not own a deep copy of the source buffer. Keep the buffer alive until the call returns.
- `stream_video()` can fail during disconnect races. Catch and debug-log transient failures; do not crash the render loop.
- First-frame readiness should be set after render-var mapping and RGBA-to-BGRA conversion into the persistent app-owned stream buffer. Do not wait for an attached browser client.
- Stream width, height, frame pitch, RenderProduct resolution, and camera aspect must agree for the fixed stream size.
- The WebRTC signaling port is not the media port. The browser discovers media endpoints through SDP.
- For local WebRTC development, set the server public IP to `127.0.0.1` when ICE discovery otherwise hangs.

Decision points:

- Use raw frames first. Add H264, H265, AV1, or custom encoded frames only when latency, bandwidth, or deployment constraints require it.
- If using encoded frames, make the encoder own color format conversion and frame lifetime explicitly.
- If no client is connected, still run scene loading and state updates, but consider pausing expensive frame submission work.
- If the user asks for RTSP, treat it as a separate delivery mode; the browser-streamed Omniverse Realtime Viewer path should remain WebRTC.

Common failure modes:

- Connected browser with no video often means frontend configured a media port manually, server ICE/public IP is wrong, or frame submission never happens.
- One frame then black usually means the frontend connected, received state, rerendered, and accidentally terminated/restarted the AppStreamer connection. Inspect server logs for `connected=True` followed by `connected=False` within about a second.
- Wrong colors mean missing RGBA-to-BGRA conversion.
- GPU memory growth can mean mapped frame resources or conversion buffers are retained beyond the intended frame lifetime.

Read for depth: see `references/streaming-server` and `references/streaming-lifecycle` for the full frame streaming contract.
