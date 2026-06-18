# Streaming Lifecycle

## Triggers

Use this skill for on_connection not firing, messages dropped, messageType envelope, data channel not ready, Loading stage, previous session already running, or ICE hang.

Use this when the stream connects but state/messages/video do not behave correctly.

## Register Before Start

ovstream can fire callbacks immediately after `start()`. Register first:

```python
server = ovstream.Server(ovstream.ServerType.WEBRTC)
server.on_connection = on_connection
server.on_message = on_message
server.on_input = on_input
# Optional for composed text input:
# server.on_unicode = on_unicode
server.start(config)
```

Late registration silently drops early connection events.

## Unwrap Frontend Envelope

The browser library may wrap app messages:

```json
{"messageType":"json","messageRecipient":"app","data":"{\"event_type\":\"openStageRequest\",\"payload\":{\"url\":\"scene.usd\"}}"}
```

```python
def on_message(raw: str):
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return
    if "messageType" in msg and "data" in msg:
        try:
            msg = json.loads(msg["data"]) if isinstance(msg["data"], str) else msg["data"]
        except json.JSONDecodeError:
            return
    if not isinstance(msg, dict) or "event_type" not in msg:
        return
    event_type = msg.get("event_type")
    payload = msg.get("payload", {})
    dispatch(event_type, payload)
```

Without this, handlers see `messageType` instead of `event_type` and do nothing.

## Proactive State Push

If a client connects after the server already loaded a stage, push initial state. Wait briefly for the data channel.

```python
def on_connection(connected: bool):
    if connected and current_stage:
        threading.Thread(target=_push_initial_state, daemon=True).start()

def _push_initial_state():
    time.sleep(0.3)
    root_path = current_stage_root_path or "/World"
    send({"event_type": "openStageResult", "payload": {
        "url": current_stage,
        "result": "success",
        "root_prim_path": root_path,
    }})
    send({"event_type": "getChildrenResult", "payload": {"prim_path": root_path, "children": root_children}})
```

This prevents a permanent "Loading stage..." UI when the frontend missed the original open result.

## Initial Stage Authority

Initial state from the server is authoritative. If `push_initial_state()` sends an `openStageResult` for the currently loaded stage, the frontend should update its selected scene from that message rather than issuing a new `openStageRequest` for its own dropdown default on every WebRTC connect.

When the current stage and frontend default disagree, a connect-time frontend request can reload the wrong stage. Use both protections:

- Frontend: do not issue a default `openStageRequest` on WebRTC connect. Only send `openStageRequest` for explicit user scene switches, file opens, and resets.
- Server: if an `openStageRequest` path matches the already-loaded stage after normalization, send a fast success `openStageResult` and current root children without reloading.

`openStageResult` should also include `root_prim_path` so the frontend starts hierarchy and selection requests from the actual scene root, not a hardcoded `/World`.

```json
{"event_type":"openStageResult","payload":{"url":"scene.usd","result":"success","root_prim_path":"/stage"}}
```

Same-stage fast success should still refresh the client state:

```python
def _handle_open_stage(self, payload):
    url = resolve_scene_url(payload.get("url", ""))
    same_stage = (
        self.server.current_stage_url
        and os.path.normcase(os.path.abspath(url))
        == os.path.normcase(os.path.abspath(self.server.current_stage_url))
    )
    if same_stage:
        root_path = self.server.current_stage_root_path or "/World"
        self.send_message("openStageResult", {
            "url": self.server.current_stage_url,
            "result": "success",
            "root_prim_path": root_path,
        })
        children = self.server._pxr.get_children(root_path)
        self.send_message("getChildrenResult", {"prim_path": root_path, "children": children})
        return

    # Otherwise start the real load path, preferably on a background thread.
```

## Exact Event Names

Common mismatches:

| Wrong | Correct |
|---|---|
| `openedStageResult` | `openStageResult` |
| `getChildrenResponse` | `getChildrenResult` in current app |
| `stageSelectionUpdate` | `stageSelectionChanged` |

Always verify active frontend `onCustomEvent` routing.

## WebRTC Direct Config Issues

For local development, bypass external STUN/ICE:

```python
config.webrtc_signal_port = 49100
config.webrtc_public_ip = "127.0.0.1"
```

The frontend must not set `mediaServer` or `mediaPort`; media is UDP and
negotiated through SDP. Use only the standalone `ovstream` Direct fields from
`streaming-client`: `server` and `signalingPort`. OKAS, Kubernetes, or another
orchestrator may provide the endpoint and manage lifecycle, but the browser
WebRTC config must not add Kit/OVC/NVCF/GFN profile fields, sign-in URLs,
custom signaling paths, or auth/session fields.

## Validation Boundary

Do not use a one-shot headless browser screenshot as the sole proof that WebRTC
video works. It can capture the DOM before ICE/SDP negotiation, data-channel
open, or the first decoded video frame. For generated viewers, collect validation
in two layers:

- Server proof: `/healthz` returns `200 ok`, the server logs the first converted
  frame, and dependency verification passed.
- Browser proof: a real or Playwright-driven browser session performs the same
  user action as the UI, waits for the video element to report nonzero decoded
  dimensions and connected app state, then captures a screenshot or validation
  report.

If browser negotiation fails but the server proof passes, report it as a
browser/WebRTC validation blocker rather than changing renderer architecture or
adding a client-side renderer fallback.

## Reconnects And Send Guard

Aggressive reconnect can flood logs with `Previous session is already running`.

```typescript
const config = { server: host, signalingPort: 49100, maxReconnects: 5, reconnectDelay: 3000 };
```

`server.send_message()` may no-op or raise during disconnected windows. Check `server.is_client_connected` first.

`server.send_message()` can still fail during a disconnect race after the connected check. Wrap outbound sends and drop failures at debug level instead of crashing the render loop:

```python
def send_event(server, event_type: str, payload: dict) -> None:
    if not server.is_client_connected:
        return
    try:
        server.send_message(json.dumps({"event_type": event_type, "payload": payload}, default=str))
    except Exception:
        logger.debug("Dropping event during disconnect: %s", event_type, exc_info=True)
```

## One Frame Then Black

If the browser shows one rendered frame, then turns black, and the server logs `connected=True` followed by `connected=False` within about a second, inspect frontend lifecycle before changing renderer code.

Common cause: the React effect that calls `AppStreamer.connect()` depends on a stateful `routeEvent`/message handler. Receiving `openStageResult`, `getChildrenResult`, or status messages updates state, recreates the callback, runs effect cleanup, and cleanup calls `AppStreamer.terminate(false)`.

Fixes:

- Make the connect effect depend only on stable connection config such as `host` and `signalingPort`.
- Keep message routing in a stable callback or ref-backed dispatcher.
- Catch rejected `AppStreamer.sendMessage()` Promises during reconnect windows.
- Avoid development `React.StrictMode` until duplicate connect/cleanup behavior is explicitly guarded.
- Add explicit `z-index` to DOM overlays above the `<video>` element so controls are not hidden by the video layer.

## Callback Threading

`on_input`, `on_unicode`, `on_message`, and `on_connection` are called from ovstream/StreamSDK internal threads. Keep handlers fast; dispatch slow USD queries or scene loads to your own queue/thread when needed.

## Async Stage Loading

Never run `_load_stage()` synchronously on the ovstream message callback thread. Large stages can spend tens of seconds compiling shaders or resolving assets; WebRTC video/control liveness can fail after roughly 7 seconds without frames or heartbeats.

Handle `openStageRequest` by starting a background load thread and returning/loading-state updates promptly. Guard renderer mutation with `stage_lock`, but keep the render loop alive:

- During load, acquire `stage_lock` non-blocking in the render loop.
- If the lock is unavailable, skip `renderer.step()` for that tick.
- Continue streaming the last successfully encoded frame so WebRTC stays connected.
- Send the final `openStageResult` only after the load has committed current stage state, including `root_prim_path`.

See also: `streaming-server`, `streaming-client`, `streaming-messages`.
