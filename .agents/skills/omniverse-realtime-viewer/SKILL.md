---
name: omniverse-realtime-viewer
description: "Use as the top-level router for Omniverse Realtime Viewer USD app requests and focused viewer reference documents."
version: "0.1.0"
license: Apache-2.0
tools:
  - Read
  - Shell
  - Write
compatibility: >
  Orchestrator skill. Downstream focused references may require NVIDIA GPUs, ovrtx,
  ovstream, ovui, OpenUSD, Python, Node/React, Tauri, Electron, C++, or cloud
  GPU deployment access depending on the selected viewer path.
metadata:
  author: NVIDIA Omniverse
  tags:
    - omniverse
    - usd
    - viewer
    - workflow
  domain: ai-ml
  languages:
    - python
    - typescript
    - cpp
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Omniverse Realtime Viewer

This is the top-level entry point for the Omniverse Realtime Viewer skill package.
It is self-contained: all required routing, conventions, and validation
guidance live in the selected references.

Use the focused reference documents as implementation recipes. This file chooses the
right recipes and preserves the architectural rules that must hold across all
generated viewer apps.

## Instructions

Start by classifying the requested viewer, then read only the references needed
for that delivery path and feature set. Implement the render path first, layer
interaction and UI behavior on top of it, and finish by capturing validation
evidence from `references/validation.md`.

## Read Order

1. Read `references/routing.md` to choose the delivery path and focused references.
2. Read `references/conventions.md` before implementing camera, input,
   selection, viewport, streaming protocol, scene loading, or environment
   behavior.
3. For broad viewer requests, read `references/usd-viewer-app/README.md`.
4. If the delivery path is unclear, read `references/streaming-vs-local/README.md`.
5. If the prompt includes layout, panels, controls, inspectors, status, or UX,
   read `references/viewer-ux-workflow/README.md` and then the focused viewer UI references.
   This applies to React/WebRTC, Tauri, Electron, `ovui`, `ovwidgets`, and Dear
   ImGui apps; "frontend" means user-facing UI, not only browser UI.
6. For viewport interaction, read `references/viewer-input-routing/README.md` before
   `references/camera-controls/README.md`, `references/native-picking-selection/README.md`, or `references/object-selection/README.md`.
7. Read only the focused capability references needed for the requested app.
8. Use `references/validation.md` to capture review evidence before handoff.

## Non-Negotiables

- Use `ovrtx` for all USD and 3D rendering.
- Browser apps display an `ovstream` WebRTC video stream plus UI. The browser
  does not render USD geometry.
- Do not substitute WebGL, Three.js, Babylon.js, PlayCanvas, A-Frame,
  model-viewer, react-three-fiber, glTF browser viewers, or other client-side
  3D renderers.
- If local validation cannot run because the GPU/runtime environment is absent,
  scaffold the `ovrtx` path and document the runtime requirement. Do not add a
  browser-renderer fallback.
- Keep user USD files unmodified. Viewer cameras, render products, render vars,
  settings, selection metadata, and runtime state belong in session/composite
  layers or app state.
- Keep one owner for `renderer.step()`, stage mutation, native picking,
  selection writes, and live attribute writes.
- Keep dependency acquisition in `references/dependencies/README.md` and deployment choices in
  `references/cloud-deployment/README.md`; do not duplicate package locations or deployment setup.

## Focused Reference Families

- Entry points and recipes: `references/usd-viewer-app/README.md`, `references/streaming-viewer-recipe/README.md`,
  `references/ovui-local-viewer-recipe/README.md`, `references/streaming-vs-local/README.md`, `references/electron-shm-viewer/README.md`,
  `references/ovwidgets-editor-shell/README.md`.
- Rendering and stage: `references/ovrtx-rendering/README.md`, `references/stage-loading/README.md`, `references/stage-management/README.md`,
  `references/render-settings/README.md`, `references/aov-switching/README.md`, `references/stage-hierarchy/README.md`, `references/stage-queries/README.md`,
  `references/stage-attribute-reads/README.md`, `references/prim-transform-safety/README.md`, `references/usd-sample-data/README.md`.
- Delivery and runtime: `references/streaming-server/README.md`, `references/streaming-client/README.md`,
  `references/streaming-messages/README.md`, `references/streaming-lifecycle/README.md`, `references/local-viewer/README.md`,
  `references/tauri-local-viewer/README.md`, `references/cpp-native-viewer/README.md`, `references/headless-shm-cli/README.md`,
  `references/viewer-backend-interface/README.md`, `references/webgl-shm-transport/README.md`.
- Viewer UI/UX: `references/viewer-ux-workflow/README.md`, `references/viewer-layout-patterns/README.md`,
  `references/viewer-control-patterns/README.md`, `references/viewer-data-view-patterns/README.md`,
  `references/viewer-feedback-status/README.md`.
- Interaction: `references/viewer-input-routing/README.md`, `references/camera-controls/README.md`,
  `references/object-selection/README.md`, `references/native-picking-selection/README.md`, `references/selection-feedback/README.md`,
  `references/selection-animation/README.md`, `references/transform-manipulator/README.md`, `references/gl-viewport-overlay/README.md`,
  `references/ovui-library/README.md`, `references/prim-pick-effects/README.md`, `references/prim-info-display/README.md`,
  `references/viewport-overlays/README.md`.
- Infrastructure: `references/dependencies/README.md`, `references/windows-native-setup/README.md`, `references/cloud-assets/README.md`,
  `references/cloud-deployment/README.md`, `references/troubleshooting/README.md`.

## Build Workflow

1. Classify the prompt by delivery path, target user, required capabilities,
   runtime environment, validation needs, and explicit constraints.
2. Select a small reference set. Start with the recipe or routing reference, then add
   focused capabilities such as camera, picking, hierarchy, properties, render
   settings, transform tools, cloud assets, or deployment.
3. Read selected references before writing app code. Follow their build order,
   import order, data-channel contracts, and renderer ownership rules.
4. Implement the core render path first, then input routing and camera, then
   selection and data panels, then scene/settings features, then packaging or
   deployment.
5. Treat the selected references as the behavior contract for API shape,
   compatibility, and generated project structure.
6. Capture validation evidence before calling the viewer ready.

## Examples

- For a browser viewer request, use the streaming recipe references plus camera,
  picking, hierarchy, properties, render settings, and stream-status references.
- For a local workstation viewer request, use the local or native delivery
  references plus renderer setup, stage loading, viewport input, and validation.

## Completion Checklist

- Selected references match the user's intent and delivery path.
- No code path uses a browser-side 3D renderer for USD.
- The generated app has one clear owner for render stepping and stage mutation.
- User USD files remain untouched by viewer-owned session data.
- Camera, input, selection, scene loading, and stream behavior follow
  `references/conventions.md`.
- Setup/build/run results and visual interaction evidence are captured with
  `references/validation.md`.
