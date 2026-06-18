# Native Picking And Selection

## Triggers

Use this skill for native picking, native selection, `enqueue_pick_query_async`, `ovrtx_enqueue_pick_query`, `ovrtx_set_pickable`, `SelectionGroupStyle`, `SelectionFillMode`, `ovrtx_set_selection_outline_group`, click picking, or marquee selection.

Use this as the primary ovrtx 0.3 reference for viewport picking and selection
feedback. It replaces the older segmentation-buffer `GpuPicker`, CPU ray/AABB
fallback, ID mapping, and Warp outline workflows.

For ovrtx picking, selection, path dictionary, or C API behavior beyond this
reference, read `references/dependencies` for acquisition guidance and supplemental
dependency documentation.

## First Rules

- Picking uses native pick queries:
  `Renderer.enqueue_pick_query_async()` in Python and
  `ovrtx_enqueue_pick_query()` in C/C++.
- Pickability uses native pickable attributes/helpers:
  `OVRTX_ATTR_NAME_PICKABLE` in Python and `ovrtx_set_pickable()` in C/C++.
- Selection visuals use native selection groups and renderer styles:
  `SelectionGroupStyle`, `SelectionFillMode`,
  `Renderer.set_selection_group_styles()`,
  `OVRTX_CONFIG_SELECTION_OUTLINE_ENABLED`,
  `ovrtx_set_selection_group_styles()`, and
  `ovrtx_set_selection_outline_group()`.
- EffectLayer material faders are not selection highlighting in this workflow.
- Do not scaffold `GpuPicker`, `cpu_picking.py`, `seg_outline.py`, or Warp
  outline systems in new ovrtx 0.3 apps.

## Renderer Setup

Enable native outlines when the renderer is created:

```python
import ovrtx


config = ovrtx.RendererConfig(
    selection_outline_enabled=True,
    selection_outline_width=4,
    selection_fill_mode=ovrtx.SelectionFillMode.GROUP_FILL_COLOR,
)
renderer = ovrtx.Renderer(config=config)

renderer.set_selection_group_styles({
    1: ovrtx.SelectionGroupStyle(
        outline_color=(1.0, 0.6, 0.0, 1.0),
        fill_color=(0.0, 0.0, 0.0, 0.0),
    )
})
```

In C/C++, use the config entry/key for
`OVRTX_CONFIG_SELECTION_OUTLINE_ENABLED`, the selection outline width and fill
mode config entries, then call `ovrtx_set_selection_group_styles()` for runtime
group colors.

Renderer-level outline enablement, width, and fill mode are creation-time
settings. Recreate the renderer to change them. Group colors are runtime state.

## Pickable Flags

Write pickability whenever the app changes the selectable set:

```python
import numpy as np
import ovrtx


def set_pickable(renderer, prim_paths: list[str], enabled: bool) -> None:
    renderer.write_attribute(
        prim_paths=prim_paths,
        attribute_name=ovrtx.OVRTX_ATTR_NAME_PICKABLE,
        tensor=np.full((len(prim_paths),), 1 if enabled else 0, dtype=np.uint8),
    )
```

C/C++:

```c
ovrtx_set_pickable(renderer, prim_paths, prim_path_count, true);
```

Pickability is separate from selection state. A prim can be pickable without
being selected, and selected paths should be cleared or updated independently
when the selectable set changes.

## Single-Click Pick

Convert UI coordinates to RenderProduct pixels first. Then enqueue a 1x1 native
pick rectangle before the renderer step that should consume it:

```python
def click_pick(renderer, render_product_path: str, x: int, y: int) -> list[str]:
    renderer.enqueue_pick_query_async(
        render_product_path=render_product_path,
        left=x,
        top=y,
        right=x + 1,
        bottom=y + 1,
    )
    products = renderer.step(
        render_products={render_product_path},
        delta_time=1.0 / 60.0,
    )
    with products as ctx:
        frame = ctx[render_product_path].frames[0]
        return decode_pick_paths(renderer, frame)
```

C/C++:

```c
ovrtx_enqueue_pick_query(renderer, render_product_path, left, top, right, bottom, flags);
```

Treat `left` and `top` as inclusive and `right` and `bottom` as exclusive.

## Marquee Selection

Marquee selection is the same API with a larger rectangle:

```python
def marquee_pick(renderer, render_product_path: str, start, end) -> list[str]:
    x0, y0 = start
    x1, y1 = end
    left = min(x0, x1)
    top = min(y0, y1)
    right = max(x0, x1) + 1
    bottom = max(y0, y1) + 1

    renderer.enqueue_pick_query_async(
        render_product_path=render_product_path,
        left=left,
        top=top,
        right=right,
        bottom=bottom,
    )
    products = renderer.step(
        render_products={render_product_path},
        delta_time=1.0 / 60.0,
    )
    with products as ctx:
        frame = ctx[render_product_path].frames[0]
        return decode_pick_paths(renderer, frame)
```

Apply replace/add/subtract selection semantics after the paths are decoded.

## Decode Pick Results

Native pick results arrive as a synthetic render var on the step that consumed
the query:

```python
import numpy as np
import ovrtx


def decode_pick_paths(renderer, frame) -> list[str]:
    if ovrtx.OVRTX_RENDER_VAR_PICK_HIT not in frame.render_vars:
        return []
    pick_var = frame.render_vars[ovrtx.OVRTX_RENDER_VAR_PICK_HIT]

    mapping = pick_var.map(device=ovrtx.Device.CPU)
    try:
        magic = int(np.from_dlpack(mapping.params["magic"]).reshape(-1)[0])
        version = int(np.from_dlpack(mapping.params["version"]).reshape(-1)[0])
        hit_count = int(np.from_dlpack(mapping.params["hitCount"]).reshape(-1)[0])
        prim_path_ids = np.from_dlpack(mapping["primPath"]).copy().reshape(-1)
    finally:
        mapping.unmap()

    if magic != ovrtx.OVRTX_PICK_HIT_MAGIC or version != ovrtx.OVRTX_PICK_HIT_VERSION:
        raise RuntimeError("Unexpected ovrtx pick-hit schema")

    paths = []
    seen = set()
    for prim_path_id in prim_path_ids[:hit_count]:
        path = renderer.resolve_prim_path_id(int(prim_path_id))
        if path and path not in seen:
            paths.append(path)
            seen.add(path)
    return paths
```

Optional hit tensors include `objectType`, `geometryInstanceId`,
`worldPositionM`, and `worldNormal`. Resolve path IDs before displaying,
storing, or broadcasting selection.

## Selection Groups

Assign selected prims to non-zero groups and clear old selection with group `0`:

```python
import numpy as np
import ovrtx


def write_selection_groups(renderer, groups_by_path: dict[str, int]) -> None:
    if not groups_by_path:
        return
    paths = list(groups_by_path)
    groups = np.asarray([groups_by_path[path] for path in paths], dtype=np.uint8)
    renderer.write_attribute(
        prim_paths=paths,
        attribute_name=ovrtx.OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP,
        tensor=groups,
    )
```

C/C++:

```c
ovrtx_set_selection_outline_group(renderer, selected_paths, selected_count, 1);
ovrtx_set_selection_outline_group(renderer, previous_paths, previous_count, 0);
```

Use group IDs consistently across the app:

| Group | Meaning |
|---|---|
| `0` | Cleared / no outline |
| `1` | Primary selection |
| `2` | Secondary selection or marquee preview |
| `3` | Hover, when supported |

## End-To-End Update Pattern

```python
def apply_pick_result(hit_paths: list[str], mode: str = "replace") -> None:
    old_mesh_paths = set(selection.mesh_paths)

    if mode == "add":
        selection.paths = sorted(set(selection.paths) | set(hit_paths))
    elif mode == "subtract":
        selection.paths = sorted(set(selection.paths) - set(hit_paths))
    else:
        selection.paths = list(hit_paths)

    selection.mesh_paths = expand_to_descendant_meshes(selection.paths)

    writes = {path: 0 for path in old_mesh_paths - set(selection.mesh_paths)}
    writes.update({path: 1 for path in selection.mesh_paths})
    write_selection_groups(renderer, writes)

    message_handler.send_message("stageSelectionChanged", {"prims": selection.paths})
```

Tree/sidebar selection should call the same selection-state function as viewport
picking. Keep the selected tree path separate from the expanded mesh paths used
for visual outlines.

## UI Coordinate Contract

- Convert browser CSS pixels, framebuffer pixels, or native window pixels into
  RenderProduct pixels before enqueueing a query.
- For streamed viewers, account for `object-fit: contain` letterboxing.
- For local viewers, account for widget scaling and image placement.
- Reject clicks outside the rendered image unless marquee selection should clamp
  to the image bounds.
- Use a drag threshold so small pointer movement still counts as a click.
- Do not run click selection after an orbit/pan/zoom drag.

## Lifecycle

On scene load or switch:

1. Pause picking while reset/load is in progress.
2. Clear pending pick requests and selected paths.
3. Load the new stage and render product.
4. Reapply pickable flags for the new stage.
5. Reapply selection group styles if the renderer was recreated.
6. Clear stale selection groups with group `0` when previous prim paths are still
   valid; otherwise discard the old runtime set.
7. Resume picking after the render product is producing valid frames.

## Compatibility Paths

`InstanceSegmentationSD` picking, `GpuPicker`, CPU ray/AABB fallback,
`learn_mapping`, isolation discovery, runtime bbox ID repair, and Warp
segmentation outlines are compatibility paths. Keep them only for explicit
compatibility needs or custom post-process overlays. They are not the 0.3 native
path.

## Troubleshooting

- No pick hit: verify the query is enqueued before `renderer.step()` and the
  rectangle is in RenderProduct pixels.
- Wrong object selected: verify letterbox/scaling conversion and click-vs-drag
  handling.
- Sidebar or tree clicks move the camera, pick unexpectedly, or make the video
  appear to jump: gate server `on_input` behind a `setViewportInputActive`
  message from the React shell, disable it for DOM controls, and cancel active
  camera interaction when disabled.
- Video disappears or shifts after selection/property updates: keep the viewport
  container layout-stable with constrained flex/grid tracks, `min-height: 0`,
  `overflow: hidden`, and a pinned `#remote-video` using `object-fit: contain`.
- Empty path string: resolve the path ID and discard empty paths before updating
  selection.
- No outline: verify renderer outline config, group styles, and non-zero
  `omni:selectionOutlineGroup` values.
- Fill color missing: verify `SelectionFillMode.GROUP_FILL_COLOR` or the
  equivalent C fill mode.
- Picking fails on a multi-GPU system: pin the picking RenderProduct to
  CUDA-visible GPU 0 with `deviceIds = [0]`.

See also: `viewer-input-routing`, `object-selection`, `selection-feedback`,
`stage-hierarchy`, `camera-controls`, `streaming-messages`,
`streaming-server`, `local-viewer`, `stage-management`.
