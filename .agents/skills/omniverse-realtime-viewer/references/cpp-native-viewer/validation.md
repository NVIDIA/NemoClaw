# C++ Validation

## Critical Gotchas

- **Import/load order:** In C++ set environment variables such as
  `OVRTX_SKIP_USD_CHECK=1` before creating the renderer or loading mixed USD
  plugins. In embedded or hybrid apps, do not load a mismatched OpenUSD/PXR
  runtime before the OVRTX runtime.
- **Single-thread rule:** One owner thread calls `ovrtx_step()`, stage
  reset/load, result mapping, pick enqueue, and `ovrtx_write_attribute()`.
  GLFW/ImGui callbacks should update pending state only.
- **No concurrent stage mutation:** Do not call `ovrtx_step()` while resetting
  the stage, loading a new USDA string, or changing render products.
- **Map lifetime:** Map render vars, copy data, unmap, then destroy results.
  Never keep `DLTensor` pointers or mapped output views across frames.
- **BGRA to RGBA:** Normalize mapped `LdrColor` to the format used by
  `glTexSubImage2D()`. If the mapped C output is BGRA, swap red and blue before
  uploading as `GL_RGBA`.
- **Render var mapping:** Match C output names by source name. Display uses
  `"LdrColor"`. Native pick results use `OVRTX_RENDER_VAR_PICK_HIT`/
  `"ovrtx_pick_hit"`. Do not expose AOVs that do not map to real full-resolution
  tensors.
- **Camera updates:** Write `omni:xform` with
  `OVRTX_SEMANTIC_XFORM_MAT4x4`. Do not rely on USD `xformOp:*` edits for live
  camera movement.
- **Selection setup:** Native outlines require renderer config plus non-zero
  per-prim `OVRTX_ATTR_NAME_SELECTION_OUTLINE_GROUP` values.
- **EffectLayer scope:** `inputs:Fader` is a material effect. It is not the
  default selection path and only works for known material shader prims.
- **First frame cost:** Cold shader/pipeline compilation can make the first
  `ovrtx_step()` slow. Use long validation timeouts before diagnosing a hang.

## Expected Project Shape

A generated C++ ImGui viewer should contain equivalent pieces:

| File | Role |
|---|---|
| `src/main.cpp` | GLFW/ImGui lifecycle, OVRTX render loop, texture upload, picking, selection |
| `include/camera.h` / `src/camera.cpp` | Orbit camera math and mouse input |
| `include/session_layer.h` | Inline USDA session/composite layer generation |
| `CMakeLists.txt` | CMake, FetchContent, `OVRTX_DIR`, ImGui/GLFW/OpenGL link setup |

Keep generated app code scoped to the patterns above and the selected OVRTX C
API aliases.

## Validation Checklist

- [ ] CMake config finds `OVRTX_DIR`, GLFW, ImGui, and OpenGL.
- [ ] App starts with a real display and an NVIDIA GPU.
- [ ] Inline session layer opens the requested USD stage.
- [ ] First `LdrColor` frame maps on CPU and appears in `ImGui::Image()`.
- [ ] OpenGL upload displays correct red/blue channel ordering.
- [ ] Orbit, dolly, and wheel update the camera through `omni:xform`.
- [ ] Click coordinates are converted to render product pixels.
- [ ] `ovrtx_enqueue_pick_query()` runs before `ovrtx_step()`.
- [ ] `OVRTX_RENDER_VAR_PICK_HIT` is decoded through the path dictionary.
- [ ] Selected prims get group `1`; previous prims get group `0`.
- [ ] EffectLayer faders toggle only for known material targets.
- [ ] Selection animation writes finite `omni:xform` matrices and restores on deselect.

See also: `ovrtx-rendering`, `stage-loading`, `viewer-input-routing`, `camera-controls`,
`native-picking-selection`, `selection-feedback`, `prim-pick-effects`,
`selection-animation`, `stage-hierarchy`, and `streaming-vs-local`.
