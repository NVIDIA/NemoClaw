# Prim Pick Effects

## Triggers

Use this skill for picked prim effect, on pick write attribute, inputs:Fader, EffectLayer, toggle visibility, custom MDL parameter, prim to material map, or selection glow attribute.

Use this when picking a prim should manipulate a USD attribute on that prim or on a related material/shader prim. This skill is for authored/runtime attribute effects. It is additive to native selection outlines; do not replace outline selection with material effects.

## Workflow

1. Resolve picked prim paths through `object-selection` or native ovrtx picking.
2. Update selection outlines through the selection feedback path.
3. Map picked prims to effect targets when needed, such as material shader prims.
4. Compute desired effect state from the complete selected set.
5. Write USD attributes with `renderer.write_attribute()` or persistent bindings.
6. Clear or reset effect attributes on deselect and scene switch.

## Basic Write Pattern

```python
import numpy as np
from ovrtx import DataAccess, PrimMode

renderer.write_attribute(
    prim_paths=[target_prim_path],
    attribute_name="inputs:Fader",
    tensor=np.array([1.0], dtype=np.float32),
    prim_mode=PrimMode.EXISTING_ONLY,
    data_access=DataAccess.SYNC,
)
```

Use `PrimMode.EXISTING_ONLY` when the composite/session layer already authored the attribute. Use `PrimMode.CREATE_NEW` for load-time resets or deliberate app-owned attributes.

For repeated writes to the same target set, bind once after stage load:

```python
binding = renderer.bind_attribute(
    prim_paths=effect_layer_paths,
    attribute_name="inputs:Fader",
    dtype="float32",
    prim_mode=PrimMode.CREATE_NEW,
)
binding.write(np.zeros((len(effect_layer_paths),), dtype=np.float32))
```

## Prim To Material Mapping

A picked mesh often does not own the effect attribute directly. For material-driven effects, build a map from renderable prim path to material or shader target:

```python
prim_to_effect_layer = {
    "/World/Mesh/Tray": "/World/Looks/Steel_Stainless/EffectLayer",
}
```

Until native relationship traversal covers material bindings at the same fidelity, build this map through the `stage-hierarchy` pxr fallback (`get_material_map`) or an equivalent USD query. Native `query_prims()` can still discover candidate shader prims by attributes such as `inputs:Fader`.

## Shared-Material Awareness

Multiple prims can share one material and therefore one effect target. Never turn off a target just because one prim was deselected; recompute active targets from all currently selected prims.

```python
def active_effect_targets(selected_prims: set[str], prim_to_target: dict[str, str]) -> set[str]:
    return {
        target
        for prim in selected_prims
        for target in [prim_to_target.get(prim)]
        if target
    }

def update_pick_effects(selected_prims: set[str]) -> None:
    global active_targets
    next_targets = active_effect_targets(selected_prims, prim_to_effect_layer)

    for path in sorted(next_targets - active_targets):
        write_fader(path, 1.0)
    for path in sorted(active_targets - next_targets):
        write_fader(path, 0.0)

    active_targets = next_targets
```

This same rule applies to custom material parameters, display color ramps, and any shared shader attribute.

## EffectLayer Fader Example

Some stages use EffectLayer shader prims with `float inputs:Fader = 0`
overrides in the composite/session layer. When the active stage exposes that
pattern and the user wants material-driven pick effects, a concrete target shape
is:

```text
/World/.../Looks/<MaterialName>/EffectLayer.inputs:Fader
```

Runtime toggle:

```python
def write_fader(effect_layer_path: str, value: float) -> None:
    renderer.write_attribute(
        prim_paths=[effect_layer_path],
        attribute_name="inputs:Fader",
        tensor=np.array([value], dtype=np.float32),
        prim_mode=PrimMode.EXISTING_ONLY,
    )
```

Load-time reset:

```python
layers = sorted(set(prim_to_effect_layer.values()))
if layers:
    renderer.write_attribute(
        prim_paths=layers,
        attribute_name="inputs:Fader",
        tensor=np.zeros((len(layers),), dtype=np.float32),
        prim_mode=PrimMode.CREATE_NEW,
    )
```

This glow is a pick effect, not the baseline selection signal. Keep native selection outlines enabled so arbitrary scenes still show precise selected-object boundaries when no EffectLayer material exists.

## Visibility Toggle Example

USD visibility is token-like. `write_attribute()` accepts `list[str]` for scalar token strings:

```python
renderer.write_attribute(
    prim_paths=[picked_path],
    attribute_name="visibility",
    tensor=["invisible"],
    prim_mode=PrimMode.EXISTING_ONLY,
)

renderer.write_attribute(
    prim_paths=[picked_path],
    attribute_name="visibility",
    tensor=["inherited"],
    prim_mode=PrimMode.EXISTING_ONLY,
)
```

Use this for explicit hide/show commands, not hover highlighting. Always preserve previous visibility if the effect is temporary.

## Custom MDL Parameter Example

For app-authored materials with known shader inputs, write the input attribute directly:

```python
renderer.write_attribute(
    prim_paths=[shader_path],
    attribute_name="inputs:HoverAmount",
    tensor=np.array([0.65], dtype=np.float32),
    prim_mode=PrimMode.EXISTING_ONLY,
)
```

Only expose controls for attributes that exist in the active stage or are deliberately authored by the viewer. Do not invent renderer-internal attribute names.

## Scene Lifecycle

- Rebuild prim-to-material/effect maps after every scene load, reload, variant change, or material-map invalidation.
- Reset app-owned effect attributes to neutral values on stage load.
- Clear active target state on selection clear and scene switch.
- Serialize writes through the render owner; do not write while `reset_stage()` or scene loading is active.
- Keep effect state separate from selection outline state.

See also: `object-selection`, `selection-feedback`, `stage-queries`, `stage-hierarchy`, `stage-attribute-reads`, `ovrtx-rendering`.
