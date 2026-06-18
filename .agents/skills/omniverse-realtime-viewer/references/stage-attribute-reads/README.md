# Stage Attribute Reads

## Triggers

Use this skill for requests mentioning `read_attribute`, `read_array_attribute`, attribute reads, USD attribute values, DLPack, GPU destinations, `read_attribute_async`, or array attributes.

Use this when inspector panels, query services, or effects need current runtime attribute values from ovrtx 0.3.

For ovrtx attribute query behavior, DLPack behavior, or release-specific read
APIs not covered here, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

## Choose The Read API

| API | Shape | Use |
|---|---|---|
| `Renderer.read_attribute()` | One value per prim | Scalar, vector, matrix, token/path-id-like values. |
| `Renderer.read_array_attribute()` | Variable-length tensor per prim | Arrays such as `points`, `normals`, `faceVertexCounts`. |
| `Renderer.read_attribute_async()` | One value per prim, non-blocking enqueue | Avoid blocking message/input callbacks. |
| `Renderer.read_array_attribute_async()` | Variable-length arrays, non-blocking enqueue | Large mesh arrays or background inspector reads. |

Use `stage-queries` first when you do not know whether an attribute exists or whether it is scalar or array.

## Scalar Reads

`read_attribute()` returns a DLPack-compatible tensor with one value per prim:

```python
import numpy as np

paths = ["/World/Cube"]
tensor = renderer.read_attribute("omni:xform", paths)
xforms = np.from_dlpack(tensor).reshape(len(paths), 4, 4)
```

For scalar numeric or matrix inspector fields, convert to a JSON-safe copy before sending over a data channel:

```python
def read_json_scalar(renderer, attr_name: str, paths: list[str]):
    tensor = renderer.read_attribute(attr_name, paths)
    return np.from_dlpack(tensor).copy().tolist()
```

## Array Reads

`read_array_attribute()` returns a dict keyed by prim path. Each value is a DLPack-compatible tensor, and lengths may differ per prim:

```python
arrays = renderer.read_array_attribute("points", ["/World/MeshA", "/World/MeshB"])
for path, tensor in arrays.items():
    points = np.from_dlpack(tensor)
    preview = points[:1000].copy().tolist()
```

Use arrays for geometry payloads only when the UI truly needs them. For most inspectors, report counts, dtype, shape, and a capped preview.

## GPU Destinations

`read_attribute()` accepts a preallocated DLPack-compatible `dest`. This supports GPU reads without staging through CPU memory:

```python
import warp as wp

paths = ["/World/Cube", "/World/Sphere"]
dest = wp.empty((len(paths), 4, 4), dtype=wp.float64, device="cuda:0")

tensor = renderer.read_attribute(
    "omni:xform",
    paths,
    dest=dest,
    cuda_stream=cuda_stream_handle,
)
xforms = wp.from_dlpack(tensor)
```

When `cuda_stream` is provided, ovrtx coordinates with that stream before and after writing `dest`, and forwards the stream to the DLPack producer where supported. If no stream/event is provided, the caller must ensure `dest` is ready before the read and must synchronize before consuming it elsewhere.

Use `cuda_event` when the read should wait on a CUDA event before writing into `dest`:

```python
tensor = renderer.read_attribute(
    "inputs:Fader",
    [effect_layer_path],
    dest=dest,
    cuda_event=cuda_event_handle,
)
```

`read_array_attribute()` does not take `dest`; it allocates one returned tensor per prim.

## Async Flow

Async reads use the operation plus pending-fetch pattern:

```python
op = renderer.read_attribute_async("omni:xform", paths)
pending = op.wait(timeout_ns=5_000_000_000)
if pending is None:
    return None

tensor = pending.fetch(timeout_ns=100_000_000)
if tensor is None:
    return None

xforms = np.from_dlpack(tensor).copy()
```

Array async reads follow the same lifecycle:

```python
op = renderer.read_array_attribute_async("points", mesh_paths)
pending = op.wait(timeout_ns=5_000_000_000)
arrays = pending.fetch(timeout_ns=100_000_000) if pending is not None else None
```

Do not access the value until both `wait()` and `fetch()` have succeeded.

## Inspector Pattern

```python
from ovrtx import AttributeFilterMode

def inspect_attrs(renderer, path: str, names: list[str]) -> dict:
    descriptors = renderer.query_prims(
        attribute_filter_mode=AttributeFilterMode.SPECIFIC,
        attribute_names=names,
    ).get(path, {})

    values = {}
    for name, desc in descriptors.items():
        if desc.is_array:
            tensor = renderer.read_array_attribute(name, [path])[path]
            values[name] = np.from_dlpack(tensor)[:1000].copy().tolist()
        else:
            tensor = renderer.read_attribute(name, [path])
            values[name] = np.from_dlpack(tensor).copy().tolist()
    return values
```

Keep pxr fallback for variant sets, relationship targets, and USD metadata until native APIs expose those fields directly as user-readable values.

## Gotchas

- Native reads return runtime attribute values; they do not replace USD composition services such as variant-set editing.
- `read_attribute()` is for scalar attributes: one fixed-shape value per prim.
- `read_array_attribute()` is for variable-length arrays and returns a dict, not a stacked tensor.
- Keep DLPack-backed views scoped. Take `.copy()` before storing values beyond the mapping/tensor lifetime or sending them to another thread.
- For GPU `dest`, keep the destination tensor alive until the read completes and any consumer has synchronized.
- Query descriptors first when a missing attribute would otherwise become an exception path in UI code.

See also: `stage-queries`, `stage-hierarchy`, `prim-info-display`, `ovrtx-rendering`.
