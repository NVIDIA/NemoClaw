# Projection Alignment

Projection alignment is the difference between an overlay that feels attached to
the USD scene and one that drifts during interaction. The GL overlay pass must
use the same camera intrinsics as ovrtx.

## Use ovrtx Intrinsics

The working gizmo uses these camera parameters:

```cpp
constexpr float kFocalLength = 18.15f;
constexpr float kHorizontalAperture = 20.955f;
```

Derive vertical aperture from the viewport aspect:

```cpp
float aspect = float(viewportWidth) / float(viewportHeight);
float verticalAperture = kHorizontalAperture / aspect;

float fovX = 2.0f * std::atan(kHorizontalAperture / (2.0f * kFocalLength));
float fovY = 2.0f * std::atan(verticalAperture / (2.0f * kFocalLength));
```

Do not use a generic orbit camera FOV such as 45 degrees for overlay rendering
or hit testing. That mismatch usually appears as a small offset while idle and a
large drift while dragging.

## Projection Matrix

Use a standard perspective matrix built from the ovrtx vertical FOV and the
current viewport aspect:

```cpp
ovui::Mat4x4 makeOvrtxProjection(int width, int height, float nearZ, float farZ) {
    float aspect = float(width) / float(height);
    float verticalAperture = 20.955f / aspect;
    float fovY = 2.0f * std::atan(verticalAperture / (2.0f * 18.15f));
    return ovui::Mat4x4::perspective(fovY, aspect, nearZ, farZ);
}
```

Use the same projection for:

- GL overlay rendering.
- `ovui::project_to_screen`.
- Axis and handle hit testing.
- Pixels-per-world-unit calculations.

## Required Y-Flip for FBO Compositing

ovrtx renders the output image top-down. The GL overlay pass renders into an FBO
using OpenGL's bottom-up framebuffer convention. When attaching the ovrtx output
texture and drawing overlay geometry into it, negate projection row 1:

```cpp
ovui::Mat4x4 overlayProjection = makeOvrtxProjection(width, height, nearZ, farZ);

overlayProjection.m[1][0] = -overlayProjection.m[1][0];
overlayProjection.m[1][1] = -overlayProjection.m[1][1];
overlayProjection.m[1][2] = -overlayProjection.m[1][2];
overlayProjection.m[1][3] = -overlayProjection.m[1][3];
```

Symptoms when this is missing:

- The overlay appears vertically mirrored.
- Hit testing selects the opposite side of the widget.
- Rotation rings line up only when the target is near the viewport center.

Keep this flip local to the render-to-texture pass. Screen-space UI and pointer
math should continue to use the coordinate convention expected by `ovui`.

## Viewport Cropping and UV Math

If ImGui displays only a sub-rectangle of the ovrtx texture, the projection and
pointer coordinates must use that same rectangle. Use the visible viewport size,
not the backing texture size, for aspect and screen projection:

```cpp
ImVec2 imageMin = ImGui::GetCursorScreenPos();
ImVec2 imageSize = computeViewportImageSize();

ovui::Vec2 pointer = {
    io.MousePos.x - imageMin.x,
    io.MousePos.y - imageMin.y,
};

bool inside =
    pointer.x >= 0.0f && pointer.x < imageSize.x &&
    pointer.y >= 0.0f && pointer.y < imageSize.y;
```

When showing a crop of the texture, pass matching UVs to ImGui:

```cpp
ImVec2 uv0 = ImVec2(cropX0 / textureWidth, cropY0 / textureHeight);
ImVec2 uv1 = ImVec2(cropX1 / textureWidth, cropY1 / textureHeight);
ImGui::Image((ImTextureID)(intptr_t)outputTexture, imageSize, uv0, uv1);
```

Then render the overlay with the same crop dimensions and pointer mapping. A
common failure mode is using full texture dimensions for the overlay while ImGui
displays a letterboxed or cropped image.

## Constant Screen-Size Scaling

Editor handles are usually easier to use when they stay roughly the same size on
screen. Scale the overlay model by distance and FOV:

```cpp
float modelScale =
    distance(cameraPosition, targetPosition) *
    std::tan(verticalFovRadians * 0.5f) *
    kScreenFraction;
```

Use one `kScreenFraction` per overlay family. For example, a transform gizmo may
use a larger fraction than an annotation pin.

## Verification Checklist

- The overlay stays attached to the prim at wide, square, and tall aspect
  ratios.
- The overlay stays attached while the camera orbits.
- Dragging does not introduce a growing offset.
- The overlay appears in the same place before and after resizing the viewport.
- A one-pixel pointer move near the target produces a reasonable world-space
  delta at both near and far zoom levels.
