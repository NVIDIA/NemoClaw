# ovui Local Project Structure

## Pattern, Not Fixed File Layout

A local Omniverse Realtime Viewer is one desktop app process where ovrtx owns
rendering and the local UI presents already-rendered frames. The file tree below
is a worked layout, not a requirement. Reorganize modules to match the host repo
as long as one UI/render owner serializes renderer mutation, viewer-owned USD
state stays out of user files, viewport input is mapped through the visible
image rectangle, and scene/query/settings code remains below the UI widget
layer.

## Global Rules

- *Before writing any code*, read `references/dependencies` for current runtime acquisition, environment contracts, and verification steps.
- *NEVER use WebGL, Three.js, Babylon.js, or any client-side 3D renderer.* All
  USD rendering is done by `ovrtx` in-process. The desktop window displays
  ovrtx-rendered frames via ovui, not a browser canvas. If local validation
  cannot run because the GPU/runtime environment is absent, scaffold the ovrtx
  code anyway and document the GPU requirement.
- For deployment work, read `references/cloud-deployment` and use the supported
  paths documented there, such as OKAS 1 or Brev.
- Keep the local Omniverse Realtime Viewer as one desktop application process. Use ovui for the native window and UI, ovrtx for rendering, and optional pxr/OpenUSD queries for hierarchy, bounds, properties, and variants.
- Do not add ovstream, WebRTC, a browser frontend, or React unless the user explicitly changes the delivery target to a streaming Omniverse Realtime Viewer.
- Do not start a full editor shell for the lightweight local Omniverse Realtime Viewer. Use focused local UI companion utilities only when they solve a narrow problem, such as an image bridge.
- Make one UI/render loop the sole owner of `renderer.step()`, `open_usd()`, `open_usd_from_string()`, reference add/remove APIs, `reset_stage()`, native pick queries, selection outline writes, and live `write_attribute()` calls. UI callbacks update local state or enqueue work for that loop.
- Set `OVRTX_SKIP_USD_CHECK=1` before ovrtx work. Keep import order disciplined for the chosen local path.
- Never modify the user USD file when adding viewer camera, render products, render vars, settings, selection metadata, inline session data, or runtime selection outline attributes.
- Do not inject viewer lights unless the user requested viewer-controlled lighting. User stages usually own their lighting.
- Always account for letterboxing when converting ovui mouse coordinates to render-image pixels for picking, overlays, and camera controls.

## 1. Create The Project Skeleton

Create a single desktop app package. Use this structure unless the host repo already has an equivalent convention:

```text
local-usd-viewer/
  .gitignore
  README.md
  requirements.txt or pyproject.toml
  local_app/
    __init__.py
    __main__.py
    app.py
    config.py
    runtime.py
    renderer_runtime.py
    scene_loader.py
    viewport.py
    input_controller.py
    camera_controller.py
    selection_controller.py
    scene_manager.py
    render_settings.py
    stage_queries.py
    settings_store.py
    widgets/
      toolbar.py
      scene_picker.py
      stage_tree.py
      prim_info_panel.py
      render_settings_panel.py
      status_bar.py
  assets/
    samples/
  data/
    viewer-settings.json
```

Do this:

- Create the skeleton files above directly in the generated app.
- Add a project `.gitignore` that excludes local virtual environments, caches,
  frontend artifacts, logs, and Python bytecode, at minimum: `.venv/`,
  `.cache/`, `node_modules/`, `dist/`, `__pycache__/`, `*.log`, and `logs/`.
- Keep renderer, USD, camera, selection, hierarchy, and settings state inside `local_app/`.
- Put sample USD files under `assets/samples/` or accept an absolute configured asset root. Do not hard-code developer machine paths.
- Persist cross-scene viewer settings under `data/viewer-settings.json` or a user-configurable settings path.
- Keep UI widgets thin. They should render app state and call local runtime actions; they should not own renderer state directly.

Critical contracts:

- `local_app/__main__.py` is the process entry point only. It parses config, constructs runtime objects, initializes ovui, enters the app loop, and shuts down cleanly.
- `local_app/runtime.py` owns high-level state, command dispatch, loading state, current scene, current selection, and lifecycle coordination.
- `local_app/renderer_runtime.py` owns the ovrtx renderer, render product path, frame stepping, frame extraction, and live attribute writes.
- `local_app/scene_loader.py` owns viewer camera/render-product/render-var injection and never mutates user USD files.
- `local_app/viewport.py` owns the `ImageBridge`, displayed image widget, overlay hit surface, viewport size, and letterbox math.
- `local_app/input_controller.py` owns ovui mouse/keyboard callbacks and translates them to camera, picking, and context-menu actions.
- `local_app/stage_queries.py` owns hierarchy, properties, variants, bounds, and descendant mesh expansion.

Decision points:

- If the user asks for the quickest local demo, build one process with a fixed render resolution and a small built-in scene picker.
- If the user asks for a native desktop app with Rust/Tauri and React UI, stop using this recipe and read `references/tauri-local-viewer`.
- If the user asks for full editor docking, property inspectors, transform gizmos, or editor workflows, switch to the dedicated full-editor skill before choosing the shell.
- If the user asks for S3, MinIO, or cloud asset browsing, keep asset discovery behind `scene_manager.py`; see `references/cloud-assets` for the full contract.

Common failure modes:

- Starting from a full editor application when the user asked for a simple viewer adds heavyweight editor behavior and obscures the core viewport.
- Putting renderer ownership inside individual widgets makes scene switching and shutdown hard to serialize.
- Returning raw local filesystem paths in UI labels exposes implementation details and makes asset roots harder to change.

Read for depth: see `references/local-viewer`, `references/ovrtx-rendering`, `references/stage-loading`, and `references/usd-viewer-app` for the full local shell and renderer contracts.
