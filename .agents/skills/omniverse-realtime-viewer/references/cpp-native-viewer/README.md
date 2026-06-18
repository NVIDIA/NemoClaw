# C++ Native ImGui OVRTX Viewer

## Triggers

Use this skill for C++ viewer, ImGui viewer, native viewer, C++ OVRTX, GLFW viewer, native Dear ImGui viewport, native executable, no-Python local desktop viewer, or requests that use the OVRTX C API directly.

Use this for a focused native binary: GLFW window, OpenGL pixel presentation, Dear ImGui controls, inline USDA session layer, OVRTX C API renderer, CPU-mapped `LdrColor`, and direct camera/picking/selection logic.

For ovrtx C API behavior, native viewer behavior, renderer lifecycle guidance,
or release-specific behavior not covered here, read `references/dependencies` for
acquisition guidance and supplemental dependency documentation.

## Read Order

| Need | Read |
|---|---|
| Choose this path, create project skeleton, configure CMake, use common C API helpers | `project-build.md` |
| Construct renderer, load user USD, author viewer-owned session layer | `renderer-session.md` |
| Upload OVRTX frames to OpenGL and run the main render loop | `presentation-loop.md` |
| Add orbit camera, picking, selection outline, pick effects, animation | `interaction-features.md` |
| Add Dear ImGui toolbars, sliders, settings controls, menus, or dialogs | `viewer-control-patterns` |
| Check gotchas, reference files, and validation checklist | `validation.md` |

## Critical Rules

- Do not use Three.js, WebGL scene rendering, glTF viewers, or browser-native rendering for USD.
- OpenGL is only the pixel presentation path for frames already rendered by OVRTX.
- Keep renderer creation, stage load/reset, pick query enqueue, result mapping, and `ovrtx_write_attribute()` calls on one owner thread.
- Use the selected OVRTX C API and helper contracts from the references; do not mix Python renderer assumptions into this path.
- Apply `viewer-control-patterns` to Dear ImGui UI: choose controls by user intent first, pair approximate sliders with numeric inputs when exact values matter, clamp values before sending them to OVRTX, and surface the effective backend value when it differs.
- Choose C++/ImGui only when the app should run as a native executable on the GPU workstation and does not need web UI reuse.

See also: `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `viewer-control-patterns`, `camera-controls`, `native-picking-selection`, `selection-feedback`, `selection-animation`, `prim-transform-safety`, `streaming-vs-local`, `ovui-local-viewer-recipe`, `tauri-local-viewer`, and `electron-shm-viewer`.
