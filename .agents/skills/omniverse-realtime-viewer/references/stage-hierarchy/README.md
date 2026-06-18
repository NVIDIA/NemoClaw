# Stage Hierarchy

## Triggers

Use this skill for scene tree, stage hierarchy, prim tree, get children, USD properties, variants, bounding box, pxr worker, query_prims, or inspect stage.

Use this for USD data queries that support trees, info panels, variants, camera fitting, and selection expansion.

This is also the canonical pattern for USD-data-to-frontend messaging in this
repo. The hierarchy view is the worked example, but the same subprocess
isolation, JSON-lines protocol, value normalization, and prim-path round trip
discipline apply to properties, variants, metadata, material relationships,
bounds, and future USD query features.

## Native Stage Query Path

For ovrtx 0.3, use `Renderer.query_prims()` / `Renderer.query_prims_async()` as the first path for runtime prim discovery, hierarchy rows, prim type filtering, and attribute-schema inspection. This avoids opening a second USD stage for common tree and inspector work.

```python
from ovrtx import AttributeFilterMode, FilterKind

result = renderer.query_prims(
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["visibility", "purpose", "omni:xform"],
)

for prim_path, attrs in result.items():
    row = {
        "name": prim_path.rsplit("/", 1)[-1] or "/",
        "path": prim_path,
        "type": classify_from_attrs_or_path(attrs, prim_path),
        "children": False,
    }
```

An empty filter matches every prim. Pair it with `AttributeFilterMode.NONE` for the cheapest full-stage path list:

```python
all_prims = renderer.query_prims(attribute_filter_mode=AttributeFilterMode.NONE)
paths = sorted(all_prims.keys())
```

### AND / OR / NOT Filters

Filters are `(FilterKind, name)` tuples:

- `FilterKind.PRIM_TYPE` matches the USD type name, such as `"Mesh"`, `"Camera"`, or `"SphereLight"`.
- `FilterKind.HAS_ATTRIBUTE` matches prims that expose an attribute, such as `"points"`, `"visibility"`, or `"inputs:Fader"`.

The filter lists combine as `require_all` AND, `require_any` OR, and `exclude` NOT:

```python
mesh_or_camera_with_visibility = renderer.query_prims(
    require_all=[
        (FilterKind.HAS_ATTRIBUTE, "visibility"),
    ],
    require_any=[
        (FilterKind.PRIM_TYPE, "Mesh"),
        (FilterKind.PRIM_TYPE, "Camera"),
    ],
    exclude=[
        (FilterKind.PRIM_TYPE, "Scope"),
        (FilterKind.HAS_ATTRIBUTE, "omni:hidden"),
    ],
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["visibility", "omni:xform"],
)
```

Use `AttributeFilterMode.ALL` only for debugging or rich schema views; it can produce large payloads on production scenes. Use `SPECIFIC` for inspector panels and `NONE` for tree path discovery.

### Async Queries

Use async queries when a request should not block the render/input callback that received it:

```python
op = renderer.query_prims_async(
    require_any=[
        (FilterKind.PRIM_TYPE, "Mesh"),
        (FilterKind.PRIM_TYPE, "Xform"),
    ],
    attribute_filter_mode=AttributeFilterMode.NONE,
)
pending = op.wait(timeout_ns=5_000_000_000)
if pending is not None:
    result = pending.fetch(timeout_ns=100_000_000)
```

Keep `renderer.step()`, scene reset/load, and query result integration serialized through the render owner. Do not query while another thread is resetting the stage.

### `prim_list_handle` Use

The C query result is grouped by shared attribute schema. Each `ovrtx_query_prim_group_t` includes:

- `prim_count`
- `attributes`
- `prim_list_handle`

`prim_list_handle` is a renderer-owned prim-list handle that can be supplied to lower-level binding/read/write descriptors, such as `ovrtx_binding_desc_t::prims_list_handle`, so native code can bulk read or write a whole query group without converting every prim path back to strings.

The Python wrapper currently resolves query groups into `dict[str, dict[str, AttributeInfo]]`, keyed by prim path. For Python code, pass the returned path keys to `read_attribute()`, `read_array_attribute()`, `write_attribute()`, or `map_attribute()`. For C/C++ integrations, preserve the query group and its `prim_list_handle` until all dependent reads or writes are enqueued, and copy any strings you need before releasing C query results.

### Native Tree Construction

`query_prims()` returns paths, not a nested child API. Build lazy tree rows by deriving parent paths:

```python
def parent_path(path: str) -> str:
    if path == "/" or path.count("/") <= 1:
        return "/"
    return path.rsplit("/", 1)[0]

def build_child_index(paths: list[str]) -> dict[str, list[str]]:
    children: dict[str, list[str]] = {}
    for path in paths:
        if path == "/":
            continue
        children.setdefault(parent_path(path), []).append(path)
    for rows in children.values():
        rows.sort()
    return children
```

Native hierarchy rows should include `name`, `path`, `type` when known from query filters or reported attributes, and `children` / `hasChildren` derived from the child index. Use `get_root_prim_path` logic below, but derive it from the native path list when possible.

## pxr Worker Fallback

`pxr_worker.py` is now a fallback for capabilities that native ovrtx 0.3 queries and attribute reads do not fully cover: variant sets, rich USD metadata, and relationship targets such as material bindings. Do not use it as the default hierarchy or scalar-attribute path.

Direct `pxr` import requires import discipline:

```python
import os
os.environ["OVRTX_SKIP_USD_CHECK"] = "1"
from ovrtx import Renderer, RendererConfig
renderer = Renderer(config=RendererConfig(sync_mode=True))
from pxr import Usd, UsdGeom, Sdf, Gf
```

On Windows or when avoiding USD DLL conflicts, run `pxr_worker.py` in a separate Python process with `usd-core` only. The main ovrtx process communicates over JSON lines. `--usd-subprocess auto` means subprocess on Windows and direct on Linux; `on` always uses subprocess; `off` always imports directly.

The tested server uses `pxr_worker.py` and an embedded `PxrWorkerClient` in `ov_web_viewer_server.py` for the fallback commands below. Older `usd_worker.py` and `usd_query_client.py` remain as reference only.

## Fallback pxr Queries

```python
stage = Usd.Stage.Open("/path/to/scene.usd")
root = stage.GetPseudoRoot()

def classify_prim_type(prim):
    if prim.IsA(UsdGeom.Camera):
        return "camera"
    if prim.IsA(UsdGeom.Gprim):
        return "geom"
    if prim.IsA(UsdGeom.Scope):
        return "scope"
    if "Light" in prim.GetTypeName():
        return "light"
    return "xform"

prim = stage.GetPrimAtPath("/World")
for child in prim.GetChildren():
    item = {
        "name": child.GetName(),
        "path": str(child.GetPath()),
        "type": classify_prim_type(child),
        "children": bool(child.GetChildren()),
    }
```

Lazy tree loading returns immediate children first, then expands individual nodes on request. A custom recursive `VStack` is often easier than `ui.TreeView` for local lightweight apps: store `expanded` and `selected_path`, render 24 px rows, and paint selected rows green. Use `ovui.stage.widget.stage_widget.StageWidget` only when editor features such as filtering or drag/drop are required.

## Root Prim Detection

Never hardcode `/World` as the hierarchy root. Different USD assets use different root prims; for example, some large sample scenes use `/stage`.

With native query results, use this order:

1. `/World` when it exists.
2. The loaded stage's default prim when a fallback pxr query is already available.
3. The first pseudo-root child that is not a viewer/session/render prim.

For a native-only tree, derive pseudo-root children from the path list:

```python
def detect_root_prim_path_from_paths(paths: set[str]) -> str:
    if "/World" in paths:
        return "/World"
    skip_names = {"Session", "Render"}
    roots = sorted(path for path in paths if path.count("/") == 1 and path != "/")
    for path in roots:
        name = path.rsplit("/", 1)[-1]
        if name in skip_names:
            continue
        return path
    return "/"
```

When pxr fallback is already active for variants or metadata, preserve the default-prim-aware order:

```python
def detect_root_prim_path(stage: Usd.Stage) -> str:
    world = stage.GetPrimAtPath("/World")
    if world and world.IsValid():
        return "/World"

    default_prim = stage.GetDefaultPrim()
    if default_prim and default_prim.IsValid():
        return str(default_prim.GetPath())

    skip_names = {"Session", "Render"}
    skip_types = {"RenderSettings", "RenderProduct", "RenderVar"}
    for child in stage.GetPseudoRoot().GetChildren():
        if child.GetName() in skip_names:
            continue
        if child.GetTypeName() in skip_types:
            continue
        return str(child.GetPath())

    return "/"
```

Return this path as `root_prim_path` in stage-open responses. Frontend tree initialization, `getChildrenRequest`, descendant mesh expansion, and `makePrimsSelectable` should use `root_prim_path` instead of `/World`.

## Properties

Prefer native attribute reads for scalar/tensor inspector data. Use `query_prims()` with `AttributeFilterMode.SPECIFIC` to confirm an attribute exists and discover its `AttributeInfo`, then call `read_attribute()` or `read_array_attribute()` from `stage-attribute-reads`.

```python
from ovrtx import AttributeFilterMode, FilterKind

result = renderer.query_prims(
    require_all=[(FilterKind.HAS_ATTRIBUTE, "omni:xform")],
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["omni:xform", "visibility", "purpose"],
)
if "/World/Cube" in result:
    xform_tensor = renderer.read_attribute("omni:xform", ["/World/Cube"])
```

Use the pxr fallback only for property categories that still need USD composition services or string target resolution, such as variant sets, metadata, and relationships:

```python
prim = stage.GetPrimAtPath("/World/Cube")
props = {}
for attr in prim.GetAttributes():
    props[attr.GetName()] = serialize_value(attr.Get())
```

Include type name, visibility, purpose, transform values, material binding, and variants when building selected-prim info. Native reads should supply numeric/tensor attribute values; pxr should fill variant sets, rich metadata, and relationship targets until native APIs cover those at the same fidelity.

## Variants

```python
vsets = prim.GetVariantSets()
for set_name in vsets.GetNames():
    vs = vsets.GetVariantSet(set_name)
    options = vs.GetVariantNames()
    current = vs.GetVariantSelection()
vs = vsets.GetVariantSet("color")
vs.SetVariantSelection("blue")
```

Changing a variant recomposes the stage; refresh children/properties under that prim and any selectable-path or material maps that may have changed.

## Type Filtering And Mesh Expansion

```python
if prim.IsA(UsdGeom.Gprim) or prim.IsA(UsdGeom.Xform):
    pass
for desc in Usd.PrimRange(prim):
    if desc.IsA(UsdGeom.Gprim):
        mesh_paths.append(str(desc.GetPath()))
```

Use descendant mesh expansion when a selected tree path is an Xform or Scope but highlight/picking needs concrete mesh paths.

## Bounding Boxes

```python
bbox_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ["default", "render"])
bbox = bbox_cache.ComputeWorldBound(stage.GetPseudoRoot())
rng = bbox.ComputeAlignedRange()
if not rng.IsEmpty():
    center = rng.GetMidpoint()
    size = rng.GetSize()
    max_dim = max(size[0], size[1], size[2])
```

Use this for camera fitting and floating prim-info anchors.

## JSON Serialization

USD values are not JSON-safe by default:

| pxr type | JSON |
|---|---|
| bool/int/float/str/token | primitive/string |
| `Gf.Vec2/3/4*` | list |
| `Gf.Matrix4*` | four row arrays |
| `Gf.Quat*` | `{real, imaginary}` |
| `Sdf.AssetPath` | resolved path or raw path |
| `Vt.Array` | `{length, preview, truncated}` for inspector/data-channel responses; full list only for explicit export/debug paths |
| unknown | `str(value)` |

```python
def serialize_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (Gf.Vec3f, Gf.Vec3d, Gf.Vec3i)):
        return list(value)
    if isinstance(value, (Gf.Matrix4d, Gf.Matrix4f)):
        return [list(value.GetRow(i)) for i in range(4)]
    if isinstance(value, (Gf.Quatf, Gf.Quatd)):
        return {"real": float(value.GetReal()), "imaginary": list(value.GetImaginary())}
    if isinstance(value, Sdf.AssetPath):
        return value.resolvedPath or value.path
    if hasattr(value, "__len__") and hasattr(value, "__getitem__"):
        return [serialize_value(v) for v in value[:1000]]
    return str(value)
```

## Fallback Subprocess Protocol

Detailed fallback subprocess and worker command guidance lives in `fallback-worker-protocol.md`.

## Frontend Normalization

The current pxr worker returns child rows with `children: bool` as expandability metadata:

```json
{"ok":true,"children":[{"name":"Mesh","path":"/World/Mesh","children":true,"type":"xform"}]}
```

React tree components commonly use `hasChildren` for expandability and reserve `children` for loaded child arrays. Normalize server rows before storing them in frontend state, or make the server emit both fields:

```typescript
type ServerPrim = {
  name: string;
  path: string;
  type?: PrimType;
  children?: boolean | USDPrim[] | null;
  has_children?: boolean;
  hasChildren?: boolean;
};

function normalizePrim(prim: ServerPrim): USDPrim {
  const loadedChildren = Array.isArray(prim.children)
    ? prim.children.map(normalizePrim)
    : undefined;
  const hasChildren = Array.isArray(prim.children)
    ? prim.children.length > 0 || Boolean(prim.hasChildren ?? prim.has_children)
    : Boolean(prim.hasChildren ?? prim.has_children ?? prim.children);
  return {
    name: prim.name,
    path: prim.path,
    type: prim.type,
    hasChildren,
    children: loadedChildren ?? null,
  };
}
```

## Frontend Contract

Requests: `openStageRequest`, `getChildrenRequest`, `getPropertiesRequest`, `getVariantsRequest`, `setVariantRequest`, `selectPrimsRequest`, `makePrimsPickable`, `resetStage`, and `loadingStateQuery`. Responses are documented in `streaming-messages`; note exact `getChildrenResult` vs older `getChildrenResponse` naming before editing.

## Native Query Coverage

Native ovrtx 0.3 covers prim discovery, prim-type filters, attribute-presence filters, attribute schema descriptors, scalar reads, array reads, live writes, and mapped writes. Keep `usd-core`/pxr isolated to the fallback categories above. Revisit this split when native APIs expose variant sets, rich metadata, and relationship target traversal at the same level.

## Generated Module Checklist - pxr_worker.py

Use this checklist only when the app still needs fallback pxr coverage. Do not build the main hierarchy tree through the worker when `query_prims()` is sufficient.

- [ ] `cmd_load(path) -> dict`
- [ ] `cmd_get_bbox() -> dict`
- [ ] `cmd_get_children(path, filters=None) -> dict`
- [ ] `cmd_get_root_prim_path() -> dict`
- [ ] `cmd_get_prim_count() -> dict`
- [ ] `cmd_get_properties(path) -> dict`
- [ ] `cmd_get_variants(path) -> dict`
- [ ] `cmd_set_variant(path, variant_set, variant_selection) -> dict`
- [ ] `cmd_get_pickable_bboxes(paths=None) -> dict`
- [ ] `cmd_get_material_map() -> dict`
- [ ] `cmd_get_world_transforms(paths=None) -> dict`
- [ ] `_HANDLERS["get_world_transforms"]`, not `get_base_transforms`
- [ ] Responses use `bboxes`, `material_map`, and `transforms` dictionaries keyed by prim path.

## Generated Module Checklist - PxrWorkerClient

- [ ] `start() -> None`
- [ ] `stop() -> None`
- [ ] `load_stage(path: str) -> bool`
- [ ] `get_children(path: str, filters: list[str] | None = None) -> list[dict]`
- [ ] `get_properties(path: str) -> dict`
- [ ] `get_variants(path: str) -> dict`
- [ ] `set_variant(path: str, variant_set: str, variant_selection: str) -> bool`
- [ ] `get_root_prim_path() -> str`
- [ ] `get_prim_count() -> int`
- [ ] `get_pickable_bboxes(paths: list[str] | None = None) -> dict[str, dict]`
- [ ] `get_material_map() -> dict[str, str]`
- [ ] `get_world_transforms(paths: list[str] | None = None) -> dict[str, list[list[float]]]`

See also: `prim-info-display`, `stage-management`, `camera-controls`, `streaming-messages`, `windows-native-setup`.

## Adding This To An Existing Omniverse Realtime Viewer

- Add `server/stage_queries.py` around native `query_prims()` for hierarchy and schema discovery.
- Add `stage-attribute-reads` helpers for native scalar and array property reads.
- Add `pxr_worker.py` only when the app needs variants, rich metadata, or relationship target resolution.
- Keep server state for the active query stage, root children, and expanded-node cache.
- Add `getChildrenRequest` -> `getChildrenResult` routing for lazy tree expansion.
- Add `getPropertiesRequest` -> `getPropertiesResponse` when prim info panels need property payloads.
- Add `getVariantsRequest`, `getVariantsResponse`, and `setVariantRequest` when variants are editable.
- Open or refresh the query stage whenever `stage-management` loads, reloads, or resets a scene.
- Frontend wires a `StageTree` component to request children on expand and selection on row click.
- Selection features use hierarchy queries for descendant mesh expansion and selectable path lists.
- Variant changes should refresh affected children, properties, selectable-path maps, material maps, and selection state.
- Clear hierarchy caches on scene switch and keep slow USD queries out of ovstream callback threads.
