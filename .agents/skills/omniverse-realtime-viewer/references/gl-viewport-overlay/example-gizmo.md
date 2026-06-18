# Example: Transform Gizmo Walkthrough

This walkthrough adapts the shared transform gizmo behavior from the Python
ovui, WebRTC overlay, and Tauri SHM paths into a C++ ImGui overlay shape. Use it
as an implementation recipe for a C++ overlay.

## 1. Define Interaction Types

`GizmoTypes.h` contains small types that do not depend on OpenGL or USD:

```cpp
namespace ovui {

enum class Tool { Translate, Rotate, Scale };
enum class Axis { None, X, Y, Z, XY, XZ, YZ, XYZ };

struct AxisHit {
    Axis axis = Axis::None;
    float distance_pixels = std::numeric_limits<float>::max();
    float depth = 0.0f;
};

struct DragState {
    bool active = false;
    Tool tool = Tool::Translate;
    Axis axis = Axis::None;
    Vec2 last_pointer;
    Vec3 origin_world;
    Vec3 axis_world;
    float pixels_per_world_unit = 1.0f;
};

}
```

The same pattern works for other overlays. A measurement tool might replace
`Axis` with `EndpointId`; an annotation tool might use `PinId`.

## 2. Project Handles to Screen

`GizmoMath.h` provides projection helpers used by both hit testing and drag
math:

```cpp
ovui::Vec2 screen = ovui::project_to_screen(
    handlePositionWorld,
    viewProjection,
    {0.0f, 0.0f, float(viewportWidth), float(viewportHeight)});
```

Use the ovrtx projection parameters here. If hit testing uses a different FOV
than rendering, the highlighted axis will not match the visible mesh.

## 3. Hit Test the Gizmo Before Camera Input

`TransformGizmo::handle_pointer` checks hover and drag state and returns whether
the gizmo consumed the event:

```cpp
ovui::PointerEvent pointer;
pointer.position = pointerInViewport;
pointer.delta_pixels = pointerDelta;
pointer.primary_down = mouseDown;
pointer.primary_pressed = mousePressed;
pointer.primary_released = mouseReleased;

bool consumed = gizmo.handle_pointer(pointer, cameraState, viewport);

if (!consumed) {
    orbitCamera.handle_pointer(pointerInViewport, pointerDelta);
}
```

This first-refusal pattern is what prevents transform edits from fighting camera
orbit.

## 4. Translate with Incremental Deltas

The final translate behavior uses current-frame mouse deltas and a refreshed
pixels-per-world-unit value:

```cpp
float pixelsPerUnit = compute_pixels_per_world_unit(
    camera,
    drag.origin_world,
    viewportHeight,
    verticalFovRadians);

float units = dot(pointer.delta_pixels, drag.axis_screen) / pixelsPerUnit;
transform.translation += drag.axis_world * units;
drag.pixels_per_world_unit = pixelsPerUnit;
```

The earlier absolute-delta approach looked plausible but drifted under
perspective projection because the screen scale changed during the drag.

## 5. Render Meshes with GL 3.3 Core

`gizmo_gl.h` owns the procedural rendering path:

```cpp
renderer.drawCylinder(axisShaftMesh, model, axisColor);
renderer.drawCone(axisArrowMesh, arrowModel, axisColor);
renderer.drawTorus(rotationRingMesh, ringModel, ringColor);
renderer.drawCube(scaleHandleMesh, cubeModel, handleColor);
```

The shader uses Phong-style lighting so rings, cones, and cubes read as 3D
objects instead of flat UI strokes:

```glsl
vec3 normal = normalize(v_normal);
vec3 lightDir = normalize(u_light_dir);
float diffuse = max(dot(normal, lightDir), 0.0);
vec3 color = u_color.rgb * (0.35 + 0.65 * diffuse);
fragColor = vec4(color, u_color.a);
```

## 6. Composite Into the ovrtx Texture

The renderer attaches the ovrtx output texture to a framebuffer:

```cpp
glBindFramebuffer(GL_FRAMEBUFFER, fbo);
glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, outputTexture, 0);
glViewport(0, 0, viewportWidth, viewportHeight);
```

Before drawing, it applies the Y-flipped projection:

```cpp
ovui::Mat4x4 projection = makeOvrtxProjection(viewportWidth, viewportHeight);
projection.m[1][0] = -projection.m[1][0];
projection.m[1][1] = -projection.m[1][1];
projection.m[1][2] = -projection.m[1][2];
projection.m[1][3] = -projection.m[1][3];
```

The overlay pass runs after ovrtx frame upload and before ImGui displays the
texture.

## 7. Keep the Gizmo Stable on Screen

The gizmo model scale is tied to camera distance and FOV:

```cpp
float gizmoScale =
    distance(camera.position, gizmo.origin) *
    std::tan(verticalFovRadians * 0.5f) *
    kGizmoScreenFraction;
```

This gives Blender/Unity-style handle behavior: zooming changes scene detail
without making the editor control unusably large or small.

## 8. Write USD Transforms During Drag

The viewer owns USD authoring. The gizmo only reports transform changes:

```cpp
if (gizmo.is_dragging()) {
    writePrimTransform(selectedPrimPath, gizmo.target_transform());
}
```

Write continuously during drag so ovrtx updates the rendered scene in real time.
When the drag ends, keep the final authored value and release pointer capture.

## 9. Launch From the Asset Directory

USD stages often reference assets with relative paths such as `materials/` and
`textures/`. Launch the viewer with CWD set to the stage asset directory that
contains those folders, matching the stage file's relative asset layout. If the
model appears untextured after adding the overlay, check CWD before debugging
rendering code.

## Reusing This Pattern

For a measurement overlay:

- Replace axes with endpoints and a segment.
- Hit test projected endpoint markers.
- Drag endpoints with incremental screen-to-world deltas.
- Render line geometry and endpoint handles into the ovrtx texture.

For annotation pins:

- Project pin anchors into screen-space.
- Give pins first priority on click and drag.
- Render leader lines in GL and text in ImGui.
- Keep USD metadata writes behind callbacks.
