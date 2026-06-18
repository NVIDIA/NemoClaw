# Selection Feedback

## Triggers

Use this skill for highlight selected, selection outline, selection group, SelectionGroupStyle, SelectionFillMode, selection glow, selected object feedback, or outline selected prim.

Use this for renderer-visible feedback after selection. Picking and selected-path
state live in `object-selection`. The combined ovrtx 0.3 API reference is
`native-picking-selection`.

The default selection visual path is native ovrtx selection outlines and styles.
Do not create segmentation/Warp outline systems for new ovrtx 0.3 apps.

For ovrtx selection outline, fill, or C API behavior beyond this reference,
read `references/dependencies` for acquisition guidance and supplemental dependency
documentation.

## Native Selection Model

- Enable the native selection outline pass when creating the renderer.
- Assign non-zero selection group IDs to selected prims.
- Write group `0` to clear a prim.
- Configure outline width and fill mode at renderer creation.
- Configure per-group outline/fill colors at runtime.
- Use transparent fill color when the app wants outlines only.

Python names:

- `ovrtx.RendererConfig(selection_outline_enabled=True)`
- `ovrtx.RendererConfig(selection_outline_width=...)`
- `ovrtx.RendererConfig(selection_fill_mode=ovrtx.SelectionFillMode.GROUP_FILL_COLOR)`
- `ovrtx.SelectionGroupStyle`
- `Renderer.set_selection_group_styles(...)`
- `ovrtx.OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP`

C/C++ names:

- `OVRTX_CONFIG_SELECTION_OUTLINE_ENABLED`
- `ovrtx_config_entry_selection_outline_enabled(true)`
- `ovrtx_config_entry_selection_outline_width(...)`
- `ovrtx_config_entry_selection_fill_mode(...)`
- `ovrtx_set_selection_group_styles(...)`
- `ovrtx_set_selection_outline_group(...)`

## Renderer Setup

```python
import ovrtx


config = ovrtx.RendererConfig(
    selection_outline_enabled=True,
    selection_outline_width=4,
    selection_fill_mode=ovrtx.SelectionFillMode.GROUP_FILL_COLOR,
)
renderer = ovrtx.Renderer(config=config)
```

Changing `selection_outline_enabled`, `selection_outline_width`, or
`selection_fill_mode` requires recreating the renderer. Per-group colors can be
changed while the renderer is running.

## Group Styles

```python
renderer.set_selection_group_styles({
    1: ovrtx.SelectionGroupStyle(
        outline_color=(1.0, 0.6, 0.0, 1.0),
        fill_color=(0.0, 0.0, 0.0, 0.0),
    ),
    2: ovrtx.SelectionGroupStyle(
        outline_color=(0.1, 0.55, 1.0, 1.0),
        fill_color=(0.1, 0.55, 1.0, 0.18),
    ),
})
```

Use stable group IDs for distinct interaction states, for example:

| Group | Use |
|---|---|
| `0` | Unselected / cleared |
| `1` | Primary selection |
| `2` | Secondary or marquee preview |
| `3` | Hover, if the app needs hover feedback |

Later style writes to the same group replace earlier styles for subsequent
frames.

## Assign And Clear Outlines

Python:

```python
import numpy as np
import ovrtx


def set_selection_groups(renderer, group_by_path: dict[str, int]) -> None:
    if not group_by_path:
        return

    paths = list(group_by_path)
    groups = np.asarray([group_by_path[path] for path in paths], dtype=np.uint8)
    renderer.write_attribute(
        prim_paths=paths,
        attribute_name=ovrtx.OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP,
        tensor=groups,
    )
```

C/C++:

```c
// Set selected prims to group 1.
ovrtx_set_selection_outline_group(renderer, selected_paths, selected_count, 1);

// Clear previously selected prims.
ovrtx_set_selection_outline_group(renderer, previous_paths, previous_count, 0);
```

Always clear previous groups that are no longer selected before assigning the
new selection. The renderer displays whatever group value is currently authored
for each prim.

## Update Pattern

```python
class SelectionFeedback:
    PRIMARY_GROUP = 1

    def __init__(self, renderer):
        self._renderer = renderer
        self._outlined_paths: set[str] = set()

    def update(self, selected_mesh_paths: set[str]) -> None:
        selected_mesh_paths = set(selected_mesh_paths)

        clear_paths = self._outlined_paths - selected_mesh_paths
        set_paths = selected_mesh_paths

        writes = {path: 0 for path in clear_paths}
        writes.update({path: self.PRIMARY_GROUP for path in set_paths})
        set_selection_groups(self._renderer, writes)

        self._outlined_paths = selected_mesh_paths

    def clear(self) -> None:
        set_selection_groups(self._renderer, {path: 0 for path in self._outlined_paths})
        self._outlined_paths.clear()
```

Tree selection often targets an Xform or Scope. Use `stage-hierarchy` to expand
that selected item to descendant mesh paths for outline assignment, while keeping
the original selected path for the tree and info panel.

## Fill Mode

Selection fill color is visible only when the renderer was created with a fill
mode that uses group fill colors, such as
`SelectionFillMode.GROUP_FILL_COLOR` /
`OVRTX_SELECTION_FILL_MODE_GROUP_FILL_COLOR`.

For outline-only selection, either use a fill mode that disables filling or keep
each group's `fill_color` alpha at `0.0`.

## Scene Lifecycle

On scene switch, reload, or renderer reset:

- Stop issuing feedback writes while the renderer is resetting.
- Clear the runtime selected path set.
- Clear previous native selection groups by writing group `0` before discarding
  the old selection state when practical.
- Recreate renderer-level outline configuration if the renderer is recreated.
- Reapply default group styles after creating a new renderer.

## Gotchas

- Selection visuals require both renderer config and per-prim non-zero group IDs.
- Group `0` means no native selection outline.
- Per-group style writes are runtime state; keep them in app setup, not in the
  per-frame hot path.
- Fill color does nothing unless the renderer fill mode enables it.
- Outline dashing/stippling is not supported by the native RTX outline pass.
- Do not use `seg-outline-highlight` unless the user explicitly needs a custom
  post-process overlay instead of native selection outlines.

See also: `viewer-input-routing`, `native-picking-selection`,
`object-selection`, `stage-hierarchy`, `stage-management`, `stage-loading`,
`ovrtx-rendering`.

## Generated Module Checklist - selection_feedback.py

- [ ] Renderer is created with native selection outlines enabled.
- [ ] Default `SelectionGroupStyle` values are installed at startup.
- [ ] Selected mesh paths are written to non-zero selection groups.
- [ ] Previously selected mesh paths are cleared with group `0`.
- [ ] Tree-selected Xforms/Scopes are expanded to descendant mesh paths.
- [ ] Renderer recreation reapplies outline config and group styles.
- [ ] No EffectLayer material or fader behavior is implemented in this module.
