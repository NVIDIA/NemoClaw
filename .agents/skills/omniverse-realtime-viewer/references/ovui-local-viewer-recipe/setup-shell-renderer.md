# ovui Local Setup, Shell, And Renderer

## 2. Install Dependencies And Configure The Environment

*Read `references/dependencies` FIRST.* Its `references/nvidia-runtime.md` file is
the source of truth for NVIDIA runtime locations. Do not guess or repeat `ovui`
package URLs, wheel names, artifact locations, or fallback install commands in
this recipe.

Do this:

- Install `ovrtx` using the package guidance in `references/dependencies`.
- Install `ovui` using the current PyPI package guidance in `references/dependencies`.
- Install any selected local UI companion packages from the same `ovui`
  package set as the base UI package.
- Install `usd-core==24.11` when the local app needs `pxr` queries. Pin to 24.11 — newer versions cause TfType schema conflicts with ovrtx.
- Install `numpy` for matrices, camera math, and CPU frame handling (`pip install numpy`).
- Install `warp-lang` only when the local app needs CUDA-side display or image-processing utilities (`pip install warp-lang`).
- Do not install `ovstream` or frontend streaming packages for a local-only viewer.

Set these environment contracts before starting the app:

- `OVRTX_SKIP_USD_CHECK=1` must be set before ovrtx is imported or the renderer is constructed.
- `OVRTX_BIN_PATH` must point at the ovrtx `bin` directory when materials or renderer plugins fail to resolve.
- The ovrtx plugin library path must be first in the dynamic library path if another USD build is present.
- `PYTHONPATH` must include any `ovui` import paths required by the selected package.
- A real display must be available. For headless validation, use a configured X display such as Xvfb.

Decision points:

- If the local app imports `pxr` in the main process, follow the local import discipline documented in `references/local-viewer`.
- If USD registry or DLL conflicts appear, isolate `pxr` queries into a subprocess and keep the main app focused on ovui plus ovrtx.
- If the user only needs rendering and camera navigation, defer `usd-core` until hierarchy or bounds queries are required.
- If running on Windows, read `references/windows-native-setup` before changing import order or subprocess strategy.
- If local UI imports report missing package metadata or missing
  `VIEWPORT_CAMERA_POSE_SOURCE`, read `references/dependencies` and use one
  compatible local UI package set.

Common failure modes:

- `usd-core detected`, duplicate USD debug symbols, `_tf` import failures, or MDL resolver crashes usually mean import order or library path is wrong.
- Magenta materials usually mean `OVRTX_BIN_PATH` or plugin library path is missing.
- ovui import failure usually means the selected package was not installed or
  its required import path is not on `PYTHONPATH`.
- A blank or crashing local window in CI usually means no real display is available.

Read for depth: see `references/dependencies`, `references/local-viewer`, `references/ovrtx-rendering`, and `references/windows-native-setup` for the full environment contracts.

## 3. Build The ovui Window Shell

Do this in `local_app/app.py` and `local_app/viewport.py`:

- Initialize ovui once with the requested title, width, height, and target FPS.
- Create one main window that fills the app window.
- Use a large central viewport, a compact header or toolbar, an optional scene tree or info sidebar, and an optional render settings panel.
- Put the rendered image inside a viewport frame that can resize with the window.
- Add a transparent hit surface above the image for mouse input.
- Route toolbar actions to runtime commands such as load scene, reload, fit camera, clear selection, toggle tree, and toggle render settings.
- For lightweight viewers, prefer a path field plus one `LOAD` button for scene loading. Add native file dialogs only after they are validated in the same display/session environment as the app.
- Wrap ovui callbacks so exceptions are logged and do not tear down the app loop.

Critical contracts:

- Use `fill_app_window=True` for the main ovui window so the UI frame tracks GLFW window resizes.
- The viewport widget must report its current size or provide a reliable fallback so letterbox math remains valid.
- The transparent mouse surface must be above the image and marked as receiving mouse events.
- Header, tree, info, and settings widgets must not intercept viewport gestures unless the pointer is actually over those controls.
- The app loop must call runtime tick/update work from one predictable place.
- If a selected-prim transform gizmo is visible, dragging it must write the selected prim's live `omni:xform` through the serialized renderer runtime; a visual-only handle is not complete.

Decision points:

- If the user wants a compact visual tool, keep a header plus viewport and place advanced panels in collapsible sidebars.
- If the user wants a dense inspection app, reserve width for a stage tree and prim info panel from the start.
- If the user wants a context menu, show it on right-button release only when the drag threshold was not exceeded.
- If the user wants a camera gizmo, build it as a local ovui scene overlay rather than using streaming overlay patterns.
- If the user wants selected-prim movement in a lightweight shell, either use a proven transform manipulator that emits transform deltas or add an app-owned fallback that treats presses near the selected pivot as transform drags.

Common failure modes:

- Without `fill_app_window=True`, the OS window resizes but the UI frame stays at the initial dimensions.
- If the hit surface is behind the image or not opaque to mouse events, orbit, pan, zoom, and picking never receive input.
- A separate `OPEN` button can be worse than no button if the native dialog is not implemented or cannot appear under the target display stack. Keep the path-field `LOAD` path reliable and make dialogs secondary.
- A selected-prim gizmo that appears but does not move the prim usually means handle input is being consumed by camera/orbit logic or the manipulator is not connected to `renderer.write_attribute`.
- Uncaught callback exceptions can stop the app loop or leave drag state stuck.
- DOM-style browser assumptions do not apply; input comes from ovui callbacks in the desktop process.

Read for depth: see `references/local-viewer`, `references/viewer-input-routing`, `references/camera-controls`, and `references/viewport-overlays` for ovui shell, input routing, context menu, and local overlay guidance.

## 4. Construct The ovrtx Renderer Runtime

Do this in `local_app/renderer_runtime.py`:

- Create the ovrtx renderer after environment variables are set and import order is settled.
- Use synchronous rendering first.
- Store the active render product path, render width, render height, current frame index, and whether a valid stage is loaded.
- Expose render-loop-only operations for loading a scene, resetting the stage, stepping a frame, mapping render vars, enqueueing and decoding native pick queries, writing native selection outline groups, and writing live attributes.
- Keep renderer mutations serialized with scene loading, scene reset, settings changes, and camera writes.

Critical contracts:

- The application calls `renderer.step()` explicitly. ovrtx does not run a hidden app loop for the viewer.
- Pass the exact viewer RenderProduct path to every step call.
- Extract `LdrColor` for local image display. It is RGBA8 from ovrtx.
- For local UI display, copy CPU-mapped pixel data inside the map context before returning it to the widget.
- Use `write_attribute` for live camera transforms and other live state. Write `omni:xform`, not authored `xformOp:*`, for interactive updates.
- Use the correct transform semantic and create-new prim mode for attributes that may not already exist in Fabric.

Decision points:

- If the app only needs basic local viewing, start with `LdrColor` only.
- Object selection uses native ovrtx pick queries. Do not add segmentation render vars just to make picking work.
- If the app needs high-FPS local display, profile CPU readback first before introducing a CUDA-to-UI path.
- If the renderer reports stale GPU hangs after a crash, inspect running Python GPU processes before changing code.

Common failure modes:

- `Unable to find RenderProduct prim` means scene setup did not create the path used by `renderer.step()`.
- Black frame usually means camera relation, render product resolution, render var source, or camera transform is invalid.
- Live camera changes doing nothing usually means the app wrote `xformOp:transform` instead of `omni:xform`, or used existing-only prim mode.
- Crashes during scene switches usually mean `renderer.step()` overlapped a reset, load, or layer mutation.

Read for depth: see `references/ovrtx-rendering` for the full renderer construction, frame extraction, and live attribute contract.

## 5. Implement Scene Loading

Do this in `local_app/scene_loader.py` and call it only from the render loop or serialized runtime load path:

- Resolve the requested URL/path against the configured asset root, allowed schemes, and security policy.
- Create viewer-owned camera, RenderProduct, RenderVar, and RenderSettings data through one inline root/session USDA string when the user stage lacks viewer render config.
- Load the user stage without modifying it.
- Store the viewer camera path and render product path in runtime state.
- Reset selection, native selection outline groups, stage query caches, pending pick queries, and loading status for the new stage.
- Fit the camera to the stage bounds unless the user requested preserving the current camera or using an authored stage camera.

Critical contracts:

- Every loaded stage needs Camera -> RenderProduct -> RenderVar -> RenderSettings wiring that ovrtx can find.
- The viewer camera path must be the same path used by camera controls when writing `omni:xform`.
- Do not inject lights unless the user explicitly asks for viewer-controlled lighting.
- Include segmentation render vars only for explicit debug/AOV display modes, not for picking.
- Prefer `renderer.open_usd_from_string()` for inline roots that sublayer the user USD and author viewer render config.
- Do not call reference or layer-add APIs after a stage is already loaded unless the renderer has been reset to an empty stage and the operation is part of the serialized load path.

Decision points:

- Use a single inline root USDA string with `subLayers = [@user_scene@]` when the user file needs viewer camera/render-product/render-var data.
- If the user stage has an authored camera and the requested policy is `stage-camera`, copy its focal length, apertures, clipping range, and transform into the viewer camera.
- If the user requests persistent camera across scene switches, keep camera state but sanitize and refit only when the old state is invalid for the new bounds.
- If the user requests viewer lighting controls, add explicit viewer-owned light prims only with a verified live apply path or an explicit reload/profile workflow; otherwise leave lighting untouched and omit live lighting controls.

Common failure modes:

- Inline roots that omit or misquote the user sublayer path fail composition or break relative asset resolution.
- Camera path mismatch makes input appear connected but the view never moves.
- A stage-load operation that reports an error must not be treated as a successful load just because the enqueue call returned.

Read for depth: see `references/stage-loading`, `references/render-settings`, `references/selection-feedback`, and `references/stage-hierarchy` for the full scene setup contract.

## 6. Display The Rendered Image

Do this in `local_app/viewport.py`:

- Create an `ImageBridge` with the render width and height.
- Display the bridge provider through an ovui image widget using preserve-aspect fit.
- Before connecting ovrtx output, push a synthetic RGBA gradient through the
  same provider path and capture a window screenshot proving the native widget
  paints nonblank, non-solid pixels.
- On each rendered frame, update the bridge with copied RGBA pixels from `LdrColor`.
- Compute the visible image rectangle inside the viewport widget after every resize.
- Store the current widget size, visible image offset, visible image size, render width, and render height for input mapping.
- Show explicit idle, loading, and error states when no frame should be displayed.

Critical contracts:

- The ovrtx `LdrColor` buffer is RGBA8 and is suitable for local image display through `ImageBridge`.
- Copy CPU-mapped pixel data while the render var map context is still open.
- Preserve-aspect display creates letterboxing. All pick and camera coordinates must pass through the same letterbox transform.
- If render resolution changes, recreate or resize all dependent state: render product, `ImageBridge`, letterbox math, pending pick coordinate state, and viewport overlays.
- Do not run scene load/reset work while the image update is reading render output.
- A nonblank direct `LdrColor` artifact plus a blank ovui window points at
  presentation, not scene setup. Fix or switch the ovui presentation path before
  changing camera, render product, or USD composition.
- If `ImageBridge` or `ByteImageProvider` updates do not paint in the active
  ovui runtime, validate with another ovui-native presentation path such as a
  `RasterImageProvider` screenshot/frame fallback instead of continuing to
  debug renderer state.

Decision points:

- If the target is a simple viewer, keep render resolution fixed and let the image widget scale with letterboxing.
- If the target requires pixel-perfect viewport resolution, treat resize as an explicit render product reconfiguration path.
- If the app needs a screenshot command, read from the same copied `LdrColor` frame used by display unless a higher-quality render path is requested.
- If CPU readback is too slow, investigate a GPU-native UI path only after the basic Omniverse Realtime Viewer is correct.

Common failure modes:

- Reading pixels after the map context closes returns invalid or stale data.
- Ignoring letterboxing makes picks offset and camera drag speed inconsistent.
- Recreating the image bridge on every frame causes flicker, memory churn, or UI stalls.
- Changing render resolution without updating viewport math and pick query coordinates causes selection to drift.
- A solid red, brown, or unexpectedly light background can be a style-color byte
  order problem. ovui integer colors are `0xAARRGGBB`.

Read for depth: see `references/local-viewer`, `references/ovrtx-rendering`, and `references/object-selection` for image bridge, frame extraction, and coordinate mapping details.
