# Render Settings

## Triggers

Use this skill for render settings, quality controls, samples, denoiser, tone mapping, lighting, DomeLight, environment map, resolution setting, or settings persistence.

Use this skill for user-facing controls that affect rendered output or per-frame buffers.

Read `viewer-control-patterns` when exposing these settings in React, `ovui`,
`ovwidgets`, or Dear ImGui. It owns the client-agnostic guidance for sliders,
numeric inputs, toggles, labels, disabled states, and confirmations.

For ovrtx render setting, RenderProduct, RenderVar, AOV, or release behavior
not covered here, read `references/dependencies/ovrtx.md`, then use the ovrtx
supplemental repository `skills/`, samples, and release notes referenced there.
Do not guess `omni:rtx:*` attributes, `write_attribute` names, or renderer APIs.

## Capability-Driven Settings

Every visible render setting must come from a server-owned supported-settings
list. Do not hard-code optimistic controls in React.

```python
@dataclass
class RenderSettingCapability:
    key: str
    label: str
    control: str
    applies_at: str  # immediate | reload_required | next_scene_load | unsupported
    apply_path: str
    validated: bool
    validation_evidence: str
```

The frontend renders only capabilities where `validated` is true and
`applies_at` is not `unsupported`. Unsupported settings should be omitted from
the live render settings panel, not shown as hopeful sliders or toggles.

Persisted JSON is only saved preference state. It is not proof that a setting was
applied to the active render. A successful setting change must either change the
active viewer state immediately or be part of an explicit non-live workflow such
as "Apply and reload stage" or "Use for newly opened scenes."

Keep effective render settings outside the USD asset. The viewer can restore
validated settings across scene changes without modifying user files.

## Apply Path Classes

| `applies_at` | Use when | User-facing behavior |
|---|---|---|
| `immediate` | The render thread can apply the setting through a verified renderer API, `renderer.write_attribute(...)`, or frame-conversion path. | Live control is enabled and `renderSettingsChanged.applied` is true after success. |
| `reload_required` | The setting only works by rebuilding viewer-owned session/composite data. | Do not hide the reload behind a live control; expose an explicit apply/reload command. |
| `next_scene_load` | The setting is only a default for future stage loads. | Put it in a profile/defaults workflow, not the live render panel. |
| `unsupported` | No verified backend path exists for the active runtime. | Omit from active controls and reject direct requests. |

`setRenderSettingRequest` must reject keys that are not in the capability list:

```json
{
  "key": "samples_per_pixel",
  "result": "error",
  "applied": false,
  "applies_at": "unsupported",
  "requires_reload": false,
  "message": "Unsupported render setting: samples_per_pixel"
}
```

For supported settings, `renderSettingsChanged` reports effective state and
whether the active render changed:

```json
{
  "settings": {"exposure": 1.0},
  "result": "success",
  "applied": true,
  "applies_at": "immediate",
  "requires_reload": false
}
```

## Render Vars

Request render vars in the inline root/session `RenderProduct.orderedVars`.

| Render var | Source name | Format | Use |
|---|---|---|---|
| `LdrColor` | `LdrColor` | RGBA uint8 | final frame |
| `InstanceSegmentationSD` | `InstanceSegmentationSD` | uint32 | debug segmentation display |
| `SemanticSegmentationSD` | `SemanticSegmentationSD` | uint32 | debug segmentation display |
| `DepthSD` | `DepthSD` | float32 | depth effects, hit testing |
| `NormalSD` | `NormalSD` | float32x3 | inspection/debug |

```usda
def "Vars" {
    def RenderVar "LdrColor"
    {
        uniform string sourceName = "LdrColor"
    }
}
def RenderProduct "ViewportTexture0" {
    rel camera = </Render/OVCamera>
    rel orderedVars = [</Render/Vars/LdrColor>]
    uniform int2 resolution = (1920, 1080)
}
```

In `fout.render_vars`, names match `sourceName`, not the RenderVar prim name. Extra render vars increase VRAM use, around 8 MB per 1080p uint32 buffer. Picking uses native pick queries in ovrtx 0.3, so do not request segmentation render vars just for object selection.

Use the multi-line `RenderVar` form above. Some ovrtx parser builds reject inline one-line `RenderVar` definitions.

## Browser Streaming Defaults

For browser-streamed ovrtx viewers, expose only verified immediate controls by
default.

- AOV/debug view is allowed when wired through `aov-switching` and frame
  extraction has the requested render var.
- Exposure and tone mapping are allowed only when implemented in the frame
  conversion path before BGRA streaming, or through a verified ovrtx
  renderer/session path.
- Samples, denoiser, lighting, and resolution are omitted unless the generated
  app owns a verified live apply path or an explicit non-live profile workflow.

Do not expose a live control just because a value exists in settings JSON or in a
generated wrapper. Controls that require rebuilding the composite/session wrapper
belong to scene-load or render-profile workflows.

For approximate tuning such as exposure or intensity, use a slider. Pair the
slider with a numeric input when exact values matter. Clamp before sending to the
backend and echo the effective value if the backend adjusts it.

## Lighting Controls

Default rule: do not add session fallback lights. Stages own their lighting, and injected lights make local and streaming samples diverge.

If the user asks for viewer-controlled lighting, expose live lighting controls
only when the app owns the light and has verified a live attribute-write path. If
lighting can only be changed by rebuilding session data, classify it as a
reload-required render profile option.

Viewer-owned lights can be authored in the session layer so they can be
recreated on reload without editing the asset:

```usda
def Scope "ViewerLighting" {
    def DomeLight "Environment" {
        float intensity = 500
        asset texture:file = @./env.hdr@
    }
}
```

Use UI toggles for enable/disable, intensity sliders, and an environment texture
picker only when they map to a verified capability. If `environment_texture` is
relative, resolve it against a stable settings/cache directory before authoring
the session layer.

## Applying After Scene Changes

Scene management should apply supported profile/default settings while building
inline root/session data and before the first user-visible frame:

```python
settings = ViewerRenderSettings.load(settings_path)
inline_root = make_inline_root_stage(scene_url, settings.width, settings.height, settings)
renderer.open_usd_from_string(inline_root)
settings.save(settings_path)
```

If a local render resolution changes at runtime, update all dependent state:
render product, CPU/GPU output buffers, `ImageBridge`, letterbox math, pick
coordinate mapping, and camera aspect. Browser-streamed Omniverse Realtime
Viewer apps should use a fixed render resolution such as 1920x1080 and scale the
video with `object-fit: contain`. Treat WebRTC resolution changes as a stream
profile requiring explicit restart/reconnect behavior.

## Validation Evidence

Generated apps must keep evidence for every visible render setting:

- before/after frame or pixel-stat evidence for visual settings;
- backend state proof from a verified API for renderer settings;
- ovrtx supplemental `skills/`, samples, or release-note evidence for API-backed
  paths not covered in this skill package;
- generated wrapper diff plus explicit user-triggered reload evidence for
  non-live profile settings;
- rejected unsupported-key response for settings intentionally omitted from the
  panel.

If no setting has evidence, do not generate a render settings panel. Persisting a
value or echoing client form state is not validation evidence.

## Gotchas

- `LdrColor` casing matters.
- Do not put lights in the generic session layer unless the feature is explicitly enabled and represented as a validated capability.
- Render-var names in output are source names.
- CPU mapping render vars causes device-to-host transfer; use CUDA mapping for streaming.
- Add render vars only when a feature needs them.
- Save validated settings before switching scenes if the UI allows immediate scene changes, but do not treat persistence as active-render application.
- `renderSettingsChanged` must describe effective state, including whether the requested setting was applied.

See also: `viewer-control-patterns`, `stage-loading`, `stage-management`, `object-selection`, `streaming-server`.

## Adding This To An Existing Omniverse Realtime Viewer

- Add `server/render_settings.py` with a supported-settings capability list and a small JSON-backed store for validated settings and non-live defaults.
- Keep server state for active settings, fixed stream profile, required render vars, and any validated viewer lighting state.
- Modify `scene_loader.py` so inline session RenderProduct, RenderVars, and optional lighting reflect only validated profile/default settings.
- Add messages such as `getRenderSettingsRequest`, `setRenderSettingRequest`, and `renderSettingsChanged`.
- Keep existing `toggleSegView` only if the app already exposes a segmentation/debug view.
- Frontend wires `RenderSettingsPanel` from the server capability list. It must not render unsupported controls.
- Reapply validated settings after every scene load/reset through `stage-management`.
- Local resolution changes must also update buffers, letterbox math, pick coordinate mapping, and camera aspect. Streaming resolution changes require an explicit restart/reconfiguration path and should not appear as a live slider.
- Save settings after successful validation, but only report success when the active state changed or an explicit non-live operation was queued.
- Do not inject viewer lights unless the user explicitly enables viewer-controlled lighting and the app exposes the capability honestly.
