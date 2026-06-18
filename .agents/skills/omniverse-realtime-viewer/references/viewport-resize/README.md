# Viewport Resize

## Triggers

Use this skill for dynamic viewport resize, responsive viewport, resizeViewport, dynamic resolution, browser resize, video letterboxing, or stream resolution changes.

Use this when a browser-streamed USD viewer should render at the current viewport size instead of a fixed stream resolution. The browser still displays a video stream; it never renders USD or 3D geometry.

## End-To-End Contract

Dynamic resize must update all resolution-dependent state together:

1. Frontend observes the video container's CSS layout size with `ResizeObserver`.
2. Frontend debounces and sends `resizeViewport {width,height}` over the data channel after connection.
3. Server validates, clamps, and rounds dimensions to encoder-safe even values.
4. Server serializes the resize with renderer stage mutation; do not resize while `renderer.step()` is active.
5. Server updates the ovrtx RenderProduct `resolution`.
6. Server updates camera aspect ratio, usually by keeping `horizontalAperture` fixed and recomputing `verticalAperture`.
7. Server recreates CUDA/Warp stream buffers for the new `[height,width,4]` shape.
8. Server resizes the ovstream encoder/output path when the API is available, otherwise reconnects or restarts through an explicit path.
9. Server sends `resizeViewportResult` with the effective dimensions after clamping.

Do not treat CSS video resizing alone as a renderer resize. CSS scaling can make the video fill the panel, but ovrtx, ovstream, picking, and camera projection still need the same effective dimensions.

## Frontend Pattern

Observe the element that defines the viewport layout, usually the parent of `video#remote-video`. Use CSS pixels, not `devicePixelRatio`-scaled pixels; the server render resolution is being matched to the browser layout box.

```tsx
useEffect(() => {
  if (status !== 'connected') return;

  const videoEl = document.getElementById('remote-video');
  const container = videoEl?.parentElement;
  if (!container) return;

  let last = { width: 0, height: 0 };
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const observer = new ResizeObserver(entries => {
    const entry = entries[0];
    if (!entry) return;
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      const width = Math.round(entry.contentRect.width) & ~1;
      const height = Math.round(entry.contentRect.height) & ~1;
      if (width <= 0 || height <= 0) return;
      if (width === last.width && height === last.height) return;
      last = { width, height };
      sendMessage({ event_type: 'resizeViewport', payload: { width, height } });
    }, 200);
  });

  observer.observe(container);
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    observer.disconnect();
  };
}, [status, sendMessage]);
```

Video CSS should match the chosen server policy:

```css
.viewport video {
  width: 100%;
  height: 100%;
  object-fit: fill;
}
```

Use `object-fit: fill` only when the server keeps render resolution and camera aspect synchronized with the container. If the server uses fixed render resolution, use preserve-aspect display and keep letterbox coordinate mapping.

## Message Protocol

Add a normal app data-channel message:

```json
{"event_type":"resizeViewport","payload":{"width":1280,"height":720}}
```

Recommended response:

```json
{"event_type":"resizeViewportResult","payload":{"width":1280,"height":720,"result":"success"}}
```

The response dimensions are the effective server values after clamping and even alignment. The frontend can use them for diagnostics; normal rendering does not need to wait for every response before sending a later debounced resize.

## Server Handler

Keep the message callback small. Validate and enqueue resize work for the render thread, or take the same lock used to serialize stage mutation and rendering.

```python
def _handle_resize_viewport(self, payload: dict) -> None:
    width = payload.get("width")
    height = payload.get("height")
    if not isinstance(width, int) or not isinstance(height, int):
        logger.warning("resizeViewport: invalid payload %s", payload)
        return

    width = max(320, min(3840, width)) & ~1
    height = max(240, min(2160, height)) & ~1
    self.server.enqueue_resize_viewport(width, height)
```

Use bounds appropriate for the target GPU and codec. Reject or clamp hostile values; data-channel payloads are client input.

## Render Thread Resize

Resize under the same ownership rules as scene loading:

```python
def resize_viewport(self, width: int, height: int) -> None:
    if width == self.width and height == self.height:
        return

    with self.stage_lock:
        self.width = width
        self.height = height
        self.camera.width = width
        self.camera.height = height

        self.resize_render_product(width, height)
        self.update_camera_aspect(width, height)
        self.recreate_stream_buffer(width, height)

        if hasattr(self.stream_server, "resize"):
            self.stream_server.resize(width, height)
        else:
            self.request_stream_reconnect("resize requires stream restart")

    self.send_message("resizeViewportResult", {
        "width": width,
        "height": height,
        "result": "success",
    })
```

If the active ovstream build does not expose live resize, do not silently keep streaming old-size frames. Use an explicit reconnect/restart path and make the frontend reconnect.

## ovrtx Render Product

Update the viewer-owned RenderProduct `resolution` in the session/composite stage. Use the actual render product path passed to `renderer.step()`.

```python
from pxr import Gf

def resize_render_product(stage, render_product_path: str, width: int, height: int) -> None:
    prim = stage.GetPrimAtPath(render_product_path)
    if not prim or not prim.IsValid():
        raise RuntimeError(f"Missing RenderProduct: {render_product_path}")
    attr = prim.GetAttribute("resolution")
    if not attr:
        raise RuntimeError(f"RenderProduct has no resolution: {render_product_path}")
    attr.Set(Gf.Vec2i(width, height))
```

When direct `pxr` access is isolated in a worker process, apply the same edit through the owner of the session/composite layer or rebuild the viewer wrapper through the render thread.

## Camera Aspect

Keep horizontal field of view stable and derive vertical aperture from the new aspect:

```python
def update_camera_aspect(stage, camera_path: str, width: int, height: int) -> None:
    cam = stage.GetPrimAtPath(camera_path)
    h_attr = cam.GetAttribute("horizontalAperture")
    v_attr = cam.GetAttribute("verticalAperture")
    h_aperture = float(h_attr.Get() or 20.955)
    v_attr.Set(h_aperture * float(height) / float(width))
```

If the app copies an authored stage camera, preserve that camera's horizontal aperture and recompute only the vertical aperture for viewport size changes.

## Buffers And Coordinates

Every buffer or coordinate transform that depends on render size must update with the resize:

- BGRA stream buffer: recreate as `wp.uint8 [height,width,4]`.
- AOV conversion buffers: recreate or validate shape before copy.
- Pick buffers and ID maps: treat the next frame after resize as the source of truth.
- Camera/input state: store current viewport width and height for drag normalization.
- DOM mapping: with `object-fit: fill`, CSS coordinates map linearly to render pixels after even rounding; with preserve-aspect display, keep letterbox correction.
- Server-side overlays: call their resize hook or rebuild their render target.

Synchronize CUDA work before freeing/replacing a buffer if the previous frame may still be in use.

```python
if self.stream_buf is None or self.stream_buf.shape[:2] != (height, width):
    wp.synchronize()
    self.stream_buf = wp.zeros((height, width, 4), dtype=wp.uint8, device="cuda:0")
```

## Validation

Check these after implementation:

- Resize the browser pane and confirm decoded frame size changes in `chrome://webrtc-internals`.
- Confirm the video has no letterboxing when using `object-fit: fill`.
- Confirm camera orbit and click picking remain aligned after resize.
- Confirm object shapes do not stretch; if they do, camera aperture/aspect was not updated.
- Confirm scene switching after resize uses the latest viewport size when rebuilding session/composite data.
- Confirm no `renderer.step()` runs concurrently with render product or stream buffer resize.

See also: `streaming-client`, `streaming-server`, `streaming-messages`, `streaming-lifecycle`, `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `camera-controls`, `object-selection`, `render-settings`.
