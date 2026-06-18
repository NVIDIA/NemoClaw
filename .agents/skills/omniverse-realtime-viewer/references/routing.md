<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Omniverse Realtime Viewer Routing

Use this reference to route plain-language viewer requests into focused references.
This routing reference is self-contained; focused references live in sibling
directories under this `references/` directory.

## Architectural Constraint

All USD and 3D rendering must use `ovrtx`, NVIDIA's RTX renderer.

The pattern is always:

- Server-side: Python or native process owns `ovrtx.Renderer` plus OpenUSD stage
  access, then renders frames on the GPU.
- Browser delivery: `ovstream` WebRTC streams rendered frames to a browser. The
  browser displays video plus UI overlays.
- Desktop delivery: `ovui` native windows, Tauri WebViews, C++ windows, or
  Electron SHM pixel transport display `ovrtx` rendered frames.

If local validation cannot run because the GPU/runtime environment is absent,
scaffold the `ovrtx` code path and document the runtime requirement. Do not
substitute a browser renderer.

## How To Use These Skills

When a user describes an Omniverse Realtime Viewer:

1. Route by user intent first.
2. Read `usd-viewer-app/README.md` for broad viewer requests.
3. Add focused references for requested capabilities.
4. Follow each selected reference's implementation notes and gotchas.
5. Capture validation and review evidence before considering the generated app
   ready to share.

## Intent-Based Routing

| User says... | Read these references |
|---|---|
| "I want to visualize USD files" / "build an Omniverse Realtime Viewer" / "3D viewport" | `usd-viewer-app/README.md` first |
| "simple interactive viewport" | `ovui-local-viewer-recipe/README.md`, then `local-viewer/README.md`, `ovrtx-rendering/README.md`, `stage-loading/README.md`, `viewer-input-routing/README.md`, `camera-controls/README.md`; add `viewer-control-patterns/README.md` if the app has toolbar, sidebar, or settings controls |
| "native desktop app with React UI" / "Tauri viewer" / "Rust OVRTX" | `tauri-local-viewer/README.md`, `ovrtx-rendering/README.md` |
| "C++ viewer" / "native desktop" / "ImGui viewer" / "GLFW viewer" | `cpp-native-viewer/README.md`; add `viewer-control-patterns/README.md` for Dear ImGui controls, toolbars, settings, or dialogs |
| "Electron app" / "Electron viewer" / "SHM viewer" / "shared memory viewer" | `electron-shm-viewer/README.md` |
| "headless automation" / "scripted testing" / "CLI tool" / "SHM automation" | `headless-shm-cli/README.md` |
| "local separate-process viewer" / "process-isolated local viewer" | `electron-shm-viewer/README.md` |
| "reusable UI" / "ViewerBackend" / "shared components" / "cross-transport UI" | `viewer-backend-interface/README.md` |
| "viewer UI" / "frontend UI" / "UX" / "app layout" / "redesign" / "panels" / "toolbar" / "ovui UI" / "ImGui UI" | `viewer-ux-workflow/README.md`, then focused viewer UI references |
| "viewport layout" / "outliner and properties" / "drawer" / "anchored inspector" / "responsive layout" | `viewer-layout-patterns/README.md` |
| "buttons" / "actions" / "forms" / "controls" / "sliders" / "confirmations" | `viewer-control-patterns/README.md` |
| "stage tree UI" / "asset grid" / "property inspector UI" / "JSON tree" | `viewer-data-view-patterns/README.md` |
| "loading state" / "error banner" / "stream health" / "offline" / "lagged" / "status UI" | `viewer-feedback-status/README.md` |
| "stream to a browser" / "browser Omniverse Realtime Viewer" | `streaming-viewer-recipe/README.md`, then `streaming-server/README.md`, `streaming-client/README.md`, `streaming-messages/README.md`, `streaming-lifecycle/README.md`, `viewer-input-routing/README.md` |
| "pick objects" / "click to select" | `viewer-input-routing/README.md`, `native-picking-selection/README.md`, `object-selection/README.md`, `selection-feedback/README.md` |
| "when picked, change a material/visibility/effect attribute" | `prim-pick-effects/README.md`, plus `object-selection/README.md` |
| "see info/properties for highlighted objects" | `prim-info-display/README.md`, `stage-attribute-reads/README.md`, `stage-hierarchy/README.md` |
| "highlight selected objects" | `selection-feedback/README.md`, `native-picking-selection/README.md` |
| "custom segmentation-buffer outline overlay" | `seg-outline-highlight/README.md` |
| "animate selected objects" | `selection-animation/README.md` |
| "move/rotate/scale selected objects" / "transform gizmo" / "manipulator" | `transform-manipulator/README.md`, plus `prim-transform-safety/README.md` |
| "Tauri SHM transform gizmo" / "client-side gizmo overlay" | `tauri-shm-transform-gizmo/README.md`, plus `tauri-local-viewer/README.md` and `webgl-shm-transport/README.md` |
| "C++ viewport overlay" / "C++ gizmo" / "GL gizmo" | `gl-viewport-overlay/README.md`, `ovui-library/README.md`, plus `cpp-native-viewer/README.md` |
| "switch scenes" / "load different USD files" / "asset browser" | `stage-management/README.md`, `stage-loading/README.md` |
| "rendering settings" / "lighting" / "quality controls" | `render-settings/README.md`, `viewer-control-patterns/README.md` |
| "switch AOVs" / "view normals" / "segmentation render output" | `aov-switching/README.md`, `ovrtx-rendering/README.md`, `streaming-messages/README.md` |
| "settings persist across scenes" | `stage-management/README.md`, `render-settings/README.md`, `viewer-control-patterns/README.md` |
| "scene tree" / "hierarchy" / "variants" | `stage-hierarchy/README.md` |
| "viewport overlays" / "camera gizmo" / "floating panel" | `viewport-overlays/README.md`, plus `camera-controls/README.md` or `prim-info-display/README.md` |
| "load from S3/MinIO/cloud assets" | `cloud-assets/README.md` |
| "browse assets with thumbnails" | `cloud-assets/README.md` |
| "deploy with cloud sessions" | `cloud-deployment/README.md` |
| "physics simulation" / "drop test" / "physics grab" | Clone `ovphysx` and check its `skills/` |
| "import CAD files" / "convert STEP/IGES to USD" | Clone `cad2usd` and check its `skills/` |
| "native Windows setup" | `windows-native-setup/README.md` |
| "full editor with docking/property inspector" | `streaming-vs-local/README.md` first; use `ovwidgets-editor-shell/README.md` for the full editor path, plus `viewer-control-patterns/README.md` and `viewer-data-view-patterns/README.md` for editor controls and panels |

Target prompt routing:

```text
I want to visualize USD files in a simple interactive viewport, I want to pick
objects and see information about the objects highlighted, and I want to easily
switch between different USD scenes and have some basic rendering and lighting
settings that persist across scenes.
```

Read: `usd-viewer-app/README.md`, `ovui-local-viewer-recipe/README.md`, `local-viewer/README.md`,
`ovrtx-rendering/README.md`, `stage-loading/README.md`, `viewer-input-routing/README.md`,
`camera-controls/README.md`, `native-picking-selection/README.md`, `object-selection/README.md`,
`selection-feedback/README.md`, `prim-info-display/README.md`, `stage-attribute-reads/README.md`,
`stage-management/README.md`, `render-settings/README.md`, `viewer-control-patterns/README.md`, and
`stage-hierarchy/README.md`.

## Capability-Based Routing

| Capability | Skills to read |
|---|---|
| High-level Omniverse Realtime Viewer recipe | `usd-viewer-app/README.md` |
| Core ovrtx renderer construction/step/write APIs | `ovrtx-rendering/README.md` |
| Camera/render product/render var/session stage setup | `stage-loading/README.md` |
| Local desktop end-to-end recipe | `ovui-local-viewer-recipe/README.md`; add `viewer-control-patterns/README.md` for toolbars, forms, render settings, or other user-facing controls |
| Local desktop lightweight ovui shell | `local-viewer/README.md`; add `viewer-control-patterns/README.md` for header, sidebar, toolbar, or inline controls |
| Tauri/Rust native desktop with React WebView | `tauri-local-viewer/README.md` |
| Native C++ OVRTX viewer with ImGui/GLFW | `cpp-native-viewer/README.md`; add `viewer-control-patterns/README.md` for Dear ImGui controls |
| Electron plus SHM local separate-process viewer | `electron-shm-viewer/README.md`, `webgl-shm-transport/README.md` |
| Headless SHM automation and testing | `headless-shm-cli/README.md` |
| ViewerBackend interface and shared React components | `viewer-backend-interface/README.md` |
| SharedArrayBuffer to WebGL pixel transport | `webgl-shm-transport/README.md` |
| Interactive translate/rotate/scale manipulators | `transform-manipulator/README.md`, `prim-transform-safety/README.md` |
| Client-rendered transform gizmo for Tauri SHM | `tauri-shm-transform-gizmo/README.md` |
| C++ GL viewport overlays and reusable gizmo math | `gl-viewport-overlay/README.md`, `ovui-library/README.md` |
| Viewer UI intent routing and UX workflow | `viewer-ux-workflow/README.md` |
| Viewport-dominant layout, panels, drawers, responsive shell | `viewer-layout-patterns/README.md` |
| Toolbars, forms, sliders, semantic actions, confirmations | `viewer-control-patterns/README.md` |
| Stage tree, asset browser, property inspector, JSON data views | `viewer-data-view-patterns/README.md` |
| Loading, errors, stream health, lagged/offline status | `viewer-feedback-status/README.md` |
| Full editor shell | `streaming-vs-local/README.md`, `ovwidgets-editor-shell/README.md`, `viewer-control-patterns/README.md`, `viewer-data-view-patterns/README.md` |
| Streaming architecture decision | `streaming-vs-local/README.md` |
| Browser-streamed end-to-end recipe | `streaming-viewer-recipe/README.md` |
| WebRTC/RTSP server and CUDA frame streaming | `streaming-server/README.md` |
| React/AppStreamer browser client for standalone ovstream Direct mode | `streaming-client/README.md` |
| Streaming JSON data-channel protocol | `streaming-messages/README.md` |
| Stream callback/data-channel lifecycle | `streaming-lifecycle/README.md` |
| Viewer input routing / WebRTC input / click-vs-drag / viewport input ownership | `viewer-input-routing/README.md` |
| Orbit/pan/zoom/camera fitting/gizmo | `viewer-input-routing/README.md`, `camera-controls/README.md` |
| Object picking/selection | `viewer-input-routing/README.md`, `native-picking-selection/README.md`, `object-selection/README.md` |
| Selection glow/highlight | `selection-feedback/README.md`, `native-picking-selection/README.md` |
| Custom segmentation-buffer post-process overlays | `seg-outline-highlight/README.md` |
| Transform-safe live prim manipulation | `prim-transform-safety/README.md`, `ovrtx-rendering/README.md` |
| Selection hover/motion animation | `selection-animation/README.md` |
| Selected prim info/properties display | `prim-info-display/README.md`, `stage-attribute-reads/README.md` |
| Scene switching/reload/persistent state | `stage-management/README.md` |
| Render quality/render vars/lighting/settings | `render-settings/README.md`, `viewer-control-patterns/README.md` |
| Browser AOV/render-var switching | `aov-switching/README.md`, `ovrtx-rendering/README.md`, `streaming-messages/README.md` |
| Server-side ovui overlays | `viewport-overlays/README.md` |
| USD hierarchy/properties/variants/bounds | `stage-hierarchy/README.md` |
| Native prim discovery/filtering | `stage-queries/README.md` |
| Native scalar/array attribute reads | `stage-attribute-reads/README.md` |
| Pick-driven USD attribute effects | `prim-pick-effects/README.md` |
| S3/MinIO asset loading and browsing | `cloud-assets/README.md` |
| Physics simulation | Clone `ovphysx`, use its skills |
| CAD-to-USD conversion | Clone `cad2usd`, use its skills |
| Native Windows setup | `windows-native-setup/README.md` |

## Decision Tree

```text
User prompt received
|
+- High-level app request? ("build an Omniverse Realtime Viewer", "visualize USD files")
|  +- READ: usd-viewer-app/README.md
|
+- Delivery method?
|  +- Browser/web -> READ: streaming-viewer-recipe + streaming-server + streaming-client + streaming-messages + streaming-lifecycle
|  +- Desktop/local (React UI, no Python) -> READ: tauri-local-viewer
|  +- Desktop/local (C++, ImGui, no Python/Rust) -> READ: cpp-native-viewer + viewer-control-patterns
|  +- Desktop/local (React UI, Python server, separate process) -> READ: electron-shm-viewer
|  +- Desktop/local (Python, simple) -> READ: ovui-local-viewer-recipe + local-viewer + ovrtx-rendering + stage-loading; add viewer-control-patterns when controls are visible
|  +- Desktop/local (Python, full editor) -> READ: streaming-vs-local + ovwidgets-editor-shell + viewer-control-patterns
|  +- Both/unsure -> READ: streaming-vs-local first
|
+- Viewer/UI work?
|  +- Broad UI/layout prompt -> READ: viewer-ux-workflow
|  +- Panels/drawers/responsive shell -> READ: viewer-layout-patterns
|  +- Toolbars/forms/actions/sliders/confirmations -> READ: viewer-control-patterns
|  +- Trees/asset grids/property inspectors -> READ: viewer-data-view-patterns
|  +- Loading/errors/stream status -> READ: viewer-feedback-status
|
+- Specific feature?
|  +- Object picking -> READ: viewer-input-routing + native-picking-selection + object-selection + selection-feedback
|  +- Pick changes a USD/material attribute -> READ: prim-pick-effects + object-selection
|  +- Object info panel -> READ: prim-info-display + stage-attribute-reads + stage-hierarchy
|  +- Camera navigation -> READ: viewer-input-routing + camera-controls
|  +- Transform gizmo/manipulator -> READ: transform-manipulator + prim-transform-safety
|  +- Tauri SHM client-rendered gizmo -> READ: tauri-shm-transform-gizmo + tauri-local-viewer + webgl-shm-transport
|  +- C++ GL viewport overlay/gizmo -> READ: gl-viewport-overlay + ovui-library + cpp-native-viewer
|  +- Scene switching -> READ: stage-management
|  +- Render quality/lighting -> READ: render-settings
|  +- AOV/render-var switching -> READ: aov-switching + ovrtx-rendering + streaming-messages
|  +- Viewport overlays -> READ: viewport-overlays
|  +- Animation -> READ: selection-animation
|  +- Custom messages -> READ: streaming-messages
|
+- Infrastructure?
|  +- Cloud assets -> READ: cloud-assets
|  +- Cloud deployment -> READ: cloud-deployment
|  +- Physics simulation -> Clone ovphysx, read its skills/
|  +- CAD file import -> Clone cad2usd, read its skills/
|  +- Windows -> READ: windows-native-setup
|
+- USD stage work?
   +- Loading scenes -> READ: stage-loading
   +- Hierarchy/queries -> READ: stage-hierarchy
   +- Native prim filters -> READ: stage-queries
   +- Native attribute values -> READ: stage-attribute-reads
```

## Dependencies Model

When a selected reference tells you to install or configure a dependency, read
`dependencies/README.md` first. It is the source of truth for the four primary
NVIDIA dependencies: `ovrtx`, `ovui`, `ovstream`, and the `ov-web-rtc` browser client.

| Library | Install method | Notes |
|---|---|---|
| `ovrtx` | See `dependencies/nvidia-runtime.md` | RTX USD renderer; RTX GPU required |
| `ovstream` | See `dependencies/nvidia-runtime.md` | Streaming runtime |
| `ov-web-rtc client` / `@nvidia/ov-web-rtc` | See `dependencies/nvidia-runtime.md` | Browser AppStreamer client for standalone `ovstream` Direct mode; do not use alternate package names, hard-coded client versions, or Kit/OVC/NVCF/GFN client connection profiles |
| `ovui` | See `dependencies/nvidia-runtime.md` | Native UI toolkit |
| `ovui-data-adapters` | Install from the same `ovui` package set | Local UI adapter contracts |
| Full editor UI package | Install only when current `ovui` dependency guidance explicitly requires it, from the same `ovui` package set | Full editor widgets |
| `ovstorage` | Install with the selected project manifest or `pip install ovstorage` | Cloud asset browsing and cache sync |
| `ovphysx` | `pip install ovphysx -i https://pypi.nvidia.com` | Physics simulation; check external skills |
| `cad2usd` | External checkout | CAD file conversion to USD |
| `pxr` / OpenUSD | `pip install usd-core` | Use version pins from platform skills |
| `numpy` | `pip install numpy` | Array operations |
| `warp` | `pip install warp-lang` | GPU kernels and CUDA buffer utilities |

## Supplemental Guidance

Use the selected references as the implementation contract. When a dependency
reference provides supplemental documentation, use it to clarify API behavior
without changing the selected viewer architecture.

```text
ovui guidance     -> local UI package setup, widgets, overlays, and native UI conventions
ovstream guidance -> streaming runtime setup, SHM behavior, native input, lifecycle, and the ovstream repo's own skills/samples
ovrtx guidance    -> renderer setup, Python/C API behavior, AOVs, picking, and selection
ovstorage guidance -> resolver and asset management patterns
Clone ovphysx    -> check ovphysx/skills/    -> physics simulation, collider cooking, grab, drop
Clone cad2usd    -> check cad2usd/skills/    -> CAD conversion and batch processing
```
