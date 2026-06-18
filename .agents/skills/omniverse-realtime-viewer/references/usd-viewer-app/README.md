# Omniverse Realtime Viewer App

## Triggers

Use this skill for Omniverse Realtime Viewer, visualize USD, 3D viewport, inspect USD files, pick objects, switch scenes, render settings, or generic Omniverse Realtime Viewer requests that should be routed to more focused references.

Use this meta-skill first for broad app requests. It does not replace the focused references; it tells you which ones to read and in what order.

## ⛔ Rendering Constraint

**ALL 3D/USD rendering MUST use `ovrtx` (NVIDIA RTX renderer, server-side or in-process).** ovrtx requires an NVIDIA GPU. Do not use WebGL, Three.js, Babylon.js, PlayCanvas, A-Frame, `<model-viewer>`, react-three-fiber, or any client-side 3D rendering library. The browser displays a `<video>` element receiving a WebRTC stream from the server; it never renders 3D geometry directly. Do NOT substitute a browser renderer.

For ovrtx renderer behavior, Python/C API behavior, or release-specific notes
beyond this viewer skill package, read `references/dependencies` for acquisition
guidance and supplemental dependency documentation.

## Streaming Recipe

Use this recipe when the user asks for browser access, remote GPUs, WebRTC, service deployment, or co-viewing. Read:

1. `streaming-viewer-recipe` as the end-to-end browser-streamed entry point.
2. `streaming-server` for server setup, frame streaming, input callbacks, and RGBA-to-BGRA conversion.
3. `streaming-client` for the React/AppStreamer standalone `ovstream` Direct connection, video display, and UI state.
4. `streaming-messages` for JSON data-channel messages and shared protocol contracts.
5. `streaming-lifecycle` for connection timing, envelope unwrapping, initial-state push, and exact event names.
6. `ovrtx-rendering` for renderer construction, stepping, frame extraction, environment setup, and `write_attribute`.
7. `stage-loading` for camera/render-product/session USDA setup and user-stage wrapping.
8. `viewer-input-routing` for WebRTC/native input normalization, viewport ownership, and click-vs-drag dispatch.
9. `camera-controls` for orbit, pan, zoom, camera fitting, row-major camera matrices, and camera gizmo controls.
10. `native-picking-selection`, `object-selection`, and `selection-feedback` for picking and visual selection state.
11. `transform-manipulator` and `prim-transform-safety` if the user asks to move selected prims or use translate/rotate/scale gizmos.
12. `prim-info-display`, `stage-attribute-reads`, `stage-hierarchy`, and `stage-queries` for properties, hierarchy data, native prim discovery, variants, and bounds.
13. `stage-management` and `render-settings` for scene switching, quality controls, lighting, and persisted settings.
14. `viewport-overlays` if overlays are rendered server-side with headless ovui and composited into the WebRTC frame.

## Local Recipe

Use this recipe when the user asks for a desktop viewer running on the GPU workstation without browser streaming. Read:

1. `ovui-local-viewer-recipe` as the end-to-end local desktop entry point.
2. `local-viewer` for the standalone ovui shell, image display, resize handling, and mouse capture surface.
3. `ovrtx-rendering` for renderer construction, stepping, frame extraction, environment setup, and `write_attribute`.
4. `stage-loading` for camera/render-product/session USDA setup and user-stage wrapping.
5. `viewer-input-routing` for ovui/native input normalization, viewport ownership, and click-vs-drag dispatch.
6. `camera-controls` for orbit, pan, zoom, camera fitting, row-major camera matrices, and camera gizmo controls.
7. `native-picking-selection`, `object-selection`, and `selection-feedback` for picking and visual selection state.
8. `transform-manipulator` and `prim-transform-safety` if the user asks to move selected prims or use translate/rotate/scale gizmos.
9. `prim-info-display`, `stage-attribute-reads`, `stage-hierarchy`, and `stage-queries` for properties, hierarchy data, native prim discovery, variants, and bounds.
10. `stage-management` and `render-settings` for scene switching, quality controls, lighting, and persisted settings.

## Intent Routing

For full user-intent routing, read `AGENTS.md` § Intent-Based Routing. This
skill only chooses the first delivery recipe for broad viewer requests:

- Browser or remote viewing: start with `streaming-viewer-recipe`.
- Local Python desktop viewing: start with `ovui-local-viewer-recipe`.
- Tauri / Rust / React desktop viewing: start with `tauri-local-viewer`.
- Electron or separate-process local viewing: start with `electron-shm-viewer`.
- Unsure between local and streaming: start with `streaming-vs-local`.

## Build Order

Start with the delivery method. If the user is unsure, read `streaming-vs-local` and decide before writing app code. Keep shared logic below the shell boundary: stage path resolution, settings persistence, camera math, picking helpers, property queries, and renderer setup should be plain Python modules where possible.

For local apps, build the shell first, then renderer/session loading, then camera, then selection, then info/settings/scene switching. For streaming apps, build the server render loop and client connection before adding app-specific message handlers.

## Decision Tree

```text
Delivery method?
|
+- Browser/web -> READ: streaming-viewer-recipe + streaming-server + streaming-client + streaming-messages + streaming-lifecycle
+- Electron local app / SHM viewer / separate-process local -> READ: electron-shm-viewer
+- Desktop/local (React UI, no Python) -> READ: tauri-local-viewer
+- Desktop/local (Python, simple) -> READ: ovui-local-viewer-recipe + local-viewer + ovrtx-rendering + stage-loading
+- Both/unsure -> READ: streaming-vs-local first
```

## Critical Cross-Cutting Rules

- Set `OVRTX_SKIP_USD_CHECK=1` before importing or constructing ovrtx components.
- `ovrtx` owns the render loop: the app calls `renderer.step()` explicitly.
- The camera is a USD prim. Orbit/pan/zoom writes `omni:xform`, not raw view matrices.
- Selected-prim transform gizmos must write the selected prim's live `omni:xform`; a visible handle without prim movement is not done.
- Session/render wrapper USDA should not inject fallback lights unless the user explicitly wants lighting overrides; stages usually own their lighting.
- Normalize native input through `viewer-input-routing`: WebRTC `ovstream.MouseButton` values are `LEFT=1`, `MIDDLE=2`, and `RIGHT=3`, and browser-streamed apps should default the viewport input gate to active when the stream surface is the native input source.
- Load-time EffectLayer `inputs:Fader = 0` is mandatory because ovrtx does not run the OmniGraph network that normally drives glow.
- Never call `renderer.step()` concurrently with `open_usd()`, `open_usd_from_string()`, reference add/remove APIs, or `reset_stage()`.
- Browser-streamed Omniverse Realtime Viewer apps use a fixed server render resolution and display the stream with `object-fit: contain`; NVST handles letterbox coordinate mapping.
- If renderer validation hangs after a crash, inspect `nvidia-smi` and kill only stale Python Omniverse Realtime Viewer processes.

## Validation

For the target prompt in `REFACTOR_TASK.md`, routing should select: `usd-viewer-app`, `ovui-local-viewer-recipe`, `local-viewer`, `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `camera-controls`, `native-picking-selection`, `object-selection`, `selection-feedback`, `prim-info-display`, `stage-attribute-reads`, `stage-management`, `render-settings`, `stage-hierarchy`, and `stage-queries`.

See also: `streaming-vs-local`, `viewer-input-routing`, `windows-native-setup`, `cloud-assets`, `cloud-deployment`.
