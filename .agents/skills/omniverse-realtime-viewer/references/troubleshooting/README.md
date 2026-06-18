# Troubleshooting

## Triggers

Use this skill for troubleshoot, debug Omniverse Realtime Viewer, server won't start, no video, data channel not working, wrong colors, black frame, scene won't load, camera doesn't move, picking broken, or WebRTC internals.

Use this when an Omniverse Realtime Viewer fails during startup, streaming, scene loading, rendering, input, selection, or UI state sync. Start by classifying the first broken boundary instead of chasing downstream symptoms.

## Triage Flowchart

```text
Server process does not start
  -> Server startup diagnostics
Server starts but browser cannot connect
  -> WebRTC signaling and port diagnostics
Browser connects but video is blank or frozen
  -> Video streaming and renderer step diagnostics
Electron SHM viewer opens but viewport is black, disconnected, or stutters
  -> Electron SHM Viewer diagnostics
Video streams but colors/materials/frame are wrong
  -> Render var, BGRA conversion, camera, MDL diagnostics
UI connects but buttons/tree/settings do nothing
  -> Data-channel diagnostics
Stage open fails or loads as empty
  -> Scene loading and asset path diagnostics
Scene loads but camera does not move
  -> Input callback and live camera write diagnostics
Camera works but click selection is wrong or empty
  -> Picking, coordinate, and segmentation diagnostics
Selection works but highlight/info/tree is stale
  -> Derived state reset and message routing diagnostics
Scene switch crashes or hangs
  -> Renderer ownership and stage reset diagnostics
```

## Fast Rules

- Debug one boundary at a time: process startup, WebRTC connection, rendered frame, JSON message, USD query, then feature state.
- Keep one render thread as the owner of `renderer.step()`, `reset_stage()`, `open_usd()`, `open_usd_from_string()`, reference mutation, native pick queries, selection outline writes, and live `write_attribute()` calls.
- In WebRTC streaming apps, mouse, wheel, keyboard, and touch input arrive through NVST/ovstream `InputEvent` callbacks; app state commands use the JSON data channel.
- A frontend "loading forever" state is usually either a missing `openStageResult`, a missed proactive state push, or a message-name mismatch.
- A local Omniverse Realtime Viewer skips WebRTC entirely. If the same renderer and scene code works locally but not in a browser, focus on ovstream, frame conversion, and the standalone ovstream Direct AppStreamer config.

## Scenario Playbooks

Detailed startup, streaming, scene, input, selection, hierarchy, and recovery playbooks live in `scenario-playbooks.md`.

## Common Error Map

| Message or symptom | Actual cause | Usual fix |
|---|---|---|
| `ModuleNotFoundError: ovstream` | Python binding missing or native lib path missing | Install ovstream and set `OVSTREAM_LIB_PATH` |
| `CRenderApi not found` | ovrtx plugin tree not resolved | Set `OVRTX_BIN_PATH` and plugin library path |
| `usd-core detected` | ovrtx USD check found another USD package | Set `OVRTX_SKIP_USD_CHECK=1` before ovrtx work |
| `multiple debug symbol definitions for SDF_ASSET` | Two USD registries loaded | Put ovrtx bundled libs first or split pxr into worker |
| `_tf` import failure | USD DLL/shared library conflict | Fix import order or use subprocess queries |
| `Default.mdl` parse crash | Renderer initialized after wrong USD registry | Fix import/construction order |
| Magenta materials | MDL resolver path missing | Set `OVRTX_BIN_PATH` and library path |
| `Unable to find RenderProduct prim` | Inline/session render path missing or mismatched | Create the render pipeline and pass the exact path |
| Black frame, no exception | Camera, RenderProduct, resolution, or RenderVar invalid | Validate stage-loading data and camera relation |
| USD parse error near `RenderVar` inline braces | ovrtx parser rejected one-line `def RenderVar "X" { ... }` syntax | Use multi-line `RenderVar` definitions from `stage-loading` |
| `RenderProductSetOutputs` has no attribute `get` | `renderer.step()` output was treated as a dict | Use `with products as ctx:` and index with `ctx[render_product_path]` |
| Invalid output handle | Frame or render var view outlived its step result | Copy buffers before leaving the `RenderProductSetOutputs` context |
| First `renderer.step()` exceeds normal test timeout | Cold RTX shader or pipeline compilation | Use a 300s+ first-run timeout and inspect ovrtx logs |
| Red/blue swapped | RGBA submitted as BGRA | Convert ovrtx `LdrColor` before ovstream |
| Stage load reports success but first frame fails | load operation status or RenderProduct path was not checked | wait/check load status, then step the exact RenderProduct |
| `TypeError: a coroutine was expected` from `ui.run` | ovui run loop received a callback/function instead of an awaitable | Pass an async render loop coroutine and yield with `await asyncio.sleep(0)` |
| `VIEWPORT_CAMERA_POSE_SOURCE` import failure | stale data adapters installed with newer local UI packages | Install local UI packages from the same package set |
| `ovui-data-adapters` is not installable | selected package set lacks matching package metadata | Use a compatible package set from `references/dependencies` |
| Native UI package requires a compiler toolchain | package/build instructions require local tools | Follow the current `ovui` dependency guidance |
| `Previous session is already running` | Old WebRTC client/session still active | Close old tab, reduce reconnect storm, restart server if stuck |
| Server sees `messageType` but no `event_type` | AppStreamer envelope not unwrapped | Parse nested `data` payload before dispatch |
| `POST /sign_in` returns HTTP 501 | Frontend used a Kit/OVC/NVCF/GFN client profile or injected auth/session fields into standalone ovstream Direct config | Rebuild the frontend from `streaming-client` using `@nvidia/ov-web-rtc` Direct mode with only the exposed `server` and `signalingPort` |
| UI waits on `getChildrenResponse` | Protocol name mismatch | Use active `getChildrenResult` route |
| Picks return old prims | pending pick/selectable state survived scene reload | clear pick state and refresh native pickability |
| Highlight visible on load | native selection outline groups not cleared | write group `0` for stale selected paths and clear runtime selection |
| Textures missing only after composition | cache path or sublayer path broke relative references | preserve cache layout and quote the original asset path correctly |

## Streaming And Local Omniverse Realtime Viewer Paths

Streaming path:

- Use `streaming-server` for ovstream lifecycle, ports, input callbacks, and frame submission.
- Use `streaming-client` for standalone ovstream Direct config, video element setup, browser diagnostics, and guarded sends.
- Use `streaming-lifecycle` when the connection exists but state, messages, or reconnects are wrong.
- Use `streaming-messages` to verify exact JSON event names and payload shapes.

Local Omniverse Realtime Viewer path:

- Use `local-viewer` for ovui shell, image display, UI-thread rules, and coordinate mapping.
- Use `ovrtx-rendering` for renderer construction, frame extraction, and live attribute writes.
- Use `stage-loading` for render prim injection and RenderProduct failures.
- Use `viewer-input-routing`, `camera-controls`, `object-selection`, `stage-hierarchy`, and `prim-info-display` for feature-specific debugging once the frame renders correctly.
