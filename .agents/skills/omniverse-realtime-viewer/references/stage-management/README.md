# Stage Management

## Triggers

Use this skill for switch scenes, load another file, change USD, asset browser, scene dropdown, persist across scenes, or reload stage.

Use this skill when the Omniverse Realtime Viewer needs multiple USD files, stage reload, reset, additive composition, or state that survives scene changes.

## Asset Discovery

Populate scene selectors from one of these sources:

- Local samples directory: scan for `.usd`, `.usda`, and `.usdc`; display basename, store absolute path.
- Cloud/cache source: resolve through `cloud-assets`, then list cached local files.
- User-provided path: validate with `Usd.Stage.Open()` for metadata queries before handing it to ovrtx.

Keep UI labels separate from load paths. Relative USD asset references require the stage file to remain in its original directory or in a cache preserving directory structure.

## Initial Stage Agreement

The server and frontend must agree on the initial stage. If the server starts with a stage already loaded, `push_initial_state()` should send `openStageResult` with the current stage URL and the frontend should accept that as authoritative. Do not let a frontend `useEffect([status])` blindly send `openStageRequest` for the dropdown default after every WebRTC reconnect; that can override the server-loaded stage.

If the frontend still sends an initial `openStageRequest`, the server must compare it with the already-loaded stage and return success immediately when they match.

```python
def same_stage(requested: str, current: str | None) -> bool:
    return bool(current) and os.path.normpath(requested) == os.path.normpath(current)
```

Skipping redundant reloads prevents unnecessary render interruption, CUDA context resets, long shader recompilation, and possible WebRTC disconnects.

## Stage Composition Policy

In ovrtx 0.3, stage replacement and additive composition are separate operations:

- Use `renderer.open_usd(path)` to replace the active root layer with a file/URL-backed stage.
- Use `renderer.open_usd_from_string(usda)` to replace the active root layer with generated viewer/session USDA, commonly an inline root that sublayers the user scene.
- Use `renderer.add_usd_reference(path, prefix_path="/SomePrim")` or `renderer.add_usd_reference_from_string(usda, prefix_path="/SomePrim")` only for additive content under a unique prim path. Keep the returned handle and call `renderer.remove_usd(handle)` to remove it.
- Use `renderer.reset_stage()` only to intentionally clear the renderer to an empty stage. It is not part of normal scene switching because `open_usd*` replaces the current root layer.

## Hot-Swap Sequence

Run stage switching on the UI/render thread unless you have a dedicated loading worker. Do not call `renderer.step()` while `open_usd*`, `add_usd_reference*`, `remove_usd()`, or `reset_stage()` is active.

```python
def switch_scene(path: str):
    selection.clear()
    info_panel.hide()
    tree.reset()
    animator = None

    stage = Usd.Stage.Open(path)              # hierarchy, bbox, material map
    camera_state = camera.snapshot()          # preserve if requested
    settings_state = settings.to_dict()

    # Replace-root load. path_or_composite(path) may be the user USD or
    # a generated wrapper USDA that sublayers the user USD and authors viewer prims.
    renderer.open_usd(path_or_composite(path))

    reset_effect_layer_faders(renderer, stage)
    material_map = build_prim_material_map(stage)
    picker.rebuild(stage)
    animator = build_animator(renderer, stage, pickable_paths)
    tree.attach_stage(stage)

    settings.apply(settings_state, renderer, stage)
    camera.restore_or_fit(camera_state, stage)
```

For generated viewer/session USDA that should not be written to disk:

```python
renderer.open_usd_from_string(make_viewer_root_usda(path, width, height))
```

For additive scene content:

```python
handle = renderer.add_usd_reference(asset_path, prefix_path="/Runtime/Assets/Asset_001")
# Later:
renderer.remove_usd(handle)
```

## Async Operations

Python `open_usd()` / `open_usd_from_string()` are blocking convenience calls. Use the `_async` variants for non-blocking loads and poll the returned `Operation` from the render/runtime owner:

```python
op = renderer.open_usd_async(path_or_composite(path))
while True:
    status = op.query_status()
    if status.done:
        break
    if status.failed:
        raise RuntimeError(status.error)
    stream_last_good_frame()

op.wait()
```

Apply the same pattern to async reset and reference operations. For two-phase query operations such as `query_prims_async(...)`, wait for the `Operation` first, then call `.fetch()` on the returned pending fetch/result object before reading dictionaries.

Do not treat an async enqueue or a C return value as proof that the stage is loaded. Poll/query or wait for completion before rebuilding pick maps, hierarchy, material maps, animation bindings, or before reporting `openStageResult: success`.

## Dynamic Root Prim

Never hardcode `/World` as the scene root. Many NVIDIA samples use `/World`, but other USD assets may use a different root such as `/stage`. Detect the root when opening the stage and pass it through stage-load state.

Root detection order:

1. Use `/World` when it exists.
2. Fall back to `stage.GetDefaultPrim()`.
3. Fall back to the first pseudo-root child that is not a viewer/session/render prim.

Include `root_prim_path` in `openStageResult` so the frontend knows where to start hierarchy queries. The stage tree, child queries, selection expansion, and `makePrimsSelectable` flow must use this dynamic root instead of a hardcoded `/World`.

## Preserve Camera

Use a policy, not an accident:

- `preserve`: keep azimuth/elevation/distance/target across stages.
- `fit`: compute bbox and frame the new scene.
- `stage-camera`: use the first authored camera if available, then fall back to bbox fit.

Camera state should be sanitized after restore. If a target or distance is non-finite, fall back to bbox center and a positive distance.

## Preserve Settings

Validated render settings and non-live profile defaults belong to app state, not the USD asset unless the user asks to author the file. Save settings JSON and re-apply only settings with a verified apply path after every replace-root `open_usd*` load and after additive composition changes that affect render settings.

```python
settings = RenderSettings.load("viewer_settings.json")
settings.apply_validated_settings(session_layer)
settings.save("viewer_settings.json")
```

Use `render-settings` for the schema and lighting controls.

## Reset, Reload, And Remove

`resetStageRequest` should reload the current scene from its source with `open_usd()` or `open_usd_from_string()` and a scene-manager `force=True` flag, then rebuild all derived state: hierarchy, pick buffers, material map, selection feedback, animator base transforms, and info panel state. It does not need a response in the existing protocol, but local UI should visually clear selection immediately.

Use `renderer.reset_stage()` only for an explicit "clear scene" or shutdown/cleanup flow where the renderer should have no root layer. A reload of the current scene is not a clear; it is another replace-root load.

For additive references, remove only the handle returned by `add_usd_reference*`. Do not call `reset_stage()` to remove one additive asset unless the intended result is to discard the entire root stage and every reference.

## Stage Switch Side Effects

After each new stage load:

- Write all EffectLayer shader `inputs:Fader` values to `0`.
- Render at least two frames before trusting any display/debug segmentation AOV.
- Recompute pickable bbox data and descendant mesh expansion maps.
- Rebuild the stage tree/sidebar under `/World` or the pseudo-root.
- Refit or restore camera before the next visible frame.
- Recreate `PrimAnimator`; do not reuse old bound attributes across replace-root loads or renderer stage resets.

## Failure Modes

- Scene appears textureless after switching: composite/cache path broke relative asset resolution.
- Highlight starts glowing before selection: EffectLayer Faders were not reset after reload.
- Picks return old prims: cached pick/path IDs survived a scene reload; clear ID maps and resolve new IDs through the current renderer path dictionary.
- Camera inside geometry: preserved distance/target does not fit the new scene; use bbox fit.
- Crash or hang on switch: `renderer.step()` ran concurrently with stage mutation.
- Success reported too early: async `Operation` was enqueued but not completed; poll `query_status()` or wait before rebuilding derived state.
- Wrong stage after reconnect: frontend requested its dropdown default instead of accepting the server's current stage from initial state.
- Long reload of the same scene: missing normalized-path check before starting a reload.
- Empty or wrong hierarchy for valid assets: code assumed `/World` even though the loaded stage used another root prim.

See also: `stage-loading`, `camera-controls`, `render-settings`, `object-selection`, `selection-feedback`, `selection-animation`, `stage-hierarchy`, `cloud-assets`.

## Adding This To An Existing Omniverse Realtime Viewer

- Add `server/scene_manager.py` or equivalent ownership around scene discovery, load, reset, and reload.
- Keep server state for current URL, loading state, hierarchy root, selection, camera policy, and settings snapshot.
- Add messages for `openStageRequest`, `openStageResult`, `resetStageRequest`, `loadingStateQuery`, and `loadingStateResponse`.
- Route all stage mutations through the render/runtime thread that owns ovrtx.
- Modify `scene_loader.py` to rebuild viewer camera, RenderProduct, RenderVars, and optional wrapper files or inline root USDA per scene.
- Reapply validated render settings and camera policy after each load before the first visible frame.
- Clear selection, pick maps, info panels, hierarchy caches, highlight faders, and animation bindings on switch.
- Frontend wires a scene picker or asset browser to `openStageRequest` and displays load/error state from responses.
- Persist cross-scene settings in an app JSON file, not in user USD assets.
- Push current scene, loading state, settings, selection, and root hierarchy to newly connected clients.
