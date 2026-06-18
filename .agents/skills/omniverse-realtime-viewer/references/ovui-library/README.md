# ovui Overlay Helper Skill

Use this skill when implementing validated gizmo interaction math as app-local
header-only C++17 overlay helpers for the ovrtx C++ viewer. The helpers follow
`ovui` conventions and own interaction math and tool behavior, not OpenGL
rendering or USD authoring.

Use `transform-manipulator`, `gl-viewport-overlay`, and
`tauri-shm-transform-gizmo` for the shared projection, hit-testing,
input-priority, and drag-math contracts. The reusable app-local C++ interaction
layer uses this header layout:

```text
clients/cpp-gizmo/include/ovui/
  GizmoTypes.h
  GizmoMath.h
  TransformGizmo.h
```

## What Belongs in App-Local Overlay Helpers

Add logic to the app-local overlay helpers when it is:

- reusable across viewer frontends
- independent of OpenGL state
- independent of ImGui widgets
- independent of concrete USD authoring APIs
- testable with only camera, pointer, and transform inputs

Good examples:

- transform gizmo hit testing and drag math
- screen projection helpers
- pixels-per-world-unit calculations
- measurement endpoint interaction
- annotation pin picking
- bounding box handle picking

Keep these outside the app-local overlay helpers:

- shader compilation
- VAO/VBO/FBO ownership
- ImGui panel layout
- direct USD stage edits
- ovrtx frame upload

## Typical Usage

```cpp
ovui::TransformGizmo gizmo;
gizmo.set_tool(ovui::Tool::Translate);
gizmo.set_target_transform(selectedTransform);

ovui::PointerEvent pointer;
pointer.position = pointerInViewport;
pointer.delta_pixels = mouseDelta;
pointer.primary_pressed = ImGui::IsMouseClicked(ImGuiMouseButton_Left);
pointer.primary_down = ImGui::IsMouseDown(ImGuiMouseButton_Left);
pointer.primary_released = ImGui::IsMouseReleased(ImGuiMouseButton_Left);

bool consumed = gizmo.handle_pointer(pointer, cameraState, viewport);

if (gizmo.transform_changed()) {
    writePrimTransform(selectedPrimPath, gizmo.target_transform());
}

if (!consumed) {
    orbitCamera.handle_pointer(pointer);
}
```

## Required Camera Convention

Overlay projection and hit testing must use the ovrtx camera intrinsics:

```cpp
constexpr float kFocalLength = 18.15f;
constexpr float kHorizontalAperture = 20.955f;
float verticalAperture = kHorizontalAperture / viewportAspect;
float fovY = 2.0f * std::atan(verticalAperture / (2.0f * kFocalLength));
```

Using a generic 45 degree orbit-camera FOV in the overlay helpers will
desynchronize hit testing from the GL-rendered overlay.

## Drag Math Rule

For translation-like tools, prefer incremental deltas:

```cpp
float pixelsPerUnit = ovui::compute_pixels_per_world_unit(camera, origin, viewport);
float units = ovui::dot(pointer.delta_pixels, axisScreen) / pixelsPerUnit;
transform.translation += axisWorld * units;
```

Refresh `pixelsPerUnit` each frame. Do not rely on total mouse movement from
drag start when perspective scale can change during the drag.

## Extension Workflow

1. Define small types in the style of `GizmoTypes.h`.
2. Add math helpers to `GizmoMath.h` only when they are generic.
3. Build tool state and pointer handling in a focused class.
4. Return `true` from pointer handling when the tool consumes input.
5. Report scene edits through callbacks or returned state, not direct USD calls.
6. Add rendering separately in the viewer or overlay renderer.

## References

- [API Reference](api-reference.md)
- [Extending App-Local Overlay Helpers](extending.md)
