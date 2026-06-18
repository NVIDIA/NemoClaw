# Electron SHM Protocol, Interaction, And Lifecycle

## JSON App Protocol

Use the envelope from `streaming-messages`:

```json
{"event_type":"<MessageType>","payload":{}}
```

Common flows:

| Flow | React sends | Python sends |
|---|---|---|
| Open stage | `openStageRequest {url}` | `openStageResult {url,result,error?,root_prim_path?}` |
| Hierarchy | `getChildrenRequest {prim_path,filters?}` | `getChildrenResult {prim_path,children}` |
| Properties | `getPropertiesRequest {prim_path,max_bytes?}` | `getPropertiesResponse {prim_path,properties,truncated?}` |
| Selection | `selectPrimsRequest {paths}` | `stageSelectionChanged {prims}` |
| Picking | `pickRequest {request_id,x,y}` | `pickResult {request_id,path?}` |
| Loading state | `loadingStateQuery {}` | `loadingStateResponse {url,loading_state}` |
| AOV query | `getAvailableAOVs {}` | `availableAOVsResult {aovs,available}` |
| AOV change | `changeAOVRequest {aov}` | `activeAOVState {active,available,result?}` |
| Settings | `setRenderSettingRequest {key,value}` / `getRenderSettingsRequest {}` | `renderSettingsChanged {settings,capabilities,result?,applied?,applies_at?,requires_reload?,message?}` |
| Error | none | `viewerError {code,message,detail?}` |

SHM lifecycle messages:

| Event | Direction | Payload |
|---|---|---|
| `shmReady` | Python to Electron main | `{name,width,height,protocol}` |
| `shmConnected` | Electron/React internal | `{name,width,height}` |
| `shmDisconnected` | Either side | `{reason?}` |
| `frameStats` | Python or React | `{fps?,sequence?,dropped?}` |

Protocol rules:

- JSON messages are UTF-8 strings on the control channel.
- Decode and validate before dispatch.
- Include request ids for async operations that may complete out of order.
- Keep backward-compatible aliases only when required by existing UI.
- Cap large property payloads and return `truncated: true` when needed.
- Never include frame bytes in JSON.
- Render setting changes must reject keys outside the backend-advertised capability list. Success means active viewer state changed, or an explicit non-live action was accepted.

## Input, Camera, And Picking

React captures local pointer events and sends semantic input to Python. Python
owns camera math and selection side effects.

Expected controls:

- left drag: orbit
- middle drag: pan
- right drag: dolly or context menu depending on drag threshold
- wheel: zoom
- click under drag threshold: native ovrtx pick query

Pointer mapping:

1. Measure the canvas CSS pixel size.
2. Compute the visible image rectangle from render width/height.
3. Reject clicks outside the image rectangle unless a drag should clamp.
4. Convert to render-product pixel coordinates.
5. Send camera or native pick messages.

Example messages:

```json
{"event_type":"cameraMouseButton","payload":{"button":0,"down":true,"x":320,"y":240,"modifiers":{}}}
```

```json
{"event_type":"cameraMouseMove","payload":{"x":340,"y":260}}
```

```json
{"event_type":"cameraWheel","payload":{"delta":-120,"x":340,"y":260}}
```

Use `viewer-input-routing` for gesture semantics, `camera-controls` for camera
math, and `object-selection` for native pick query behavior. Use native
selection outlines for renderer-visible selection feedback: enable outlines at
renderer creation, configure group styles, write non-zero
`omni:selectionOutlineGroup` values for selected prims, and write group `0` to
clear. Do not add legacy segmentation-based picker or outline compositor modules
for ovrtx 0.3 generated Electron apps.

## Scene Loading, Queries, And Settings

Scene switching is server-owned:

1. React sends `openStageRequest {url}`.
2. Python resolves the path or asset id.
3. Python pauses stepping and resets/reloads the ovrtx stage.
4. Python rebuilds viewer camera, render product, render vars, and settings.
5. Python clears stale selection, hover, pending pick, selection outline, AOV,
   and load error state.
6. Python resets or restores camera according to stage-management settings.
7. Python emits `openStageResult`, root children, settings state, and selection.
8. Frame publishing resumes after the new render product produces a valid frame.

Hierarchy and property query rules:

- Use `stage-hierarchy` for traversal, variants, bounds, and properties.
- Keep slow USD queries out of the render loop and transport callbacks.
- Cache the root prim path after load; do not assume `/World`.
- Include root prim path in `openStageResult`.
- Keep tree/property payloads bounded.

Render settings are server state. React sends commands; Python validates and
applies them on the render loop thread. Persist cross-scene viewer settings
under a user-configurable path such as `data/viewer-settings.json`.

Do not add lights in inline session layers unless the user requested
viewer-controlled lighting. Preserve authored scene lighting by default.

## Lifecycle

Development startup:

```text
python server/app.py --transport shm --width 1920 --height 1080
npm run electron:dev
```

Packaged startup:

```text
Electron main starts Python sidecar
Python prints shmReady JSON
Electron connects native SHM client
React backend starts frame pump
Python loads initial stage or waits idle
```

Shutdown:

```text
React unsubscribes frame listeners
preload disconnects
Electron main cancels WaitFrame workers
native addon closes SHM client
Python render loop stops stepping
Python closes SHM server and unlinks owned resources
Python calls ovstream shutdown exactly once
Electron terminates sidecar if it started it
```

Failure handling:

- If Python exits, stop the frame pump and emit disconnected state.
- If Electron exits, Python should detect client detach and either idle or exit
  according to app config.
- If the SHM name is stale, fail fast with a reconnectable error.
- If protocol versions differ, refuse to connect.
- If frame header validation fails, drop the frame and reconnect.

## Build And Dev Workflow

Python setup:

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install --upgrade pip setuptools wheel
python3 -m pip install -r requirements.txt
export OVRTX_SKIP_USD_CHECK=1
```

Use `references/dependencies` for exact `ovrtx`, `ovstream`, USD, NumPy, and Warp
setup. Do not invent alternate acquisition paths.

Electron setup:

```bash
npm install
npm run build:native
npm run electron:dev
```

Native addon notes:

- Link against the ovstream SHM client library shipped with the app dependency
  set.
- Package `libovstream_shm_client.so` beside the addon or configure a stable
  runtime library path before loading it.
- Rebuild the addon when Electron version changes.
- Prefer the host repo's existing `node-gyp-build`, `prebuildify`, or `cmake-js`
  convention.
- Do not rely on globally installed native libraries.

Useful scripts:

```json
{
  "scripts": {
    "server:shm": "OVRTX_SKIP_USD_CHECK=1 python -m server.app --transport shm",
    "build:native": "npm --prefix electron/native run build",
    "frontend:dev": "vite --host 127.0.0.1",
    "electron:dev": "electron ."
  }
}
```

Keep server, frontend, and native addon steps individually runnable.
