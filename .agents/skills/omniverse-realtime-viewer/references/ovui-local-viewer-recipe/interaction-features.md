# ovui Local Interaction Features

## 7. Add Camera Controls

Read `references/viewer-input-routing` first for ovui button normalization,
click-vs-drag dispatch, and input/render-loop ownership. Then implement camera
math in `local_app/input_controller.py` and `local_app/camera_controller.py`:

- Track mouse press, movement, release, buttons, wheel, keyboard modifiers, viewport dimensions, and drag threshold state from ovui callbacks.
- Convert ovui screen coordinates into render-image coordinates, accounting for widget position, preserve-aspect scaling, and letterboxing.
- Use drag thresholding so a short left press/release selects and a left drag orbits.
- Support orbit, pan, dolly/zoom, wheel zoom, fit-to-stage, and optional WASD fly mode when requested.
- If selected-prim transform is enabled, test transform-gizmo presses before normal left-drag orbit and before click selection.
- Sanitize camera state before input handling and before writing matrices.
- Write the viewer camera transform to the camera prim through ovrtx live attributes.

Critical contracts:

- The camera is a USD prim. Camera movement writes `omni:xform` on the viewer camera path.
- Use the row-vector matrix layout expected by USD/ovrtx: basis vectors in rows and translation in the final row.
- Clamp elevation away from straight up/down singularities.
- Clamp camera distance above a small positive minimum.
- Skip camera writes when any matrix value is non-finite.
- Use the same world-up convention as the scene when fitting and orbiting.
- Left-click selection fires only on release if movement stayed below the drag threshold.
- A transform-gizmo mouse-down owns the full gesture until release; it suppresses camera orbit and click-pick for that mouse-down.
- Map ovui button IDs to the camera helper's expected button IDs before interpreting gestures.

Decision points:

- If the user wants simple navigation, use left drag orbit, middle drag pan, right drag dolly, and wheel zoom.
- If the user wants DCC-style navigation, use Alt+left for orbit, Alt+middle for pan, and Alt+right for dolly while preserving left-click selection.
- If the stage has an authored camera and the app policy is to use it, initialize viewer camera settings from that camera before allowing interaction.
- If the user requests camera UI buttons, wire them to local runtime commands rather than duplicating pointer gesture logic in widgets.
- If a minimal ovui gizmo renders handles but does not expose handle-drag callbacks, project the selected pivot into viewport space and implement a direct-manipulation fallback that converts mouse deltas into camera-plane world deltas.

Common failure modes:

- Putting matrix basis vectors in columns instead of rows places the camera inside, behind, or under the scene.
- Ignoring letterboxing makes orbit centers and picks offset from the visible image.
- Treating every left release as selection causes accidental selections after orbit drags.
- Letting the camera controller see a transform-gizmo press first makes the gizmo appear inert because orbit owns the drag.
- Forgetting ovui's button order makes right-drag and middle-drag modes swap.

Read for depth: see `references/viewer-input-routing`, `references/camera-controls`, `references/local-viewer`, and `references/stage-hierarchy` for input routing, camera math, and bounds contracts.

## 8. Add Picking, Selection, And Highlighting

Do this in `local_app/selection_controller.py`; the completed click or marquee
gesture should come from `references/viewer-input-routing`:

- On left mouse release after a click gesture, map the screen coordinate to a render pixel and enqueue a native ovrtx pick query.
- After the next render step, read the synthetic `ovrtx_pick_hit` render var, validate its params, resolve `primPath` ids to USD prim paths, and deduplicate the result.
- Maintain selected tree path and selected mesh paths separately when an Xform or Scope expands to descendant geometry.
- Keep selection state in runtime memory and update viewport highlight, tree row selection, and prim info from that single source.
- Clear selection on scene reset, scene switch, empty tree selection, or explicit clear command.
- Apply visual selection feedback by writing native selection outline group attributes on the runtime stage, not by permanently editing the user USD.

Critical contracts:

- The pick query rectangle uses render-product pixel space after letterbox/scaling correction.
- Picking coordinates must use render-pixel space after letterbox and scaling correction.
- Selection state is local-runtime authoritative. Widgets mirror it; they do not independently mutate it.
- Enable selection outlines at renderer creation and set per-group outline/fill colors with `Renderer.set_selection_group_styles(...)`.
- Clear previous outlines by writing group `0`; assign selected prims to a non-zero group such as `1`.
- Do not let selection picking run while the scene is loading or the renderer is resetting.
- Check operation status for the stage load, render step, and pick query before changing selection. An empty or failed pick should not corrupt the previous selected state.

Decision points:

- If the user only asks for tree selection, implement tree-driven selection first and defer viewport picking.
- If the user asks for visual highlight, use native selection outlines after selection state works.
- If the user asks for hover, multi-select, or marquee selection, extend the local state model explicitly and keep final selected state centralized.
- If selection needs property display, trigger the info panel to query the selected prim rather than stuffing full properties into every selection update.

Common failure modes:

- Selection appears offset when coordinate transforms ignore image scaling or letterboxing.
- No pick result arrives when the query was enqueued for a different RenderProduct than the next `renderer.step()`.
- Highlight persists across scene loads when old selection outline groups are not cleared.
- Tree selection and viewport selection diverge when each widget tracks its own selected path.

Read for depth: see `references/viewer-input-routing`, `references/object-selection`, `references/selection-feedback`, `references/prim-info-display`, and `references/stage-hierarchy` for the full input, picking, highlighting, and info contracts.

## 9. Add Scene Switching And Asset Browsing

Do this in `local_app/scene_manager.py` and `local_app/widgets/scene_picker.py`:

- Build a scene registry from configured local sample paths or an allowed asset root.
- Display user-friendly scene labels while storing validated absolute paths or registry IDs internally.
- When the user selects a scene, enter loading state, stop stepping the old scene, reset renderer stage state, create the new inline root/session data, load the new stage, restore persistent settings, fit or restore camera, clear selection, refresh hierarchy, and resume rendering.
- Keep the previous valid scene alive until the new load succeeds when the UX requires non-destructive scene switching.
- Provide a reload current scene action that rebuilds all derived state from the original source.

Critical contracts:

- Never call `renderer.step()` concurrently with scene reset/load.
- Preserve render settings across scene switches unless the user explicitly asks for per-scene settings.
- Preserve camera across scenes only when that policy is requested and the old camera state is valid for the new bounds; otherwise fit to the new stage.
- Recompute hierarchy, properties cache, variants cache, bounds, pickability filters, and selection outline state for the new stage.
- Validate user-selected paths against an allowed root before loading them.

Decision points:

- If assets are local files, scan `.usd`, `.usda`, and `.usdc` files under an allowed root.
- If assets are cloud-backed, use `references/cloud-assets` and keep cloud logic behind the same asset registry interface.
- If scene load fails, keep the previous scene visible if it is still valid, or enter idle/error state with a clear status message.
- If variant changes require stage reload, route them through the same load lock and loading-state path as scene switching.

Common failure modes:

- Leaving the render loop active during reset produces intermittent crashes or corrupted frames.
- Not clearing caches after scene switch shows stale tree children or properties.
- Persisting a camera blindly can place the viewer far away from a very different scene.
- Displaying raw absolute paths in the UI leaks local filesystem structure and makes labels noisy.

Read for depth: see `references/stage-management`, `references/stage-loading`, `references/stage-hierarchy`, and `references/cloud-assets` for the full scene switching and asset contracts.

## 10. Add Stage Hierarchy, Properties, And Variants

Do this in `local_app/stage_queries.py`, `local_app/widgets/stage_tree.py`, and `local_app/widgets/prim_info_panel.py`:

- Open or attach the current stage for query operations using the chosen direct or subprocess `pxr` mode.
- Query root children after a scene loads.
- Load tree children lazily when a row expands.
- Represent each prim with name, path, type, and child-load state.
- Fetch properties for the selected prim when selection changes.
- Fetch variants for the selected prim and apply variant changes through the scene manager.
- After variant changes, refresh affected hierarchy, properties, bounds, native pickability state, and selection if composition changed.

Critical contracts:

- Avoid full recursive hierarchy traversal by default for large scenes.
- Keep children semantics stable: expandable-but-not-loaded is distinct from loaded children and leaf rows.
- Do not assume all USD property values are directly displayable. Normalize arrays, tokens, paths, numbers, booleans, and fallback display strings.
- Include the prim path with every local query result so widgets can ignore stale data after selection or scene changes.
- If query work can block the UI, move it to a worker and return results to the UI/render loop safely.
- Tree selection should call the same runtime selection path as viewport picking.

Decision points:

- If direct `pxr` imports are stable in the local process, direct query helpers are acceptable.
- If imports conflict, use a subprocess query mode and keep logs on stderr while requests and responses use structured data.
- If the user asks for variant editing, treat it as a scene mutation and route it through scene management.
- If the user asks for full property editing, treat it as a separate feature and add explicit edit/apply/reload contracts.

Common failure modes:

- Large scenes freeze the UI when the full hierarchy is traversed synchronously.
- Non-serializable or non-displayable USD values break property rendering.
- Variant changes leave stale property and child rows unless caches are invalidated.
- Direct `pxr` imports can conflict with ovrtx if import order or library paths are inconsistent.

Read for depth: see `references/stage-hierarchy`, `references/prim-info-display`, `references/stage-management`, and `references/windows-native-setup` for the full hierarchy and property contracts.

## 11. Add Render Settings And Lighting Controls

Do this in `local_app/render_settings.py`, `local_app/settings_store.py`, and `local_app/widgets/render_settings_panel.py`:

- Define a small persistent settings model for validated render settings, camera policy, segmentation/debug state, viewport/profile defaults, and non-live defaults after the runtime capability list is known.
- Build a runtime-owned supported-settings capability list from verified backend apply paths. The render settings panel must render from that list, not from hard-coded optimistic controls.
- Load settings at app start.
- Apply validated immediate settings and accepted profile/default settings after every scene load.
- Persist user changes after validation.
- Keep scene-independent settings separate from scene-specific transient state.
- Echo the effective settings and capabilities back into UI state after every change so controls reflect clamped values, `applied`, `applies_at`, `requires_reload`, and any message.

Critical contracts:

- Do not add viewer lights by default. Only create viewer-owned lights when the user requests lighting controls.
- If changing resolution, treat it as a render product, image bridge, pick coordinate, and viewport math reconfiguration.
- If changing render vars, update scene setup and frame extraction together.
- Persist validated settings across scene switches.
- Validate every setting value from the UI before applying it.
- Reject unsupported setting keys. Do not report success for client-side form state alone.
- Do not invent `write_attribute` names for renderer internals; expose only controls supported by the active ovrtx build and documented by `references/render-settings`.

Decision points:

- If the user wants a basic Omniverse Realtime Viewer, provide only verified immediate controls by default. AOV/debug view is acceptable when implemented through `aov-switching`; lighting controls are acceptable only when backed by a verified live apply path or explicit reload/profile workflow.
- If the user wants material or renderer internals, read `references/render-settings` before exposing them.
- If the setting can be applied live through ovrtx attributes, apply it from the render loop.
- If the setting requires stage reload, expose it as an explicit render-profile or scene-load action rather than a live control.

Common failure modes:

- UI says a setting changed while the renderer is still using the old value because effective settings were not echoed back.
- UI exposes controls that cannot apply because the panel did not render from backend-advertised capabilities.
- Viewer-created lights change the look of authored scenes unexpectedly.
- Resolution changes break picking because render product, image bridge, pick coordinate mapping, and letterbox math no longer agree.
- Extra render vars increase memory and frame time even when no feature uses them.

Read for depth: see `references/render-settings`, `references/stage-management`, and `references/stage-loading` for the full settings contract.

## 12. Manage Runtime State And Shutdown

Do this in `local_app/runtime.py`:

- Maintain explicit runtime states: starting, idle/no scene, loading, rendering, error, and shutting down.
- Drain queued commands from the UI/render loop before stepping the next frame.
- Keep the latest loaded stage path, hierarchy root, selection, render settings, loading state, and viewer error in runtime memory.
- Handle app shutdown by stopping the ovui loop, preventing new scene commands, releasing renderer-owned resources if the API exposes them, and closing any query subprocesses.
- Guard long-running operations so the UI can display loading or error state instead of silently freezing.

Critical contracts:

- UI callbacks must not call renderer load/reset/step/write APIs directly if they can run during another renderer operation.
- Scene load and reset operations must be mutually exclusive with frame stepping.
- Errors should clear active drag state, loading state, and stale selection when needed.
- Query subprocesses must be terminated on shutdown and restarted only through a controlled path.
- The app should exit cleanly on interrupt or window close without leaving stale GPU processes.

Decision points:

- If all work stays on the UI thread, keep command handling simple and deterministic.
- If loading large scenes needs a worker thread, make the render thread the only component that mutates the ovrtx renderer.
- If hierarchy queries are slow, cache per-prim results and invalidate them on scene switch or variant change.
- If the app needs autosave settings, write only app settings JSON, never user USD files.

Common failure modes:

- Calling renderer methods from both callbacks and the render loop creates rare crashes that are hard to reproduce.
- Exceptions during input can leave a drag gesture active and cause later clicks to orbit or select unexpectedly.
- Query workers that write logs to stdout can corrupt structured responses.
- App exits that skip GPU cleanup may leave stale Python processes holding CUDA/RTX state.

Read for depth: see `references/local-viewer`, `references/ovrtx-rendering`, `references/stage-management`, and `references/stage-hierarchy` for runtime and shutdown contracts.
