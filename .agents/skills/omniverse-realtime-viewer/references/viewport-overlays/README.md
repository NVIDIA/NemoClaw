# Viewport Overlays

## Triggers

Use this skill for viewport overlay, camera gizmo overlay, ovui overlay, headless ovui, floating panel, composite overlay, or PrimInfoPanel.

Use this for server-side ovui overlays rendered in headless Vulkan mode, alpha-composited over the ovrtx frame, and streamed through ovstream. For local inline overlays, also read `local-viewer`, `viewer-input-routing`, `camera-controls`, and `prim-info-display`.

For interactive translate/rotate/scale gizmos or object manipulators, read `transform-manipulator`. That skill owns gizmo math, hit testing, input priority before camera controls, USD xform authoring, and the local numpy-frame drawing path.

## Frame Path

```text
Browser input -> MessageHandler.on_input
  -> OvuiInputBridge (consume if over gizmo/panel or dragging)
  -> ovui SceneView gestures
  -> OrbitCamera.orbit_delta()

ovrtx renderer.step() -> LdrColor CUDA RGBA8
  -> copy/swap to stream BGRA buffer
  -> overlay.update_screen_position(view, proj)
  -> standalone._tick_one_frame()
  -> headless_frame.wait_ready -> copy_to_linear -> signal_consumed
  -> OvuiCudaComposite.blend_over(stream_buf)
  -> ovstream.VideoFrame.from_cuda_array(stream_buf)
```

## Reference Files

- `server/ovui_overlay/__init__.py`: exports overlays and `world_to_screen`.
- `server/ovui_overlay/camera_gizmo.py`: `OrbitGizmoOverlay` and shared overlay window.
- `server/ovui_overlay/input_bridge.py`: ovstream-to-ovui mouse translation and consume logic.
- `server/ovui_overlay/cuda_composite.py`: Warp RGBA-over-BGRA blend kernel.
- `server/ovui_overlay/prim_info_panel.py`: floating prim info panel and projection.
- `server/ov_web_viewer_server.py`: `--ovui-camera-gizmo`, init/tick/composite/shutdown.
- `server/message_handler.py`: input routing, `setCameraGizmo`, prim info updates.

## Current Overlays

- Camera orbit gizmo: 120x120 bottom-right trackball ring, hover highlight, DragGesture to `orbit_delta`.
- Prim info panel: dark translucent panel, appears on single-select, tracks prim world center, hides on click-off or behind-camera depth, shows name/path/type/translate/rotate/scale/material.
- Transform manipulator: use `transform-manipulator` for selected-prim translate/rotate/scale gizmos; this overlay skill only covers the shared headless ovui frame/composite plumbing.

## Add A Widget

1. Create a class under `server/ovui_overlay/`.
2. Use one shared ovui Window with a ZStack layout; multiple windows break headless export.
3. Position screen-space widgets with `ui.Placer`.
4. Add `contains(x, y)` for input hit testing.
5. Wire `show/hide/update` from `message_handler.py` or the server.
6. For world anchors, call `world_to_screen()` every frame before ticking ovui.

```python
sx, sy, depth = world_to_screen(point_3d, view_matrix, proj_matrix, viewport_w, viewport_h)
if depth < 0:
    widget.hide()
```

`camera.get_view_matrix()` returns a column-major 4x4 with translation in column 3; the helper handles row/column translation detection by norm check.

## Environment

Activate the selected `ovui` package as described in `references/dependencies`.
Set these environment variables before importing `omni.ui`:

```bash
export OMNIUI_HEADLESS=1
export OMNIUI_BACKEND=vulkan
export OVRTX_SKIP_USD_CHECK=1
```

Read `references/dependencies` for the current `ovui` PyPI package guidance.
Do not hard-code direct wheel URLs or action artifact links in this overlay skill.
For ovui headless overlay or widget behavior beyond the patterns below, read
`references/dependencies` for acquisition guidance and supplemental dependency
documentation.

## ovui Runtime Requirement

The selected `ovui` package must support headless Vulkan rendering and
transparent overlay export. If the available package produces an opaque overlay
or does not expose headless frame export, treat that as an `ovui` package
mismatch and resolve it through `references/dependencies`. Keep the requested
server-side overlay in scope; do not silently switch delivery paths or omit the
overlay.

## Gotchas

- `libglfw3-dev` is required even with `OMNIUI_HEADLESS_ONLY`.
- `DragGesture` objects must be created once in `__init__` and reused.
- Headless frame order is `wait_ready -> copy_to_linear -> signal_consumed`.
- ovui exports RGBA8 while stream buffers are BGRA8; blend kernels must handle channels.
- Skip failing `byte_image_gpu_test` by building explicit targets.
- Disable software cursor with `standalone.set_software_cursor(False)` after `standalone.init()`.
- `imgui.ini` is runtime state and must stay gitignored.
- Input bridge must consume while dragging even outside gizmo bounds.
- `PrimInfoPanel.contains()` returns False when hidden.
- Feature should remain behind `--ovui-camera-gizmo`; server runs normally without it.

See also: `transform-manipulator`, `prim-info-display`, `viewer-input-routing`, `camera-controls`, `streaming-server`, `local-viewer`.
