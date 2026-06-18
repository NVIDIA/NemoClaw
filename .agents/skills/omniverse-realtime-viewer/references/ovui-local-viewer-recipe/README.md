# ovui Local Omniverse Realtime Viewer Recipe

## Triggers

Use this skill for local Python desktop Omniverse Realtime Viewer, lightweight ovui desktop viewer, standalone ovui viewer, simple interactive local viewport, build local viewer, or broad non-streaming viewer requests that should use `ovui` rather than Tauri, Electron, C++, or browser streaming.

This is specifically the Python + lightweight `ovui` path. For React/Tauri use `tauri-local-viewer`; for Electron + SHM use `electron-shm-viewer`; for native C++/ImGui use `cpp-native-viewer`; for remote/browser viewing use `streaming-viewer-recipe`.

## Read Order

Load only the reference files needed for the current phase:

| Phase | Read |
|---|---|
| Decide local ovui project shape and non-negotiable rules | `project-structure.md` |
| Install dependencies, build the local ovui-based app shell, construct renderer, load scenes, display frames | `setup-shell-renderer.md` |
| Add input routing, camera, picking, selection, scene switching, hierarchy, properties, settings, shutdown | `interaction-features.md` plus `viewer-input-routing` for button normalization and click-vs-drag dispatch; use `viewer-control-patterns` for toolbar, sidebar, form, slider, and settings control choices |
| Validate behavior and order implementation work | `validation-build-order.md` |

## Critical Rules

- Before writing code, read `dependencies` for current runtime acquisition,
  environment contracts, verification steps, and supplemental dependency
  documentation. Keep this local recipe self-contained; generate app-specific
  widgets and renderer glue from the selected references rather than assuming access
  to dependency source repositories.
- Do not use WebGL, Three.js, Babylon.js, or client-side 3D rendering. The desktop window displays frames rendered by in-process `ovrtx` through `ovui`.
- Keep this as one desktop application process unless the user explicitly chooses Electron + SHM or streaming.
- Use `ovui` for the native window and focused viewer UI; do not start the full `ovui` editor shell for lightweight viewer requests. Apply `viewer-control-patterns` when choosing native `ovui` controls for settings, actions, and tool modes.
- Make one UI/render loop the sole owner of `renderer.step()`, stage mutation, native picking, selection outline writes, and live `write_attribute()` calls.
- Set `OVRTX_SKIP_USD_CHECK=1` before ovrtx work.
- Never modify user USD files when adding viewer camera, render products, render vars, settings, selection metadata, inline session data, or runtime selection outline attributes.
- Account for letterboxing when converting ovui mouse coordinates to render-image pixels, and normalize ovui button ids through `viewer-input-routing`.
- If selected-prim gizmos are requested, read `transform-manipulator` and `prim-transform-safety`; validate that dragging the gizmo moves the prim, not only the handle.

## Build Order

1. Create the local desktop package and keep UI widgets thin.
2. Install and verify `ovrtx`, `ovui`, OpenUSD/pxr, NumPy, and optional Warp.
3. Build the `ovui` window shell and image display path.
4. Construct the renderer runtime and scene loader.
5. Add input routing, camera controls, picking, selection, scene switching, hierarchy/properties, and render settings.
6. Manage runtime state, shutdown, and stale GPU process cleanup.
7. Capture validation and review evidence.

See also: `local-viewer`, `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `viewer-control-patterns`, `camera-controls`, `native-picking-selection`, `object-selection`, `selection-feedback`, `transform-manipulator`, `prim-transform-safety`, `prim-info-display`, `stage-attribute-reads`, `stage-management`, `render-settings`, `stage-hierarchy`, `stage-queries`, and `viewport-overlays`.
