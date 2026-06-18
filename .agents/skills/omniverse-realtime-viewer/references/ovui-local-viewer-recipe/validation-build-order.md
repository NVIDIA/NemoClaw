# ovui Local Validation And Build Order

## 13. Validate The Omniverse Realtime Viewer

Validate in this order:

1. Compile or import-check the local app package.
2. Launch with a real display and confirm the ovui window opens at the requested size.
3. Confirm the main window resizes and the viewport image frame tracks the window dimensions.
4. Push a synthetic RGBA gradient through the selected ovui image provider and
   capture a desktop screenshot proving native presentation works before any
   renderer debugging.
5. Load a simple sample scene and save a direct ovrtx `LdrColor` artifact from
   the same render product and render var used by the viewport.
6. Capture a desktop screenshot of the ovui window showing that rendered frame.
7. Confirm colors are correct with a scene containing obvious red and blue objects.
8. Confirm the scene was not modified and no viewer lights were injected unless requested.
9. Confirm camera orbit, pan, right-drag dolly, wheel zoom, and fit-to-stage update the rendered view.
10. Confirm left-click selection does not fire after an orbit drag.
11. Confirm viewport picking uses the visible image rect and remains accurate after resize.
12. Confirm selected prim state appears in the tree and info panel.
13. Confirm hierarchy expansion, properties, and variants display the current selected prim only.
14. Confirm scene switching clears stale selection, refreshes hierarchy, preserves render settings, and avoids concurrent render/reset.
15. Confirm every visible render setting has validation evidence: before/after pixels, backend state proof, ovrtx docs/sample-backed API proof, wrapper diff plus explicit reload, or unsupported-key rejection.
16. Confirm render settings persist after scene switch and app restart only for settings that were validated or accepted as non-live defaults.
17. Confirm selection outline groups are cleared on every stage load when selection feedback is enabled.
18. If a selected-prim transform gizmo is present, confirm dragging it changes a known prim's live `omni:xform` by a measured delta and the highlight/info panel follow the moved prim.
19. Confirm the app shuts down without leaving a stale Python GPU process.

Use these failure checks:

- Window opens but content does not resize: verify the ovui window fills the app window and viewport widgets use flexible sizing.
- Black frame: verify render product path, camera path, render var source, resolution, and camera transform.
- Direct `LdrColor` artifact is nonblank but the window is blank: verify ovui
  presentation with the synthetic frame and switch to a known-good ovui-native
  presentation path if needed.
- Magenta materials: verify `OVRTX_BIN_PATH` and plugin library path.
- Scene load works once but fails after switching: verify renderer reset/load serialization, inline sublayer paths, and operation error handling.
- Camera moves incorrectly: verify row-major camera matrix layout, world-up convention, finite state, ovui button mapping, and letterbox transform.
- Picking fails: verify native pick query enqueue/step/result handling, pick coordinate transform, RenderProduct GPU pinning when required by the active ovrtx build, and no picking during load/reset.
- Gizmo appears but prim does not move: verify the gizmo gets mouse-down priority before camera/orbit, drag release does not enqueue a pick, and drag deltas call `renderer.write_attribute` on `omni:xform` with the selected prim path.
- `OPEN` button does nothing or fails inconsistently: remove or demote the dialog control until it is validated; keep the path-field `LOAD` path as the primary stage-loading control.
- Tree or info panel shows stale data: verify cache invalidation after scene switch, variant change, and selection clear.
- UI freezes on large scenes: verify hierarchy traversal is lazy or moved off the UI path.

Read for depth: see `references/local-viewer`, `references/stage-loading`, `references/viewer-input-routing`, `references/camera-controls`, `references/object-selection`, `references/stage-hierarchy`, `references/render-settings`, and `references/stage-management` for full debugging contracts.

## Recommended Build Order For Agents

Follow this sequence when implementing from scratch:

1. Create the project skeleton and dependency files.
2. Build app config, runtime state, ovui lifecycle, and a resizable empty viewport shell.
3. Add ovrtx renderer construction and a single hard-coded sample scene load.
4. Add a synthetic ovui presentation smoke test and capture the first nonblank
   window screenshot.
5. Add inline root/session setup with `LdrColor`, save a direct frame artifact,
   and confirm one displayed frame in the ovui window.
6. Add continuous frame stepping and stable `ImageBridge` updates.
7. Add letterbox math, normalized input routing, and a transparent viewport hit surface.
8. Add camera orbit, pan, zoom, wheel zoom, and fit-to-stage.
9. Add scene registry, scene picker, reload, and serialized scene switching.
10. Add hierarchy and properties queries.
11. Add tree-driven selection, then viewport picking.
12. Add native selection outline feedback and prim info display.
13. Add selected-prim transform gizmo behavior only after selection and live transform writes are proven.
14. Add render settings capabilities, immediate apply paths, and persistence only for validated settings.
15. Run the validation checklist and fix failures before adding optional overlays, cloud assets, or editor-style widgets.

Do not skip the displayed-frame milestone. If the first implementation includes every feature before ovrtx image display is proven, failures become hard to isolate.
