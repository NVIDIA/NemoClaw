# GL Viewport Overlay Skill

Use this skill when adding a GPU-rendered 3D overlay to the ovrtx C++ ImGui
viewer. The overlay can be a transform gizmo, measurement ruler, bounding box,
annotation pin, selection outline, axis tripod, or any other world-space widget
that must line up with the rendered USD scene.

For ovrtx-owned C++ renderer behavior, projection behavior, texture handoff, or
native viewer details not covered here, read `references/dependencies` for
acquisition guidance and supplemental dependency documentation.

This skill adapts the shared transform-gizmo projection, hit-testing,
input-priority, and drag-math constraints to a C++ ImGui path. The C++ overlay
files are generated-app implementation files; create them when the app needs
GL-rendered viewport overlays.

The core pattern is:

1. Build a small overlay renderer that owns its OpenGL resources.
2. Render the overlay into the ovrtx output texture after the ovrtx frame upload.
3. Use the exact ovrtx projection parameters, including the FBO Y-flip.
4. Let overlay interaction consume pointer input before camera controls see it.

## Quick Start: Colored Axis Indicator

This minimal overlay draws three colored world-space axes at a target transform.
It is intentionally simpler than the transform gizmo: no hit testing, no drag
state, just GL geometry composited into the viewport texture.

```cpp
struct AxisOverlay {
    GLuint fbo = 0;
    GLuint vao = 0;
    GLuint vbo = 0;
    GLuint program = 0;

    void initialize() {
        glGenFramebuffers(1, &fbo);

        // position.xyz, color.rgb
        const float vertices[] = {
            0, 0, 0, 1, 0, 0,   1, 0, 0, 1, 0, 0,
            0, 0, 0, 0, 1, 0,   0, 1, 0, 0, 1, 0,
            0, 0, 0, 0, 0, 1,   0, 0, 1, 0, 0, 1,
        };

        glGenVertexArrays(1, &vao);
        glGenBuffers(1, &vbo);
        glBindVertexArray(vao);
        glBindBuffer(GL_ARRAY_BUFFER, vbo);
        glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(float) * 6, (void*)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(float) * 6, (void*)(sizeof(float) * 3));

        program = createAxisShaderProgram();
    }

    void renderToViewportTexture(
        GLuint ovrtxTexture,
        int width,
        int height,
        const ovui::Mat4x4& view,
        const ovui::Mat4x4& ovrtxProjection,
        const ovui::Mat4x4& targetWorld,
        float cameraDistance,
        float verticalFovRadians) {

        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, ovrtxTexture, 0);
        glViewport(0, 0, width, height);

        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glDisable(GL_DEPTH_TEST);

        ovui::Mat4x4 projection = ovrtxProjection;
        projection.m[1][0] = -projection.m[1][0];
        projection.m[1][1] = -projection.m[1][1];
        projection.m[1][2] = -projection.m[1][2];
        projection.m[1][3] = -projection.m[1][3];

        const float screenFraction = 0.12f;
        const float modelScale = cameraDistance * std::tan(verticalFovRadians * 0.5f) * screenFraction;
        ovui::Mat4x4 model = targetWorld * ovui::Mat4x4::scale({modelScale, modelScale, modelScale});
        ovui::Mat4x4 mvp = projection * view * model;

        glUseProgram(program);
        glUniformMatrix4fv(glGetUniformLocation(program, "u_mvp"), 1, GL_FALSE, &mvp.m[0][0]);
        glBindVertexArray(vao);
        glLineWidth(3.0f);
        glDrawArrays(GL_LINES, 0, 6);

        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }
};
```

Call it from the viewer after the ovrtx frame is available and before ImGui
draws the image:

```cpp
uploadOvrtxFrameToTexture(outputTexture);

if (showAxisOverlay) {
    axisOverlay.renderToViewportTexture(
        outputTexture,
        viewportWidth,
        viewportHeight,
        camera.viewMatrix(),
        makeOvrtxProjection(viewportWidth, viewportHeight),
        selectedPrimWorldTransform,
        distance(camera.position(), selectedPrimPosition),
        makeOvrtxVerticalFov(viewportWidth, viewportHeight));
}

ImGui::Image((ImTextureID)(intptr_t)outputTexture, ImVec2(viewportWidth, viewportHeight));
```

## Non-Negotiable Alignment Rules

### Match ovrtx Projection

Do not use the orbit camera's 45 degree FOV for overlays. The overlay must use
the same camera model as ovrtx:

```cpp
constexpr float kFocalLength = 18.15f;
constexpr float kHorizontalAperture = 20.955f;

float aspect = float(viewportWidth) / float(viewportHeight);
float verticalAperture = kHorizontalAperture / aspect;
float fovY = 2.0f * std::atan(verticalAperture / (2.0f * kFocalLength));
```

If this does not match, the overlay may appear correct while idle but drift away
from the USD primitive during drag or camera movement.

### Flip Y for FBO Compositing

ovrtx and OpenGL disagree about image origin in this path. When rendering into
the ovrtx output texture via an FBO, negate projection row 1:

```cpp
projection.m[1][0] = -projection.m[1][0];
projection.m[1][1] = -projection.m[1][1];
projection.m[1][2] = -projection.m[1][2];
projection.m[1][3] = -projection.m[1][3];
```

Apply this only for the GL overlay pass that writes into the ovrtx texture.
Do not bake the flip into the interaction math unless that code is also using
the composited framebuffer coordinate convention.

### Use Incremental Drag Math

For perspective interactions, avoid recomputing the transform from total mouse
delta since drag start. Recompute `pixels_per_world_unit` for the current camera
and target distance each frame, then apply only the latest mouse movement:

```cpp
float worldDelta = pointer.delta_pixels.x / drag.pixels_per_world_unit;
drag.pixels_per_world_unit = computePixelsPerWorldUnit(camera, drag.current_origin);
transform.translation += drag.axis_world * worldDelta;
```

This avoids drift caused by changing perspective scale during the drag.

## Implementation Checklist

1. Define the overlay contract:
   - What world-space data does it draw?
   - Does it need pointer interaction?
   - Should it remain constant size on screen?
2. Add an overlay renderer:
   - Own shader program, VAOs/VBOs, FBO handle, and any procedural meshes.
   - Render into the existing ovrtx output texture.
   - Preserve or restore GL state that the viewer depends on.
3. Align projection:
   - Use `focalLength = 18.15`.
   - Use `horizontalAperture = 20.955`.
   - Derive vertical aperture from viewport aspect.
   - Flip projection row 1 for the FBO overlay pass.
4. Integrate input:
   - Call overlay hit testing or `handle_pointer()` before camera orbit.
   - If the overlay consumes the event, skip camera motion.
   - Freeze animation while actively dragging, then resume on release.
5. Integrate scene writes:
   - For edit tools, apply changes through a callback such as
     `writePrimTransform(path, transform)`.
   - Keep interaction state independent from USD authoring details.
6. Validate:
   - Compare overlay alignment at several zoom levels and viewport sizes.
   - Drag near the camera and far from the camera.
   - Check cropped or resized viewport panels.
   - Launch from the stage asset directory so USD-relative `materials/` and
     `textures/` references resolve the same way they do for the stage file.

## When to Use `ovui`

Use `ovui` for interaction logic that benefits from reusable math and hit
testing. The transform gizmo uses it for projection, axis hits, drag state, and
translation/rotation/scale updates. A passive overlay such as a bounding box can
skip `ovui::TransformGizmo`, but should still reuse the same projection and math
conventions where practical.

## References

- [Architecture](architecture.md)
- [Projection Alignment](projection-alignment.md)
- [Interaction Pattern](interaction-pattern.md)
- [Example Transform Gizmo](example-gizmo.md)
