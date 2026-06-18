# AOV Switching

## Triggers

Use this skill for requests mentioning `AOV`, `render var`, `changeAOVRequest`, `activeAOVState`, `availableAOVsResult`, `HdrColor`, `NormalSD`, `segmentation view`, or `display render output`.

Use this when the Omniverse Realtime Viewer needs to stream something other than `LdrColor`, such as HDR color, normals, instance segmentation, or semantic segmentation.

Keep one WebRTC video stream. AOV selection changes which ovrtx render var is
copied into a persistent CUDA BGRA8 stream buffer before calling
`ovstream.stream_video()`.

For ovrtx AOV, RenderVar tensor, mapping, or release-specific behavior not
covered here, read `references/dependencies` for acquisition guidance and
supplemental dependency documentation.

## Architecture

```text
composite USDA orderedVars
    -> ovrtx frame_output.render_vars
    -> runtime displayable-AOV discovery
    -> selected AOV maps on CUDA
    -> Warp converts named tensor dtype/shape to BGRA8
    -> ovstream VideoFrame.from_cuda_array
    -> React dropdown state from data-channel events
```

Do not create a separate stream per AOV. The browser receives the same video track; only the server-side source render var changes.

## Server State

Keep display state on the server, not only in React. The server is authoritative because it knows which render vars ovrtx actually produced on recent frames.

```python
# Displayable AOVs requested by the composite stage, in preferred display order.
# Only AOVs that ovrtx actually produces full-resolution data for are included.
DISPLAY_AOVS = (
    "LdrColor",                 # uint8  RGBA [H,W,4]
    "HdrColor",                 # uint16 RGBA [H,W,4], fp16 packed as uint16
    "NormalSD",                 # uint32 RGBA [H,W,4], packed float bits
    "InstanceSegmentationSD",   # uint32 [H,W,1], display/debug instance IDs
    "SemanticSegmentationSD",   # uint32 [H,W,1], display/debug semantic IDs
    "DepthSD",                  # uint32 [H,W,1], float32 bits packed as uint32
    "DiffuseAlbedoSD",          # uint8  RGBA [H,W,4]
)

self._active_aov: str = "LdrColor"
self._available_aovs: Set[str] = {"LdrColor"}
self._aov_error: Optional[str] = None
```

Runtime discovery should filter `frame_output.render_vars` through `DISPLAY_AOVS`. Do not expose every reported key; many requested render vars currently map to empty tensors or fail when mapped.

```python
def _update_available_aovs(self, render_vars: Any, notify: bool = False) -> None:
    names = set(render_vars.keys()) if hasattr(render_vars, "keys") else set(render_vars)
    available = {name for name in DISPLAY_AOVS if name in names}
    if not available:
        available = {"LdrColor"}

    changed = available != self._available_aovs
    self._available_aovs = available

    if self._active_aov not in self._available_aovs:
        self._active_aov = "LdrColor"
        changed = True

    if notify and changed and self._stream_server:
        available_payload = self.get_available_aovs()
        self._message_handler.send_message(
            "availableAOVsResult",
            {"aovs": available_payload, "available": available_payload},
        )
        self._message_handler.send_message("activeAOVState", self.get_active_aov_state())
```

## Composite Stage

Request all candidate render vars in the composite stage so future ovrtx support can surface without changing the stage wrapper again. The UI should still expose only `DISPLAY_AOVS`.

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
def RenderVar "InstanceSeg"
{
    uniform string sourceName = "InstanceSegmentationSD"
}
```

The keys in `frame_output.render_vars` are source names such as `NormalSD`, not necessarily the `RenderVar` prim names such as `Normal`.

`InstanceSegmentationSD` is a display/debug AOV in this skill. Do not use it as the required picking path for 0.3 viewers; use ovrtx pick queries and resolve pick-hit path IDs through the renderer path dictionary.

## Message Protocol

Use the standard data-channel envelope:

```json
{"event_type":"changeAOVRequest","payload":{"aov":"NormalSD"}}
```

| Flow | Client sends | Server sends |
|---|---|---|
| Change active AOV | `changeAOVRequest {aov}` | `activeAOVState {active,available,result?,previous?,requested?,reason?}` plus `availableAOVsResult` |
| Query AOVs | `getAvailableAOVs {}` | `availableAOVsResult {aovs,available}` |
| State push | none | `activeAOVState {active,available}` on connect, stage load, or discovery change |
| Legacy segmentation toggle | `toggleSegView {enabled?}` | `segViewState {enabled}` and AOV state |

The server sends both `aovs` and `available` in `availableAOVsResult` for compatibility. Frontends should accept either field.

```python
self._handlers = {
    "changeAOVRequest": self._handle_change_aov,
    "getAvailableAOVs": self._handle_get_available_aovs,
    "toggleSegView": self._handle_toggle_seg_view,
}
```

```python
def _handle_change_aov(self, payload: Dict[str, Any]) -> None:
    requested = payload.get("aov") or payload.get("name")
    if not isinstance(requested, str) or not requested:
        self._send_aov_state({"result": "error", "reason": "Missing AOV name"})
        return

    previous = getattr(self.server, "_active_aov", "LdrColor")
    if self.server.set_active_aov(requested):
        self._send_aov_state({"result": "success", "previous": previous})
        return

    self._send_aov_state({
        "result": "error",
        "requested": requested,
        "reason": "AOV is not available for the current render product",
    })
```

## Conversion Pipeline

Allocate one long-lived BGRA8 CUDA buffer and copy/convert each selected AOV into it. This keeps ovstream frame handoff stable even when the selected AOV has a different dtype.

```python
def _ensure_stream_buffer(self, height: int, width: int) -> bool:
    if self._stream_buf is None:
        self._stream_buf = wp.zeros((height, width, 4), dtype=wp.uint8, device="cuda:0")
        return True
    return self._stream_buf.shape[0] == height and self._stream_buf.shape[1] == width
```

Map the selected render var on CUDA, choose the tensor to display, wrap it with Warp via DLPack, and dispatch by dtype and shape. Most display AOVs are single-tensor outputs, so the mapped render var itself is the DLPack producer. Multi-tensor render vars must be addressed by tensor name; do not use older single-tensor convenience access in new code.

```python
def _display_tensor(mapped: Any, preferred: tuple[str, ...] = ("Color", "color", "data")) -> Any:
    try:
        return wp.from_dlpack(mapped)
    except TypeError:
        for name in preferred:
            try:
                return wp.from_dlpack(mapped[name])
            except (KeyError, TypeError):
                pass
        raise

with fout.render_vars[aov_name].map(device=Device.CUDA) as rv:
    src = _display_tensor(rv)
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

Always fall back to `LdrColor` if the active AOV cannot be copied. If that also fails, keep streaming the last good buffer instead of sending an invalid frame.

```python
copied = self._copy_aov_to_stream_buffer(fout, self._active_aov)
if not copied and self._active_aov != "LdrColor":
    copied = self._copy_aov_to_stream_buffer(fout, "LdrColor")
```

## Production Display Conversion Rules

Before calling `stream_video()`, the selected AOV must be visualization-ready BGRA8 in the server-owned CUDA stream buffer. Use these conversions:

| AOV | Expected behavior |
|---|---|
| `LdrColor` | Direct RGBA8 copy followed by R/B channel swap to BGRA8. |
| `HdrColor` | Tone map linear HDR for display. Use exposure/Reinhard-style compression plus gamma/sRGB correction, clamp to `[0,255]`, and output BGRA8. For fp16-packed `uint16` HDR, normalize around fp16 `1.0` and apply Reinhard. |
| `DepthSD` | Convert float depth, or `uint32` packed float bits, to normalized grayscale. Inverse-distance visualization is useful for interactive inspection because near objects stay bright and far objects fade. |
| `NormalSD` | Convert float normals or `uint32` packed float bits to RGB by remapping each component from `[-1,1]` to `[0,1]`, then BGRA8. |
| `InstanceSegmentationSD` | Display/debug only. Convert `uint32` IDs to deterministic hashed colors. ID `0` is black/background. |
| `SemanticSegmentationSD` | Use the same deterministic ID colorization as instance segmentation. |
| `DiffuseAlbedoSD` | Convert linear float RGB through gamma/sRGB correction, or use the RGBA8 channel-swap path when ovrtx already returns `uint8 [H,W,4]`. |

Dispatch by AOV name, dtype, shape, and channel count. Image outputs are channel-last `[H,W,C]`; scalar AOVs are expected as `[H,W,1]`. Do not assume that all `uint32 [H,W,1]` values are segmentation; `DepthSD` uses the same shape but needs depth visualization.

## Warp Kernels

| Kernel | Input | Use |
|---|---|---|
| `_swap_rb` | `uint8 [H,W,4]` | `LdrColor` RGBA8 to ovstream BGRA8 |
| `_rgb8_to_bgra` | `uint8 [H,W,3]` | Generic 8-bit RGB AOVs |
| `_gray8_3d_to_bgra` | `uint8 [H,W,1]` | Generic 8-bit scalar AOVs |
| `_colorize_seg_3d` | `uint32 [H,W,1]` | Instance/semantic segmentation ID visualization |
| `_uint16_rgba_hdr_to_bgra` | `uint16 [H,W,4]` | `HdrColor` approximate fp16 tonemap |
| `_uint32_normals_to_bgra` | `uint32 [H,W,4]` | `NormalSD` packed-normal visualization |
| `_float32_rgb_to_bgra`, `_float16_rgb_to_bgra` | float RGB | Future float color/normal AOVs |
| `_float32_gray3d_to_bgra` | float scalar `[H,W,1]` | Future scalar AOVs |
| `_float16_gray3d_to_bgra` | fp16 scalar `[H,W,1]` | Future scalar AOVs |
| `_depth_to_bgra_3d` | float depth `[H,W,1]` | Future depth if ovrtx maps it |

Warp does not provide a simple bit-cast path in these kernels. The current `HdrColor` and `NormalSD` conversions are visualization approximations, not numerically exact decoders.

## Frontend Wiring

React keeps local UI state, but the server event stream corrects it whenever discovery changes or a requested AOV is rejected.

```typescript
case 'activeAOVState': {
  const payload = event.payload as ActiveAOVStatePayload;
  if (Array.isArray(payload.available) && payload.available.length > 0) {
    setAvailableAOVs(payload.available);
  }
  setActiveAOV(payload.active || 'LdrColor');
  break;
}
case 'availableAOVsResult': {
  const payload = event.payload as AvailableAOVsResultPayload;
  const names = payload.aovs || payload.available || [];
  if (names.length > 0) {
    setAvailableAOVs(names);
  }
  break;
}
```

```typescript
sendMessage({
  event_type: 'changeAOVRequest',
  payload: { aov: selectedAOV },
});
```

## ovrtx Findings

The composite stage requests 17 render vars. In this implementation, ovrtx reports them, but only the listed render vars currently produce useful full-resolution data in the streaming path:

| AOV | Observed tensor | Stream behavior |
|---|---|---|
| `LdrColor` | `uint8 [H,W,4]` | Works, swap RGBA to BGRA |
| `HdrColor` | `uint16 [H,W,4]` | Works with approximate Reinhard tonemap |
| `NormalSD` | `uint32 [H,W,4]` | Works as packed-normal visualization |
| `InstanceSegmentationSD` | `uint32 [H,W,1]` | Works as display/debug, hash IDs to colors |
| `SemanticSegmentationSD` | `uint32 [H,W,1]` | Works, hash IDs to colors |
| `DepthSD` | `uint32 [H,W,1]` | Works, float32 bits packed as uint32, inverse-distance viz |
| `DiffuseAlbedoSD` | `uint8 [H,W,4]` | Works, same RGBA→BGRA path as LdrColor |

## Enabling Additional AOVs via Path-Tracing Flags

Many AOVs produce empty tensors by default because the RTX path-tracing AOV passes are disabled. To unlock `DepthSD`, `DiffuseAlbedoSD`, and potentially more:

### 1. Add API schemas to the RenderProduct

```usda
def RenderProduct "ViewportTexture0" (
    prepend apiSchemas = ["OmniRtxSettingsCommonAdvancedAPI_1", "OmniRtxSettingsPtAdvancedAPI_1", "OmniRtxSettingsRtAdvancedAPI_1"]
)
{
    token omni:rtx:rendermode = "RealTimePathTracing"
    ...
}
```

### 2. Enable PT AOV flags

```usda
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
```

### 3. Use correct source names

Some AOV source names differ from intuitive guesses:

| Wrong name | Correct sourceName |
|---|---|
| `Depth` | `DepthSD` |
| `Diffuse` | `DiffuseAlbedoSD` |

Using the wrong `sourceName` causes `map()` failures or empty tensors even when the render pass is enabled.

### Current status with PT flags

- *Working (7):* LdrColor, HdrColor, NormalSD, InstanceSegmentationSD, SemanticSegmentationSD, DepthSD, DiffuseAlbedoSD
- *Still empty (needs investigation):* DirectDiffuse, DirectSpecular, IndirectDiffuse, IndirectSpecular, Emissive, Specular, AmbientOcclusion, Metallic, MotionVectors
- *Still fails to map:* Roughness

The lighting decomposition AOVs may need more PT convergence samples or a different configuration. See `docs/ovrtx_aov_deep_dive.md` for the full investigation.

## Gotchas

- Keep picking independent of display AOV. Use ovrtx pick queries for selection and treat `InstanceSegmentationSD` as a visualization/debug output.
- Reset `_active_aov` and `_available_aovs` on stage load. AOV availability is render-product/runtime state, not global app state.
- Send AOV state after initial client connection. A browser can connect after startup and miss the stage-open response.
- Do not trust a render var just because it appears in `fout.render_vars`; mapping can still fail or yield empty data.
- `HdrColor` is half-float data exposed as `uint16`; the current conversion is for display only.
- `NormalSD` is float bit-pattern data exposed as `uint32`; exact decoding needs a real bit-cast path.
- ovstream expects BGRA8. Every displayable AOV must end in a `uint8 [H,W,4]` buffer.
- Scalar render outputs are channel-last `[H,W,1]`. Keep old `[H,W]` kernel paths only as compatibility fallbacks if supporting pre-0.3 builds.

See also: `ovrtx-rendering`, `streaming-server`, `streaming-messages`, `render-settings`, `object-selection`.
