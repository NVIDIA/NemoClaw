# Prim Transform Safety

## Triggers

Use this skill for bind_attribute PrimMode.CREATE_NEW safety, zero-scale discovery, selection animation, transform restore, or prims jump to the origin.

Use this whenever a viewer binds or writes live `omni:xform` attributes for scene prims. The risky operations are selection animation, hide/show discovery, zero-scale isolation, and any runtime transform manipulation.

For ovrtx live attribute binding/write behavior not covered here, read
`references/dependencies` for acquisition guidance and supplemental dependency
documentation.

## Core Rule

`renderer.bind_attribute(..., prim_mode=PrimMode.CREATE_NEW)` creates a Fabric attribute if one does not already exist. For `omni:xform`, that new attribute initializes to identity. If the app renders before writing the real transform, the prim can jump to the origin and lose its authored placement in the rendered stage.

Safe sequence:

1. Query world transforms from USD before binding.
2. Bind `omni:xform` with `PrimMode.CREATE_NEW`.
3. Immediately write each saved world transform into its binding before any `renderer.step()`.
4. Perform temporary edits, such as zero-scale isolation or selection animation.
5. Restore from the saved world transform, not from the binding's initial value.

## Query World Transforms First

Use `pxr` directly or through a worker process, depending on the viewer's import isolation.

```python
from pxr import Usd, UsdGeom
import numpy as np

def get_world_transforms(stage: Usd.Stage, prim_paths: list[str]) -> dict[str, np.ndarray]:
    result = {}
    for path in prim_paths:
        prim = stage.GetPrimAtPath(path)
        if not prim or not prim.IsValid() or not prim.IsA(UsdGeom.Xformable):
            continue
        mat = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        xform = np.array(mat, dtype=np.float64).reshape(4, 4)
        if np.isfinite(xform).all():
            result[path] = xform
    return result
```

Do this before `bind_attribute`. Reading a newly-created binding is not a safe substitute; it may already be identity.

## Bind And Immediately Restore

```python
import warp as wp
from ovrtx import Device, PrimMode

bindings = {}
base_xforms = get_world_transforms(stage, prim_paths)

for path in prim_paths:
    if path not in base_xforms:
        continue
    bindings[path] = renderer.bind_attribute(
        prim_paths=[path],
        attribute_name="omni:xform",
        dtype="float64",
        shape=(4, 4),
        prim_mode=PrimMode.CREATE_NEW,
    )

for path, bind in bindings.items():
    with bind.map(device=Device.CPU) as mapped:
        wp.from_dlpack(mapped.tensor).numpy().reshape(1, 4, 4)[0] = base_xforms[path]
```

The second loop must run before the next render step. This turns the new live attribute into a faithful copy of the authored world transform before later code manipulates it.

## Safe Temporary Manipulation

For isolation-based ID discovery, hide one prim by writing a zero matrix, render, then restore its saved transform.

```python
zero_xform = np.zeros((4, 4), dtype=np.float64)

def write_bound_xform(bind, xform: np.ndarray) -> None:
    with bind.map(device=Device.CPU) as mapped:
        wp.from_dlpack(mapped.tensor).numpy().reshape(1, 4, 4)[0] = xform

baseline_ids = render_and_read_instance_ids(renderer)

for path, bind in bindings.items():
    write_bound_xform(bind, zero_xform)
    hidden_ids = render_and_read_instance_ids(renderer)
    missing_ids = baseline_ids - hidden_ids

    write_bound_xform(bind, base_xforms[path])
    render_and_read_instance_ids(renderer)  # let the restore reach the next frame

    for instance_id in missing_ids:
        id_to_path[instance_id] = path
```

The same pattern applies to animation: compose offsets with `base_xforms[path]`, and restore that base transform when animation ends.

```python
def write_offset(path: str, offset_xyz: np.ndarray) -> None:
    offset_mat = np.eye(4, dtype=np.float64)
    offset_mat[3, 0:3] = offset_xyz
    write_bound_xform(bindings[path], base_xforms[path] @ offset_mat)
```

## Batch Write Alternative

If a helper does not need long-lived bindings, use `write_attribute`, but still query transforms first and write the real values immediately.

```python
from ovrtx import DataAccess, PrimMode, Semantic

paths = [path for path in prim_paths if path in base_xforms]
xforms = np.stack([base_xforms[path] for path in paths]).astype(np.float64)

renderer.write_attribute(
    prim_paths=paths,
    attribute_name="omni:xform",
    tensor=xforms,
    semantic=Semantic.XFORM_MAT4x4,
    prim_mode=PrimMode.CREATE_NEW,
    data_access=DataAccess.SYNC,
)
```

Use bound attributes for per-frame updates. Use batch writes for one-shot initialization or reset.

## Interactive Gizmo Drag Pattern

For selected-prim transform gizmos, treat the gizmo as a UI input source and
keep transform authority in one runtime model. Do not stop at rendering the
handle; every drag path must call a live `omni:xform` write.

Safe drag lifecycle:

1. On selection, keep the selected path list separate from the mesh paths used
   for highlight outlines.
2. On drag start, snapshot each selected prim's current transform. Prefer the
   app's live-transform cache when the prim has already moved; otherwise query
   USD world transform before creating a live `omni:xform`.
3. On drag move, compose the drag delta from the drag-start snapshot rather
   than incrementally reading back a newly-created `omni:xform`.
4. Write the composed transform with `Semantic.XFORM_MAT4x4`,
   `PrimMode.CREATE_NEW`, and `DataAccess.SYNC`.
5. On drag end, clear the snapshot and refresh selected-prim telemetry from the
   live-transform cache.

```python
class TransformDragModel:
    def __init__(self, runtime):
        self.runtime = runtime
        self.selected_paths = []
        self.start_xforms = {}

    def on_drag_start(self):
        self.start_xforms = {}
        for path in self.selected_paths:
            xform = self.runtime.get_live_or_usd_world_transform(path)
            if xform is not None:
                self.start_xforms[path] = xform

    def on_drag_moved(self, delta_matrix):
        for path, base in self.start_xforms.items():
            self.runtime.write_live_xform(path, base @ delta_matrix)

    def on_drag_ended(self):
        self.start_xforms.clear()
```

Validation must assert a numeric transform delta for a known prim. A screenshot
showing a visible gizmo is not enough; the selected prim must move and the
highlight/inspector must follow the live transform.

## Scene Lifecycle

- Recompute world transforms after every scene load, reload, variant change, or selectable-set rebuild.
- Recreate bindings after `reset_stage()` or stage replacement.
- Do not keep transform bindings across scenes.
- Do not call `renderer.step()` concurrently with transform discovery or scene reset.
- If a prim is missing a valid world transform, skip binding it instead of falling back to identity.

## Anti-Patterns

```python
# Wrong: CREATE_NEW may read back identity, not the authored transform.
bind = renderer.bind_attribute(..., attribute_name="omni:xform", prim_mode=PrimMode.CREATE_NEW)
with bind.map(device=Device.CPU) as mapped:
    original = wp.from_dlpack(mapped.tensor).numpy().reshape(1, 4, 4)[0].copy()

# Wrong: identity fallback silently moves a prim to the origin.
original_xforms[path] = np.eye(4, dtype=np.float64)

# Wrong: authored USD xform ops are not the live ovrtx update path.
renderer.write_attribute(..., attribute_name="xformOp:transform")
```

## Gotchas

- `PrimMode.EXISTING_ONLY` can skip missing live attributes; use it only when inline session data already created them.
- `omni:xform` matrices are `float64`, row-major, with translation in row 3 in the viewer patterns used here.
- A zero-scale or zero matrix hide operation must always have a known restore matrix.
- Multi-mesh or instanceable assets can produce several segmentation IDs for one selected path; preserve path-to-many-ID behavior when needed.
- Transform-safe discovery should use the baseline, hide, diff, restore pattern
  above; never discover IDs by reading a newly-created `omni:xform` binding or
  leaving a prim hidden across frames.

See also: `object-selection`, `selection-animation`, `ovrtx-rendering`, `stage-hierarchy`, `stage-management`.
