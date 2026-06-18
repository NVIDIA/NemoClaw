# Stage Loading

## Triggers

Use this skill for load USD, RenderProduct, RenderVar, black frame, composite stage, session layer, camera aspect, open_usd, add_usd_reference, or Unable to find RenderProduct prim.

ovrtx needs a complete render pipeline in the stage: Camera -> RenderProduct -> RenderVar -> RenderSettings. Most user USD files do not include this, so viewers load a generated root/composite stage that sublayers the user scene and authors viewer-owned render prims.

For ovrtx stage composition, render pipeline, or release-specific loading
behavior not covered here, read `references/dependencies` for acquisition guidance
and supplemental dependency documentation.

## ovrtx 0.3 Stage Composition APIs

Use the explicit 0.3 composition APIs:

- `renderer.open_usd(path)` opens a file/URL as the active root layer. Calling it again replaces the previous root layer.
- `renderer.open_usd_from_string(usda)` opens generated inline USDA as the active root layer. Use this for viewer/session USD that sublayers a user scene and adds cameras, RenderProducts, RenderVars, and RenderSettings.
- `renderer.add_usd_reference(path, prefix_path="/SomePrim")` adds referenced content under a prim path after a root stage is already open.
- `renderer.add_usd_reference_from_string(usda, prefix_path="/SomePrim")` is the inline-string equivalent for additive referenced content. Inline referenced layers need a `defaultPrim`.
- `renderer.remove_usd(handle)` removes content added by `add_usd_reference*`.
- `renderer.reset_stage()` clears the runtime stage to empty. It is not required before normal scene replacement because `open_usd*` already replaces the active root layer.

Do not use older implicit stage-addition or anonymous-layer staging patterns for 0.3 stage loading.

## Generated Root Stage Pattern

For local and streamed Omniverse Realtime Viewers, generate one root USDA layer that sublayers the user scene and contains only viewer camera, render product, render vars, and render settings. Do not inject lights here unless the user asked for viewer-controlled lighting and the app exposes a verified lighting capability or explicit reload/profile workflow.

```python
CAMERA_PATH = "/Session/Cameras/Main"
RENDER_PRODUCT_PATH = "/Session/Render/Viewport"

def viewer_root_usda(scene_path: str, width: int, height: int) -> str:
    h_aperture = 20.955
    v_aperture = h_aperture * float(height) / float(width)
    scene_ref = scene_path.replace("\\", "/")
    return f"""#usda 1.0
(
    subLayers = [
        @{scene_ref}@
    ]
    defaultPrim = "Session"
)
def Scope "Session" {{
    def Scope "Cameras" {{ def Camera "Main" {{
        float focalLength = 18.15
        float horizontalAperture = {h_aperture}
        float verticalAperture = {v_aperture}
        float2 clippingRange = (0.01, 10000000)
        token projection = "perspective"
        matrix4d xformOp:transform = ((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1))
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }} }}
    def Scope "Render" {{ def RenderProduct "Viewport" {{
        rel camera = </Session/Cameras/Main>
        rel orderedVars = [</Session/Render/Vars/LdrColor>, </Session/Render/Vars/InstanceSeg>]
        uniform int2 resolution = ({int(width)}, {int(height)})
    }}
    def Scope "Vars" {{
        def RenderVar "LdrColor"
        {{
            uniform string sourceName = "LdrColor"
        }}
        def RenderVar "InstanceSeg"
        {{
            uniform string sourceName = "InstanceSegmentationSD"
        }}
    }} }}
}}
"""
```

```python
renderer.open_usd_from_string(viewer_root_usda(str(stage_path), width, height))
products = renderer.step(render_products={RENDER_PRODUCT_PATH}, delta_time=1 / 60)
with products as ctx:
    product = ctx[RENDER_PRODUCT_PATH]
```

## Direct Frame Validation

For local desktop viewers, always separate renderer validation from native UI
presentation validation. After opening the generated root stage, step the same
RenderProduct path the viewport will use and save a direct `LdrColor` artifact
before debugging the window.

A nonblank direct `LdrColor` frame proves that the generated Camera ->
RenderProduct -> RenderVar wiring is basically working. If the native window is
still black or blank after that, the next suspect is the ovui presentation path,
not the render product path, camera relation, or USD composition.

If the direct frame is blank, continue debugging this skill's concerns: user
sublayer path, camera path, render product path, render var source name,
resolution, camera transform, stage lighting, material/plugin resolution, and
load-operation errors.

## Composite File Pattern

Streaming servers should prefer a wrapper `.usda` written beside the user stage. The wrapper sublayers the user scene, injects the server camera/render product/render vars, and is passed to `renderer.open_usd(composite_path)`. During scene switches, the next `open_usd()` call replaces the previous root stage; do not reset first unless the user explicitly requested an empty stage.

The reference streaming server uses camera path `/OVCamera` and render product path `/Render/OVServer/ViewportTexture0`.

```python
OV_CAMERA_PRIM = "/OVCamera"
OV_RENDER_PRODUCT = "/Render/OVServer/ViewportTexture0"
CAMERA_HORIZONTAL_APERTURE = 20.955

def make_composite_stage(scene_url: str, width=1920, height=1080) -> str:
    scene_ref = scene_url.replace("\\", "/")
    safe_width = max(1, int(width))
    safe_height = max(1, int(height))
    vertical_aperture = CAMERA_HORIZONTAL_APERTURE * float(safe_height) / float(safe_width)
    return f'''#usda 1.0
(
    subLayers = [
        @{scene_ref}@
    ]
)

def Camera "OVCamera"
{{
    float2 clippingRange = (1, 10000000)
    float focalLength = 18.15
    float horizontalAperture = {CAMERA_HORIZONTAL_APERTURE:.3f}
    float verticalAperture = {vertical_aperture:.4f}
    token projection = "perspective"
    double3 xformOp:translate = (-553.5, 246.6, -22.5)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}}

def "Render"
{{
    def "OVServer"
    {{
        def RenderProduct "ViewportTexture0" (
            prepend apiSchemas = ["OmniRtxSettingsCommonAdvancedAPI_1", "OmniRtxSettingsPtAdvancedAPI_1", "OmniRtxSettingsRtAdvancedAPI_1"]
        )
        {{
            token omni:rtx:rendermode = "RealTimePathTracing"
            bool omni:rtx:pt:diAOV = 1
            bool omni:rtx:pt:giAOV = 1
            bool omni:rtx:pt:diffuseFilterAOV = 1
            bool omni:rtx:pt:reflectionsAOV = 1
            bool omni:rtx:pt:refractionFilterAOV = 1
            bool omni:rtx:pt:refractionsAOV = 1
            bool omni:rtx:pt:selfIllumAOV = 1
            bool omni:rtx:pt:volumesAOV = 1
            bool omni:rtx:pt:worldNormalsAOV = 1
            bool omni:rtx:pt:worldPosAOV = 1
            bool omni:rtx:pt:zDepthAOV = 1
            bool omni:rtx:pt:denoising:optix:denoiseAOVs = 1
            float omni:rtx:pt:zDepthMin = 0.1
            float omni:rtx:pt:zDepthMax = 10000
            int omni:rtx:pt:maxSamplesPerLaunch = 2073600
            float omni:rtx:rtpt:modulatingRoughnessThreshold = 0.08
            rel camera = <{OV_CAMERA_PRIM}>
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
            uniform int2 resolution = ({safe_width}, {safe_height})
        }}
    }}

    def "Vars"
    {{
        def RenderVar "LdrColor"
        {{
            uniform string sourceName = "LdrColor"
        }}
        def RenderVar "HdrColor"
        {{
            uniform string sourceName = "HdrColor"
        }}
        def RenderVar "Depth"
        {{
            uniform string sourceName = "DepthSD"
        }}
        def RenderVar "Normal"
        {{
            uniform string sourceName = "NormalSD"
        }}
        def RenderVar "InstanceSeg"
        {{
            uniform string sourceName = "InstanceSegmentationSD"
        }}
        def RenderVar "SemanticSeg"
        {{
            uniform string sourceName = "SemanticSegmentationSD"
        }}
        def RenderVar "Metallic"
        {{
            uniform string sourceName = "Metallic"
        }}
        def RenderVar "Roughness"
        {{
            uniform string sourceName = "Roughness"
        }}
        def RenderVar "Emissive"
        {{
            uniform string sourceName = "Emissive"
        }}
        def RenderVar "Diffuse"
        {{
            uniform string sourceName = "DiffuseAlbedoSD"
        }}
        def RenderVar "Specular"
        {{
            uniform string sourceName = "Specular"
        }}
        def RenderVar "AO"
        {{
            uniform string sourceName = "AmbientOcclusion"
        }}
        def RenderVar "DirectDiffuse"
        {{
            uniform string sourceName = "DirectDiffuse"
        }}
        def RenderVar "DirectSpecular"
        {{
            uniform string sourceName = "DirectSpecular"
        }}
        def RenderVar "IndirectDiffuse"
        {{
            uniform string sourceName = "IndirectDiffuse"
        }}
        def RenderVar "IndirectSpecular"
        {{
            uniform string sourceName = "IndirectSpecular"
        }}
        def RenderVar "MotionVectors"
        {{
            uniform string sourceName = "MotionVectors"
        }}
    }}

    def RenderSettings "OVRenderSettings"
    {{
        rel products = [<{OV_RENDER_PRODUCT}>]
    }}
}}

# Override EffectLayer shaders to disable selection glow.
# In ovrtx, no OmniGraph runtime drives EffectLayerMT.mdl's animation input.
# Setting Fader=0 forces a clean load-time non-highlighted state.
over "World"
{{
    over "Misc"
    {{
        over "Looks"
        {{
            over "Concrete_Rough"
            {{
                over "EffectLayer"
                {{
                    float inputs:Fader = 0
                }}
            }}
            over "Steel_Stainless"
            {{
                over "EffectLayer"
                {{
                    float inputs:Fader = 0
                }}
            }}
            over "MetallicGreen_OmniPbr"
            {{
                over "EffectLayer"
                {{
                    float inputs:Fader = 0
                }}
            }}
        }}
    }}
}}
'''
```

Pass the injected RenderProduct path to `renderer.step()`.

The `EffectLayer` override block above is a material-effect example, not a
baseline stage-loading requirement. For a general viewer, only generate
equivalent `over` blocks when the active stage actually contains compatible
EffectLayer shader paths and the app intends to use material-driven pick
effects. Keep those overrides in the composite/session layer before runtime
effect writes use `PrimMode.EXISTING_ONLY`.

The OmniRtx API schemas and path-tracing AOV flags are required viewer-owned
render pipeline metadata. Recommended viewer implementations author the schemas
on the `RenderProduct`; if a target ovrtx build expects them on
`RenderSettings`, keep the same schema list and flag values on the render
settings prim instead of dropping them.

Do not use inline one-line prim bodies such as `def RenderVar "LdrColor" { uniform string sourceName = "LdrColor" }` or nested one-line override bodies such as `over "EffectLayer" { float inputs:Fader = 0 }`. Some ovrtx-bundled USD parser builds reject or misdiagnose these compact forms, especially when generated through Python strings with escaped braces. Use the multi-line brace form shown above for every generated `def`, `over`, and nested override block.

## Generated USDA Self-Check

Before calling `renderer.open_usd()` or `renderer.open_usd_from_string()` with a
generated wrapper, validate the exact generated text with OpenUSD in the selected
`pxr` subprocess. This catches malformed braces, bad asset references, and wrong
value syntax before the ovrtx process enters its render/load path.

Use this validation for generated app scaffolds and tests. Keep it out of the
ovrtx render process when the app otherwise follows the pxr-subprocess isolation
contract.

## Initial Resolution And Aspect

The RenderProduct resolution and camera aperture must agree. Derive `verticalAperture` from `horizontalAperture * height / width` when creating session/composite camera data.

Browser-streamed Omniverse Realtime Viewer apps should use a fixed server render resolution, typically 1920x1080, and let the frontend display the video with `object-fit: contain`. CSS layout changes should not rebuild session/composite camera data.

Write the composite into the same directory as the user stage and reference the user stage by basename so relative textures, MDL files, and sublayers resolve:

```python
stage_dir = os.path.dirname(os.path.abspath(url))
stage_basename = os.path.basename(url)
stage_stem = os.path.splitext(stage_basename)[0]
composite_path = os.path.join(stage_dir, f"_ovrtx_composite_{stage_stem}.usda")
with open(composite_path, "w", encoding="utf-8") as f:
    f.write(make_composite_stage(stage_basename, width, height))

renderer.open_usd(composite_path)
products = renderer.step(render_products={OV_RENDER_PRODUCT}, delta_time=1 / 60)
```

## Dynamic Scene Root

Do not assume the loaded scene root is `/World`. Some assets use roots such as `/stage`, and hardcoded `/World` paths break hierarchy, selection, and pickable-prim setup.

When opening the USD for metadata, detect and store the root prim path:

1. Prefer `/World` if it exists.
2. Otherwise use `stage.GetDefaultPrim()` if valid.
3. Otherwise use the first pseudo-root child.

Pass this `root_prim_path` through the load result so frontend hierarchy and selection code can query the correct root.

### Implementation: pxr_worker subprocess

Do not import `pxr` (OpenUSD Python) in the main ovrtx process — it conflicts with ovrtx's bundled USD. Run all pxr queries in a separate subprocess:

```python
# pxr_worker.py — runs in subprocess, communicates via JSON over stdin/stdout
def cmd_get_root_prim_path():
    """Detect the best root prim path for the stage."""
    if not _stage:
        return {"ok": False, "error": "no stage loaded"}

    # 1. Prefer /World if it exists
    world = _stage.GetPrimAtPath("/World")
    if world.IsValid():
        return {"ok": True, "path": "/World"}

    # 2. Try DefaultPrim
    default_prim = _stage.GetDefaultPrim()
    if default_prim and default_prim.IsValid():
        return {"ok": True, "path": str(default_prim.GetPath())}

    # 3. First pseudo-root child
    for child in _stage.GetPseudoRoot().GetChildren():
        return {"ok": True, "path": str(child.GetPath())}

    return {"ok": True, "path": "/"}
```

The main server proxies this via `PxrWorkerClient.get_root_prim_path()` and caches the result in `self.current_stage_root_path` after each successful load.

### Protocol: root_prim_path in openStageResult

The server includes `root_prim_path` in every `openStageResult` and `push_initial_state` message:

```python
self.send_message("openStageResult", {
    "url": active_url,
    "result": "success",
    "root_prim_path": server.current_stage_root_path,
})
# Send children from detected root, not hardcoded /World
children = server._pxr.get_children(root_path)
self.send_message("getChildrenResult", {
    "prim_path": root_path,
    "children": children,
})
```

## Skip-Reload Optimization

When the frontend sends `openStageRequest` for a stage that is already loaded (e.g., on reconnect or duplicate requests), skip the expensive renderer reload:

```python
def _stage_path_key(self, url: str) -> str:
    """Normalize path for comparison."""
    return os.path.normcase(os.path.abspath(url))

def _load_stage(self, url: str, force: bool = False) -> bool:
    # Skip if same stage already loaded
    if not force and self.current_stage_url:
        if self._stage_path_key(url) == self._stage_path_key(self.current_stage_url):
            logger.info("Stage already loaded, skipping reload: %s", url)
            return True
    # ... proceed with actual load
```

The `force=True` parameter is used by `_handle_reset_stage` so explicit resets always work. Without this optimization, duplicate or reconnect-time `openStageRequest` messages can trigger redundant reloads.

### Caveats

- Use `os.path.normcase(os.path.abspath(...))` for path comparison — not string equality.
- Keep `import os` at module level, never inside `_load_stage()`.
- The frontend should not send a default `openStageRequest` on connect. Let the server's delayed `push_initial_state` send the current `openStageResult` and root children after the data channel opens.
- The frontend should send `openStageRequest` only for explicit scene switches, file opens, resets, or reloads.
- A same-stage `openStageRequest` should fast-return success and current root state without calling `reset_stage()` or `open_usd()`.

## Do Not Block The Render Loop

Loading can be slow because USD composition, texture/material discovery, and shader compilation may continue after `open_usd*` starts. In streaming apps, do not run the full load synchronously on the WebRTC message handler or block frame production for more than a few seconds.

Use a background loading thread plus a `stage_lock` around renderer mutation. While the lock is held for `open_usd*`, `add_usd_reference*`, `remove_usd()`, or `reset_stage()`, the render loop should skip `renderer.step()` and keep streaming the last good frame.

## Rules

- `clippingRange` is `float2 clippingRange = (near, far)`, not separate `.near`/`.far` attributes.
- Use `open_usd()` for file-backed root stages and `open_usd_from_string()` for generated root USDA. Both replace the active root.
- Use `add_usd_reference*` only for additive content under a unique `prefix_path`; keep the returned handle if you will remove it later.
- Camera path must match the path used by `camera-controls` when writing `omni:xform`; the reference streaming camera is `/OVCamera`.
- The user scene is never modified by wrapper/session loading.
- Write composite files in the same directory as the user USD so relative textures, MDL files, and sublayers resolve correctly.
- Keep composite files alive for the server lifetime; ovrtx can perform async texture/material loading after `open_usd()` returns.
- If the user stage has a camera, copy focal length, horizontal/vertical aperture, clipping range, and transform for visual consistency.
- Use `PrimMode.CREATE_NEW` for camera `omni:xform`; the camera may only have authored `xformOp:*`.
- Add `InstanceSegmentationSD` only when a debug/display segmentation AOV is needed. 0.3 picking uses ovrtx pick queries and resolved path IDs; it does not require a token-map RenderVar.

## Failure Modes

- `Unable to find RenderProduct prim`: wrapper/session render pipeline missing or wrong render product path.
- Black frame: camera path invalid, resolution missing, or RenderVar sourceName wrong.
- Broken textures after wrapping: composite is in `/tmp` instead of beside the asset.
- Textures fail later after initial load: composite was deleted too early.

See also: `ovrtx-rendering`, `render-settings`, `camera-controls`, `stage-management`, `streaming-server`.
