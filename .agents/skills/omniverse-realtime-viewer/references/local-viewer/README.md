# Local Omniverse Realtime Viewer Shell

## Triggers

Use this skill for ovui window shell, standalone viewport shell, simple ovui app, `ImageBridge`, image display, resize handling, mouse capture surfaces, or requests that should avoid the full ovui editor shell.

For a complete local desktop viewer, read `ovui-local-viewer-recipe` first and use
this as the focused shell/display skill. Use this for a small single-window
viewer: header, RTX viewport, optional sidebar, and inline controls. Do not use
`ovui.app.Application`; that starts the full OvGear editor with docking, menus,
property panels, transform gizmos, and status bars.

For mouse button normalization, click-vs-drag handling, and dispatch to camera
or selection controllers, read `viewer-input-routing`.

For header/sidebar controls, toolbar actions, render settings widgets,
sliders, and destructive confirmations, read `viewer-control-patterns` and
translate its client-agnostic control guidance into native `ovui` widgets.

For ovui widget APIs or native UI behavior not covered here, read
`references/dependencies` for acquisition guidance and supplemental dependency
documentation.

For ovrtx renderer setup, frame extraction, or release-specific behavior not
covered here, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

## Runtime Setup

Install and activate the selected `ovui` package through `references/dependencies`
before imports. The lightweight local path imports `pxr` before direct `ovrtx`
use; other server paths may construct `ovrtx.Renderer` first. Keep the chosen
import discipline consistent in one process.

```python
import asyncio
import os
os.environ.setdefault("OVRTX_SKIP_USD_CHECK", "1")

from pxr import Usd, UsdGeom, Sdf
import ovrtx
import omni.ui as ui
```

Run with a real display from the activated environment:

```bash
DISPLAY=:99 OVRTX_SKIP_USD_CHECK=1 python3 -m local_app
```

If `renderer.step()` hangs after a crash, use `nvidia-smi` and kill only stale Python Omniverse Realtime Viewer processes that still hold CUDA/RTX state.

## ovui Window Shell

Use `fill_app_window=True`; without it the GLFW window can resize while the UI frame remains stuck at the initial dimensions.

```python
ui.init("Omniverse Realtime Viewer", width=1280, height=720, max_fps=60)
window = ui.Window("Omniverse Realtime Viewer", width=1280, height=720, fill_app_window=True, flags=ui.WINDOW_FLAGS_NO_TITLE_BAR)
with window.frame:
    with ui.ZStack(style_type_name_override="Local.Root"):
        ui.Rectangle(style_type_name_override="Local.Root")
        with ui.VStack(spacing=0):
            build_header(height=50)
            with ui.HStack(spacing=0, height=ui.Fraction(1)):
                with ui.Frame(width=ui.Fraction(1)):
                    viewport.build()
                with ui.Frame(width=ui.Pixel(280)):
                    sidebar.build()

async def render_loop():
    while True:
        app.step_and_present()
        await asyncio.sleep(0)

ui.run(render_loop())
```

Keep the surface focused: black header, large viewport, white/sidebar utility area, green `#76b900` accents. Avoid editor-only affordances unless requested.

`omni.ui.standalone.run()` expects an awaitable coroutine, not a plain callback. Returning from the coroutine ends the app, so long-running viewers should yield with `await asyncio.sleep(0)` after each render/UI tick.

## Header And Load Controls

Keep scene loading boring and reliable. For lightweight local viewers, default
to one path field plus one `LOAD` button that calls the same serialized scene
load path used by command-line startup. Do not add a separate `OPEN` button or
native file dialog unless it is implemented and validated under the same
display/session environment as the viewer. A broken dialog next to a working
path loader creates needless ambiguity.

```python
path_model = ui.SimpleStringModel(str(initial_stage))
ui.StringField(model=path_model, height=30)
ui.Button("LOAD", clicked_fn=lambda: runtime.load(path_model.get_value_as_string()))
```

If a native file dialog is explicitly requested, keep it secondary and test it
with the target display stack (`DISPLAY`, Xvfb/VNC, Wayland/X11, container
permissions). On failure, report the dialog failure in the status bar and leave
the path-field loader usable.

## Image Display

Use the app's local image bridge helper when a plain image widget is enough.
For projects using the `ovwidgets` helper, import
`ovwidgets.viewport.image_bridge.ImageBridge`; otherwise use
`ui.ByteImageProvider` directly. The renderer may stay at fixed resolution while
`ImageWithProvider` stretches with preserve-aspect letterboxing.

```python
bridge = ImageBridge(render_width, render_height)
image = ui.ImageWithProvider(bridge.provider, fill_policy=ui.IwpFillPolicy.IWP_PRESERVE_ASPECT_FIT)
bridge.update(frame_rgba_uint8)
```

For a direct provider path:

```python
provider = ui.ByteImageProvider()
image = ui.ImageWithProvider(provider, fill_policy=ui.IwpFillPolicy.IWP_PRESERVE_ASPECT_FIT)

# arr is C-contiguous uint8 RGBA, shape H x W x 4
provider.set_data_array(arr, [arr.shape[1], arr.shape[0]])
```

Use ovui integer style colors as `0xAARRGGBB`. Swapping the byte order can turn
an intended dark background into light red or brown and make a blank viewport
look like a renderer failure.

Read `LdrColor` inside the map context and copy before returning:

```python
with products as ctx:
    rv = ctx[RENDER_PRODUCT_PATH].frames[0].render_vars["LdrColor"]
    with rv.map(device=ovrtx.Device.CPU) as mapping:
        try:
            frame = np.from_dlpack(mapping).copy()
        except Exception:
            frame = np.from_dlpack(mapping).copy()
```

## Display Smoke Test And Blank-Viewport Triage

Before debugging camera, lighting, or USD composition, prove the ovui image path
can paint a synthetic frame:

```python
def synthetic_rgba(width: int, height: int) -> np.ndarray:
    x = np.linspace(0, 255, width, dtype=np.uint8)
    y = np.linspace(0, 255, height, dtype=np.uint8)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, 0] = x[None, :]       # red horizontal ramp
    rgba[:, :, 1] = y[:, None]       # green vertical ramp
    rgba[:, :, 2] = 64               # visible blue floor
    rgba[:, :, 3] = 255
    return np.ascontiguousarray(rgba)

provider.set_data_array(synthetic_rgba(640, 360), [640, 360])
```

Capture a desktop screenshot of the window and verify it is nonblank and
non-solid. If the synthetic image does not paint, debug ovui presentation first:
provider construction, widget visibility, frame sizing, style opacity, main-loop
stepping, and whether the active provider API updates in this ovui build.

Use this decision tree for black, blank, or solid-color viewports:

1. Capture `LdrColor` directly from ovrtx outside ovui and save it as an image.
2. If direct `LdrColor` is blank, debug scene loading, camera fit, render
   product path, render vars, lighting, and material/plugin resolution.
3. If direct `LdrColor` is nonblank but the window is blank, debug ovui
   presentation before touching camera or renderer state.
4. Test the chosen `ImageBridge` or `ByteImageProvider` path with the synthetic
   RGBA frame above.
5. If dynamic byte-provider updates do not paint in the active ovui build, use a
   known-good ovui-native presentation path for validation, such as a
   `RasterImageProvider` screenshot/frame fallback, then document the selected
   presentation path in the generated app.

For unstable startup ordering, load the scene and render one direct ovrtx frame
before entering the long-running ovui loop. Continuous rendering may run in a
dedicated render worker that owns `renderer.step()` and copies the latest RGBA
frame into an application buffer; the ovui/main loop should only present that
latest copied frame. Do not call `renderer.step()` while another thread is
loading, resetting, or mutating the stage.

## Resize And Letterbox Math

For picking, overlays, and camera input, compute the visible rendered image rect inside the viewport widget.

```python
def widget_size(hit_rect, image, fallback):
    w = int(float(getattr(hit_rect, "computed_width", 0.0) or 0.0))
    h = int(float(getattr(hit_rect, "computed_height", 0.0) or 0.0))
    if (w <= 0 or h <= 0) and image is not None:
        w = int(float(getattr(image, "computed_width", 0.0) or 0.0))
        h = int(float(getattr(image, "computed_height", 0.0) or 0.0))
    return max(1, w or fallback[0]), max(1, h or fallback[1])

def image_content_rect(widget_w, widget_h, image_w, image_h):
    image_aspect = image_w / max(1.0, float(image_h))
    widget_aspect = widget_w / max(1.0, float(widget_h))
    if widget_aspect > image_aspect:
        draw_h = float(widget_h); draw_w = draw_h * image_aspect
        return (widget_w - draw_w) * 0.5, 0.0, draw_w, draw_h
    draw_w = float(widget_w)
    return 0.0, (widget_h - draw_w / image_aspect) * 0.5, draw_w, draw_w / image_aspect
```

## Mouse Capture Surface

Attach callbacks to a transparent top-level `ui.Rectangle` over the image. Wrap callbacks; unguarded ovui callback exceptions can tear down the app loop.

```python
hit_rect = ui.Rectangle(style={"background_color": 0x00000000})
hit_rect.opaque_for_mouse_events = True
hit_rect.set_mouse_pressed_fn(on_mouse_pressed)
hit_rect.set_mouse_released_fn(on_mouse_released)
hit_rect.set_mouse_moved_fn(on_mouse_moved)
hit_rect.set_mouse_wheel_fn(on_mouse_wheel)

def local_render_coords(screen_x: float, screen_y: float, clamp: bool):
    x = float(screen_x) - float(hit_rect.screen_position_x)
    y = float(screen_y) - float(hit_rect.screen_position_y)
    off_x, off_y, draw_w, draw_h = image_content_rect(...)
    if not clamp and (x < off_x or y < off_y or x > off_x + draw_w or y > off_y + draw_h):
        return None
    u = (x - off_x) / max(1.0, draw_w)
    v = (y - off_y) / max(1.0, draw_h)
    if clamp:
        u, v = max(0.0, min(1.0, u)), max(0.0, min(1.0, v))
    return u * render_width, v * render_height
```

```python
def on_mouse_moved(*args):
    try:
        if dragging and len(args) >= 2:
            camera.on_mouse_move(*local_render_coords(args[0], args[1], clamp=True))
    except Exception:
        logger.exception("Mouse move failed")
        dragging = False
```

When a `SceneView` overlay and top-level mouse callbacks coexist, explicitly
arbitrate pointer ownership. A transform drag should suppress orbit and click
selection for that mouse-down; normal left-drag outside the transform handle can
still orbit. Do not let a gizmo drag also enqueue a pick on release.

## Local Transform Gizmo Wiring

A drawn transform gizmo is not sufficient. The generated app must prove that a
drag changes the selected prim in the ovrtx runtime stage. For a lightweight
local app, prefer this contract:

1. Selection state owns the selected prim paths and notifies the gizmo model.
2. On transform-drag start, read and store each selected prim's current world
   transform from USD or from the app's latest live-transform cache.
3. On each drag delta, compose a delta matrix from the drag movement and the
   stored start transform, then write `omni:xform` through `renderer.write_attribute`.
4. Use `Semantic.XFORM_MAT4x4`, `PrimMode.CREATE_NEW`, and `DataAccess.SYNC`
   for these live writes.
5. On release, clear drag state and rebuild/refresh any selected-prim info
   panel from the same live-transform cache.

If a reusable `omni.ui_scene` / `ovwidgets` transform manipulator only renders
the handles in a minimal shell, add an app-owned fallback path: when LMB starts
near the selected pivot/handle, enter a transform-drag mode and convert pointer
motion into camera-plane world deltas. This keeps direct manipulation working
even if lower-level handle gestures are not firing in the active standalone
ovui build.

```python
def on_gizmo_drag_start(selected_paths):
    drag_start = {
        path: runtime.get_live_or_usd_world_transform(path)
        for path in selected_paths
    }

def on_gizmo_drag_delta(dx_px: float, dy_px: float):
    right, up, _forward = camera.basis()
    scale = max(0.001, camera.distance * 0.0018)
    delta_world = right * (dx_px * scale) - up * (dy_px * scale)
    delta = np.eye(4, dtype=np.float64)
    delta[3, :3] = delta_world
    for path, base in drag_start.items():
        runtime.write_live_xform(path, base @ delta)
```

Validation for gizmos must include both evidence types:

- A programmatic transform write test that moves a known prim and verifies the
  pivot/transform changed by the expected delta.
- A windowed or screenshot/manual note that grabbing near the selected
  gizmo/pivot moves the highlighted prim, not only the handle.

## Context Menu (Right-Click)

ovui supports popup context menus via `ui.Menu`. Show it on RMB release only when the mouse did not drag (use the drag threshold from `viewer-input-routing` or `camera-controls`). If the user drags RMB, that's a camera look/dolly — suppress the menu.

```python
def on_mouse_released(x, y, button, modifier):
    if button == 1:  # RMB
        if not _exceeded_drag_threshold:
            _show_context_menu(x, y)
        return
    # ... other release handling

def _show_context_menu(screen_x: float, screen_y: float):
    """Show a popup context menu at the cursor position."""
    if hasattr(ui, "Menu"):
        menu = ui.Menu("Viewport")
        with menu:
            ui.MenuItem("Open File...", triggered_fn=_on_open_file)
            ui.MenuItem("Reload Stage", triggered_fn=_on_reload)
            ui.Separator()
            ui.MenuItem("Frame All", triggered_fn=_on_frame_all)
            ui.MenuItem("Reset Camera", triggered_fn=_on_reset_camera)
            ui.Separator()
            ui.MenuItem("Quit", triggered_fn=lambda: ui.shutdown())
        menu.show_at(int(screen_x), int(screen_y))
```

Key points:
- Create the `ui.Menu` fresh each time (ovui menus are lightweight)
- Use `menu.show_at(x, y)` with screen-space pixel coordinates
- Guard with the drag threshold check — if the mouse moved ≥5 px between press and release, it was a camera gesture, not a menu intent
- Wrap in try/except; older ovui builds may not support `show_at`

## Local Validation

Run `python3 -m compileall local_app server`, launch with `DISPLAY=:99`, prove
synthetic ovui presentation paints in the window, save a direct `LdrColor`
artifact, and capture a desktop screenshot showing that same rendered frame in
the ovui window. Then resize the window, switch Sample 1/Sample 2, verify stage01
renders without extra session lights, check tree/viewport selection, confirm
native selection outlines clear on load, verify prim animation returns on
clear/reset, ensure prim info follows orbit/pan/zoom/resize, and confirm
orbit/pan/right-drag zoom/wheel move the camera. Confirm selected-prim gizmo
drag changes the prim's live `omni:xform`; do not accept a result where the
gizmo appears but the prim is stationary. Left-click selection
must not fire after orbit drags.

See also: `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `viewer-control-patterns`, `camera-controls`, `object-selection`, `selection-feedback`, `transform-manipulator`, `prim-transform-safety`, `prim-info-display`, `stage-management`, `render-settings`, `dependencies`.
