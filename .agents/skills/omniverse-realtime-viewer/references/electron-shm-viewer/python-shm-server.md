# Electron SHM Python Server

## Python Server Runtime

The Python server is the source of truth for renderer and USD state:

- current stage URL/path and root prim path
- `ovrtx.Renderer`
- active render product and AOV
- camera controller
- selection, hover, native pick-query state, and selection outline groups
- stage hierarchy/property query helpers
- render settings and persisted viewer settings
- SHM frame publisher and JSON message router

Startup order:

```text
set OVRTX_SKIP_USD_CHECK=1
configure OVRTX_BIN_PATH/library path if needed
import ovrtx
construct Renderer(RendererConfig(sync_mode=True))
initialize USD query helper or subprocess if needed
initialize ovstream SHM server
register JSON control callbacks
load initial stage or enter idle state
warm up until first valid frame when a stage exists
enter one render loop
```

Render loop shape:

```python
while running:
    command_queue.drain()
    if not scene_loaded:
        wait_for_command()
        continue
    camera_controller.update(dt)
    renderer_runtime.write_camera_if_needed()
    frame = renderer_runtime.step_display_frame(dt)
    if frame is not None:
        shm_server.publish_frame(frame)
```

Critical server invariants:

- Only the render loop calls ovrtx load/reset/step/write APIs.
- Callbacks decode messages and enqueue work.
- `FrameNotReady` is recoverable; keep the latest good frame visible.
- Repeated non-recoverable render failures should stop stepping and emit a JSON
  error event until the next successful stage load.
- Scene loading must pause stepping, reset or reload the ovrtx stage, rebuild
  viewer camera/render products/render vars, clear stale selection, pending
  pick-query state, and selection outline groups, and resume only after a valid
  frame.
- Never mutate the user USD file for viewer camera, render products, render
  vars, settings, or selection metadata.

Use `stage-loading` for exact `open_usd()` / `open_usd_from_string()` stage
details and `ovrtx-rendering` for frame extraction and live write contracts.

## SHM Server Contract

Use ovstream's SHM server type for local shared memory. Exact class and enum
names may vary by binding version; preserve these roles:

```python
import os
os.environ.setdefault("OVRTX_SKIP_USD_CHECK", "1")

import ovstream

ovstream.initialize()
server = ovstream.Server(server_type=ovstream.ServerType.SHM)
server.set_message_callback(on_message)
server.start({"name": shm_name, "width": width, "height": height})
```

Requirements:

- one SHM server instance per viewer runtime
- one named SHM session per active viewer
- binary publish API for complete BGRA/RGBA frames
- JSON control channel for `event_type`/`payload` messages
- explicit close/shutdown on process exit
- generated session names such as `ov-usd-viewer-<pid>-<nonce>`
- cleanup only for stale segments owned by this app

Pass the final SHM name to Electron through CLI args, environment, or a
readiness JSON line on stdout:

```json
{"event_type":"shmReady","payload":{"name":"ov-usd-viewer-1234","width":1920,"height":1080,"protocol":1}}
```

Do not scrape logs for connection data. Keep logs on stderr or structured files.

## Frame Header And Pixels

Each frame starts with a fixed 16-byte little-endian header:

```text
byte 0..3    uint32 width
byte 4..7    uint32 height
byte 8..15   uint64 sequence
byte 16..N   BGRA8 pixel data, tightly packed, width * height * 4 bytes
```

Frontend parsing:

```typescript
const header = new DataView(buffer, 0, 16);
const width = header.getUint32(0, true);
const height = header.getUint32(4, true);
const sequence = Number(header.getBigUint64(8, true));
const pixels = new Uint8Array(buffer, 16, width * height * 4);
```

Sequence rules:

- increment once per published display frame
- drop duplicate or older frames in React
- allow gaps
- use sequence for display freshness and stats, not app state

Pixel rules:

- Frame payload is BGRA8 unless both sides explicitly negotiate RGBA8.
- `LdrColor` is the default display AOV.
- If ovrtx outputs RGBA and SHM publishes BGRA, convert once on the server.
- If SHM publishes BGRA and WebGL uploads RGBA, convert into reusable
  renderer-owned staging memory.
- Do not convert in place on shared memory that the server can overwrite.
- If a BGRA WebGL upload extension is available, use it and skip conversion.
- When exposing AOV switching, handle ovrtx 0.3 single-tensor and multi-tensor
  render vars. Select the named image tensor for composite outputs, read params
  separately, and treat image tensors as channel-last (`H x W x C`).

BGRA to RGBA conversion:

```typescript
function bgraToRgbaInPlace(words: Uint32Array) {
  for (let i = 0; i < words.length; i += 1) {
    const p = words[i];
    words[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
  }
}
```

Validate width, height, sequence, and byte length before creating texture upload
views. Drop invalid frames and request reconnect rather than drawing corrupted
memory.
