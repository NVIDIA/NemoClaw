# GL Viewport Overlay Architecture

The transform gizmo implementation uses three layers. Keep the same separation
for new overlay tools so rendering, interaction, and viewer integration remain
testable in isolation.

## Layer 1: `ovui` Header-Only Interaction Library

Suggested extraction layout for generated C++ overlay projects:

```text
clients/cpp-gizmo/include/ovui/
  GizmoTypes.h
  GizmoMath.h
  TransformGizmo.h
```

Responsibilities:

- Store lightweight math and interaction types (`Vec2`, `Vec3`, `Mat4x4`,
  `Tool`, `Axis`, `DragState`, `AxisHit`).
- Project world-space handles to screen-space.
- Hit test axes, rings, and handles.
- Convert pointer drags into transform updates.
- Expose callbacks so the viewer can write results back to USD.

`ovui` does not own OpenGL state and does not know how the viewer displays the
final image. That keeps it useful for other frontends or tests.

## Layer 2: OpenGL Overlay Renderer

Suggested C++ viewer location if you add the GL renderer:

```text
viewers/cpp-imgui/gizmo_gl.h
```

Responsibilities:

- Compile a GL 3.3 Core shader program.
- Generate procedural overlay meshes:
  - cylinders for translation shafts
  - cones for arrow heads
  - torus rings for rotation
  - cubes for scale handles
- Shade 3D handles with simple Phong lighting so depth and orientation are
  readable.
- Attach the ovrtx output texture to an FBO and draw directly into it.
- Scale the overlay by camera distance so it stays stable on screen.

The renderer should receive camera matrices and widget state from the caller.
It should not own camera controls or USD editing.

## Layer 3: C++ ImGui Viewer Integration

Current C++ viewer integration location:

```text
viewers/cpp-imgui/main.cpp
```

Responsibilities:

- Update ovrtx and upload the current frame into an OpenGL texture.
- Ask the overlay interaction layer whether pointer input is consumed.
- Block camera orbit while the overlay is hovering or dragging.
- Pause animation on grab and resume it on release.
- Call scene write callbacks during active edits.
- Render the overlay into the ovrtx texture before `ImGui::Image`.

The typical frame order is:

```cpp
pollInput();
updateCameraUnlessOverlayConsumedInput();
renderOrUploadOvrtxFrame(outputTexture);
renderOverlayToTexture(outputTexture);
drawViewportImage(outputTexture);
```

## Data Flow

```text
ImGui pointer state
    -> ovui hit testing and drag update
    -> writePrimTransform callback
    -> ovrtx scene update
    -> ovrtx frame upload to GL texture
    -> GL overlay FBO pass into the same texture
    -> ImGui viewport image
```

For passive overlays, omit the hit-test and scene-write steps:

```text
USD/world data -> overlay renderer -> ovrtx texture -> ImGui viewport image
```

## State Ownership

Keep ownership boundaries explicit:

- `main.cpp` owns viewer state, camera state, animation state, and USD write
  callbacks.
- `ovui::TransformGizmo` owns interaction state such as active tool, hovered
  axis, drag start, and drag deltas.
- `GizmoRenderer` owns GL objects and draw-time configuration.
- ovrtx owns the path-traced image and the output texture content before the
  overlay pass.

This split prevents the overlay renderer from becoming a second viewer.

## Adding a New Overlay Type

Use the same structure for new overlays:

1. Put reusable tool logic in `ovui` if it is not tied to OpenGL.
2. Put mesh generation, shaders, and FBO compositing in a small renderer.
3. Wire the renderer and interaction object from `main.cpp`.
4. Keep USD writes behind callbacks so interaction code can be tested without a
   live stage.

Examples:

- Measurement ruler:
  - `ovui`: pick points, snap mode, distance calculation.
  - GL renderer: line strip, endpoint handles, label anchor markers.
  - viewer: author or display measurement metadata.
- Annotation pins:
  - `ovui`: hit test projected pin positions and drag anchors.
  - GL renderer: billboard marker and leader line.
  - viewer: edit annotation text and target prim path.
- Bounding box overlay:
  - `ovui`: optional corner hit testing.
  - GL renderer: box edges and face tint.
  - viewer: read selected prim bounds.
