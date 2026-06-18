# Streaming Client And Protocol

## 7. Build The React WebRTC Client

Do this in `frontend/src/streaming/` and `frontend/src/App.tsx`:

- Create a streaming provider that resolves host and signaling port from URL parameters first, environment variables second, a `stream.config.json` file third, and browser hostname plus default port last.
- Render the video element with the exact id expected by AppStreamer before attempting to connect.
- Connect with the Direct stream mode and the resolved signaling host/port from a stable React effect.
- Style the video with `object-fit: contain` so the fixed-resolution stream scales to the available page area without distortion.
- Expose status, error message, connection lifecycle events, a guarded send helper, and custom-event subscription to the rest of the app.
- Mount the viewport video first, then overlay DOM controls such as toolbar, scene picker, tree, property panel, status, and settings.
- Clean up custom-event subscriptions on component unmount.

Critical contracts:

- Use `server` in the Direct config, not `signalingServer`.
- Do not configure `mediaServer` or `mediaPort` for the browser client. SDP negotiates media.
- Do not construct sign-in URLs, append custom signaling paths, or add
  auth/session fields to the browser WebRTC config. Orchestrators may launch and
  route the session, but the frontend should receive a standalone `ovstream`
  Direct host and signaling port.
- The video element must exist before connect starts.
- Gate initial data-channel sends on connected status.
- Keep the `AppStreamer.connect()` effect dependent only on immutable connection config. Do not let stateful message routers recreate the effect after `openStageResult`, `getChildrenResult`, or status events arrive.
- Catch rejected `AppStreamer.sendMessage()` Promises during connect/disconnect windows.
- Give DOM overlays explicit `z-index` above the video layer.
- Use modest reconnect settings to avoid repeated `previous session already running` churn.
- Let the streaming library forward mouse, keyboard, wheel, and touch input through NVST's native input channel. Do not duplicate these as app JSON.
- Do not send viewport-size messages when CSS layout changes. Keep the stream fixed and rely on NVST letterbox coordinate mapping.

Decision points:

- If the app should auto-load a default scene, send `openStageRequest` only after connected status is reached.
- If the server loads an initial scene before the browser connects, rely on server initial-state push rather than requiring the frontend to guess.
- If the user wants a dense tool UI, keep it as DOM overlay around the video. Use server-side overlays only when they must be part of the streamed pixels.
- If the client runs from a different machine, expose host and signaling port through URL parameters.

### Production `stream.config.json`

For production builds served as static files (e.g., from a Docker container or CDN), the frontend cannot rely on Vite environment variables or dev-server proxying. Place a `stream.config.json` in the frontend `dist/` directory:

```json
{
  "source": "local",
  "local": {
    "server": "<server-ip-or-hostname>",
    "signalingPort": 49100,
    "mediaPort": null,
    "mediaServer": "<server-ip-or-hostname>"
  }
}
```

- `server`: IP or hostname of the ovstream signaling server, reachable from the client browser.
- `signalingPort`: WebSocket signaling port (default `49100`).
- `mediaPort`: Set to `null` to let SDP negotiation determine the media port.
- `mediaServer`: Usually the same as `server`; set differently only if media routes through a separate IP.

The frontend should fetch `stream.config.json` at startup and use its values as defaults when URL parameters are not provided. This enables zero-rebuild reconfiguration of the streaming target for containerized or remote deployments.

Common failure modes:

- Connecting before the video element exists produces a connection that cannot display video.
- Setting media port to the signaling port produces connected-with-no-video failures.
- Sending requests before data channel readiness drops initial scene loads.
- One rendered frame then black can be caused by React effect cleanup calling `AppStreamer.terminate()` after normal app state updates.
- A frontend waiting for `getChildrenResponse` while the server sends `getChildrenResult` leaves the tree empty.

Read for depth: see `references/streaming-client` and `references/streaming-lifecycle` for the full React/AppStreamer contract.

## 8. Define The Data-Channel Protocol

Do this before wiring UI features:

- Define the app envelope as `event_type` plus `payload` in both directions.
- Make the server unwrap the browser library's outer message envelope when present. The app message may arrive inside a `data` field rather than as the top-level object.
- Register handlers by exact event name.
- Validate each payload before mutating renderer or USD state.
- Send all responses and pushed events through one guarded send helper.

Use this message set for the complete Omniverse Realtime Viewer:

| Flow | Client event | Required payload | Server event | Required payload |
|---|---|---|---|---|
| Open scene | `openStageRequest` | `url` | `openStageResult` | `url`, `result`, optional `error` |
| Reset scene | `resetStageRequest` | empty object | `openStageResult` or loading/error events | current URL/result |
| Loading state | `loadingStateQuery` | empty object | `loadingStateResponse` | `url`, `loading_state` |
| Progress amount | none | none | `updateProgressAmount` | `amount` |
| Progress activity | none | none | `updateProgressActivity` | `activity` |
| Get hierarchy children | `getChildrenRequest` | `prim_path`, optional `filters` | `getChildrenResult` | `prim_path`, `children` |
| Get properties | `getPropertiesRequest` | `prim_path` | `getPropertiesResponse` | `prim_path`, `properties` |
| Select prims | `selectPrimsRequest` | `paths` | `stageSelectionChanged` | `prims` |
| Make prims selectable | `makePrimsSelectable` | `paths` | optional status/error | implementation-specific |
| Make scene pickable | `makePrimsPickable` | optional filters | optional status/error | native pickability state |
| Get variants | `getVariantsRequest` | `prim_path` | `getVariantsResponse` | `prim_path`, `variants` |
| Set variant | `setVariantRequest` | `prim_path`, `variant_set`, `variant_selection` | `getVariantsResponse` plus reload/dirty events | updated variants |
| Set render setting | `setRenderSettingRequest` | setting key and value | `renderSettingsChanged` | full effective settings plus `result`, `applied`, `applies_at`, `requires_reload`, optional `message` |
| Query render settings | `getRenderSettingsRequest` | empty object | `renderSettingsChanged` | full effective settings plus supported-setting capabilities |
| Camera command | `cameraCommandRequest` | command and optional values | `cameraStateChanged` | current camera state |
| Fit camera | `fitCameraRequest` | optional target prim path | `cameraStateChanged` | current camera state |
| Error | none | none | `viewerError` | `code`, `message`, optional context |

Critical contracts:

- Exact event names matter. Use `openStageResult`, `getChildrenResult`, and `stageSelectionChanged`.
- `paths: []` in `selectPrimsRequest` clears selection.
- Children semantics must be stable: expandable-but-not-loaded is truthy, loaded children is an array, and leaf is null or absent.
- Properties and variants responses must include the requested `prim_path` so the frontend can ignore stale responses.
- Message handlers that load scenes, set variants, or change heavy settings must enqueue work for the render thread.
- Message handlers that only query cached state may respond immediately if they do not touch renderer-owned state.
- `setRenderSettingRequest` must reject keys that are not in the server capability list. Success means the active viewer state changed, or an explicit non-live action was accepted.
- For runtime prim discovery, prefer `renderer.query_prims(...)` / `query_prims_async(...)` and return its resolved path strings. Use a `pxr` worker only for queries not exposed through ovrtx native stage APIs.
- Push `openStageResult` and root `getChildrenResult` after a client connects if a stage is already loaded.

Decision points:

- If stage hierarchy queries are slow or risky in the renderer process, move them behind a subprocess owned by `stage_queries.py`.
- If multiple UI panels can request the same data, make responses idempotent and keyed by prim path instead of relying on request ordering.
- If a feature is optional, still reserve its event names in one central protocol table to avoid drift.

Common failure modes:

- Failing to unwrap the outer browser envelope makes the server see `messageType` instead of `event_type`.
- Using older response names such as `getChildrenResponse` breaks current frontend routing.
- Sending app state before the data channel is ready causes permanent loading indicators unless initial state is pushed on connection.

Read for depth: see `references/streaming-messages`, `references/streaming-lifecycle`, and `references/stage-hierarchy` for the full protocol and query contracts.

## 14. Wire Frontend Components

Do this after the stream connects and core messages work:

- `Viewport` renders the video element and any DOM overlay controls.
- `Toolbar` sends fit camera, reset view, render settings toggle, and debug view commands.
- `ScenePicker` lists available scenes and sends `openStageRequest`.
- `StageTree` requests children lazily and sends `selectPrimsRequest` on row selection.
- `PrimInfoPanel` subscribes to selection and requests properties/variants for the active prim.
- `RenderSettingsPanel` renders backend-advertised capabilities, displays effective settings, and sends validated changes.
- `StatusBar` displays connection, loading state, current scene, FPS if available, and latest viewer error.

Critical contracts:

- The video element id must match AppStreamer config exactly.
- Keep data-channel sends behind the streaming provider's connected-state guard.
- Treat server events as authoritative for loaded scene, selection, settings, and errors.
- Do not duplicate pointer input handling in DOM unless it is for UI widgets outside the video viewport.
- Clean up event subscriptions when components unmount.

Decision points:

- If a panel is optional, still keep the provider and message types stable so the feature can be added later.
- If a UI widget overlaps the video, ensure it does not intercept pointer events meant for camera/selection unless the widget is actively being used.
- If the app needs keyboard shortcuts, decide which shortcuts are browser UI shortcuts and which should pass through to the streamed app input path.

Common failure modes:

- DOM overlays intercept all pointer events and camera controls stop working.
- Frontend local state diverges when it assumes requests succeeded instead of waiting for server events.
- Components leak subscriptions and process every server event multiple times after navigation.

Read for depth: see `references/streaming-client`, `references/streaming-messages`, and `references/streaming-lifecycle` for the full frontend contracts.
