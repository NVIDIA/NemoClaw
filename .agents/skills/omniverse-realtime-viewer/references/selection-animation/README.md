# Selection Animation

## Triggers

Use this skill for selection animation, prim animation, hover animation, float selected object, animate selected, omni:xform animation, map_attribute, AttributeMapping, or transform not updating.

Use this when selected prims need optional renderer-visible motion feedback. It
writes live `omni:xform` transforms to ovrtx without changing the source USD.

## Key Rules

- Attribute: `omni:xform`, not `xformOp:transform` or `xformOp:translate`.
- Semantic: `Semantic.XFORM_MAT4x4`.
- PrimMode: `PrimMode.CREATE_NEW`.
- Matrix: float64, row-major, translation in row 3.
- Call `animator.update(dt)` before `renderer.step()`.
- Bind attributes once at stage load and reuse the `AttributeBinding` handles. Use `binding.map()`, `binding.write()`, or `renderer.map_attribute()` for frame updates; do not recreate bindings every frame.
- Preserve base transforms by reading them once and composing offsets with them.
- Selection animation is driven by selected prim paths. It does not depend on EffectLayer materials, material maps, or segmentation IDs. Those belong to selection feedback, not motion.
- Motion parameters are application choices. Derive direction, magnitude,
  duration, and easing from the product brief, stage units, asset scale, and
  active coordinate system.

## State Machine

`IDLE -> RISING -> HOVERING -> FALLING -> IDLE`

Use a small state machine so selection and deselection are reversible. The
specific motion can be lift, pulse, nudge, scale, or another non-destructive
transform chosen by the app. The example below uses a configurable translation
offset; replace its values for the target product.

```python
ANIMATION = {
    "direction": np.array([0.0, 1.0, 0.0], dtype=np.float64),  # app-defined
    "distance": 0.05,      # stage units; choose from asset scale/bounds
    "oscillation": 0.0,    # optional additional stage-unit offset
    "frequency_hz": 1.5,
    "rise_seconds": 0.25,
    "fall_seconds": 0.25,
}

def ease_out_quint(t): return 1.0 - (1.0 - t) ** 5
def ease_in_out_sine(t): return -(math.cos(math.pi * t) - 1) / 2
```

## Animator Construction

Initialize Warp once before constructing GPU/attribute helpers. Build fresh bindings after every scene switch.

```python
import warp as wp
wp.init()

world_transforms = {}
for path in pickable_paths:
    prim = stage.GetPrimAtPath(path)
    if prim and prim.IsValid():
        m = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        base = np.array(m, dtype=np.float64).reshape(4, 4)
        if np.isfinite(base).all():
            world_transforms[path] = base
animator = PrimAnimator(renderer, list(world_transforms), world_transforms)
```

## Binding And Write Pattern

Pre-bind `omni:xform` attributes when the stage loads, then reuse the bindings. Use one batched binding when the animated set is stable; use a path-to-binding map when the selectable set changes frequently.

```python
import numpy as np
import warp as wp
from ovrtx import BindingFlag, Device, PrimMode, Semantic

binding = renderer.bind_attribute(
    prim_paths=prim_paths,
    attribute_name="omni:xform",
    dtype="float64",
    shape=(4, 4),
    semantic=Semantic.XFORM_MAT4x4,
    prim_mode=PrimMode.CREATE_NEW,
    flags=BindingFlag.OPTIMIZE,
)
```

Immediately initialize the new live attribute from saved world transforms before any render step. `CREATE_NEW` can otherwise initialize `omni:xform` to identity.

```python
initial = np.stack([base_xforms[path] for path in prim_paths]).astype(np.float64)
binding.write(initial)
```

Each frame, compose the saved base transform with the app-defined transform
offset and write through the persistent binding:

```python
def compose_offset_xforms(
    prim_paths: list[str],
    offsets: dict[str, np.ndarray],
) -> np.ndarray:
    out = np.empty((len(prim_paths), 4, 4), dtype=np.float64)
    for i, path in enumerate(prim_paths):
        base = base_xforms[path]
        offset = offsets.get(path)
        offset_mat = np.eye(4, dtype=np.float64)
        if offset is not None:
            offset_mat[3, 0:3] = offset
        out[i] = base @ offset_mat
    return out

def write_offsets_cpu(offsets: dict[str, np.ndarray]) -> None:
    xforms = compose_offset_xforms(prim_paths, offsets)
    binding.write(xforms)
```

For direct mapped writes, consume the mapped DLPack tensor with NumPy, Warp, or another DLPack-compatible library:

```python
def write_offsets_mapped(offsets: dict[str, np.ndarray]) -> None:
    xforms = compose_offset_xforms(prim_paths, offsets)
    with binding.map(device=Device.CPU) as mapping:
        np.from_dlpack(mapping.tensor)[:] = xforms
```

## ovrtx 0.3 Mapping And Async Writes

`Renderer.write_attribute()`, `AttributeBinding.write()`, and async variants accept CPU or GPU DLPack tensors. `DataAccess.SYNC` copies input immediately. `DataAccess.ASYNC` references the caller's buffer until the operation completes, so keep the source tensor alive and provide CUDA stream/event synchronization when writing GPU data.

```python
from ovrtx import DataAccess

gpu_xforms = build_gpu_xform_tensor()  # Warp/CuPy/PyTorch object with __dlpack__()
op = binding.write_async(
    gpu_xforms,
    data_access=DataAccess.ASYNC,
    cuda_stream=cuda_stream_handle,
)
op.wait()
```

Use `renderer.map_attribute()` for by-name mapped writes when you do not need a long-lived binding object, or when a helper owns a short update batch:

```python
mapping = renderer.map_attribute(
    prim_paths,
    "omni:xform",
    dtype="float64",
    shape=(4, 4),
    semantic=Semantic.XFORM_MAT4x4,
    device=Device.CPU,
    prim_mode=PrimMode.CREATE_NEW,
)
np.from_dlpack(mapping.tensor)[:] = compose_offset_xforms(prim_paths, offsets)
mapping.unmap()
```

For CUDA mapped writes, launch kernels into the mapped tensor and commit with explicit stream or event sync:

```python
mapping = renderer.map_attribute(
    prim_paths,
    "omni:xform",
    dtype="float64",
    shape=(4, 4),
    semantic=Semantic.XFORM_MAT4x4,
    device=Device.CUDA,
    device_id=0,
    prim_mode=PrimMode.CREATE_NEW,
)
mapped_xforms = wp.from_dlpack(mapping.tensor)
# `cuda_stream_handle` must identify the same CUDA stream used by `wp_stream`.
wp.launch(
    fill_offset_xforms_kernel,
    dim=len(prim_paths),
    inputs=[mapped_xforms],
    device="cuda:0",
    stream=wp_stream,
)
unmap_op = mapping.unmap_async(stream=cuda_stream_handle)
unmap_op.wait()
```

`AttributeMapping.unmap_async()` marks the mapping as unmapped immediately and returns an operation for caller-managed completion. Wait before `renderer.step()` if the next frame must show the new transform.

## Per-Path Binding Alternative

If the selected set is sparse and changes often, store one binding per path and keep those handles alive until the scene reloads:

```python
bindings = {
    path: renderer.bind_attribute(
        prim_paths=[path],
        attribute_name="omni:xform",
        dtype="float64",
        shape=(4, 4),
        semantic=Semantic.XFORM_MAT4x4,
        prim_mode=PrimMode.CREATE_NEW,
    )
    for path in prim_paths
}

def _write_offset(path: str, offset: np.ndarray):
    bind = bindings.get(path)
    base = base_xforms.get(path)
    if bind is None or base is None:
        return
    offset_mat = np.eye(4, dtype=np.float64)
    offset_mat[3, 0:3] = offset
    mat = base @ offset_mat
    with bind.map(device=Device.CPU) as mapping:
        np.from_dlpack(mapping.tensor).reshape(1, 4, 4)[0] = mat
```

## Frame Loop

```python
now = time.monotonic()
dt = max(1.0 / 300.0, min(0.1, now - last_step))
last_step = now
if animator is not None:
    animator.update(dt)
products = renderer.step(render_products={RENDER_PRODUCT_PATH}, delta_time=dt)
```

Updating after `step()` renders the previous transform and makes animation lag or appear stuck.

## Selection Lifecycle

```python
def select_prim(path: str):
    if animator is not None:
        animator.deselect_all()
        animator.select(path)

def clear_selection():
    if animator is not None:
        animator.deselect_all()
```

Native picking, tree selection, marquee selection, or scripted selection can all call the same animation methods after they resolve selected prim paths. Native selection outlines and EffectLayer/material effects should be updated by their own managers in parallel.

On rapid select/deselect, record the current offset so falling reverses smoothly
from the current transform state.

## Generated Module Checklist - prim_animation.py

- [ ] `PrimAnimator.__init__(renderer, prim_paths, base_transforms)`
- [ ] `PrimAnimator.select(path: str) -> None`
- [ ] `PrimAnimator.deselect(path: str) -> None`
- [ ] `PrimAnimator.deselect_all() -> None`
- [ ] `PrimAnimator.update(dt: float) -> None`
- [ ] `PrimAnimator.current_offset(path: str) -> np.ndarray`
- [ ] `PrimAnimator.freeze(path: str) -> None` and `PrimAnimator.resume(path: str) -> None` when transform tools can edit animated prims.
- [ ] Base transforms are loaded before binding, using the app's transform-safe query path such as `pxr_worker.get_world_transforms(paths)` when native live attributes are not enough.
- [ ] Attribute bindings are created once for `omni:xform` with `PrimMode.CREATE_NEW`.
- [ ] Newly-created `omni:xform` attributes are initialized from base transforms before the first render step.
- [ ] Writes use `Semantic.XFORM_MAT4x4` semantics when calling `write_attribute`, `bind_attribute`, or `map_attribute`.
- [ ] CPU writes use NumPy/DLPack with `DataAccess.SYNC` or mapped context managers.
- [ ] GPU writes use DLPack tensors plus `DataAccess.ASYNC` and CUDA stream/event synchronization.
- [ ] `AttributeMapping.unmap_async()` operations are waited before the next frame when the frame depends on them.
- [ ] Falling state restores the saved base transform when complete.

See also: `object-selection`, `selection-feedback`, `prim-transform-safety`, `stage-management`, `ovrtx-rendering`.
