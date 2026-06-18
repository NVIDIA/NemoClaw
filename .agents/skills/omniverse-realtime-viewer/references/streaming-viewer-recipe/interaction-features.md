# Streaming Interaction Features

## 9. Add Camera Controls

Read `references/viewer-input-routing` first for transport button mapping,
viewport ownership, wheel deltas, and click-vs-drag dispatch. Then implement
camera math in `server/input_router.py` and `server/camera_controller.py`:

- Track mouse press, movement, release, buttons, wheel, keyboard modifiers, and viewport dimensions from ovstream `InputEvent` callbacks.
- Convert browser input coordinates into render-image coordinates, accounting for letterboxing or scaling.
- Use drag thresholding so a short left press/release selects and a left drag orbits.
- Support orbit, pan, dolly/zoom, wheel zoom, fit-to-stage, and optional WASD fly mode when requested.
- Set camera aspect from the fixed RenderProduct resolution; keep horizontal aperture stable and derive vertical aperture from `height / width`.
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
- Do not use JSON messages for routine pointer movement.
- The browser displays the fixed-resolution stream with `object-fit: contain`; use the letterbox transform for any app-owned coordinate math, while NVST handles stream input mapping.

Decision points:

- If the user wants DCC-style navigation, use Alt+left for orbit, Alt+middle for pan, and Alt+right for dolly while preserving left-click selection.
- If the user wants simple browser navigation, use left drag orbit, middle drag pan, right drag dolly, and wheel zoom.
- If the stage has an authored camera and the app policy is to use it, initialize viewer camera settings from that camera before allowing interaction.
- If the user requests camera UI buttons, send high-level camera commands over the data channel; keep continuous pointer input in ovstream input.

Common failure modes:

- Putting matrix basis vectors in columns instead of rows places the camera inside, behind, or under the scene.
- Ignoring letterboxing makes picks and orbit centers offset from the visible image.
- Treating every left release as selection causes accidental selections after orbit drags.

Read for depth: see `references/viewer-input-routing`, `references/camera-controls`, and `references/stage-hierarchy` for the full input, camera math, and bounds contracts.

## 10. Add Object Selection And Highlighting

Do this in `server/selection_controller.py`; the completed click gesture should
come from `references/viewer-input-routing`:

- On left mouse release after a click gesture, map the visible image coordinate to the render pixel coordinate and enqueue a native ovrtx pick query.
- After the next render step, read the synthetic `ovrtx_pick_hit` render var, validate its params, resolve `primPath` ids to USD prim paths, and deduplicate the result.
- Maintain selected prim paths in server state.
- Send `stageSelectionChanged` whenever selection changes.
- Support `selectPrimsRequest` from the frontend for tree-driven selection.
- Clear selection on `selectPrimsRequest` with an empty path list, scene reset, or scene switch.
- Apply visual selection feedback by writing native selection outline group attributes on the runtime stage, not by permanently editing the user USD.

Critical contracts:

- The pick query rectangle uses render-product pixel space after letterbox/scaling correction.
- Picking coordinates must use render-pixel space after letterbox/scaling correction.
- Selection state is server-authoritative. The frontend mirrors it from `stageSelectionChanged`.
- Enable selection outlines at renderer creation and set per-group outline/fill colors with `Renderer.set_selection_group_styles(...)`.
- Clear previous outlines by writing group `0`; assign selected prims to a non-zero group such as `1`.
- Do not let selection picking run while the scene is loading or the renderer is resetting.
- Check operation status for the stage load, render step, and pick query before changing selection. An empty or failed pick should not corrupt the previous selected state.

Decision points:

- If the user only asks for tree selection, implement `selectPrimsRequest` first and defer click picking.
- If the user asks for visual highlight, use native selection outlines after selection state works.
- If the user asks for hover, multi-select, or marquee selection, extend the protocol with explicit event names and keep final selected state server-authoritative.
- If selection needs property display, trigger or expect a `getPropertiesRequest` for the selected prim rather than stuffing full properties into every selection event.

Common failure modes:

- Selection appears offset when coordinate transforms ignore video scaling or letterboxing.
- No pick result arrives when the query was enqueued for a different RenderProduct than the next `renderer.step()`.
- Highlight persists across scene loads when old selection outline groups are not cleared.
- Frontend and server selection diverge when the frontend mutates local selection without waiting for `stageSelectionChanged`.

Read for depth: see `references/viewer-input-routing`, `references/object-selection`, `references/selection-feedback`, and `references/prim-info-display` for the full input, picking, highlighting, and info contracts.

## 11. Add Scene Switching And Asset Browsing

Do this in `server/scene_manager.py`, `server/assets.py`, and `frontend/src/components/ScenePicker.tsx`:

- Build a server-side scene registry from configured local sample paths or an allowed asset root.
- Expose scene choices to the frontend through a message or static config that does not leak arbitrary server filesystem paths.
- When the user selects a scene, send `openStageRequest` with the scene URL or registry id.
- In the server render loop, enter loading state, stop stepping the old scene, reset renderer stage state, create the new inline root/session data, load the new stage, restore persistent settings, fit or restore camera, clear selection, and resume streaming.
- Send loading progress/activity events during long loads.
- Send `openStageResult` after load success or failure.
- Send root hierarchy after successful load or when the frontend requests it.

Critical contracts:

- Never call `renderer.step()` concurrently with scene reset/load.
- Preserve render settings across scene switches unless the user explicitly asks for per-scene settings.
- Preserve camera across scenes only when that policy is requested and the old camera state is valid for the new bounds; otherwise fit to the new stage.
- Recompute hierarchy, properties cache, variants cache, bounds, pickability filters, and selection outline state for the new stage.

Decision points:

- If assets are local files, validate paths against an allowed root and reject traversal outside it.
- If assets are cloud-backed, use `references/cloud-assets` and keep cloud logic behind the same asset registry interface.
- If scene load fails, keep the previous scene streaming if it is still valid, or enter idle/error state with a clear frontend error.
- If variant changes require stage reload, route them through the same load lock and loading-state path as scene switching.

Common failure modes:

- Leaving render loop active during reset produces intermittent crashes or corrupted frames.
- Not clearing caches after scene switch shows stale tree children or properties.
- Persisting a camera blindly can place the viewer far away from a very different scene.
- Returning raw absolute server paths to the browser exposes local filesystem details.

Read for depth: see `references/stage-management`, `references/stage-loading`, `references/stage-hierarchy`, and `references/cloud-assets` for the full scene switching and asset contracts.

## 12. Add Hierarchy, Properties, And Variants

Do this in `server/stage_queries.py`, `frontend/src/components/StageTree.tsx`, and `frontend/src/components/PrimInfoPanel.tsx`:

- Query root children after a scene loads.
- Load tree children lazily through `getChildrenRequest`.
- Represent each prim with name, path, type, and child-load state.
- Fetch properties for the selected prim through `getPropertiesRequest`.
- Fetch variants through `getVariantsRequest` and apply changes through `setVariantRequest`.
- After variant changes, refresh affected hierarchy, properties, bounds, and selection if the variant changes composition.

Critical contracts:

- Do not perform long USD traversal in ovstream callback threads.
- Include `prim_path` in every response so the frontend can discard stale data.
- Keep children response semantics consistent with the frontend tree implementation.
- Do not assume all USD property values are JSON-serializable without conversion. Normalize arrays, tokens, paths, numbers, booleans, and fallback display strings.
- Avoid loading the entire stage tree by default for large scenes.

Decision points:

- Use ovrtx `query_prims` for basic hierarchy roots and prim discovery whenever it provides the needed data.
- If direct `pxr` imports are stable in the server process, direct query helpers are acceptable for USD features not covered by ovrtx native queries after ovrtx initialization.
- If imports conflict or the platform is Windows, use a subprocess query mode for those remaining `pxr` queries.
- If the user asks for full property editing, treat it as a separate feature and add explicit edit/apply/reload contracts.

Common failure modes:

- Large scenes freeze the stream when the full hierarchy is traversed synchronously.
- Non-serializable USD values break data-channel sends.
- Variant changes leave stale property and child rows unless caches are invalidated.

Read for depth: see `references/stage-hierarchy`, `references/prim-info-display`, and `references/streaming-messages` for the full hierarchy and property contracts.

## 13. Add Render Settings And Lighting Controls

Do this in `server/render_settings.py`, `server/settings_store.py`, and `frontend/src/components/RenderSettingsPanel.tsx`:

- Define a small persistent settings model for validated render settings, camera policy, segmentation/debug state, stream/profile defaults, and non-live defaults after the backend capability list is known.
- Build a server-owned supported-settings capability list from verified backend apply paths. The frontend render settings panel must render from that list, not from hard-coded optimistic controls.
- Load settings at server start.
- Apply validated immediate settings and accepted profile/default settings after every scene load.
- Send the effective settings and capabilities to the frontend after connection and after every change.
- Persist user changes after validation.
- Keep scene-independent settings separate from scene-specific transient state.

Critical contracts:

- Do not add viewer lights by default. Only create viewer-owned lights when the user requests lighting controls.
- If changing a user-selected fixed resolution, treat it as a render product and stream config change with explicit reconfiguration or restart. Do not tie stream resolution to browser CSS viewport size.
- If changing render vars, update scene setup and frame extraction together.
- Persist validated settings across scene switches.
- Validate every setting value from the client before applying it.
- Reject unsupported setting keys. Do not report success for client-side form state alone.
- Send the full effective settings after applying a change so the UI reflects clamped values, `applied`, `applies_at`, `requires_reload`, and any message.

Decision points:

- If the user wants a basic Omniverse Realtime Viewer, provide only verified immediate controls by default. AOV/debug view is acceptable when implemented through `aov-switching`; exposure/tone mapping are acceptable only when backed by frame conversion or a verified ovrtx path.
- If the user wants material or renderer internals, read `references/render-settings` before exposing them.
- If the setting can be applied live through ovrtx attributes, enqueue a render-thread command.
- If the setting requires stage reload, expose it as an explicit render-profile or scene-load action rather than a live control.

Common failure modes:

- UI says a setting changed while the renderer is still using the old value because the server did not echo effective settings.
- UI exposes controls that cannot apply because React hard-coded settings that the backend did not advertise as capabilities.
- Viewer-created lights change the look of authored scenes unexpectedly.
- Resolution changes break video because the frontend, ovstream config, render product, and frame pitch no longer agree.

Read for depth: see `references/render-settings` and `references/stage-management` for the full settings contract.
