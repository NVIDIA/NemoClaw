# ovrtx Rendering

## Triggers

Use this skill for `ovrtx`, `renderer.step`, `step_async`, `LdrColor`, AOVs, render vars, `HdrColor`, `NormalSD`, RenderProduct resolution, `write_attribute`, `omni:xform`, `OVRTX_BIN_PATH`, magenta materials, or RenderApi errors.

ovrtx is a headless RTX renderer driven from Python. The app owns the render loop, camera updates, frame extraction, and any streaming/display handoff.

For ovrtx renderer behavior, Python/C API behavior, release notes, or behavior
not covered here, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

## Core API

```python
from ovrtx import Renderer, RendererConfig, Device, Semantic, PrimMode

renderer = Renderer(config=RendererConfig(
    sync_mode=True,
    active_cuda_gpus="0",
    keep_system_alive=True,
))
print(renderer.version)
renderer.open_usd("/path/to/composite.usda")
products = renderer.step(render_products={"/Session/Render/Viewport"}, delta_time=1.0 / 60.0)
with products as ctx:
    product = ctx["/Session/Render/Viewport"]
```

`sync_mode=True` blocks until the GPU frame is complete. Async pipelines can use `False`, but then buffer lifetime and frame readiness need explicit care.

`renderer.step()` returns `RenderProductSetOutputs`, not a Python `dict`. It supports `[]`, `in`, `keys()`, `values()`, and `items()`, but not `.get()` or `.update()`. Some installed builds also support context-manager cleanup. Generated code should use context-manager cleanup when `__enter__` is available, and otherwise consume the mapping-like result directly while copying required frame data before the next step.

`renderer.step_async()` enqueues the same frame work and returns an `Operation`. Poll `op.query_status()` from the runtime owner when you need the render loop to stay responsive, then call `op.wait()` before reading `RenderProductSetOutputs`. Do not mutate the stage while a step operation is in flight.

## Stage Composition APIs

ovrtx 0.3 uses explicit stage composition:

- `renderer.open_usd(path)` replaces the active root layer with a file/URL.
- `renderer.open_usd_from_string(usda)` replaces the active root layer with generated inline USDA, commonly a wrapper root with `subLayers` and viewer-owned camera/render prims.
- `renderer.add_usd_reference(path, prefix_path="/Runtime/Asset")` adds referenced content under an existing root stage and returns a handle.
- `renderer.add_usd_reference_from_string(usda, prefix_path="/Runtime/Asset")` is the inline-string additive-reference path.
- `renderer.remove_usd(handle)` removes additive content by handle.
- `renderer.reset_stage()` clears the stage to empty. It is not needed for normal root replacement because `open_usd*` replaces the root.

Do not use older implicit stage-addition APIs as the main load path in 0.3 docs or examples.

## Frame Extraction

```python
products = renderer.step(render_products={RENDER_PRODUCT_PATH}, delta_time=dt)
with products as ctx:
    if RENDER_PRODUCT_PATH in ctx:
        product = ctx[RENDER_PRODUCT_PATH]
        for frame in product.frames:
            if "LdrColor" in frame.render_vars:
                with frame.render_vars["LdrColor"].map(device=Device.CUDA) as rv:
                    rgba_cuda = wp.from_dlpack(rv)  # H x W x 4, channel-last
                with frame.render_vars["LdrColor"].map(device=Device.CPU) as rv:
                    pixels = np.from_dlpack(rv).copy()  # H x W x 4 RGBA
```

CUDA mapping exposes linear CUDA memory. CPU mapping transfers data to host. For local UI, copy inside the map context before returning.

A 0.3 render variable output can contain one or more named tensors plus named params. For single-tensor outputs such as `LdrColor`, use the mapped object itself as the DLPack producer (`np.from_dlpack(rv)` / `wp.from_dlpack(rv)`). For multi-tensor outputs, address tensors by name (`rv["Coordinates"]`, `rv["Intensity"]`) and params through `rv.params["hitCount"]`. Do not write new code against older single-tensor convenience access.

C maps an `ovrtx_render_var_output_t` with `ovrtx_map_render_var_output()`. Iterate its `tensors[]` and `params[]` by name; do not assume tensor index `0` is the only payload unless the RenderVar contract says it is.

## Frame Result Lifetime

`RenderProductSetOutputs`, products, frames, mapped render var outputs, and tensor wrappers are per-step views into ovrtx-owned output. Map and copy render vars while the owning `RenderProductSetOutputs` object is still alive, inside the same render-loop step that produced them. When the step result supports `__enter__`, use `with products as ctx:` for deterministic cleanup; when it does not, still copy the data before the next `renderer.step()`.

Do not return a `frame`, render var output, mapped tensor, DLPack wrapper, or NumPy/Warp view that still depends on the mapped ovrtx output. Do not hold references to frame data across later `renderer.step()` calls; the next step can invalidate handles from the previous step.

If frame data must move downstream to an encoder, streaming layer, UI bridge, worker queue, or logger, copy it before the step result goes out of scope. For CPU paths, use an owned array such as `np.from_dlpack(rv).copy()`. For CUDA paths, copy into an application-owned persistent CUDA buffer, such as a Warp array allocated outside the map context, before passing that buffer to the next stage.

## Render Product Resolution

Set the viewer-owned RenderProduct `resolution` in the session or composite layer before loading the stage. The render product path must be the same path passed to `renderer.step(render_products={...})`.

Browser-streamed Omniverse Realtime Viewer apps should keep this resolution fixed, typically 1920x1080, and let the browser display the video with `object-fit: contain`. ovrtx does not expose a `renderer.resize()` API, and ovstream encoders should not be treated as live-resizable.

## Render Vars And AOVs

The render product controls which AOVs ovrtx attempts to produce:

```usda
def RenderProduct "ViewportTexture0"
{
    rel camera = </OVCamera>
    rel orderedVars = [
        </Render/Vars/LdrColor>,
        </Render/Vars/HdrColor>,
        </Render/Vars/Depth>,
        </Render/Vars/Normal>,
        </Render/Vars/InstanceSeg>,
        </Render/Vars/SemanticSeg>,
        </Render/Vars/Metallic>,
        </Render/Vars/Roughness>,
        </Render/Vars/Emissive>,
        </Render/Vars/Diffuse>,
        </Render/Vars/Specular>,
        </Render/Vars/AO>,
        </Render/Vars/DirectDiffuse>,
        </Render/Vars/DirectSpecular>,
        </Render/Vars/IndirectDiffuse>,
        </Render/Vars/IndirectSpecular>,
        </Render/Vars/MotionVectors>,
    ]
}

def RenderVar "Normal"
{
    uniform string sourceName = "NormalSD"
}
```

`frame.render_vars` is keyed by source name, not necessarily by `RenderVar` prim name. For example, the `RenderVar "Normal"` prim appears as `NormalSD` in Python.

Common displayable AOVs for viewer apps:

| AOV key | Tensor | Notes |
|---|---|---|
| `LdrColor` | `uint8 [H,W,4]` | Tonemapped RGBA; swap R/B for ovstream BGRA |
| `HdrColor` | `uint16 [H,W,4]` | Linear HDR exposed as fp16 bits in `uint16`; display with approximate tonemap |
| `NormalSD` | `uint32 [H,W,4]` | Screen-space normals exposed as packed float bit patterns |
| `InstanceSegmentationSD` | `uint32 [H,W,1]` | Instance IDs; display/debug AOV, colorize for inspection |
| `SemanticSegmentationSD` | `uint32 [H,W,1]` | Semantic IDs; display/debug AOV, colorize for inspection |

All image tensors are channel-last `[H, W, C]`; scalar lanes are `[H, W, 1]`, not `[H, W]`. The composite stage can request more render vars for future use, but do not expose them until they map to real non-empty data.

## AOV Discovery

Discover available display AOVs from real frame output, then filter through a conservative allowlist.

```python
DISPLAY_AOVS = (
    "LdrColor",
    "HdrColor",
    "NormalSD",
    "InstanceSegmentationSD",
    "SemanticSegmentationSD",
)

def _update_available_aovs(self, render_vars: Any, notify: bool = False) -> None:
    names = set(render_vars.keys()) if hasattr(render_vars, "keys") else set(render_vars)
    available = {name for name in DISPLAY_AOVS if name in names}
    if not available:
        available = {"LdrColor"}
    self._available_aovs = available
```

Log the full `render_vars` key list once when investigating new ovrtx versions, but use the allowlist for UI state. Presence in `render_vars` does not guarantee that mapping succeeds or that the tensor is non-empty.

## AOV Conversion

ovstream expects one BGRA8 CUDA image. Convert every selected AOV into a persistent `wp.uint8 [H,W,4]` buffer:

```python
with fout.render_vars[aov_name].map(device=Device.CUDA) as rv:
    # Single-tensor output. For multi-tensor outputs, use rv["TensorName"].
    src = wp.from_dlpack(rv)
    shape = tuple(int(dim) for dim in src.shape)
    height, width = shape[0], shape[1]
    channels = shape[2] if len(shape) >= 3 else 1
    dtype = src.dtype
    dim = (width, height)

    if dtype == wp.uint8 and len(shape) == 3 and channels == 4:
        wp.copy(self._stream_buf, src)
        wp.launch(_swap_rb, dim=dim, inputs=[self._stream_buf], device="cuda:0")
        return True

    if dtype == wp.uint32 and len(shape) == 3 and channels == 1:
        wp.launch(_colorize_seg_3d, dim=dim, inputs=[src, self._stream_buf], device="cuda:0")
        return True
```

Include kernels for `uint8`, `uint16`, `uint32`, `float32`, and `float16`,
with channel-last scalar, RGB, and RGBA forms. See `aov-switching` for the full
dispatch rules.

## Live Attribute Writes

ovrtx consumes Fabric attributes such as `omni:xform`; standard authored USD `xformOp:*` is not the live update path.

```python
xforms = np.array([...], dtype=np.float64).reshape(n, 4, 4)
renderer.write_attribute(
    prim_paths=paths,
    attribute_name="omni:xform",
    tensor=xforms,
    semantic=Semantic.XFORM_MAT4x4,
    prim_mode=PrimMode.CREATE_NEW,
    data_access=0,  # 0=ASYNC for GPU tensors, 1=SYNC for CPU numpy
)
```

`PrimMode.EXISTING_ONLY` silently skips attributes not already registered. Use `CREATE_NEW` for camera, animation, and EffectLayer attributes that may not exist in Fabric yet.

## Renderer Config And Process State

Set renderer-wide behavior at construction time:

- `sync_mode=True` keeps `step()` blocking until the frame is complete. Use `step_async()` for responsive loops that can poll an `Operation`.
- `active_cuda_gpus="0"` or `"0,1"` restricts which CUDA-visible devices ovrtx can use. Values are indices into `CUDA_VISIBLE_DEVICES`.
- `keep_system_alive=True` keeps the ovrtx system initialized across idle/reset periods, which is useful for long-running viewers that replace stages repeatedly. Choose the value once at renderer creation.

The ovrtx logging callback is process-global state, not renderer-owned state. Install it once during process startup if the app needs to route ovrtx logs into its logger. Avoid registering a different callback per request, per viewer tab, or per renderer instance; in multi-viewer processes the last process-global registration is the one that matters.

## First-Run Shader Compilation

The first `renderer.step()` on a cold machine or fresh cache can take 2-5 minutes while RTX pipelines and shaders compile. Treat this as a normal first-run cost before assuming the process is hung.

Use a longer timeout for first validation and CI runs, at least 300 seconds for the first rendered frame. Check the ovrtx log for shader or pipeline compilation progress before killing the process. GPU utilization can show 0% during parts of shader compilation because the work may be CPU-side, driver-side, or CUDA compute rather than graphics utilization.

Subsequent steps are usually fast once the shader cache is populated. If every run pays the full cold-start cost, check the local cache configuration in `dependencies` and make sure the cache directory is writable and persistent for the intended environment.

## Schema Registration And Path Dictionary

ovrtx runtime population is schema-driven. Built-in stage data such as Cameras, RenderProducts, RenderVars, `omni:xform`, pickability, and selection-outline attributes use ovrtx-supported schemas. If an app depends on custom authored attributes, register the schema before loading the stage, or opt in with root-layer `customLayerData.populateAllAuthoredAttributes = true` when broad authored-attribute population is acceptable. The broad flag can significantly increase memory usage.

Path and token IDs returned by C queries or pick-hit buffers are not user-facing strings. Resolve them through the renderer path dictionary (`ovrtx_get_path_dictionary()` and path-dictionary utilities). Python high-level stage queries return path strings, while Python pick-hit decoding uses `Renderer.resolve_prim_path_id()`.

## Geometry Streaming

For USD assets, prefer `open_usd*` and `add_usd_reference*` composition. Use geometry streaming only for runtime-generated geometry or high-frequency geometry updates that are owned by the application. Keep schemas registered before streaming attributes, keep stream ownership/lifetime explicit, and continue to render with ovrtx; do not replace this with browser-side geometry rendering.

## Multi-GPU

`RendererConfig(active_cuda_gpus="0,1")` enables multiple CUDA-visible GPUs for rendering, subject to the installed ovrtx build and RenderProduct configuration. Per-RenderProduct `uint[] deviceIds = [...]` is an allow-list into `CUDA_VISIBLE_DEVICES`; use it when a product must run on a specific device.

For WebRTC streaming and Warp conversion, keep the selected display RenderProduct on the CUDA device used by the stream buffer or add an explicit copy. Picking currently requires the picking RenderProduct to run on CUDA-visible GPU `0`; pin pick products with `deviceIds = [0]` when multi-GPU rendering is enabled.

## Environment

```bash
export OVRTX_SKIP_USD_CHECK=1
export OVRTX_BIN_PATH="$(python3 -c 'import ovrtx, os; print(os.path.join(os.path.dirname(ovrtx.__file__), "bin"))')"
export LD_LIBRARY_PATH="$OVRTX_BIN_PATH/plugins${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

If a separate USD build is present, ovrtx's bundled USD/plugins must resolve first or USD debug symbols can be registered twice (`SDF_ASSET` fatal errors).

## Import Order

Use one import discipline per process:

- Streaming/direct ovrtx server: set `OVRTX_SKIP_USD_CHECK`, construct `Renderer`, then import `pxr` if direct queries are needed.
- Lightweight local Omniverse Realtime Viewer and OvGear paths: import `pxr`
  first, then let local renderer/adapter code import ovrtx as documented in
  `local-viewer` and ovui guidance.
- Windows streaming path: keep `pxr` in a subprocess; do not import it in the ovrtx process.

The reason is USD plugin registry ownership. Mixing `usd-core` and ovrtx's bundled USD in the wrong order can cause MDL resolver failures, `_tf` DLL import failures, or duplicate symbol crashes.

## Minimal Render Example

```python
import os
import numpy as np
from PIL import Image
os.environ["OVRTX_SKIP_USD_CHECK"] = "1"
from ovrtx import Renderer, RendererConfig, Device

renderer = Renderer(config=RendererConfig(sync_mode=True))
renderer.open_usd("/path/to/composite.usda")
for _ in range(60):
    products = renderer.step(render_products={"/Render/RenderProduct"}, delta_time=1/60)
    with products as ctx:
        product = ctx["/Render/RenderProduct"]
        for frame in product.frames:
            if "LdrColor" in frame.render_vars:
                with frame.render_vars["LdrColor"].map(device=Device.CPU) as rv:
                    Image.fromarray(np.from_dlpack(rv).copy()).save("output.png")
```

## MDL Material Resolution

ovrtx bundles MDL assets under `ovrtx/bin/library/mdl/`, including `Base/OmniPBR.mdl`, `Base/OmniGlass.mdl`, and `mdl/nvidia/core_definitions.mdl`. Without `OVRTX_BIN_PATH` pointing at `ovrtx/bin`, materials importing `::OmniPBR::OmniPBR` or `::nvidia::core_definitions::*` can render magenta.

UJITSO "multi-node material unsupported" warnings are informational if the full MDL compiler can find the library. They become a problem when `OVRTX_BIN_PATH` or `LD_LIBRARY_PATH` is wrong.

## Common Errors

| Symptom | Cause | Fix |
|---|---|---|
| `CRenderApi not found` | plugin tree missing | set `OVRTX_BIN_PATH` |
| `multiple debug symbol definitions for SDF_ASSET` | two USD instances | put ovrtx bundled libs first |
| `usd-core detected` | version check conflict | set `OVRTX_SKIP_USD_CHECK=1` |
| `Default.mdl` parse crash | renderer initialized after wrong USD registry | fix import/construction order |
| `RenderProductSetOutputs` has no `.get` | treated `renderer.step()` output as a dict | use `with products as ctx:` and `ctx[path]` |
| `AttributeError: __enter__` from `with products as ctx:` | installed step result is mapping-like but not a context manager | branch on `hasattr(products, "__enter__")`, consume directly when absent, and copy frame data before the next step |
| invalid output handle after returning frame data | frame or render var view outlived its `RenderProductSetOutputs` | copy inside the same step before the context exits |
| first `renderer.step()` appears hung | cold RTX shader or pipeline compilation | use a 300s+ first-run timeout and inspect ovrtx logs |
| `write_attribute` does nothing | missing Fabric attr with default mode | use `PrimMode.CREATE_NEW` |
| transform not visible | wrote `xformOp:transform` | write `omni:xform` with semantic |
| `Semantic.XFORM_MAT4x4` becomes `NONE` | imported adapter implementation module `_ovrtx` | `import ovrtx` directly |
| single-tensor examples fail or hide data | 0.3 render vars can be multi-tensor | use `np.from_dlpack(rv)` or named tensors such as `rv["TensorName"]` |
| AOV listed but blank | ovrtx produced empty tensor | enable PT flags, check source name |
| `Depth` mapping fails | wrong source name | use `DepthSD` not `Depth` |
| `Diffuse` empty/fails | wrong source name | use `DiffuseAlbedoSD` not `Diffuse` |
| `Roughness` mapping fails | unsupported in current ovrtx build | do not expose |
| red/blue swapped in browser | streamed RGBA directly | convert to BGRA before `stream_video()` |
| magenta materials | MDL resolver path missing | set `OVRTX_BIN_PATH` and plugin `LD_LIBRARY_PATH` |
| stale hangs | old GPU process | inspect `nvidia-smi`, kill stale Omniverse Realtime Viewer PIDs |

See also: `aov-switching`, `stage-loading`, `camera-controls`, `render-settings`, `selection-feedback`, `selection-animation`, `streaming-server`.
