# ovui API Reference

This reference describes the public surface used by the transform gizmo and the
viewer integration. Names may need small adjustment to match the installed
headers or generated app-local helper names, but the contracts are the important
part.

## Headers

```cpp
#include <ovui/GizmoTypes.h>
#include <ovui/GizmoMath.h>
#include <ovui/TransformGizmo.h>
```

`ovui` is header-only C++17. Consumers should be able to include the headers
without linking an extra library.

## Core Types

```cpp
namespace ovui {

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;
};

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

struct Mat4x4 {
    float m[4][4] = {};
};

enum class Tool {
    Translate,
    Rotate,
    Scale,
};

enum class Axis {
    None,
    X,
    Y,
    Z,
    XY,
    XZ,
    YZ,
    XYZ,
};

}
```

Keep these types plain and cheap to copy. They are used every frame by hit
testing, projection, and rendering setup.

## Pointer Input

An overlay interaction object should receive pointer coordinates relative to the
viewport image:

```cpp
struct PointerEvent {
    Vec2 position;
    Vec2 delta_pixels;
    bool primary_down = false;
    bool primary_pressed = false;
    bool primary_released = false;
};
```

The viewer is responsible for mapping from ImGui window coordinates to viewport
coordinates before calling `ovui`.

## Hit Results

```cpp
struct AxisHit {
    Axis axis = Axis::None;
    float distance_pixels = std::numeric_limits<float>::max();
    float depth = 0.0f;

    explicit operator bool() const {
        return axis != Axis::None;
    }
};
```

Hit tests should prefer the nearest visible handle in screen space. Use depth to
break ties when two handles overlap.

## Drag State

```cpp
struct DragState {
    bool active = false;
    Tool tool = Tool::Translate;
    Axis axis = Axis::None;
    Vec2 start_pointer;
    Vec2 last_pointer;
    Vec3 origin_world;
    Vec3 axis_world;
    float pixels_per_world_unit = 1.0f;
};
```

Store both the original drag anchor and the previous pointer position. Translate
tools should apply incremental deltas from `last_pointer`.

## TransformGizmo Contract

The transform gizmo owns current tool state, hover state, drag state, and the
target transform being edited.

```cpp
class TransformGizmo {
public:
    void set_tool(Tool tool);
    Tool tool() const;

    void set_target_transform(const Transform& transform);
    const Transform& target_transform() const;

    bool handle_pointer(
        const PointerEvent& pointer,
        const CameraState& camera,
        const Viewport& viewport);

    bool is_hovered() const;
    bool is_dragging() const;
    bool just_started_dragging() const;
    bool just_finished_dragging() const;
    bool transform_changed() const;

    Axis hovered_axis() const;
    Axis active_axis() const;
};
```

Return value of `handle_pointer`:

- `true`: the gizmo consumed the pointer for hover or drag, so the viewer should
  skip camera orbit.
- `false`: the pointer is available for normal viewport controls.

## Scene Write Callback

If a callback is used, keep it generic:

```cpp
using WriteTransformFn = std::function<void(const Transform&)>;

gizmo.set_write_transform_callback([&](const ovui::Transform& transform) {
    writePrimTransform(selectedPrimPath, transform);
});
```

Do not include USD path or stage types in the core `ovui` API unless the library
is deliberately becoming USD-specific.

## Math Helpers

Useful helpers in `GizmoMath.h` include:

```cpp
Mat4x4 inverse(const Mat4x4& matrix);
Mat4x4 perspective(float fovYRadians, float aspect, float nearZ, float farZ);
Mat4x4 translate(const Vec3& value);
Mat4x4 rotate(const Vec3& axis, float radians);
Mat4x4 scale(const Vec3& value);

Vec2 project_to_screen(
    const Vec3& world,
    const Mat4x4& viewProjection,
    const Viewport& viewport);

float compute_pixels_per_world_unit(
    const CameraState& camera,
    const Vec3& worldPosition,
    const Viewport& viewport);
```

Use the same projection matrix for math helpers and GL rendering.

## Callback Timing

For real-time manipulation:

```cpp
bool consumed = gizmo.handle_pointer(pointer, camera, viewport);

if (gizmo.transform_changed()) {
    writePrimTransform(selectedPath, gizmo.target_transform());
}
```

The viewer should write while dragging, not only on release, so ovrtx can render
the edited scene immediately.
