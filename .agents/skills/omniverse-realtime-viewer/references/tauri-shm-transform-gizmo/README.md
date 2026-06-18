# Tauri SHM Transform Gizmo

## Triggers

Use this skill for Tauri SHM viewer transform manipulation, client-rendered
gizmos, canvas overlay handles, translate/rotate/scale controls, or gizmo-first
input dispatch in the shared-memory local viewer path.

Use this whenever a Tauri SHM frontend needs to manipulate selected USD prims
with an interactive transform gizmo while the rendered 3D image still comes from
`ovrtx` through shared memory. The browser WebView renders only the overlay UI;
it never renders the USD scene.

## Architecture Overview

```text
React WebView
  |-- WebGLViewport.tsx       -> displays SHM frame and dispatches pointer input
  |-- GizmoOverlay.tsx        -> pointer-events:none 2D canvas overlay
  |-- TransformGizmo.ts       -> hit testing, drag state, transform commands
  |-- GizmoRenderer.ts        -> 2D handle drawing
  `-- useShmTauriBackend.ts   -> message routing and request tracking

Tauri Rust backend
  |-- shm_reader.rs           -> queues commands to SHM reader thread
  `-- SHM reader thread       -> sends commands to ovrtx process
```

The gizmo is client-rendered. It draws translate, rotate, and scale handles on a
transparent 2D canvas positioned over the viewport. The canvas should use
`pointer-events: none`; the viewport receives pointer events and asks the gizmo
to hit-test before forwarding input to the camera or picking path.

The drag lifecycle uses window-level `pointermove`, `pointerup`, and
`pointercancel` listeners. Do not depend on pointer capture for this path.

Transform updates are sent over Tauri IPC as fire-and-forget messages. Continuous
dragging must not block on Rust, the SHM reader thread, or a response from the
renderer process.

## WebKit2GTK Constraint

This is the critical Linux Tauri constraint: `setPointerCapture` on or around
`pointer-events: none` overlay elements can swallow `pointerup` in WebKit2GTK.
The result is a stuck drag, stale gizmo state, or camera input that never
receives a release.

The required pattern is:

1. Configure the gizmo with `capturePointer: false`.
2. Keep the overlay canvas at `pointer-events: none`.
3. Hit-test the gizmo from `WebGLViewport` during `onPointerDown`.
4. If the gizmo starts a drag, register window-level `pointermove`,
   `pointerup`, and `pointercancel` listeners.
5. Remove those listeners when the drag ends or the component unmounts.

This differs from browser viewers where pointer capture may be acceptable. For
Tauri on Linux, use window-level listeners instead.

## Gizmo-First Input Dispatch

`WebGLViewport` should check the transform gizmo before sending pointer input to
camera orbit, pan, zoom, or pick logic.

```typescript
function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
  const viewportPoint = toViewportPoint(event);

  if (gizmo.current?.pointerDown(viewportPoint, event)) {
    beginWindowDragListeners();
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  backend.sendInputEvent({
    type: "pointerDown",
    x: viewportPoint.x,
    y: viewportPoint.y,
    button: event.button,
    modifiers: readModifiers(event),
  });
}
```

The gizmo owns the drag only after a successful handle hit. Non-gizmo pointer
events continue to the viewport's normal camera and selection input path.

## Canvas Overlay

`GizmoOverlay.tsx` should render a full-size canvas over the SHM viewport:

- absolute-position the canvas over the displayed frame;
- set `pointer-events: none`;
- resize for CSS pixels and device pixel ratio;
- clear and redraw whenever selection, camera matrices, viewport rect, or active
  drag state changes;
- draw handles in screen space with depth-aware ordering where possible.

Use the same letterboxed image rect used by the SHM frame display. Gizmo handle
positions must match the visible rendered image, not the full WebView content
area when the viewport is letterboxed.

## Camera Matrix Flow

The server can send camera matrices through these message types:

- `cameraMatricesUpdate`: explicit view/projection matrix update for overlays;
- `cameraState`: initial camera state after stage load or viewer setup;
- `cameraUpdate`: camera state after orbit, pan, zoom, fit, or other camera
  changes.

The frontend should normalize both messages into the gizmo's camera cache and
dispatch a DOM event for overlay consumers:

```typescript
window.dispatchEvent(
  new CustomEvent("ovrtx-camera-update", { detail: cameraState }),
);
```

The gizmo uses the latest camera view/projection data to project the selected
object origin and axes into screen space.

Matrix convention is row-major storage with column-vector multiplication:

```text
clip = projection * view * world * position
```

Keep this convention explicit in `gizmo/math.ts`; inconsistent row/column
interpretation will make handles drift, invert, or disappear behind the camera.

## Scale Gizmo: Local vs World Axes

Scale handles must align with the selected object's local coordinate frame, not
the world axes. This is especially visible when a prim has an authored rotation:
world-axis scale handles modify the wrong visual direction and make the gizmo
feel detached from the object.

Extract normalized basis vectors from the selected transform matrix rows 0, 1,
and 2:

```typescript
const localX = normalize([m[0][0], m[0][1], m[0][2]]);
const localY = normalize([m[1][0], m[1][1], m[1][2]]);
const localZ = normalize([m[2][0], m[2][1], m[2][2]]);
```

Use those local basis vectors to draw and hit-test scale handles. Translate and
rotate handles should use world axes, which is the standard behavior for this
viewer path.

## IPC Architecture

Both `send_message` and `send_input_event` must be fire-and-forget on the Rust
side. They should queue a command to the SHM reader thread and return
immediately.

Do not use a blocking `mpsc::channel` round trip for SHM commands. That pattern
can deadlock when the Tauri IPC thread waits for a reply while the SHM reader
thread is busy inside a frame callback or waiting on the same event flow. The
command path should be:

```text
Tauri command -> enqueue command to SHM reader thread -> return Ok(())
```

Request/response operations still need correlation, but the wait belongs in the
frontend:

```typescript
const pendingByRequest = new Map<string, PendingRequest>();

function sendAndWait<T>(message: ShmMessage, timeoutMs = 1500): Promise<T> {
  const requestId = crypto.randomUUID();
  backend.sendMessage({ ...message, requestId });

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingByRequest.delete(requestId);
      reject(new Error(`Timed out waiting for ${message.type}`));
    }, timeoutMs);

    pendingByRequest.set(requestId, { resolve, reject, timeout });
  });
}
```

Use this request map for discrete queries such as `getTransform`. Continuous
drag updates should not use `sendAndWait`.

## Server Message Contract

The Tauri frontend expects the ovrtx process to handle two transform-specific
messages:

- `getTransformRequest`: request/response query for the selected prim.
  Respond with `getTransformResult` and payload `{ matrix, position }`, where
  `matrix` is the row-major 4x4 world transform and `position` is its world
  origin.
- `set_transform`: fire-and-forget drag update with payload `{ path, matrix }`.
  Queue this onto the renderer/render-loop owner and apply it there; do not
  mutate USD/ovrtx state from the SHM reader or IPC thread.

For live ovrtx writes, follow `prim-transform-safety`: initialize new
`omni:xform` attributes from the real world transform before rendering, and
recreate bindings after stage reloads.

## Drag Message Coalescing

Rapid pointer movement can generate more transform messages than the backend can
consume. Coalesce continuous drag sends so the backend sees the latest transform
at a bounded rate. The validated sample uses a 33 ms throttle with a single
pending latest message:

```typescript
const TRANSFORM_SEND_INTERVAL_MS = 33;
let lastSendTime = 0;
let pendingSend: number | null = null;
let lastMessage: ShmSetTransformMessage | null = null;

function sendThrottled(message: ShmSetTransformMessage) {
  lastMessage = message;
  const elapsed = performance.now() - lastSendTime;

  if (lastSendTime === 0 || elapsed >= TRANSFORM_SEND_INTERVAL_MS) {
    clearPendingSend();
    lastMessage = null;
    doSend(message);
    return;
  }

  clearPendingSend();
  pendingSend = window.setTimeout(() => {
    pendingSend = null;
    const next = lastMessage;
    lastMessage = null;
    if (next) doSend(next);
  }, TRANSFORM_SEND_INTERVAL_MS - elapsed);
}
```

This keeps the latest drag result while avoiding unbounded message growth. Do
not use `sendAndWait` for drag updates. If your transport exposes a promise,
catch failures for logging but do not make pointer motion wait for a response.

## Message Listener Stability

Register the Tauri `listen("shm-message", ...)` handler once. Do not re-register
it whenever selection, camera, pending requests, or component state changes.
Re-registration creates an unsubscribe/subscribe gap where response messages can
be missed.

Use a ref for the current handler logic:

```typescript
const handleMessageRef = useRef<(message: ShmMessage) => void>(() => {});

handleMessageRef.current = (message) => {
  routeMessage(message);
};

useEffect(() => {
  let unlisten: (() => void) | undefined;

  listen<ShmMessage>("shm-message", (event) => {
    handleMessageRef.current(event.payload);
  }).then((dispose) => {
    unlisten = dispose;
  });

  return () => {
    unlisten?.();
  };
}, []);
```

Keep `pendingByRequest` in a ref or stable store so request/response routing does
not require listener churn.

## Generated File Layout

Use this generated app file layout for the Tauri SHM transform gizmo:

- `clients/tauri-shm/src/components/GizmoOverlay.tsx`
- `clients/tauri-shm/src/gizmo/TransformGizmo.ts`
- `clients/tauri-shm/src/gizmo/math.ts`
- `clients/tauri-shm/src/gizmo/GizmoRenderer.ts`
- `clients/tauri-shm/src/components/WebGLViewport.tsx`
- `clients/tauri-shm/src-tauri/src/shm_reader.rs`
- `clients/tauri-shm/src/hooks/useShmTauriBackend.ts`

## Implementation Checklist

1. Add the overlay canvas and make it visually track the SHM frame rect.
2. Cache camera state from `cameraMatricesUpdate`, `cameraState`, and
   `cameraUpdate` messages.
3. Dispatch `CustomEvent("ovrtx-camera-update")` after camera messages are
   normalized.
4. Implement `getTransformRequest`/`getTransformResult` and `set_transform` on
   the ovrtx process side.
5. Query the selected prim transform with a request id and timeout.
6. Draw translate and rotate handles along world axes.
7. Draw scale handles along the selected prim's local transform basis.
8. In `WebGLViewport`, route pointer down through gizmo hit testing first.
9. Drive active drags with window-level move/up/cancel listeners.
10. Send drag transforms with fire-and-forget IPC and latest-message throttling.
11. Keep `listen("shm-message", ...)` registered once with ref-based routing.

## Anti-Patterns

```typescript
// Wrong for Tauri/WebKit2GTK: pointerup can be swallowed.
element.setPointerCapture(event.pointerId);

// Wrong: scale axes should come from the selected object's local transform.
const scaleAxes = [WORLD_X, WORLD_Y, WORLD_Z];

// Wrong: continuous drag updates must not wait for request/response messages.
await sendAndWait({ type: "setTransform", transform });
```

```rust
// Wrong: blocks the IPC thread waiting on the SHM reader thread.
let (reply_tx, reply_rx) = std::sync::mpsc::channel();
reader_tx.send(Command::SendMessage { message, reply_tx })?;
reply_rx.recv()?;
```

- Do not use `setPointerCapture` in Tauri/WebKit2GTK.
- Do not use synchronous IPC for SHM commands.
- Do not re-register event listeners on state changes.
- Do not draw scale handles along world axes.
- Do not send unbounded transform messages during drag.

See also: `tauri-local-viewer`, `electron-shm-viewer`, `webgl-shm-transport`,
`prim-transform-safety`, `viewer-input-routing`, `camera-controls`,
`object-selection`.
