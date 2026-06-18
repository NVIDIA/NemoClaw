# Transform Manipulator

Use this when an Omniverse Realtime Viewer needs interactive translate, rotate, or scale controls for a selected USD prim. Also read `prim-transform-safety` when live `omni:xform` attributes or selection animation are involved, and `viewport-overlays` for the WebRTC headless ovui overlay compositor.

For ovui-owned gizmo, widget, or headless overlay behavior beyond this skill,
read `references/dependencies` for acquisition guidance and supplemental dependency
documentation.

## Implementation Contract

Implement these pieces in the generated app as needed:

- Local ovui frame gizmo: draw translate, rotate, and scale handles directly
  into the numpy RGBA frame before `ByteImageProvider` receives it.
- Viewport input router: convert letterboxed viewport coordinates into render
  coordinates and give the gizmo pointer priority before camera controls.
- App tool state: own active tool, keyboard shortcuts, toolbar state, selected
  path synchronization, animation pause/resume, and pending transform updates.
- Runtime bridge: write live `omni:xform` values for immediate ovrtx feedback,
  then commit final persistent edits through the selected session-layer path.
- WebRTC headless overlay: draw the same manipulator grammar through ovui
  overlay primitives, then alpha-composite the RGBA overlay over the streamed
  BGRA frame.
- Message/input handler: route pointer and keyboard input to the gizmo first,
  then to camera or selection handlers only when the gizmo does not consume it.
- Shared projection helper: expose one `world_to_screen()` convention for
  headless overlays, hit testing, labels, and tooltips.
- CUDA/Warp compositor: blend overlay RGBA over the ovrtx BGRA stream buffer
  without copying the full video frame through browser-side 3D rendering.

## Architecture

There are two supported manipulator paths. Both share the same state and math: selected path, active tool, projected axis endpoints, hit testing, drag state, and USD transform authoring.

```text
WebRTC path:
  ovrtx renderer.step() -> LdrColor CUDA frame
  -> headless ovui TransformGizmoOverlay draws SceneView primitives
  -> copy ovui RGBA output to CUDA
  -> CUDA alpha blend over BGRA stream buffer
  -> ovstream WebRTC video frame

Local ovui path:
  ovrtx renderer.step() -> CPU numpy RGBA frame
  -> TransformGizmo.draw(frame) draws anti-aliased lines/polygons
  -> ImageBridge.update(frame) -> ByteImageProvider
```

For the WebRTC browser path, do not implement browser-side WebGL manipulators.
Browser delivery displays the ovstream video frame; USD rendering and gizmo
composition remain server-side. For the local Tauri SHM WebView path, use
`tauri-shm-transform-gizmo`: it renders a 2D canvas overlay over already-rendered
SHM pixels, not a browser 3D scene.

## Input Priority

The gizmo must receive mouse input before the camera controller. If the camera sees the press first, orbit steals the drag and the manipulator feels broken.

```python
def on_mouse_pressed(x, y, button, modifier):
    local = viewport_to_render_coords(x, y, clamp=False)
    if local and transform_gizmo.mouse_pressed(local[0], local[1], button):
        camera_dragging = False
        return

    mapped = camera_button_from_ovui(button)
    if mapped is not None:
        lx, ly = viewport_to_render_coords(x, y, clamp=True)
        camera.on_mouse_button_down(lx, ly, mapped)
```

During drag, keep routing all move and release events to the gizmo, even when the pointer leaves the rendered image. Clamp coordinates while dragging so release can finish cleanly.

```python
def on_mouse_moved(x, y):
    dragging = bool(getattr(transform_gizmo, "dragging", False))
    local = viewport_to_render_coords(x, y, clamp=dragging)
    if local and transform_gizmo.mouse_moved(local[0], local[1]):
        return
    if camera_dragging:
        camera.on_mouse_move(*viewport_to_render_coords(x, y, clamp=True))
```

For WebRTC/headless overlays, the server input bridge follows the same rule: `transform_gizmo.handle_input(event)` runs before camera input dispatch, and returns `True` when the gizmo consumed the event.

In lightweight local ovui shells, do not assume that drawing a `SceneView` gizmo
also wires low-level handle drag events into the application. If the selected
handle/pivot can be hit but no transform callback fires, add an app-owned
fallback: project the selected prim pivot into the visible image rect, treat an
LMB press within a generous radius as transform intent, and route the whole
mouse-down to the transform model. The release must not also enqueue a pick.

## Hit Testing

Project the gizmo origin and each world-axis tip to screen space every frame:

```python
AXES = {
    "x": np.array([1.0, 0.0, 0.0]),
    "y": np.array([0.0, 1.0, 0.0]),
    "z": np.array([0.0, 0.0, 1.0]),
}
HIT_RADIUS_PX = 35.0
AXIS_LENGTH_PX = 88.0
RING_RADII_PX = {"x": 76.0, "y": 64.0, "z": 52.0}
```

For translate and scale, choose the closest axis line segment from center to tip.

```python
def distance_to_segment(point, start, end):
    segment = end - start
    denom = float(np.dot(segment, segment))
    if denom <= 1e-9:
        return float(np.linalg.norm(point - start))
    t = np.clip(np.dot(point - start, segment) / denom, 0.0, 1.0)
    return float(np.linalg.norm(point - (start + segment * t)))

hit = min(axis_cache, key=lambda item: distance_to_segment(point, origin, item.end))
axis = hit.name if hit.distance <= HIT_RADIUS_PX else None
```

For rotate, compare the click radius to the ring radii and choose the nearest ring.

```python
distance = float(np.linalg.norm(point - screen_origin))
delta, axis = min(
    (abs(distance - radius), axis_name)
    for axis_name, radius in RING_RADII_PX.items()
)
return axis if delta <= HIT_RADIUS_PX else None
```

Use `35px`, not a tighter `18px`; WebRTC latency and pointer jitter otherwise make the axes hard to grab. Treat degenerate projected segments as center hits or fall back to a stable screen direction when an axis points into the camera.

## Projection And Drag Math

Project the axis direction, not only the axis endpoint. Try larger world-space scales until the projected direction has a usable length.

```python
FALLBACK_AXIS_SCREEN = {
    "x": np.array([1.0, 0.0]),
    "y": np.array([0.0, -1.0]),
    "z": np.array([-0.72, 0.52]),
}

def project_axis_direction(origin, world_axis, axis_name):
    for scale in (1.0, 10.0, 100.0, 1000.0):
        projected = world_to_top_left_screen(origin + world_axis * scale)
        if projected is None:
            continue
        delta = projected - screen_origin
        length = float(np.linalg.norm(delta))
        if length > 0.5 and math.isfinite(length):
            return delta / length, length / scale

    fallback = FALLBACK_AXIS_SCREEN[axis_name]
    return fallback / np.linalg.norm(fallback), 1.0
```

Drag math is screen-space first. Store the starting transform and compute each update from that base; do not accumulate small increments frame-to-frame.

```python
delta_px = float(np.dot(mouse - drag.start_mouse, drag.screen_direction))

if drag.tool == "translate":
    amount = delta_px / max(drag.pixels_per_world_unit, 1e-6)
    next_position = drag.start_position + AXES[drag.axis] * amount
    next_transform = drag.start_transform.copy()
    next_transform[3, :3] = next_position
elif drag.tool == "rotate":
    next_transform = rotate_transform(
        drag.start_transform,
        AXES[drag.axis],
        delta_px * 0.01,  # radians
    )
elif drag.tool == "scale":
    factor = max(0.05, 1.0 + delta_px / 140.0)
    next_transform = scale_transform(drag.start_transform, drag.axis, factor)
```

The viewer matrix convention is row-major with translation in row 3. Keep `world_to_screen()` coordinate conventions consistent: if the projection helper returns bottom-left origin, convert once to top-left origin before hit testing.

## USD Transform Authoring

For immediate ovrtx feedback, every manipulator drag path must update the live
runtime transform. Use `renderer.write_attribute(..., "omni:xform", ...)` with
`Semantic.XFORM_MAT4x4`, `PrimMode.CREATE_NEW`, and `DataAccess.SYNC`, and
snapshot the selected prim's current world transform at drag start. A visible
manipulator without a live transform write is not complete.

Session-layer xformOp authoring is useful for persistent/editor-style edits,
but it should not be the only path for a realtime viewer drag. If both are
required, write live `omni:xform` during the drag and commit the final edit
through the chosen session-layer/undo path on release.

Author manipulator edits into the session layer so user USD files remain non-destructive. Convert the desired world matrix into parent-local space before writing xform ops.

```python
from pxr import Gf, Usd, UsdGeom

def apply_world_transform_to_prim(stage, path, world_transform):
    prim = stage.GetPrimAtPath(path)
    if not prim or not prim.IsValid() or not prim.IsA(UsdGeom.Xformable):
        return False

    desired_world = gf_matrix_from_numpy(world_transform)
    parent_world = Gf.Matrix4d(1.0)
    parent = prim.GetParent()
    if parent and parent.IsValid() and str(parent.GetPath()) != "/":
        parent_world = UsdGeom.XformCache(
            Usd.TimeCode.Default()
        ).GetLocalToWorldTransform(parent)
    local = desired_world * parent_world.GetInverse()

    translate, rotate_xyz, scale = decompose_common_matrix(local)
    with Usd.EditContext(stage, stage.GetSessionLayer()):
        return write_xform_ops(UsdGeom.Xformable(prim), translate, rotate_xyz, scale)
```

Write xform ops directly. Do not use `UsdGeom.XformCommonAPI.SetRotate()` for mixed assets because existing prims may have `Gf.Vec3d` rotate/scale attributes while `SetRotate()` expects `Gf.Vec3f`.

```python
def set_vec3_op(op, values):
    attr = op.GetAttr()
    type_name = attr.GetTypeName().cppTypeName if attr else ""
    if "Vec3d" in type_name or "double" in type_name:
        op.Set(Gf.Vec3d(*values), Usd.TimeCode.Default())
    else:
        op.Set(Gf.Vec3f(*[float(v) for v in values]), Usd.TimeCode.Default())

def write_xform_ops(xformable, translate, rotate_xyz, scale):
    ops = {op.GetOpName(): op for op in xformable.GetOrderedXformOps()}
    t_op = ops.get("xformOp:translate") or xformable.AddTranslateOp()
    r_op = ops.get("xformOp:rotateXYZ") or xformable.AddRotateXYZOp()
    s_op = ops.get("xformOp:scale") or xformable.AddScaleOp()

    t_op.Set(Gf.Vec3d(*translate), Usd.TimeCode.Default())
    set_vec3_op(r_op, rotate_xyz)
    set_vec3_op(s_op, scale)
    return True
```

For live ovrtx state, coordinate this with `prim-transform-safety`: query real world transforms before binding `omni:xform`, initialize the binding before the next render step, and recreate bindings after scene reload.

## Drawing

Use the same visual grammar in both render paths:

- X axis: red `(1.0, 0.18, 0.14)`.
- Y axis: green `(0.22, 0.92, 0.32)`.
- Z axis: blue `(0.25, 0.54, 1.0)`.
- Active axis: lighter/brighter variant while dragging.
- Translate: axis lines with arrowheads.
- Rotate: concentric rings with different radii per axis.
- Scale: axis lines with square handles at endpoints.
- Center: small white square at the projected origin.

Local frame drawing should alpha-blend anti-aliased line and polygon masks into the numpy frame. Headless ovui drawing should use `omni.ui_scene.scene.Line` and `PolygonMesh` under the shared overlay `SceneView`, then let the existing CUDA compositor blend RGBA over the BGRA stream.

## Animation Interaction

Selection animation and manipulator drags must not write transforms at the same time.

```python
gizmo = TransformGizmo(
    width,
    height,
    on_transform_changed=apply_world_transform_to_prim,
    on_drag_start=lambda path: animator.freeze(path),
    on_drag_end=lambda path: animator.resume(path),
)
```

When selection animation changes the selected prim's visible transform, include
that animation offset in the gizmo position so the handles stay attached to the
rendered object.

```python
world = np.array(base_world_transform, copy=True)
world[3, 0:3] += animator.current_offset(path)
gizmo.set_selection(path, world_transform=world)
```

On drag start, freeze the animation first, then use the current visible transform as `start_transform`. On drag end, update the animator base transform before resuming so it does not snap back to the pre-drag position.

## Tool Selection

Use conventional editor shortcuts and toolbar buttons:

```text
Q = none/select
W = translate
E = rotate
R = scale
```

The active tool gates visibility and behavior. No active tool means no manipulator is rendered and no manipulator hit testing should consume camera input.

```python
def set_active_tool(tool):
    normalized = None if tool in (None, "", "none", "select") else tool
    gizmo.set_active_tool(normalized)
    toolbar.set_checked(normalized)
```

For local ovui, wire keyboard shortcuts on the viewport hit rectangle and
toolbar buttons in the header. For WebRTC, send a JSON app message such as
`{"event_type": "setActiveTool", "payload": {"tool": "translate"}}` and update
the server-side overlay state.

## Common Pitfalls

- `XformCommonAPI.SetRotate()` only accepts `GfVec3f`; directly write existing xform ops and preserve their attribute type.
- Read `viewer-input-routing` for `ovstream` mouse button normalization before combining gizmo, camera, and pick handlers.
- `HIT_RADIUS_PX = 18` is too small for WebRTC. Use `35`.
- Hover consumption is intentional: `contains() == True` can block camera input so the cursor can communicate that the gizmo is interactive. Only start transforms on press hits.
- Convert viewport coordinates through the same letterbox mapping used for picking and camera input.
- Do not call `renderer.step()` concurrently with scene reset, transform binding, or stage mutation.
- Keep one shared ovui headless overlay window; multiple windows can break frame export.
- If an axis projects to a near-zero screen length, use a deterministic fallback direction instead of producing NaNs.
- If the gizmo is visible but the prim stays stationary, verify input ownership first and then verify that the drag callback reaches the live `omni:xform` write path for the selected prim.

## Checklist

- [ ] Read `viewport-overlays` for WebRTC/headless ovui composition or `local-viewer` for inline `ByteImageProvider` drawing.
- [ ] Read `prim-transform-safety` before writing live `omni:xform` or combining gizmo drags with selection animation.
- [ ] Route gizmo input before camera input for press, move, release, and wheel.
- [ ] Project origin and axes every frame from the current camera view/projection.
- [ ] Use `start_transform` and `start_mouse` as the base for each drag update.
- [ ] During drag, write the selected prim's live `omni:xform`; on release, optionally commit to a session-layer USD edit path.
- [ ] Author USD xform ops in the session layer with parent compensation and Vec3f/Vec3d type preservation.
- [ ] Validate with a measured transform delta, not only a screenshot of a visible manipulator.
- [ ] Freeze animation during drag and resume from the new base transform after drag end.

See also: `viewport-overlays`, `prim-transform-safety`, `viewer-input-routing`, `camera-controls`, `object-selection`, `selection-animation`, `local-viewer`, `streaming-messages`.
