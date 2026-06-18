# Prim Info Display

## Triggers

Use this skill for object information, show properties, inspect prim, selected object panels, tooltips, prim info, `read_attribute`, or metadata requests.

Use this skill when a selected object should reveal readable USD information.

## What To Show

Minimum useful fields:

- Display name: `prim.GetName()`
- Full path: `str(prim.GetPath())`
- Type: `prim.GetTypeName()`
- Kind/model metadata if available.
- Transform: authored `xformOp:*` values and computed world transform.
- Material: direct or inherited material binding path.
- Visibility/purpose and selected variant sets when relevant.

For broad property inspection, use `stage-hierarchy` serialization rules and cap large arrays.

## Preferred Data Path

Use native ovrtx 0.3 reads for inspector attributes first:

1. Use `Renderer.query_prims()` with `AttributeFilterMode.SPECIFIC` or `ALL` to discover available attributes and `AttributeInfo` descriptors.
2. Use `Renderer.read_attribute()` for scalar values with one value per prim, such as `omni:xform`, radius-like numeric values, or shader inputs.
3. Use `Renderer.read_array_attribute()` for variable-length array values, such as mesh `points`, `normals`, or `faceVertexCounts`.
4. Use pxr only for variant sets, relationship targets, and USD metadata until native APIs cover those at the same fidelity.

```python
import numpy as np
from ovrtx import AttributeFilterMode

COMMON_ATTRS = ["omni:xform", "visibility", "purpose", "inputs:Fader"]

def native_prim_info(renderer, path: str) -> dict:
    query = renderer.query_prims(
        attribute_filter_mode=AttributeFilterMode.SPECIFIC,
        attribute_names=COMMON_ATTRS,
    )
    attrs = query.get(path, {})
    data = {
        "name": path.rsplit("/", 1)[-1],
        "path": path,
        "attributes": sorted(attrs.keys()),
    }
    if "omni:xform" in attrs:
        tensor = renderer.read_attribute("omni:xform", [path])
        data["world_transform"] = np.from_dlpack(tensor).reshape(1, 4, 4)[0].tolist()
    if "inputs:Fader" in attrs:
        tensor = renderer.read_attribute("inputs:Fader", [path])
        data["fader"] = float(np.from_dlpack(tensor).reshape(-1)[0])
    return data
```

Do not force every inspector field through pxr just because the UI already has a worker. The worker should augment native data with variants, material relationship strings, and authored metadata when those fields are requested.

## Delivery-Mode Field Sets

The exact fields shown differ by delivery path:

| Mode | Current fields |
|---|---|
| Streaming headless ovui overlay | Name, path, `typeName`, translate, rotate, scale, material binding, and a projected world-center anchor. |
| Streaming React inspector | Selected name/path/type plus `KIND`, `VISIBILITY`, `MATERIAL`, and `BOUNDS` derived from `getPropertiesResponse`. |
| Local ovui overlay | Name, path, type, and position, projected into the local viewport with image-letterbox offsets. |
| Tauri shared React panel | Selected path plus `PrimProperty[]`; the current backend stub returns only a `path` property until a Rust/USD property query is added. |

## Native Property Query Pattern

For selected-prim panels, keep a small allowlist of high-value attributes and cap payload size before sending over a data channel:

```python
def read_selected_attributes(renderer, path: str, attr_names: list[str]) -> dict:
    info = renderer.query_prims(
        attribute_filter_mode=AttributeFilterMode.SPECIFIC,
        attribute_names=attr_names,
    ).get(path, {})

    values = {}
    for name, desc in info.items():
        if desc.is_array:
            arrays = renderer.read_array_attribute(name, [path])
            values[name] = np.from_dlpack(arrays[path])[:1000].tolist()
        else:
            tensor = renderer.read_attribute(name, [path])
            values[name] = np.from_dlpack(tensor).tolist()
    return values
```

Token/path-valued data may surface as numeric token or path IDs rather than user-facing strings. Keep pxr fallback for readable visibility tokens, material binding targets, relationship lists, and variant sets when the UI needs display strings:

```python
from pxr import UsdGeom, UsdShade

def prim_info(stage, path: str) -> dict:
    prim = stage.GetPrimAtPath(path)
    if not prim or not prim.IsValid():
        return {}
    data = {"name": prim.GetName(), "path": str(prim.GetPath()), "type": prim.GetTypeName()}
    xformable = UsdGeom.Xformable(prim)
    if xformable:
        data["world_transform"] = [list(xformable.ComputeLocalToWorldTransform(Usd.TimeCode.Default()).GetRow(i)) for i in range(4)]
    binding = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
    if binding:
        data["material"] = str(binding.GetPath())
    data["properties"] = {a.GetName(): serialize_value(a.Get()) for a in prim.GetAttributes()}
    return data
```

## UI Patterns

- Sidebar panel: best for dense property lists and stage-tree selection.
- Floating panel: best for visual selection feedback near the selected object.
- Tooltip: best for short name/type/path hints.

Do not duplicate a full editor property inspector unless the user asks for the ovui editor path.

## Floating Panel Projection

Build a `ui.Placer` in the viewport `ZStack`, store a world-space anchor, and update the projected screen position each frame. Use the rendered image rect, not the full widget rect, so letterboxing does not offset the panel.

```python
def world_to_screen(point_3d, view_matrix, proj_matrix, viewport_w, viewport_h):
    point = np.array([point_3d[0], point_3d[1], point_3d[2], 1.0], dtype=np.float64)
    view = np.asarray(view_matrix, dtype=np.float64).reshape(4, 4)
    proj = np.asarray(proj_matrix, dtype=np.float64).reshape(4, 4)
    clip = proj @ (view @ point)
    depth = float(clip[3])
    if abs(depth) < 1e-9:
        return math.nan, math.nan, depth
    ndc = clip[:3] / clip[3]
    return (ndc[0] * 0.5 + 0.5) * viewport_w, (ndc[1] * 0.5 + 0.5) * viewport_h, depth
```

```python
placer = ui.Placer(offset_x=8, offset_y=8, width=0, height=0, stable_size=False, visible=False)
with placer:
    build_prim_info_panel()

def update_overlay_position(world_center):
    vp_w, vp_h = viewport.widget_size()
    image_x, image_y, image_w, image_h = viewport.image_content_rect()
    sx, bottom_y, depth = world_to_screen(
        world_center,
        camera.get_view_matrix(),
        camera.get_projection_matrix(aspect_ratio=image_w / max(1.0, image_h)),
        int(round(image_w)),
        int(round(image_h)),
    )
    sx = image_x + sx
    sy = image_y + (image_h - bottom_y)  # top-left UI origin
    if depth <= 0.0 or not (math.isfinite(sx) and math.isfinite(sy)):
        placer.visible = False
        return
    panel_w, panel_h = 260, max(130.0, float(getattr(panel_container, "computed_height", 0.0) or 0.0))
    placer.offset_x = min(max(8.0, sx - panel_w * 0.5), max(8.0, vp_w - panel_w - 8.0))
    placer.offset_y = min(max(8.0, sy - panel_h - 80.0), max(8.0, vp_h - panel_h - 8.0))
    placer.visible = True
```

Use bbox top-center as the anchor when available; fall back to local-to-world translation. Hide the panel when selection clears, the prim is invalid after scene switching, or the projected point is behind the camera.

## Streaming Overlay Path

For server-side WebRTC overlays, `viewport-overlays` owns the headless ovui composition path. It uses the same info fields and projection idea but renders to an alpha frame that is blended over the stream.

See also: `stage-attribute-reads`, `stage-hierarchy`, `object-selection`, `viewport-overlays`, `local-viewer`.

## Adding This To An Existing Omniverse Realtime Viewer

- Add `server/prim_info.py` or extend `server/stage_queries.py` with selected-prim info queries backed by native `query_prims()` and `read_attribute()` / `read_array_attribute()`.
- Maintain current selected prim path, latest info payload, and an invalidation flag for scene reloads.
- Use `stageSelectionChanged` as the trigger to request or push fresh prim info.
- Reuse `getPropertiesRequest` -> `getPropertiesResponse` for dense property panels.
- Do not emit only `getPropertiesResult` for the current React inspector; it listens for `getPropertiesResponse`.
- Frontend wires a `PrimInfoPanel` to selection state and property responses.
  In React, update a `selectedPathRef.current` synchronously inside the
  `stageSelectionChanged` handler, clear the panel, then request properties.
  Accept `getPropertiesResponse` only when `response.prim_path` equals that ref.
  Do not guard with closure-captured `selectedPath`; fast property responses can
  otherwise be dropped after selection changes.
- Local Omniverse Realtime Viewer apps can use a sidebar or viewport overlay tied directly to the local stage query object.
- Include name, path, type, transform, material, visibility, purpose, metadata, and variants when available.
- Prefer native attribute reads for transform and numeric/tensor values; use pxr for variant sets, relationships, and USD metadata.
- Cap large arrays and serialize USD values using `stage-hierarchy` rules before
  sending JSON. For inspector panels, send counts plus a small preview for mesh
  buffers such as `points`, `normals`, `faceVertexIndices`, and UV primvars; do
  not send complete geometry arrays over WebRTC.
- Hide or clear the panel when selection clears, the scene switches, or the prim becomes invalid.
- Floating panels need bbox anchors, camera projection, and viewport letterbox offsets from the viewer shell.
