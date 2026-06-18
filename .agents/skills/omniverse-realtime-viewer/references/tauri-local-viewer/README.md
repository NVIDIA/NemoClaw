# Tauri + Rust OVRTX Omniverse Realtime Viewer

## Triggers

Use this skill for Tauri 2, Rust desktop Omniverse Realtime Viewer, OVRTX through C FFI, Tauri Channel IPC, ViewerBackend interface, native desktop Omniverse Realtime Viewer, web-technology UI, no Python, or no ovui runtime.

Use this pattern when the app should be a native desktop binary with a React
frontend, no Python runtime, and direct Rust FFI to OVRTX. The Tauri app shares
its `ViewerBackend` interface with the WebRTC streaming frontend so UI components
can be reused across both paths.

For ovrtx C API behavior, FFI behavior, renderer lifecycle guidance, or
release-specific behavior not covered here, read `references/dependencies` for
acquisition guidance and supplemental dependency documentation.

This is not a GPU zero-copy renderer. The active display path is:

```text
OVRTX step -> CPU map LdrColor -> raw RGBA payload -> Tauri Channel -> canvas putImageData
```

Do not add `wgpu`, CUDA/Vulkan external-memory import, NVENC, or WebCodecs as
part of the active local display path unless the app is explicitly redesigned
around a new presentation contract.

## When to Use This vs Other Paths

| You want... | Use... |
|---|---|
| Native desktop, web-tech UI, no Python | This skill: Tauri + Rust FFI |
| Native desktop, Python, simple Omniverse Realtime Viewer shell | `local-viewer` + `ovrtx-rendering` |
| Native desktop, Python, full editor UI | `ovui` |
| Browser-based remote viewing | `streaming-server` + `streaming-client` |
| Unsure between local and streaming | `streaming-vs-local` |

## Architecture Overview

```text
React WebView (Vite)
  |-- ViewerBackend interface (useTauriBackend.ts)
  |-- Tauri invoke / Channel IPC
  |
Rust backend
  |-- commands.rs       -> Tauri commands, events, shared-state reads
  |-- render_loop.rs    -> single render thread owns mutable OVRTX state
  |     |-- drain commands
  |     |-- write camera (ovrtx_write_attribute)
  |     |-- step renderer (ovrtx_step)
  |     |-- CPU map "LdrColor"
  |     `-- push binary frame via Tauri Channel
  |-- ovrtx_bridge.rs   -> OVRTX C API FFI, loading, mapping, native picking
  |-- camera.rs         -> OrbitCamera math and input handling
  |-- session_layer.rs  -> inline root/session USDA generation
  |-- ovrtx_env.rs      -> Windows DLL/path/runtime discovery
  `-- picking.rs        -> native pick requests and UI selection state
```

Generated project paths may be `tauri-app/src-tauri/src/` and
`tauri-app/src/`, or a flattened layout such as `tauri-src/` and `ts-src/`.
Treat the module names above as the stable structure.

## Critical Invariants

### 1. Single Render Thread

One Rust thread owns all mutable render state:

- `OvrtxBridge` renderer and stage handles
- `OrbitCamera`
- `InstanceTable`
- selection state
- frame counters and render error counters

Tauri commands enqueue `RenderCommand` messages through `mpsc` when they need to
touch OVRTX or camera state. Never call OVRTX from the IPC thread. Continuous
input is fire-and-forget; discrete actions use reply channels or events.

### 2. Camera Write Contract

```text
ovrtx_write_attribute:
  attribute:    "omni:xform"
  semantic:     XFORM_MAT4X4
  binding dtype: float64, lanes=16
  input tensor:  (1,4,4) float64 lanes=1, ndim=3, strides=NULL, CPU
  prim_mode:    CREATE_NEW
  access:       SYNC
  path:         /Session/Cameras/Main
```

Write the camera every frame before `step()`. Validate finite values and skip the
write on NaN. Do not use bind+map or a different lane layout; OVRTX failures here
can look like a camera that silently never moves.

### 3. Session Layer Paths

These paths must match the Python local Omniverse Realtime Viewer and streaming server camera setup:

```text
/Session/Cameras/Main         camera
/Session/Render/Viewport      LdrColor display render product
/Session/Render/PickBuffer    InstanceSeg pick render product
/Session/Render/Vars/...      render vars
/Session/OVRenderSettings     render settings
```

Non-matching paths can cause OVRTX to use a default camera or fail to expose the
expected render outputs.

### 4. Fixed Render Resolution

Resolution is baked into the generated session USDA. Changing it requires a
session reload and wipes the camera xform. Keep the backend render size fixed
and use UI-side letterboxing plus pointer-coordinate mapping.

`resize(width, height)` is advisory in the current backend; it does not resize
OVRTX render products.

### 5. Channel-Based Frame Delivery

Primary frame transport is a Tauri `Channel<InvokeResponseBody>` registered by
`subscribe_frame_events(on_frame)`. The payload is:

```text
[u32 width LE][u32 height LE][u64 sequence LE][RGBA8 pixels]
```

The frontend decodes `ArrayBuffer` payloads, drops duplicate or older sequence
numbers, creates `ImageData`, and paints with `canvas.putImageData`.

Do not use a named binary `ovrtx-frame` event for frames. Named events are used
for lifecycle, errors, picking, and selection, not for the main frame stream.

`take_frame_bytes()` is a pull fallback for reconnect/debug paths. Channel push
is the primary display path. New Channel subscribers should receive the latest
cached good frame immediately when one exists.

### 6. Stage Load Sequence

The stage load flow should:

1. Resolve the input path.
2. Read/cache a lightweight stage tree before the render-thread load.
3. Reset any existing OVRTX stage.
4. Add the user USD at the root.
5. Add the generated session USDA under `/Session`.
6. Clear selection and render error state.
7. Reset the camera to the default view.
8. Rebuild `InstanceTable` from the cached tree.
9. Mark the stage loaded and emit `stage-loaded`.

Effect-fader writes are currently inactive. The load path calls
`write_effect_faders` with an empty shader-path list, so the helper returns
without writing anything. If real shader paths are supplied in a future feature,
the helper must keep using `CREATE_NEW`, not `EXISTING_ONLY`.

### 7. Render Loop Timing

The render thread drains all pending commands before rendering a frame. When no
stage is loaded it waits for commands instead of busy-spinning.

The active loop targets about 16 ms per frame. Render delta time is clamped to a
small lower bound and to about 0.1 seconds on the high end so long stalls do not
explode camera or animation updates.

Do not call `renderer.step()` concurrently with stage reset/load.

### 8. Error Model

- `FrameNotReady` is not a fatal render error.
- Ten consecutive non-`FrameNotReady` render failures disable rendering.
- Disabling rendering emits `ovrtx-render-stopped`.
- The disabled state clears only on the next `LoadStage`.
- Keep serving the latest good frame while rendering is disabled.
- Display-frame map/result cleanup uses RAII guards.
- Pick-buffer mapping uses explicit cleanup; do not assume all mapped-output
  paths are RAII protected.

## IPC Commands and Events

Expected Tauri command inventory:

| Command | Behavior |
|---|---|
| `load_stage(path)` | Resolves the path, parses a lightweight tree, enqueues render-thread load, emits `stage-loaded`, returns `{ path, tree }` |
| `set_camera(...)` | Enqueues camera state update |
| `get_camera()` | Rust command exists; current TS backend may not expose it |
| `resize(width, height)` | Advisory/no-op for OVRTX resolution |
| `mouse_button(...)` | Enqueues input; release may become a click/pick |
| `mouse_move(x, y)` | Fire-and-forget continuous input |
| `mouse_wheel(delta)` | Fire-and-forget continuous input |
| `pick(x, y)` | Returns a request id immediately; actual result arrives later |
| `get_stage_tree(root_path?)` | Returns cached tree; current `root_path` is ignored |
| `select_prims(paths)` | Updates UI selection state and emits selection event |
| `subscribe_frame_events(on_frame)` | Registers Tauri Channel frame sink and replays latest frame |
| `take_frame_bytes()` | Returns latest frame bytes as reconnect/debug fallback |

Expected emitted event names:

| Event | Role |
|---|---|
| `stage-loaded` | Stage load completed |
| `stage-selection-changed` | UI selection paths changed |
| `ovrtx-pick` | Async pick result for a request id |
| `ovrtx-error` | Camera, render, or pick error |
| `ovrtx-render-stopped` | Rendering disabled after repeated failures |

Do not add a frame event named `ovrtx-frame`; use the Channel command for frame
payloads.

## ViewerBackend Interface

The shared contract between Tauri and WebRTC frontends should look like this for
the current local Omniverse Realtime Viewer:

```typescript
interface ViewerBackend {
  connect(): Promise<void>;
  disconnect(): void;
  loadStage(path: string): Promise<{ path: string; tree: PrimNode[] } | void>;
  resize(width: number, height: number): Promise<void>;
  setCamera(camera: CameraState): Promise<void>;
  cameraMouseButton(input: PointerInput): Promise<boolean>;
  cameraMouseMove(x: number, y: number): Promise<void>;
  cameraWheel(delta: number): Promise<void>;
  onFrame(callback: (frame: FrameData) => void): () => void;
  onSelectionChanged(callback: (paths: string[]) => void): () => void;
  pick(x: number, y: number): Promise<string | null>;
  getStageTree(rootPath?: string): Promise<PrimNode[]>;
  selectPrims(paths: string[]): Promise<void>;
  getProperties(path: string): Promise<PrimProperty[]>;
}
```

Use `viewer-input-routing` for the shared click-vs-drag and button semantics
behind `cameraMouseButton`, `cameraMouseMove`, `cameraWheel`, and `pick`.

`getProperties` is currently a frontend stub that returns only the path property.
There is no Rust/USD property-query command yet. `get_camera` exists on the Rust
side but may not be exposed by `useTauriBackend`.

To add a feature, extend `ViewerBackend` first. Use a Tauri command plus
`RenderCommand` only when the feature must touch OVRTX, camera, or render-thread
state. Shared-state reads such as cached tree access and frame-channel
subscription do not need to enqueue render-thread work.

## Picking and Selection

Display and picking use the same render-product pixel coordinate space. A
frontend click is mapped through the letterboxed image rect and sent to the Rust
render thread, which enqueues an ovrtx native pick query for the active
RenderProduct.

Picking is asynchronous from the frontend point of view:

1. The frontend invokes `pick(x, y)`.
2. Rust returns a `request_id` immediately.
3. The render thread enqueues the native pick query and steps the active RenderProduct.
4. The render thread decodes `ovrtx_pick_hit`, resolves the picked path id, and emits `ovrtx-pick` with the `request_id` and optional path.
5. The frontend resolves the pending pick promise, currently with a short timeout.

Do not document or implement pick as a synchronous command returning the final
path directly.

`select_prims(paths)` stores UI selection state and emits
`stage-selection-changed`. When renderer-visible feedback is requested,
`OvrtxBridge::set_selection` should write native selection outline groups:
group `0` to clear previous paths and a non-zero styled group for selected
paths.

## Stage Tree and Properties

The current stage-tree reader is intentionally lightweight:

- It reads simple `.usda` text.
- It recognizes basic `def` and `over` prim declarations.
- It returns children under `/World` if present; otherwise it returns roots or a
  fallback `/World` node.
- It does not build complete nested `children` arrays for all USD constructs.
- `get_stage_tree(rootPath?)` ignores `rootPath` and returns the cached tree.

Do not present this as a full USD stage browser. Use `stage-hierarchy` when the
app needs robust USD traversal, properties, variants, bounds, or composition
queries.

Stage path resolution accepts an absolute existing path, then tries the current
directory, parent, and grandparent before returning the original input path.

## Camera and Input

The expected controls are:

- left drag: orbit
- middle drag: pan
- right drag: dolly
- wheel: zoom
- button release with movement under the click threshold: pick

`OrbitCamera::current_xform` recomputes the camera transform and the render loop
writes it every frame. On stage load, reset the camera to the default view before
rendering.

Frontend pointer handling should use pointer capture plus window-level
`pointermove`, `pointerup`, and `pointercancel` listeners so drags survive
WebView edge cases and leaving the canvas bounds.

## Environment Setup and Loader Notes

Runtime setup should prove the app loaded the packaged ovrtx runtime that it
will use at run time, not only that Rust compiled. Read the local ovrtx C/CMake
headers or examples before assuming FFI names, library names, or config keys.

On Linux, packaged runtime layouts commonly expose `bin/libovrtx-dynamic.so`;
do not assume `libovrtx.so` is the load target. On Windows, use the equivalent
packaged DLL path from the same runtime root. In both cases, resolve absolute
paths before launch and log them.

Expected runtime proof:

- `OVRTX_LIB_PATH=/absolute/path/to/ovrtx/bin` when the loader needs an explicit
  library directory.
- `OVRTX_BINARY_PACKAGE_ROOT_PATH=/absolute/path/to/ovrtx` when the runtime
  needs package-root discovery.
- Runtime layout contains the expected `bin`, `plugins`, `usd_plugins`, and
  `rendering-data` entries for the selected ovrtx package.
- Backend logs include the exact dynamic library path, ovrtx version, requested
  stage path, and stage-open result.
- `/proc/<pid>/maps` on Linux, or platform-equivalent loader inspection on
  Windows, confirms the running desktop process mapped the expected ovrtx
  library from the expected package root.

On Windows, runtime setup should:

- set `OVRTX_SKIP_USD_CHECK=1` before OVRTX work
- honor `OVRTX_BINARY_PACKAGE_ROOT` when provided
- probe upward from the executable for the OVRTX SDK/package layout
- derive `OVRTX_SDK_PATH` and `OVRTX_BIN_PATH`
- prepend `bin/plugins` and `bin` to `PATH`

`build.rs` should add `OVRTX_SDK_PATH` as a native link search path. Loader setup
may need to pass the package `bin` directory as the loader root when plugins live
under `bin/plugins`.

`OvrtxBridge::new` should pass OVRTX config entries for binary package root,
sync mode, and active CUDA GPUs according to the local SDK expectations.

Prefer one reproducible launch command or script that configures the runtime,
stage, and log file together:

```bash
OVRTX_LIB_PATH=/path/to/ovrtx/bin \
OVRTX_BINARY_PACKAGE_ROOT_PATH=/path/to/ovrtx \
OVRTX_OPEN_STAGE=/path/to/stage.usd \
npm run dev:desktop 2>&1 | tee /tmp/ovrtx-tauri-viewer-dev.log
```

For Hugging Face-hosted USD datasets, read `huggingface-usd`, download or clone
the dataset to the local filesystem, preserve relative dependency layout, and
open the resolved local path. Validate that the root USD is real data before
launching; for binary crate USD, `head -c 8 <file>.usd` should show `PXR-USDC`,
not a Git LFS pointer.

## FFI and Memory Safety

OVRTX FFI is layout-sensitive. Keep Rust structs synchronized with
`ovrtx_types.h`; in particular, `OvrtxConfigEntryT` must not grow an extra field
between `key_type` and `key`.

Keep strings, config arrays, tensors, and attribute buffers alive for the full
duration of synchronous OVRTX calls. Do not pass pointers to temporaries that can
be dropped before the C function returns.

Mapped output handling must respect DLPack layout:

- accept 2D, 3D, 4D, and known fallback dimensional layouts
- compute width, height, row stride, byte length, and data pointer from metadata
- pack padded RGBA rows into tightly packed bytes before sending to the WebView
- unmap and destroy result handles on every error path

Display mapping has RAII cleanup. Pick mapping currently uses explicit cleanup;
keep that distinction in mind when editing `pick_instance`.

## Behavioral Reference

When behavior differs between local Tauri code and the Python viewer, prefer the
local app's established contracts for:

- camera write shape and session USDA paths
- fixed render resolution with UI letterboxing
- pointer coordinate mapping into the rendered image content rect
- render-thread ownership of OVRTX state

## Common Mistakes

| Mistake | Consequence | Prevention |
|---|---|---|
| Calling OVRTX from the IPC thread | Race-prone state corruption or silent failures | Route OVRTX work through the render thread |
| Wrong camera tensor shape or lanes | Camera appears stuck or OVRTX ignores the write | Match the exact camera write contract |
| Custom `/Session` path substitutes | OVRTX resolves the wrong camera/output | Use the session paths above |
| Dynamic resize through session reload | Camera xform and state are wiped | Keep fixed render size and letterbox in UI |
| Not checking camera matrix finiteness | Bad values poison renderer state | Skip non-finite camera writes |
| Awaiting mouse move or wheel commands | Input latency and backlog | Fire-and-forget continuous input |
| JPEG/base64 frame encoding | Extra CPU cost and quality loss | Send raw RGBA over Tauri Channel |
| Using a named `ovrtx-frame` event | Bypasses current frame transport | Register `subscribe_frame_events` Channel |
| Treating pick as synchronous | Lost or mismatched pick results | Use request id plus `ovrtx-pick` event |
| Assuming stage tree is full USD traversal | Missing hierarchy/properties/variants | Use `stage-hierarchy` for robust USD queries |
| Assuming selection highlights in OVRTX | UI state changes but no render highlight | Implement renderer-side selection before claiming feedback |
| `EXISTING_ONLY` fader writes | Silent no-op when creating attrs | Use `CREATE_NEW` if fader paths become active |

## Definition Of Done

A Tauri ovrtx viewer is not done at compile time. Before handing it off, capture
evidence for the real desktop runtime path:

- `npm run check` or equivalent TypeScript/Rust validation passes.
- `npm run build:desktop` or equivalent Tauri package build passes.
- The real Tauri desktop app launches through the reproducible launch script.
- The requested USD stage path is opened at startup, and backend logs show
  `runtime loaded`, `ovrtx version`, and `stage opened` or equivalent fields.
- The process stays alive after stage load and produces at least one displayed
  frame through the Tauri Channel path.
- Loader inspection confirms the process mapped the expected ovrtx dynamic
  library from the configured package root.
- `nvidia-smi` or the platform equivalent shows the app using the GPU when GPU
  rendering is expected and available.
- UI-visible runtime status agrees with backend logs; do not show "ready" when
  the runtime fell back, failed to load, or never opened the stage.
