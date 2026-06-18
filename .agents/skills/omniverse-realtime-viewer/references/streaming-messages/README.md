# Streaming Messages

## Triggers

Use this skill for custom streaming message, data channel, event_type, openStageRequest, getChildrenRequest, getPropertiesRequest, getPrimCountRequest, getStatsRequest, selectPrimsRequest, setViewportInputActive, changeAOVRequest, activeAOVState, availableAOVsResult, variants, or message protocol.

Application messages use this envelope in both directions:

```json
{"event_type": "<MessageType>", "payload": {}}
```

Input events are not JSON messages. WebRTC input arrives through NVST's native input channel as binary `InputEvent` structs and reaches `streaming-server` `on_input`. SHM Python clients must use `ovstream.ShmClient.send_input_event()`; C clients use `ovstream_shm_client_send_input_event()`. Do not use JSON `mouseInput`. In-process clients should call the local Python/C++ APIs directly. Read `viewer-input-routing` for button normalization, viewport ownership, and click-vs-drag dispatch.

## ovstream Callback Split

Keep the StreamSDK callback responsibilities separate:

| Callback | Payload | Use it for |
|---|---|---|
| Server `on_message` | JSON strings, bytes, dicts, or the browser library wrapper `{messageType,data}` | App protocol messages: stage switching, tree requests, property requests, prim count, AOV changes, variants, settings, and UI state queries. |
| Browser `onCustomEvent` | Parsed app events from the server | React state updates: `openStageResult`, `getChildrenResult`, `stageSelectionChanged`, `availableAOVsResult`, `activeAOVState`, and errors. |
| Server `on_input` | Raw `ovstream.InputEvent` objects | Mouse, keyboard, wheel, and gamepad input for camera orbit/pan/zoom and click-to-pick. |
| Server `on_unicode` | Composed text input | IME, on-screen keyboard, paste, and other text events when a viewer needs text entry. |

The browser does not implement camera math and must not forward pointer movement as app JSON. The WebRTC streaming library forwards raw input through NVST/ovstream; the Python server handles orbit, pan, zoom, drag-threshold click detection, and picking.

Golden-style server routing:

```python
stream_server.on_connection = message_handler.on_connection
stream_server.on_message = message_handler.on_message
stream_server.on_input = message_handler.on_input
# Optional for composed text input:
# stream_server.on_unicode = message_handler.on_unicode
```

```python
def on_input(self, event):
    import ovstream
    if event.type == ovstream.InputEventType.MOUSE:
        mouse = event.mouse
        if mouse.type == ovstream.MouseEventType.MOVE:
            server.camera.on_mouse_move(mouse.x, mouse.y)
        elif mouse.type == ovstream.MouseEventType.BUTTON:
            button = camera_button_from_ovstream(mouse.data, ovstream)
            if button is None:
                return
            is_down = mouse.button_state == ovstream.KeyState.DOWN
            if is_down:
                server.camera.on_mouse_button_down(mouse.x, mouse.y, button)
            else:
                was_click = server.camera.on_mouse_button_up(mouse.x, mouse.y, button)
                if button == 0 and was_click:
                    self._handle_click(mouse.x, mouse.y)
        elif mouse.type == ovstream.MouseEventType.WHEEL:
            server.camera.on_scroll(mouse.scroll_y or mouse.data)
```

## Message Reference

| Flow | Client sends | Server sends | Handler responsibility |
|---|---|---|---|
| Open stage | `openStageRequest {url}` | `openStageResult {url,result,error?,root_prim_path?}` | Server loads USD into pxr worker and ovrtx, resets selection/highlight/AOV state, pushes root hierarchy |
| Hierarchy | `getChildrenRequest {prim_path,filters?}` | `getChildrenResult {prim_path,children}` | USD worker lists direct children and type/expandable metadata |
| Properties | `getPropertiesRequest {prim_path,max_bytes?}` | `getPropertiesResponse {prim_path,properties,truncated?}` | USD worker serializes attributes, relationships, metadata, variants, bounds summary |
| Prim count | `getPrimCountRequest {}` | `getPrimCountResult {count}` | USD worker traverses stage and returns total prim count |
| Stats | `getStatsRequest {}` | `getStatsResult {fps,latency_ms,...}` | Prefer client-side real WebRTC stats; server result may be placeholder |
| Selection | `selectPrimsRequest {paths}` | `stageSelectionChanged {prims}` | Server applies selected paths, updates highlight, and pushes canonical selection |
| Selectable | `makePrimsSelectable {paths}` or `makePrimsPickable {paths}` | no required response | Server marks paths pickable/selectable |
| Reset | `resetStageRequest {}` or `resetStage {}` | optional `openStageResult`/loading messages | Server force-reloads the current stage; use force to bypass same-path skip |
| Variants | `getVariantsRequest {prim_path}` | `getVariantsResponse {prim_path,variants}` | USD worker lists variant sets/options/current selection |
| Set variant | `setVariantRequest {prim_path,variant_set,variant_selection}` | updated `getVariantsResponse` and/or hierarchy refresh | Server applies variant, refreshes affected data |
| Loading | `loadingStateQuery {}` | `loadingStateResponse {url,loading_state}` | Server reports current load state |
| Progress | none | `updateProgressAmount {amount}`, `updateProgressActivity {activity}` | Server pushes long load progress |
| AOV change | `changeAOVRequest {aov}` | `activeAOVState {active,available,result?,previous?,requested?,reason?}` | Server switches the render var copied into the video stream |
| AOV query | `getAvailableAOVs {}` | `availableAOVsResult {aovs,available}` | Server returns runtime-discovered displayable AOVs |
| Viewport input | `setViewportInputActive {active}` | no required response | Server gates native WebRTC input so DOM controls do not drive camera or picking |
| Render/settings | `toggleSegView`, `setCameraGizmo`, viewer-specific settings | implementation-specific result or state push | Server updates renderer/view state |

Exact event names matter. Current apps route `getChildrenResult` and `getPropertiesResponse`; older notes may say `getChildrenResponse` or `getPropertiesResult`. Accept old aliases when practical, but emit and document `getPropertiesResponse` for selected-prim properties.

`getPropertiesResponse.prim_path` is the response correlation key. Browser
inspectors should compare it against the current selected prim path stored in a
ref or resolver map, not against stale React state captured when the message
handler was registered.

## Payload Shapes

```json
{"event_type":"openStageResult","payload":{"url":"samples/samples_data/stage01.usd","result":"success","root_prim_path":"/World"}}
```

```json
{"event_type":"getChildrenResult","payload":{"prim_path":"/World","children":[{"name":"Cube","path":"/World/Cube","type":"geom","children":true},{"name":"Light","path":"/World/Light","type":"light","children":false}]}}
```

```json
{"event_type":"getPropertiesResponse","payload":{"prim_path":"/World/Cube","properties":{"typeName":"Mesh","visibility":"inherited","xformOp:translate":[0,1,0]},"truncated":false}}
```

```json
{"event_type":"getVariantsResponse","payload":{"prim_path":"/World/Car","variants":{"color":{"options":["red","blue"],"selection":"red"}}}}
```

```json
{"event_type":"changeAOVRequest","payload":{"aov":"NormalSD"}}
```

```json
{"event_type":"activeAOVState","payload":{"active":"NormalSD","available":["LdrColor","HdrColor","NormalSD","InstanceSegmentationSD","SemanticSegmentationSD","DepthSD","DiffuseAlbedoSD"],"result":"success","previous":"LdrColor"}}
```

```json
{"event_type":"availableAOVsResult","payload":{"aovs":["LdrColor","HdrColor","NormalSD","InstanceSegmentationSD","SemanticSegmentationSD","DepthSD","DiffuseAlbedoSD"],"available":["LdrColor","HdrColor","NormalSD","InstanceSegmentationSD","SemanticSegmentationSD","DepthSD","DiffuseAlbedoSD"]}}
```

`paths: []` in `selectPrimsRequest` clears selection.

```json
{"event_type":"setViewportInputActive","payload":{"active":false}}
```

Use `setViewportInputActive` only as an app UI ownership hint. Mouse, keyboard,
wheel, and touch events still travel through the native input channel, not JSON.
The server should cancel active camera gestures when the flag changes to false.

## Server Handler Map

Detailed server handler dispatch guidance lives in `server-handler-map.md`.

## Selection Sync

Selection is bidirectional:

- Viewport clicks update server selection, highlight, animation, server-side overlays, and then broadcast `stageSelectionChanged`.
- Tree clicks must send `selectPrimsRequest {paths}` to the server; local React state alone does not update RTX highlight or animation.
- The server's `selectPrimsRequest` handler should perform the same selection side effects as the pick path before broadcasting canonical selection.

```python
def _handle_select_prims(self, payload: Dict[str, Any]) -> None:
    paths = [p for p in payload.get("paths", []) if isinstance(p, str)]
    prev_selected = set(self.server.selected_prims)
    new_selected = set(paths)
    self.server.selected_prims = paths

    if self.server._highlight_mgr:
        self.server._highlight_mgr.update_selection(new_selected, prev_selected)
    if self.server._animator:
        for path in new_selected - prev_selected:
            self.server._animator.select(path)
        for path in prev_selected - new_selected:
            self.server._animator.deselect(path)

    self.send_message("stageSelectionChanged", {"prims": self.server.selected_prims})
```

On the frontend, `StageTree` row selection should call:

```typescript
sendMessage({ event_type: 'selectPrimsRequest', payload: { paths: selectedPaths } });
```

## Dynamic Root Prim

Do not assume every stage uses `/World`. The reference server asks the pxr worker for a hierarchy root after loading:

```python
def cmd_get_root_prim_path() -> Dict[str, Any]:
    if not _stage:
        return {"ok": False, "error": "no stage loaded"}
    world = _stage.GetPrimAtPath("/World")
    if world.IsValid():
        return {"ok": True, "path": "/World"}

    default_prim = _stage.GetDefaultPrim()
    if default_prim and default_prim.IsValid():
        return {"ok": True, "path": str(default_prim.GetPath())}

    for child in _stage.GetPseudoRoot().GetChildren():
        return {"ok": True, "path": str(child.GetPath())}

    return {"ok": True, "path": "/"}
```

Cache the result on the server as `current_stage_root_path`, include it in `openStageResult`, and use it for the initial `getChildrenResult` push:

```python
self.send_message("openStageResult", {
    "url": active_url,
    "result": "success",
    "root_prim_path": root_path,
})
children = server._pxr.get_children(root_path)
self.send_message("getChildrenResult", {"prim_path": root_path, "children": children})
```

## Stage Reload Semantics

Open-stage requests should be idempotent. Normalize paths before deciding whether a request points at the already loaded stage:

```python
if not force and self.current_stage_url:
    requested_key = os.path.normcase(os.path.abspath(url))
    current_key = os.path.normcase(os.path.abspath(self.current_stage_url))
    if requested_key == current_key:
        logger.info("Stage already loaded, skipping reload: %s", url)
        return True
```

For explicit reset/reload messages, call the load path with `force=True` so a same-path reload is not optimized away:

```python
def _handle_reset_stage(self, payload: Dict[str, Any]) -> None:
    if server.current_stage_url:
        server._load_stage(server.current_stage_url, force=True)
```

## AOV Messages

AOV state is synchronized through normal data-channel messages; the video stream itself stays unchanged.

```python
def _send_aov_state(self, extra: Optional[Dict[str, Any]] = None) -> None:
    available = server.get_available_aovs()
    active = getattr(server, "_active_aov", "LdrColor")
    payload = {"active": active, "available": available}
    if extra:
        payload.update(extra)
    self.send_message("activeAOVState", payload)
    self.send_message("availableAOVsResult", {"aovs": available, "available": available})
```

```python
def _handle_change_aov(self, payload: Dict[str, Any]) -> None:
    requested = payload.get("aov") or payload.get("name")
    if not isinstance(requested, str) or not requested:
        self._send_aov_state({"result": "error", "reason": "Missing AOV name"})
        return

    previous = getattr(server, "_active_aov", "LdrColor")
    if server.set_active_aov(requested):
        self._send_aov_state({"result": "success", "previous": previous})
        return

    self._send_aov_state({
        "result": "error",
        "requested": requested,
        "reason": "AOV is not available for the current render product",
    })
```

`toggleSegView` should remain as a compatibility shim. Map it to `InstanceSegmentationSD` when enabled and `LdrColor` when disabled, then send normal AOV state.

On the frontend, accept both AOV event shapes:

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

## Data-Channel Size Limit

Some WebRTC data-channel paths fail above roughly `65535` bytes per message. `getPropertiesResponse` is the common offender on complex prims.

Cap payloads before sending:

```python
MAX_MESSAGE_BYTES = 60000

def capped_event(event_type: str, payload: dict) -> tuple[dict, bool]:
    encoded = json.dumps({"event_type": event_type, "payload": payload}, default=str)
    if len(encoded.encode("utf-8")) <= MAX_MESSAGE_BYTES:
        return payload, False
    if "properties" in payload:
        trimmed = {}
        omitted = 0
        for key, value in payload["properties"].items():
            candidate = {**payload, "properties": {**trimmed, key: value}}
            size = len(json.dumps({"event_type": event_type, "payload": candidate}, default=str).encode("utf-8"))
            if size > MAX_MESSAGE_BYTES:
                omitted += 1
            else:
                trimmed[key] = value
        return {**payload, "properties": trimmed, "truncated": True, "omitted_count": omitted}, True
    return {**payload, "truncated": True, "error": "payload too large"}, True
```

Prefer a capped single response over chunking unless the frontend already supports chunk assembly. If adding pagination, make it opt-in with request fields such as `max_bytes`, `offset`, or `cursor`, and keep the original response shape for older clients.

For selected-prim property panels, avoid sending full mesh buffers in the first
place. Serialize array attributes such as `points`, `normals`,
`faceVertexIndices`, `faceVertexCounts`, and `primvars:st*` as
`{length, preview, truncated}` summaries unless the user explicitly requests a
full geometry dump or paginated array viewer.

## Adding A Message

If a project has `server/config.py`, add a message constant there; otherwise a literal string is acceptable. If generating code files, include these parts:

1. `server/message_handler.py`: handler function, dictionary entry, payload validation, send helper call.
2. USD worker module: a pure query/mutation function when the handler needs stage data.
3. `frontend/src/types/usd.ts`: TypeScript payload interfaces and discriminated event type.
4. `frontend/src/App.tsx` or the relevant component: `sendMessage({ event_type, payload })` and response routing in `onCustomEvent`.

```python
def _handle_my_feature(self, payload):
    result = self._do_something(payload.get("some_param", ""))
    self._send_message("myFeatureResponse", {"result": result})
```

```typescript
sendMessage({ event_type: 'myFeatureRequest', payload: { some_param: 'value' } });
```

## Backward Compatibility Rules

- Never change the outer `{event_type,payload}` envelope.
- Add optional payload fields; do not rename required fields in place.
- Accept known aliases (`makePrimsPickable`/`makePrimsSelectable`, `resetStage`/`resetStageRequest`, `aov`/`name`) and normalize internally.
- Unknown request fields should be ignored, not treated as fatal.
- Unknown event types should log a warning and return an error response only if the frontend expects one.
- Keep request/response names stable across server and frontend; verify the active `onCustomEvent` router before changing names.
- Send current state on connect for browser clients that attach after startup.

See also: `aov-switching`, `streaming-client`, `streaming-server`, `streaming-lifecycle`, `viewer-input-routing`, `stage-hierarchy`, `stage-management`.
