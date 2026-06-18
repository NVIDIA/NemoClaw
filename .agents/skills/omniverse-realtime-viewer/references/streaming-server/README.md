# Streaming Server

## Triggers

Use this skill for stream to browser, WebRTC server, ovstream server, stream_video, on_input, VideoFrame, RGBA BGRA, fixed resolution, or no video.

Use this for the Python server that renders with ovrtx and streams frames through ovstream.

## GPU Requirement

ovrtx requires an NVIDIA GPU. Build and document the ovrtx server path as the only rendering path; do not add CPU rendering, WebGL, Three.js, Babylon.js, glTF viewer, or other client-side rendering substitutes.

## Native Library Setup

Read `references/dependencies` before installing or locating `ovstream`.
`references/dependencies/nvidia-runtime.md` is the source of truth for
the current package source. For ovstream server, SHM, native input, or
release-specific behavior not covered here, read the supplemental dependency
documentation referenced by `references/dependencies`.

For ovrtx Python/C API behavior or release-specific server integration details
not covered here, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

If the installed runtime cannot locate native libraries automatically, set:

```bash
export OVSTREAM_LIB_PATH=/path/to/ovstream/lib/   # directory with .so/.dll files
```

### Bundled Native Library

The ovstream Python wheel bundles its own `libovstream.so`. Do **not** override
it by placing a separate `libovstream.so` on `LD_LIBRARY_PATH` or in
`OVSTREAM_LIB_PATH` unless you are deliberately using a different version for a
specific transport (e.g., a newer SHM transport build). Overriding with a
mismatched `.so` causes symbol errors or silent protocol failures.

### Display Requirement

ovrtx requires an X11 display for GPU rendering, even in headless deployments.
Use Xvfb when no physical display is available:

```bash
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
```

Without a display, ovrtx initialization will fail with EGL/GLX errors.

## Canonical Startup Sequence

The reference WebRTC server starts in this order. Keep the ordering when generating `server/ov_web_viewer_server.py` or equivalent runtime shells:

1. Set `OVRTX_SKIP_USD_CHECK=1` before importing `ovrtx` or any module that can import `pxr`.
2. Import `ovrtx`, construct `Renderer(RendererConfig(sync_mode=True, selection_outline_enabled=True))`, then import sibling helpers. Use ovrtx stage queries for basic prim discovery; keep a `pxr_worker.py` subprocess only for USD features that still require OpenUSD.
3. Import and initialize CUDA helpers such as `warp` for frame conversion.
4. Load the initial stage if one is configured: build one inline root USDA string that sublayers the user file and authors viewer camera/render-product/render-var data, call `renderer.open_usd_from_string(...)`, bind or write the camera `omni:xform`, initialize native selection outline styles, and cache `current_stage_root_path`.
5. Warm up the renderer before starting ovstream: step several frames against the canonical render product, update camera transforms, probe render vars, allocate the persistent BGRA stream buffer, and discover the currently available display AOVs.
6. Initialize ovstream, create `ovstream.Server(ovstream.ServerType.WEBRTC)`, register `on_connection`, `on_message`, `on_input`, and `on_unicode` callbacks where needed, then call `server.start(ServerConfig(...))`.
7. Start the `/healthz` endpoint before or alongside server startup. It must return `503 not ready` until the renderer has produced and copied one valid display frame into the app-owned stream buffer, then `200 ok` after that.
8. Start exactly one render loop thread. That thread owns `renderer.step()`, frame conversion, native pick-query enqueue/result decoding, selection-outline state writes, animation updates, and `stream_video()`.

Skeleton:

```python
import os
os.environ["OVRTX_SKIP_USD_CHECK"] = "1"

from ovrtx import Renderer, RendererConfig, Device, PrimMode
import ovstream
import warp as wp

from healthz import HealthServer
from message_handler import MessageHandler

wp.init()
renderer = Renderer(config=RendererConfig(sync_mode=True, selection_outline_enabled=True))

health = HealthServer()
health.start()

load_initial_stage(renderer)
warm_up_renderer(renderer, render_product="/Render/OVServer/ViewportTexture0")

ovstream.initialize(log_fn=stream_log, log_min_severity=ovstream.LogLevel.VERBOSE)
stream = ovstream.Server(ovstream.ServerType.WEBRTC)
handler = MessageHandler(server_runtime)
stream.on_connection = handler.on_connection
stream.on_message = handler.on_message
stream.on_input = handler.on_input
if hasattr(handler, "on_unicode"):
    stream.on_unicode = handler.on_unicode
config = ovstream.ServerConfig(width=1920, height=1080, video_input=ovstream.VideoInput.CUDA)
config.webrtc_signal_port = 49100
config.webrtc_public_ip = public_ip or "127.0.0.1"
stream.start(config)

threading.Thread(target=render_loop, daemon=True).start()
```

## Lifecycle

```python
import ovstream
from ovstream import LogLevel, ServerType, ServerConfig, VideoFrame

# LogLevel enum values: DEFAULT, ERROR, INFO, NONE, VERBOSE, WARNING
# Note: there is no WARN variant — use WARNING.
ovstream.initialize(
    log_fn=lambda level, channel, msg, timestamp: print(f"[{level.name}] {channel}: {msg}"),
    log_min_severity=LogLevel.WARNING,
)
server = ovstream.Server(ServerType.WEBRTC)
server.on_connection = on_connection
server.on_input = on_input
server.on_message = on_message
# Optional for composed text input:
# server.on_unicode = on_unicode
server.start(ServerConfig(
    width=1920,
    height=1080,
    target_fps=60,
    stream_port=0,
    video_input=ovstream.VideoInput.CUDA,
    webrtc_signal_port=0,
))
try:
    while running:
        cuda_buffer = render_bgra8_cuda_frame()
        server.stream_video(VideoFrame(buffer=cuda_buffer, width=1920, height=1080, pitch_bytes=1920 * 4))
finally:
    server.stop()
    server.close()
    ovstream.shutdown()
```

`initialize()` is ref-counted; every call needs a matching `shutdown()`. Register callbacks before `start()` so initial connection/input/message events cannot race past handlers.

Guard server sends and frame submission against disconnect races. A client can disconnect between `is_client_connected` and `send_message()`, or during `stream_video()`. Those transient failures should not crash the render loop:

```python
def send_event(server, event_type: str, payload: dict) -> None:
    if not server.is_client_connected:
        return
    try:
        server.send_message(json.dumps({"event_type": event_type, "payload": payload}, default=str))
    except Exception:
        logger.debug("Dropping event during disconnect: %s", event_type, exc_info=True)

def stream_frame(server, frame: ovstream.VideoFrame) -> None:
    try:
        server.stream_video(frame)
    except Exception:
        logger.debug("Dropping frame during disconnect", exc_info=True)
```

## Frame Loop And Continuity

Detailed frame-source, fixed-resolution, and stage-load continuity guidance lives in `frame-loop-and-continuity.md`.

## Readiness Health Gate

Expose readiness separately from process liveness. Orchestrators and load balancers must not send clients to the service until the renderer has produced and converted a valid frame.

```python
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Event, Thread

class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/healthz":
            self.send_response(404); self.end_headers(); return
        if self.server.ready_event.is_set():
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        else:
            self.send_response(503); self.end_headers(); self.wfile.write(b"not ready")

ready = Event()
httpd = HTTPServer(("0.0.0.0", 8081), HealthHandler)
httpd.ready_event = ready
Thread(target=httpd.serve_forever, daemon=True).start()

# In the render loop, after the first successful render-var map, copy,
# and RGBA-to-BGRA conversion into the app-owned stream buffer:
ready.set()
```

Do not mark readiness when the process starts, when ovstream starts, or when a stage-load operation returns. Mark it only after a valid frame path has succeeded.

Readiness must not depend on an active browser client or on `server.stream_video()`
succeeding. Before any client connects, `stream_video()` may be a no-op or may
raise a transient no-client/disconnect error depending on the selected ovstream
build. A server that has already rendered and converted a valid frame should
report ready even while no client is attached.

Generated viewers should log the first converted frame before entering normal
streaming, for example `First BGRA frame ready: WIDTHxHEIGHT`. Use that log line
to separate renderer/camera/frame-conversion failures from browser/WebRTC
negotiation failures.

## RGBA To BGRA

ovrtx outputs RGBA8. ovstream expects BGRA8. Without conversion, red/blue channels swap.

```python
import warp as wp

@wp.kernel
def swap_rb(img: wp.array3d(dtype=wp.uint8)):
    i, j, k = wp.tid()
    if k == 0 or k == 2:
        r = img[i, j, 0]
        b = img[i, j, 2]
        img[i, j, 0] = b
        img[i, j, 2] = r
```

```python
with frame.render_vars["LdrColor"].map(device=ovrtx.Device.CUDA) as var:
    wp_array = wp.from_dlpack(var)
    wp.launch(swap_rb, dim=(h, w, 4), inputs=[wp_array])
    server.stream_video(ovstream.VideoFrame.from_cuda_array(wp_array))
```

No CPU round trip is needed.

## Production AOV Conversion Before `stream_video()`

Every displayed render var must be converted into a persistent CUDA `uint8 [H,W,4]` BGRA buffer before creating `ovstream.VideoFrame`. Keep `LdrColor` as the fallback if the active AOV cannot be copied.

ovrtx 0.3 render vars can be single-tensor or multi-tensor outputs. For a single-tensor render var, consume the mapped object directly with DLPack. For a multi-tensor render var, choose the named tensor that represents the image payload and read params separately. Image tensors are channel-last: `H x W`, `H x W x 1`, `H x W x 3`, or `H x W x 4`. Do not assume `C x H x W`, and do not use old `.tensor` access in new generated code.

| AOV | Expected input | Conversion rule |
|---|---|---|
| `LdrColor` | `uint8 [H,W,4]` RGBA | Copy to the stream buffer and swap R/B to BGRA. |
| `HdrColor` | `uint16 [H,W,4]` or float RGB/RGBA | Apply exposure/Reinhard tonemapping, gamma/sRGB display correction, clamp, output BGRA8. |
| `DepthSD` | `float32 [H,W]` or `uint32 [H,W]` packed float bits | Normalize to a useful grayscale visualization, usually inverse-distance or min/max normalized, output BGRA8. |
| `NormalSD` | float RGB/RGBA or `uint32 [H,W,4]` packed float bits | Remap normal components from `[-1, 1]` to `[0, 255]`, output BGRA8. |
| `InstanceSegmentationSD` | `uint32 [H,W]` or `[H,W,1]` | Debug visualization only: hash each non-zero ID to a deterministic color; ID `0` is black/background. Native picking does not require this AOV. |
| `SemanticSegmentationSD` | `uint32 [H,W]` or `[H,W,1]` | Use the same deterministic colorization as instance segmentation. |
| `DiffuseAlbedoSD` | float RGB/RGBA or `uint8 [H,W,4]` | Gamma-correct linear albedo when needed, clamp, output BGRA8. |

```python
copied = copy_aov_to_stream_buffer(fout, active_aov)
if not copied and active_aov != "LdrColor":
    copied = copy_aov_to_stream_buffer(fout, "LdrColor")
if copied:
    video_frame = ovstream.VideoFrame.from_cuda_array(stream_bgra_buffer)
    stream_server.stream_video(video_frame)
```

Pick queries are independent of the displayed AOV. Do not update a segmentation-derived pick buffer in generated ovrtx 0.3 apps.

## Native Picking And Selection Outlines

Use ovrtx native pick queries and native selection outline state:

1. Convert the ovstream input coordinate to render-product pixel space.
2. Enqueue `renderer.enqueue_pick_query_async(...)` with a 1x1 rectangle for click picking or a larger rectangle for marquee selection.
3. Step the same RenderProduct. The pick result appears as the synthetic render var `ovrtx_pick_hit`.
4. Map the pick-hit output, validate its params such as `magic` and `version`, read the named `primPath` tensor, and resolve each non-zero path id with `renderer.resolve_prim_path_id(...)`.
5. Deduplicate resolved paths and publish `stageSelectionChanged`.
6. Clear previous outlines by writing selection group `0`, then write group `1` or another styled group to selected prims through `omni:selectionOutlineGroup` / `OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP`.

Configure selection outlines at renderer creation with `RendererConfig(selection_outline_enabled=True, selection_outline_width=...)`. Configure per-group colors at runtime with `Renderer.set_selection_group_styles(...)`. Changing global width or fill mode requires recreating the renderer; changing per-group colors does not.

Do not create legacy segmentation picker modules, CPU ray fallback picker modules, segmentation ID maps, isolation ID discovery, or Warp outline compositors for ovrtx 0.3 generated apps.

## Operation Status And Errors

Treat stage loads, render steps, and pick queries as operations whose status must be checked:

- In Python, blocking helpers such as `open_usd()` may raise; async variants return operations that must be `.wait()`ed and fetched before the result is trusted.
- In C, load errors are reported through `ovrtx_op_wait_result_t::error_op_ids`; the enqueue return value only says whether the work was accepted.
- A failed or timed-out stage load must send `openStageResult {result: "error"}` plus `viewerError`, keep or restore the previous valid frame when possible, and avoid marking readiness.
- A failed render step should keep the last good frame, emit a bounded error event, and stop retrying only after repeated non-recoverable failures.
- A failed or empty pick query should clear hover state or return no path without mutating the current selection unless the user explicitly requested clear-on-miss.

## Input Callback

Input is separate from JSON messages. For WebRTC, NVST forwards mouse/keyboard/gamepad input as binary `InputEvent` structs that arrive through `server.on_input`. For SHM Python clients, send the same native input struct path through `ovstream.ShmClient.send_input_event()`; C clients use `ovstream_shm_client_send_input_event()`. Do not send JSON `mouseInput`. Read `viewer-input-routing` before implementing this callback.

```python
def on_input(event):
    if not viewport_input_active:
        camera.cancel_interaction()
        return
    if event.type == ovstream.InputEventType.MOUSE:
        mouse = event.mouse
        if mouse.type == ovstream.MouseEventType.MOVE:
            handle_mouse_move(mouse.x, mouse.y, mouse.modifiers)
        elif mouse.type == ovstream.MouseEventType.BUTTON:
            button = camera_button_from_ovstream(mouse.data, ovstream)
            if button is not None:
                handle_mouse_button(button, mouse.button_state, mouse.x, mouse.y)
        elif mouse.type == ovstream.MouseEventType.WHEEL:
            handle_scroll(mouse.scroll_y or mouse.data, mouse.x, mouse.y)
    elif event.type == ovstream.InputEventType.KEYBOARD:
        handle_key(event.keyboard.key_code, event.keyboard.key_state, event.keyboard.modifiers)
    elif event.type == ovstream.InputEventType.GAMEPAD:
        handle_gamepad(event.gamepad.control, event.gamepad.position, event.gamepad.gamepad_id)
```

Use this native input path for orbit/pan/zoom and viewport picking. In browser
apps with DOM controls, maintain `viewport_input_active` from a lightweight app
message such as `setViewportInputActive {active}`. Disable it when the pointer is
over sidebars, trees, inspectors, menus, or top bars so UI clicks do not move the
camera or trigger picks.

`ovstream.MouseButton` values are not DOM button ids: `LEFT=1`, `MIDDLE=2`,
and `RIGHT=3`. Use `viewer-input-routing` to convert through the enum or an
explicit mapping before passing buttons to shared camera helpers that use
`0=left`, `1=middle`, `2=right`.

When the WebRTC stream surface is the only source of native input, initialize
`viewport_input_active = True` and let DOM panels turn it off with
`setViewportInputActive {active:false}`. If the server starts inactive, the
first mouse-down can race ahead of the React activation message, so a left-click
release is seen without a matching press and click picking never queues.

## ServerConfig Reference

| Field | Meaning |
|---|---|
| `width`, `height`, `target_fps` | stream dimensions and frame rate |
| `stream_port=0` | default media port: 47998 WebRTC, 47999 native, 8554 RTSP; SHM uses no media port |
| `webrtc_signal_port=0` | default signaling port: 49100 |
| `webrtc_public_ip=None` | use ICE; set `127.0.0.1` for local loopback |
| `video_input` | `CUDA`, `TENSOR`, `CUSTOM`, `H264`, `H265`, or `AV1` |
| `rtsp_pipeline`, `rtsp_mount_point` | RTSP custom pipeline/path |
| `shm_stream_name`, `shm_slot_count` | SHM stream identifier and ring depth for local shared-memory transport |

`ServerType.WEBRTC` is for browser streaming, `RTSP` for VLC/ffplay, `NATIVE` for native clients, and `SHM` for same-machine shared-memory readers. WebRTC supports one connected client at a time; guard `send_message` with `server.is_client_connected`. Multiple network servers in one process need explicit unique ports; ovstream does not auto-increment conflicting defaults.

## Ports

Signaling is TCP/WebSocket on 49100 by default. WebRTC media is UDP and
negotiated by SDP; check the selected ovstream release notes for the current
default media port. Do not conflate these in frontend config.

## Generated Module Checklist - streaming server

- [ ] `main()` sets `OVRTX_SKIP_USD_CHECK=1` before ovrtx imports.
- [ ] `OVWebViewerServer.start()` or equivalent constructs `Renderer(RendererConfig(sync_mode=True, selection_outline_enabled=True))` when selection feedback is needed.
- [ ] `PxrWorkerClient.start()` is optional and used only for USD queries not covered by ovrtx native stage APIs.
- [ ] Initial stage load uses `renderer.open_usd_from_string()` with an inline root USDA when viewer render config must be injected.
- [ ] Renderer warmup steps before `ovstream.Server.start()`.
- [ ] `MessageHandler.on_message` is registered for JSON app messages.
- [ ] `MessageHandler.on_input` is registered for raw ovstream input events.
- [ ] `MessageHandler.on_unicode` is registered when composed text input matters.
- [ ] `/healthz` returns `503` before first successful frame and `200` afterward.
- [ ] Render loop is the only owner of `renderer.step()`.
- [ ] Render loop enqueues/decodes native pick queries and updates native selection outline groups.
- [ ] AOV conversion writes a persistent CUDA BGRA8 buffer before `stream_video()`.
- [ ] Disconnect races around `send_message()` and `stream_video()` are caught and debug-logged.

See also: `streaming-client`, `streaming-messages`, `streaming-lifecycle`, `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `camera-controls`, `object-selection`.
