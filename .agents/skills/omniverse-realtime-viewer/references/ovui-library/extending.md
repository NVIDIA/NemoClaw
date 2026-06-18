# Extending App-Local Overlay Helpers

App-local overlay helpers are the right place for reusable overlay behavior that
is independent of OpenGL and USD. Use this guide when adding new tools such as
measurement overlays, annotation pins, bounding box handles, or custom editor
widgets.

## Extension Rules

1. Keep tool logic renderer-agnostic.
2. Use viewport-relative pointer coordinates.
3. Use the ovrtx projection parameters for every projected hit test.
4. Return whether input was consumed.
5. Use callbacks or returned state for scene edits.
6. Use incremental drag deltas for perspective-sensitive movement.

## Adding a Measurement Tool

A measurement overlay needs two world-space endpoints, hit testing for endpoint
markers, and a distance calculation.

```cpp
struct MeasurementState {
    Vec3 a_world;
    Vec3 b_world;
    int active_endpoint = -1;
    bool dragging = false;
};

class MeasurementTool {
public:
    bool handle_pointer(
        const PointerEvent& pointer,
        const CameraState& camera,
        const Viewport& viewport) {

        Vec2 a = project_to_screen(state_.a_world, camera.view_projection, viewport);
        Vec2 b = project_to_screen(state_.b_world, camera.view_projection, viewport);

        if (pointer.primary_pressed) {
            state_.active_endpoint = pick_endpoint(pointer.position, a, b);
            state_.dragging = state_.active_endpoint >= 0;
        }

        if (state_.dragging && pointer.primary_down) {
            drag_endpoint_incremental(pointer, camera, viewport);
            return true;
        }

        if (pointer.primary_released) {
            state_.dragging = false;
            state_.active_endpoint = -1;
        }

        return near(pointer.position, a) || near(pointer.position, b);
    }

    float distance() const {
        return length(state_.b_world - state_.a_world);
    }

private:
    MeasurementState state_;
};
```

The GL renderer can draw the line and endpoint handles. ImGui can draw the text
label anchored to the projected midpoint.

## Adding Annotation Pins

Annotation pins are usually billboard-like markers anchored to world positions.
Keep picking and dragging in the app-local overlay helpers; keep text layout in
the viewer:

```cpp
struct AnnotationPin {
    uint64_t id = 0;
    Vec3 anchor_world;
};

AxisHit pick_pin(
    const std::vector<AnnotationPin>& pins,
    Vec2 pointer,
    const Mat4x4& viewProjection,
    const Viewport& viewport);
```

For many pins, project once per frame and cache screen positions. Hit testing can
then operate entirely in screen-space.

## Adding Bounding Box Handles

A box overlay can expose corner, edge, or face handles:

```cpp
enum class BoxHandle {
    None,
    MinX,
    MaxX,
    MinY,
    MaxY,
    MinZ,
    MaxZ,
    Corner,
};
```

Project handle positions and pick the nearest marker under a pixel threshold.
When dragging a face, move only along the face normal. When dragging a corner,
update all affected extents.

## Adding a New Transform Gizmo Tool

When extending `TransformGizmo` itself:

1. Add a new value to `Tool`.
2. Add hit-test logic for the new handles.
3. Add drag state fields only if existing state is insufficient.
4. Add transform update math.
5. Update the GL renderer to draw the new handles.
6. Update the viewer UI to select the tool.

Keep rendering decisions out of `TransformGizmo`. It can report hovered and
active handles, while the renderer decides colors, mesh shapes, and lighting.

## Perspective Drag Helper

Use this helper shape for movement constrained to a world axis:

```cpp
float axis_delta_units(
    const PointerEvent& pointer,
    const Vec3& originWorld,
    const Vec3& axisWorld,
    const CameraState& camera,
    const Viewport& viewport) {

    Vec2 origin = project_to_screen(originWorld, camera.view_projection, viewport);
    Vec2 tip = project_to_screen(originWorld + axisWorld, camera.view_projection, viewport);
    Vec2 axisScreen = normalize(tip - origin);

    float pixelsPerUnit = compute_pixels_per_world_unit(camera, originWorld, viewport);
    return dot(pointer.delta_pixels, axisScreen) / pixelsPerUnit;
}
```

Recompute the screen axis and pixels-per-unit every frame. This is the simplest
way to prevent perspective drift while keeping the implementation understandable.

## Testing New Tools

Unit tests can cover most `ovui` behavior without OpenGL:

- Project known world points and verify expected screen positions.
- Hit test points just inside and outside the pixel threshold.
- Drag with fixed camera data and verify transform deltas.
- Resize the viewport and verify picks still line up.
- Use non-square aspect ratios to catch projection mistakes.

Viewer tests or manual checks should cover:

- GL overlay alignment with the path-traced image.
- Y-flip correctness.
- Camera input blocking during active drags.
- Animation pause and resume behavior.
