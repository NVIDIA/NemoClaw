# Interaction Pattern

Interactive overlays need first priority on viewport input. A transform gizmo,
measurement endpoint, or annotation pin should be able to capture the pointer
without the camera orbiting at the same time.

## Input Priority

Call the overlay interaction handler before camera controls:

```cpp
bool overlayConsumed = false;

if (viewportHovered) {
    ovui::PointerEvent pointer;
    pointer.position = {mouseXInViewport, mouseYInViewport};
    pointer.delta_pixels = {io.MouseDelta.x, io.MouseDelta.y};
    pointer.primary_down = ImGui::IsMouseDown(ImGuiMouseButton_Left);
    pointer.primary_pressed = ImGui::IsMouseClicked(ImGuiMouseButton_Left);
    pointer.primary_released = ImGui::IsMouseReleased(ImGuiMouseButton_Left);

    overlayConsumed = gizmo.handle_pointer(pointer, cameraState, viewport);
}

if (!overlayConsumed) {
    updateOrbitCameraFromMouse(io);
}
```

The important contract is simple: if the overlay returns `true`, skip camera
orbit for that frame.

## Hover, Grab, Drag, Release

Use a small state machine:

```text
idle -> hover -> active drag -> release -> idle
```

For gizmos, the state usually includes:

- hovered axis or handle
- active axis or handle
- drag start transform
- last pointer position
- current pixels-per-world-unit
- whether animation was paused by the drag

For a measurement overlay, replace active axis with active endpoint. For
annotation pins, replace it with active pin id.

## Freeze on Grab

Animated scenes can move underneath the pointer while a user edits a prim. Pause
animation when the overlay begins an edit, then restore the previous animation
state when the edit ends:

```cpp
if (gizmo.just_started_dragging()) {
    animationWasPlayingBeforeDrag = animationPlaying;
    animationPlaying = false;
}

if (gizmo.is_dragging()) {
    writePrimTransform(selectedPath, gizmo.target_transform());
}

if (gizmo.just_finished_dragging()) {
    animationPlaying = animationWasPlayingBeforeDrag;
}
```

This keeps the selected target stable during manipulation and prevents camera or
timeline updates from changing the drag basis.

## Incremental Translation

For perspective scenes, translation should use incremental pointer deltas:

```cpp
if (drag.active && drag.axis == ovui::Axis::X) {
    float pixelsPerUnit = computePixelsPerWorldUnit(camera, drag.current_origin);
    float units = pointer.delta_pixels.x / pixelsPerUnit;
    transform.translation += drag.axis_world * units;
    drag.pixels_per_world_unit = pixelsPerUnit;
}
```

Avoid deriving the transform from `pointer.position - drag.start_position` for
the entire drag. Perspective scale changes as the object moves and as the camera
updates, so absolute start deltas accumulate error.

## Rotation and Scale

Rotation and scale can still use a drag anchor, but should use the current
projected basis:

```cpp
ovui::Vec2 center = ovui::project_to_screen(targetPosition, viewProjection, viewport);
ovui::Vec2 a = normalize(pointer.previous_position - center);
ovui::Vec2 b = normalize(pointer.position - center);

float angleDelta = std::atan2(cross(a, b), dot(a, b));
transform.rotation = ovui::rotate(transform.rotation, drag.axis_world, angleDelta);
```

For scale handles, clamp small values and keep the drag basis stable enough that
the handle does not flip sides when crossing the target origin.

## Scene Write Callback

Keep USD authoring outside the interaction class:

```cpp
gizmo.setWriteTransformCallback(
    [&](const SdfPath& path, const ovui::Transform& transform) {
        writePrimTransform(path, transform);
    });
```

This lets `ovui` stay header-only and testable. It also makes it easier to reuse
the same interaction code for non-USD previews or tools.

## Input Validation Checklist

- Hovering a handle highlights it without moving the camera.
- Pressing a handle starts a drag and pauses animation.
- Dragging updates the selected prim every frame.
- Releasing the mouse resumes the previous animation state.
- Clicking empty viewport space still orbits the camera.
- Pointer coordinates are relative to the displayed viewport image, not the
  application window.
