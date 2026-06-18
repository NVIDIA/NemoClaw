# Stage Queries

## Triggers

Use this skill for query_prims, stage query, find prims, prim type filter, has attribute, AttributeFilterMode, FilterKind, or prim_list_handle.

Use this when an Omniverse Realtime Viewer needs to discover prim paths, build a stage tree, find prims by type, find prims with specific attributes, or inspect attribute schemas before reading or writing.

## Core API

```python
from ovrtx import AttributeFilterMode, FilterKind

result = renderer.query_prims(
    attribute_filter_mode=AttributeFilterMode.NONE,
)
paths = sorted(result.keys())
```

`Renderer.query_prims()` is the synchronous convenience path. `Renderer.query_prims_async()` enqueues the same query and returns an operation:

```python
op = renderer.query_prims_async(
    require_any=[(FilterKind.PRIM_TYPE, "Mesh"), (FilterKind.PRIM_TYPE, "Camera")],
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["omni:xform", "visibility"],
)
pending = op.wait(timeout_ns=5_000_000_000)
if pending is not None:
    result = pending.fetch(timeout_ns=100_000_000)
```

The Python result is `dict[str, dict[str, AttributeInfo]]`: each key is a prim path, and each value is the reported attribute descriptors for that prim.

## Filter Construction

Each filter is a `(kind, name)` tuple:

| Kind | Meaning | Example |
|---|---|---|
| `FilterKind.PRIM_TYPE` | Match USD type name | `"Mesh"`, `"Xform"`, `"Camera"`, `"SphereLight"` |
| `FilterKind.HAS_ATTRIBUTE` | Match attribute presence | `"points"`, `"omni:xform"`, `"visibility"`, `"inputs:Fader"` |

Filter lists combine as:

- `require_all`: AND. The prim must match every filter in this list.
- `require_any`: OR. The prim must match at least one filter in this list.
- `exclude`: NOT. The prim must match none of these filters.

```python
meshes_or_lights_with_visibility = renderer.query_prims(
    require_all=[
        (FilterKind.HAS_ATTRIBUTE, "visibility"),
    ],
    require_any=[
        (FilterKind.PRIM_TYPE, "Mesh"),
        (FilterKind.PRIM_TYPE, "SphereLight"),
        (FilterKind.PRIM_TYPE, "DistantLight"),
    ],
    exclude=[
        (FilterKind.PRIM_TYPE, "Scope"),
        (FilterKind.HAS_ATTRIBUTE, "omni:hidden"),
    ],
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["visibility", "purpose", "omni:xform"],
)
```

Omitted lists impose no constraint. An empty query matches every prim.

## Attribute Reporting

`AttributeFilterMode` controls descriptor payload size:

| Mode | Use |
|---|---|
| `AttributeFilterMode.NONE` | Fast path discovery and prim counts. Per-prim descriptor dicts are empty. |
| `AttributeFilterMode.SPECIFIC` | Inspector allowlists and read/write planning. Only `attribute_names` are reported. |
| `AttributeFilterMode.ALL` | Debugging and rich schema browsing. Avoid for routine data-channel payloads. |

`AttributeInfo` exposes:

- `name`
- `dtype`
- `is_array`
- `semantic`

Use descriptors to choose `read_attribute()` for scalar values or `read_array_attribute()` for variable-length arrays.

```python
query = renderer.query_prims(
    require_all=[(FilterKind.PRIM_TYPE, "Mesh")],
    attribute_filter_mode=AttributeFilterMode.SPECIFIC,
    attribute_names=["points", "faceVertexCounts", "omni:xform"],
)

for path, attrs in query.items():
    if "points" in attrs and attrs["points"].is_array:
        points = renderer.read_array_attribute("points", [path])[path]
```

## Tree Construction

`query_prims()` returns flat paths. Build hierarchy by splitting paths:

```python
def parent_path(path: str) -> str:
    if path == "/" or path.count("/") <= 1:
        return "/"
    return path.rsplit("/", 1)[0]

def child_index(paths: list[str]) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for path in paths:
        if path != "/":
            index.setdefault(parent_path(path), []).append(path)
    for children in index.values():
        children.sort()
    return index
```

Use lazy UI expansion: query once after stage load, cache a parent-to-children index, and only send children for expanded rows.

## `prim_list_handle`

The lower-level C query result groups matching prims by attribute schema. Each `ovrtx_query_prim_group_t` includes a `prim_list_handle` that can be plugged into binding/read/write descriptors, such as `ovrtx_binding_desc_t::prims_list_handle`, to avoid string path round-trips for bulk operations.

Python resolves query groups into a path-keyed dict today, so Python apps should pass `list(result.keys())` or grouped path lists into `read_attribute()`, `write_attribute()`, or `map_attribute()`. C/C++ integrations should preserve `prim_list_handle` while enqueueing follow-up operations, and copy any names needed after `ovrtx_release_query_results()`.

## Gotchas

- Query filters match type names and attribute names, not path substrings.
- `AttributeFilterMode.SPECIFIC` with no `attribute_names` reports no descriptors.
- Query result attribute descriptors describe schema; they do not read values. Use `stage-attribute-reads` for values.
- Relationship-like values may surface as path IDs or token IDs; use pxr fallback for readable relationship target inspection until native relationship traversal is complete.
- Keep stage load/reset and query integration serialized through the render owner.

See also: `stage-attribute-reads`, `stage-hierarchy`, `prim-info-display`, `prim-pick-effects`, `ovrtx-rendering`.
