# Camera Controls

## Triggers

Use this skill for requests mentioning orbit camera, pan, zoom, camera controls, viewport navigation, fit to scene, camera aspect, letterbox coordinates, camera gizmos, row-major camera matrices, or cameras inside geometry.

ovrtx does not provide native camera input handling. The camera is a USD prim, and the app updates its `omni:xform` every frame or after input changes.

Read `viewer-input-routing` first when the task involves WebRTC/SHM input
callbacks, ovui button ids, viewport input gating, wheel events, or
click-vs-drag dispatch. This skill owns camera state and camera math.

## Input Mapping

This section is a camera-facing summary. `viewer-input-routing` is the primary
source for transport normalization and input ownership.

For local ovui callbacks, button ids differ from the `OrbitCamera` helper:

- ovui: `0=left`, `1=right`, `2=middle`
- `OrbitCamera`: `0=left`, `1=middle`, `2=right`
- Local ovui maps exactly as `0 -> left/orbit`, `2 -> middle/pan`, and `1 -> right/dolly`.

```python
def camera_button_from_ovui(button: int) -> int | None:
    return {0: 0, 2: 1, 1: 2}.get(button)
```

For WebRTC `ovstream.InputEvent` callbacks, do not treat raw button integers
as browser DOM button ids. `ovstream.MouseButton` uses `NONE=0`, `LEFT=1`,
`MIDDLE=2`, `RIGHT=3`. Normalize to the shared camera helper convention before
calling camera or pick code:

```python
def camera_button_from_ovstream(raw_button) -> int | None:
    try:
        button = raw_button if isinstance(raw_button, ovstream.MouseButton) else ovstream.MouseButton(raw_button)
    except Exception:
        return None
    if button == ovstream.MouseButton.LEFT:
        return 0
    if button == ovstream.MouseButton.MIDDLE:
        return 1
    if button == ovstream.MouseButton.RIGHT:
        return 2
    return None
```

Use left drag for orbit, middle drag for pan, right drag for dolly/zoom, and wheel for zoom. For desktop apps with modifier keys, use Alt+LMB for orbit, Alt+MMB for pan, Alt+RMB for dolly. Optionally support RMB+WASD fly mode for free camera movement. Left-click selection should fire only on release when movement stayed below the drag threshold.

## Render Aspect

When creating or explicitly reconfiguring the render product resolution, update camera viewport dimensions and projection aspect in the same operation. For USD cameras, keep horizontal aperture stable and derive vertical aperture from the render size:

```python
def update_camera_aspect(stage, camera_path: str, width: int, height: int) -> None:
    cam = stage.GetPrimAtPath(camera_path)
    if not cam or not cam.IsValid() or width <= 0 or height <= 0:
        return
    h_attr = cam.GetAttribute("horizontalAperture")
    v_attr = cam.GetAttribute("verticalAperture")
    h_aperture = float(h_attr.Get() or 20.955)
    v_attr.Set(h_aperture * float(height) / float(width))
```

Browser streaming should keep a fixed server render resolution, display the video with `object-fit: contain`, and avoid sending resize messages for CSS layout changes. NVST handles letterbox coordinate mapping for WebRTC input carried as binary `InputEvent` structs; app-owned DOM math should still use the visible image rectangle before orbit, pan, zoom, or pick calculations.

Input transport rules:

- WebRTC: use the NVST native input channel and handle `InputEvent` structs from ovstream callbacks.
- SHM: use `ovstream.ShmClient.send_input_event()` from Python, or `ovstream_shm_client_send_input_event()` from C, with `InputEvent` structs; do not send JSON `mouseInput`.
- In-process: call camera controller methods directly from the Python/C++ UI event loop.

For browser-streamed React apps, gate native input with an app-level viewport
ownership flag. UI panels should send `setViewportInputActive {active:false}`;
the viewport sends `active:true` on pointer entry/down and `active:false` on
pointer leave. The server should ignore native input while inactive and cancel
any drag state:

```python
def set_viewport_input_active(self, active: bool) -> None:
    self._viewport_input_active = bool(active)
    if not self._viewport_input_active:
        self.camera.cancel_interaction()

def handle_input(self, event):
    if not self._viewport_input_active:
        self.camera.cancel_interaction()
        return
    # Normal orbit, pan, zoom, and click-to-pick handling.
```

This prevents sidebar, tree, top-bar, and inspector interactions from reaching
the orbit controller as stale WebRTC mouse input.

For WebRTC servers, initialize the viewport input gate to active when the only
native input source is the stream surface. Otherwise the first mouse-down of a
click can arrive before the React `setViewportInputActive {active:true}` data
channel message, and the release will not be recognized as a click. DOM panels
should still send `active:false` on pointer enter/down to disable camera and
picking while the user interacts with UI chrome.

## Drag Threshold (Click vs Drag Discrimination)

A short press-and-release should be treated as a click (selection, context menu),
not a drag (orbit, pan, dolly). Track movement from press to release and compare
against a threshold. The default desktop threshold is a 1 px delta: any move
event with `abs(dx) > 1.0` or `abs(dy) > 1.0` turns the gesture into a drag.

```python
DRAG_THRESHOLD_PX = 1.0  # pixels of movement before press becomes drag

class InputState:
    def __init__(self):
        self.last_x: float = 0.0
        self.last_y: float = 0.0
        self.exceeded_threshold: bool = False

    def on_press(self, x: float, y: float):
        self.last_x = x
        self.last_y = y
        self.exceeded_threshold = False

    def on_move(self, x: float, y: float) -> bool:
        """Returns True if this motion exceeds the drag threshold."""
        dx = x - self.last_x
        dy = y - self.last_y
        self.last_x = x
        self.last_y = y
        if not self.exceeded_threshold:
            if abs(dx) > DRAG_THRESHOLD_PX or abs(dy) > DRAG_THRESHOLD_PX:
                self.exceeded_threshold = True
        return self.exceeded_threshold

    def was_click(self) -> bool:
        """Call on release — True means the gesture was a click, not a drag."""
        return not self.exceeded_threshold
```

Usage rules:
- *LMB*: if `was_click()` → fire selection pick at release position. If threshold exceeded → it was an orbit drag, do not select.
- *RMB*: if `was_click()` → show context menu (see `local-viewer`). If threshold exceeded → it was a look/dolly, suppress menu.
- *MMB*: always pan (no click action on middle button).
- *Transform gizmo*: if the press begins on or near a selected transform
  handle/pivot, enter transform-drag mode for the whole mouse-down and suppress
  orbit and click-pick on release.
- Use the same coordinate space passed to the camera helper. Local and Tauri
  pointer events should be mapped through the letterboxed image rect first, so
  the camera sees render-pixel coordinates.
- Use a 1 px threshold for precise desktop input. Increase to 8–10 only for
  touch-first input.
- For browser-streamed React apps, a 4–6 px threshold is often more tolerant of
  WebRTC/browser pointer jitter around click selection.

## Gizmo Hit Testing And Input Ownership

For lightweight local viewers that combine a `SceneView` overlay with app-owned
mouse callbacks, keep a single input owner for each mouse-down. Project the
selected prim pivot into the visible rendered image rectangle and treat a press
near that point as transform intent; otherwise route the press through normal
camera/pick behavior.

```python
def project_world_to_viewport(point, view, proj, image_rect, widget_origin):
    p = np.array([point[0], point[1], point[2], 1.0], dtype=np.float64)
    clip = proj @ (view @ p)
    if abs(float(clip[3])) < 1e-8:
        return None
    ndc = clip[:3] / clip[3]
    if not np.isfinite(ndc).all() or ndc[2] < -1.0 or ndc[2] > 1.0:
        return None
    off_x, off_y, draw_w, draw_h = image_rect
    x = widget_origin[0] + off_x + (ndc[0] * 0.5 + 0.5) * draw_w
    y = widget_origin[1] + off_y + (1.0 - (ndc[1] * 0.5 + 0.5)) * draw_h
    return float(x), float(y)

def pointer_is_near_selected_gizmo(screen_x, screen_y, selected_pivot):
    projected = project_world_to_viewport(selected_pivot, view, proj, image_rect, widget_origin)
    if projected is None:
        return False
    dx = screen_x - projected[0]
    dy = screen_y - projected[1]
    return dx * dx + dy * dy <= 160.0 * 160.0
```

This fallback does not replace a real axis-handle manipulator when the shell has
one. It ensures the viewer still satisfies direct manipulation when a standalone
ovui build displays the gizmo but does not deliver lower-level handle drag
events into the app's transform model.

## Sanitize State

NaN camera state poisons projection, picking, overlays, and ovrtx writes.

```python
MIN_DISTANCE = 0.01
MAX_ELEVATION = math.pi / 2 - 0.01

def sanitize_camera(camera) -> None:
    if not math.isfinite(float(camera.azimuth)):
        camera.azimuth = -1.5708
    if not math.isfinite(float(camera.elevation)):
        camera.elevation = 0.0
    camera.elevation = max(-MAX_ELEVATION, min(MAX_ELEVATION, camera.elevation))
    try:
        camera.distance = max(MIN_DISTANCE, float(camera.distance))
    except Exception:
        camera.distance = MIN_DISTANCE
    if not math.isfinite(camera.distance):
        camera.distance = MIN_DISTANCE
    target = np.asarray(camera.target, dtype=np.float64)
    if target.shape != (3,) or not np.isfinite(target).all():
        target = np.array([-74.5, 103.0, -22.5], dtype=np.float64)
    camera.target = target
```

Call this before handling input and before generating matrices.

## Row-Major ovrtx Camera Matrix

ovrtx consumes USD `GfMatrix4d` row-vector layout:

```python
M = np.eye(4, dtype=np.float64)
M[0, :3] = right       # X basis
M[1, :3] = up          # Y basis
M[2, :3] = -forward    # camera local -Z looks forward
M[3, :3] = eye         # translation
```

For Y-up scenes:

```python
forward = target - eye
forward /= np.linalg.norm(forward)
world_up = np.array([0.0, 1.0, 0.0])
right = np.cross(forward, world_up); right /= np.linalg.norm(right)
up = np.cross(right, forward)
```

Use `world_up = [0, 0, 1]` for Z-up scenes. The common mistake is putting axes in columns, which puts the camera inside or under geometry.

If your camera helper returns a GL view matrix, convert it:

```python
world_matrix = np.ascontiguousarray(np.linalg.inv(view_matrix).T, dtype=np.float64)
```

## Write To ovrtx

```python
xform = np.ascontiguousarray(camera.get_camera_xform(), dtype=np.float64)
if xform.shape == (4, 4) and np.isfinite(xform).all():
    renderer.write_attribute(
        prim_paths=["/Session/Cameras/Main"],
        attribute_name="omni:xform",
        tensor=xform.reshape(1, 4, 4),
        semantic=ovrtx.Semantic.XFORM_MAT4x4,
        prim_mode=ovrtx.PrimMode.CREATE_NEW,
    )
```

Use the actual inline session camera path from `stage-loading`.

## Fit Camera To Stage

Search for authored `UsdGeom.Camera` prims first. If the app policy allows
stage cameras, copy the selected authored camera's focal length, apertures,
clipping range, projection, and transform into the viewer camera before falling
back to bounds fitting.

If no authored camera exists, compute a world bbox via `stage-hierarchy`, then
set target to the bbox center and distance from max dimension and focal
length/field of view. Choose the initial view for the kind of stage:

- For general object/prop scenes, a three-quarter orbit view is usually safe.
- For Z-up exterior or architectural scenes, avoid a steep roof-down first view.
  Prefer a lower elevation overview so walls, entrances, windows, racks, and
  scene context are visible.
- For very wide or flat scenes, increase distance and lower elevation rather
  than aiming straight down.

When the first view matters, render 4-6 candidate camera poses, build a small
contact sheet, and choose the least occluded view. Candidate sets should vary
azimuth, elevation, and distance while keeping the same bbox target.

## Inline Local Camera Gizmo

For local ovui, build the gizmo directly in the viewport `ZStack` with `omni.ui_scene.SceneView`; do not use the streaming server's headless overlay compositor.

```python
class OverlayCamera(sc.AbstractManipulatorModel):
    def get_as_floats(self, item):
        if item == self.get_item("projection"):
            f = 1.0 / math.tan(math.radians(30.0))
            return [f,0,0,0, 0,f,0,0, 0,0,-1.002,-1, 0,0,-0.2002,0]
        if item == self.get_item("view"):
            return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-4,1]
        return []

class OrbitRingManipulator(sc.Manipulator):
    def __init__(self, on_orbit_delta, pixel_scale: float, **kwargs):
        super().__init__(**kwargs)
        self._on_orbit_delta = on_orbit_delta
        self._pixel_scale = float(pixel_scale)
        self._drag = sc.DragGesture(on_changed_fn=self._on_changed, on_began_fn=lambda _s: self.invalidate(), on_ended_fn=lambda _s: self.invalidate())
        self._drag.mouse_button = 0
    def on_build(self):
        for axis, color in enumerate((0xD134BCFF, 0x9EFF6BFF, 0x94C7FFFF)):
            pts = [([math.cos(i*math.tau/72), math.sin(i*math.tau/72), 0], [math.cos(i*math.tau/72), 0, math.sin(i*math.tau/72)], [0, math.cos(i*math.tau/72), math.sin(i*math.tau/72)])[axis] for i in range(73)]
            for a, b in zip(pts, pts[1:]):
                sc.Line(a, b, color=color, thickness=3.0, intersection_thickness=18.0, gesture=self._drag)
        sc.Screen(gesture=self._drag)
    def _on_changed(self, sender):
        payload = getattr(sender, "gesture_payload", None)
        if payload is not None:
            dx_ndc, dy_ndc = payload.mouse_moved
            self._on_orbit_delta(float(dx_ndc), float(-dy_ndc), self._pixel_scale)
```

Toggle the gizmo from a header button. `DragGesture` instances must be created once and reused.

## Gotchas

- Use `omni:xform`, not authored USD `xformOp:*`, for live ovrtx camera updates.
- Use `Semantic.XFORM_MAT4x4` and `PrimMode.CREATE_NEW`.
- Skip writes if the 4x4 matrix is non-finite.
- Clamp local mouse coordinates through the visible rendered image rect so letterboxing does not skew orbit/pick math.

## Alt+Modifier Input Mapping (Desktop Apps)

For Qt or native windowing with modifier keys:

```python
def on_mouse_press(event):
    if event.modifiers() & Alt:
        if event.button() == LeftButton:
            mode = "orbit"
        elif event.button() == MiddleButton:
            mode = "pan"
        elif event.button() == RightButton:
            mode = "dolly"
    elif event.button() == RightButton:
        mode = "fly_look"  # enter RMB+WASD fly mode
    elif event.button() == LeftButton:
        mode = "select"  # click-to-select (fire on release if no drag)
```

## WASD Fly Mode

When the right mouse button is held, enable keyboard-driven fly movement:

```python
class FlyState:
    def __init__(self):
        self.keys_held: set[str] = set()
        self.speed = 2.0  # units/second, adjustable via scroll wheel while RMB held

    def update(self, camera, dt: float):
        if not self.keys_held:
            return
        forward = camera.forward_vector()
        right = camera.right_vector()
        up = camera.world_up  # [0,0,1] for Z-up, [0,1,0] for Y-up
        move = np.zeros(3, dtype=np.float64)
        if "w" in self.keys_held: move += forward
        if "s" in self.keys_held: move -= forward
        if "d" in self.keys_held: move += right
        if "a" in self.keys_held: move -= right
        if "e" in self.keys_held: move += up
        if "q" in self.keys_held: move -= up
        norm = np.linalg.norm(move)
        if norm > 1e-6:
            move = move / norm * self.speed * dt
        camera.target += move
        # eye moves with target (no orbit change)
```

While in fly mode, mouse movement rotates the camera view (adjust azimuth/elevation without changing distance). Scroll wheel adjusts fly speed.

## Generated Module Checklist - camera.py

- [ ] `OrbitCamera.__init__(width: int, height: int)`
- [ ] `OrbitCamera.on_mouse_button_down(x: float, y: float, button: int) -> None`
- [ ] `OrbitCamera.on_mouse_button_up(x: float, y: float, button: int) -> bool`
- [ ] `OrbitCamera.on_mouse_move(x: float, y: float) -> None`
- [ ] `OrbitCamera.orbit_delta(dx: float, dy: float, scale: float = 1.0) -> None`
- [ ] `OrbitCamera.on_scroll(delta: float) -> None`
- [ ] `OrbitCamera.get_camera_xform() -> np.ndarray`
- [ ] `OrbitCamera.get_view_matrix() -> np.ndarray`
- [ ] `OrbitCamera.get_projection_matrix(aspect_ratio=None) -> np.ndarray`
- [ ] `OrbitCamera._sanitize_state() -> None`
- [ ] Press/release state distinguishes click from drag using the 1 px threshold.
- [ ] Matrix rows are right, up, negative-forward, translation.

## Generated Module Checklist - server input routing

- [ ] `MessageHandler.on_input(event) -> None`
- [ ] Mouse move calls `camera.on_mouse_move(x, y)`.
- [ ] Left-button release calls `camera.on_mouse_button_up(..., 0)` and picks only when it returns `True`.
- [ ] Middle-button input maps to camera button `1`.
- [ ] Right-button input maps to camera button `2`.
- [ ] Wheel input calls `camera.on_scroll(delta)`.
- [ ] Browser pointer events are not duplicated as JSON messages.

See also: `viewer-input-routing`, `local-viewer`, `stage-loading`, `stage-hierarchy`, `prim-info-display`, `viewport-overlays`.
