# Streaming Client

## Triggers

Use this skill for React streaming client, AppStreamer, DirectConfig,
standalone ovstream Direct WebRTC, browser-streamed Omniverse Realtime Viewer,
remote-video, StreamingContext, VITE_SERVER_HOST, frontend no video, or
object-fit contain.

Use this for the browser side of a WebRTC Omniverse Realtime Viewer backed by
standalone `ovstream`. The viewer service may run under OKAS, Kubernetes, or
another session orchestrator, but the browser WebRTC client profile remains
standalone `ovstream` Direct mode, not a Kit, OVC, NVCF, or GFN connection
profile.

## AppStreamer Direct API

Install the current released `@nvidia/ov-web-rtc` package as described in
`references/dependencies/nvidia-runtime.md`. For the connection shape, use the
current `ovstream` WebRTC browser client example as the reference:
<https://github.com/NVIDIA-Omniverse/ovstream/tree/main/examples/webrtc_client>

```typescript
import { AppStreamer, StreamType, type DirectConfig } from '@nvidia/ov-web-rtc';

const config: DirectConfig = {
  videoElementId: 'remote-video',
  audioElementId: 'remote-audio',
  server: 'localhost',
  signalingPort: 49100,
  nativeTouchEvents: true,
  fps: 60,
  maxReconnects: 5,
  reconnectDelay: 3000,
  onStart: msg => {},
  onUpdate: msg => {},
  onCustomEvent: msg => {},
  onStop: msg => {},
  onTerminate: msg => {},
};

await AppStreamer.connect({ streamSource: StreamType.DIRECT, streamConfig: config });
```

`onCustomEvent` receives parsed app JSON. Mouse, keyboard, wheel, and touch events are forwarded by the streaming library automatically; do not send them manually as JSON messages.

## DirectConfig Gotchas

- Use `streamSource: StreamType.DIRECT` with `server` and `signalingPort` for
  the standalone `ovstream` server.
- Do not use Kit, OVC, NVCF, or GFN client connection profiles in the browser
  WebRTC config. If an orchestrator launches the session, map its exposed
  endpoint to `server` and `signalingPort`.
- Do not set `mediaServer` or `mediaPort`; SDP discovers the UDP media endpoint. Setting `mediaPort: 49100` sends media to the TCP signaling port and causes connected-with-no-video failures.
- Do not construct a sign-in URL, append a custom signaling path, or add
  auth/session fields to `DirectConfig`. Portal auth and session lifecycle
  belong outside the browser WebRTC client config.
- The `<video id="remote-video">` element must exist in the DOM before `connect()`.
- Tune reconnects to avoid log storms: `maxReconnects: 5`, `reconnectDelay: 3000`.
- Keep the React effect that calls `AppStreamer.connect()` stable. It should depend only on immutable connection config, not on stateful message routers that change when app messages arrive.
- Avoid `React.StrictMode` for the first direct-streaming scaffold unless the connect effect explicitly guards double mount/connect. StrictMode can intentionally mount, cleanup, and remount effects in development.
- `AppStreamer.sendMessage()` returns a Promise. Treat app messages as fire-and-forget during reconnect windows and catch rejected sends so transient disconnects do not surface as unhandled browser errors.

```tsx
function sendMessage(message: StreamMessage) {
  if (!connectedRef.current) return;
  void AppStreamer.sendMessage(message).catch(() => undefined);
}
```

## StreamingContext Pattern

Wrap AppStreamer in React context:

```tsx
<StreamingProvider>
  <AppContent />
</StreamingProvider>

const { status, sendMessage, onCustomEvent, errorMessage } = useStreaming();
```

The provider should own exactly one `AppStreamer.connect()` call for a given host/port pair. Keep `onCustomEvent` routing behind a stable callback or a ref-backed dispatcher so state updates from server events do not recreate the connection effect and trigger cleanup.

The hook should expose:

| Field | Purpose |
|---|---|
| `status` | `'connecting' | 'connected' | 'failed'` |
| `sendMessage` | send `{event_type, payload}`; no-op if disconnected |
| `onCustomEvent` | subscribe to server messages; returns cleanup |
| `errorMessage` | failure detail |

On connect, prefer the server's `push_initial_state` when a stage is already loaded; it should send `openStageResult`, root `getChildrenResult`, AOV state, and any overlay state after the data channel opens. If the server starts idle and the app has bundled samples, auto-open the first sample once after `status === 'connected'`. Send later `openStageRequest` messages only when the user switches scenes, opens a file, or resets/reloads.

```tsx
const openedInitial = useRef(false);

useEffect(() => {
  if (status !== 'connected' || openedInitial.current) return;
  openedInitial.current = true;
  sendMessage({ event_type: 'openStageRequest', payload: { url: sampleAssets[0].url } });
}, [status, sendMessage]);

function handleSelectAsset(url: string) {
  sendMessage({ event_type: 'openStageRequest', payload: { url } });
}
```

Clean up handlers:

```tsx
useEffect(() => {
  const unsub = onCustomEvent(event => routeEvent(event));
  return unsub;
}, [onCustomEvent]);
```

Do not call `AppStreamer.terminate()` from ordinary message-handler cleanup. Only terminate when the provider is truly unmounting or the user intentionally disconnects. A common failure is: connect, receive `openStageResult`, rerender, effect cleanup calls terminate, video shows one frame, then goes black.

## Video Layout

Browser-streamed Omniverse Realtime Viewer apps use a fixed server render resolution, typically 1920x1080. Let the page resize the video element with preserve-aspect containment:

```css
#remote-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

Do not send viewport-size messages when CSS layout changes. NVST handles letterbox coordinate mapping for stream input when the video is contained inside a differently shaped DOM box. Do not synthesize JSON `mouseInput`; AppStreamer/NVST forwards browser input through the native input channel.

For React shells with sidebars, top bars, or inspectors, keep the stream surface
layout-stable while UI state changes:

```css
.viewer-shell {
  height: 100vh;
  overflow: hidden;
}

.viewer-content,
.sidebar,
.viewport {
  min-height: 0;
  overflow: hidden;
}

.viewport {
  position: relative;
}

#remote-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

Do not let tree expansion, property-panel updates, or selection state change the
viewport container's dimensions. Use flex/grid tracks with constrained overflow
for adjacent panels so the `<video>` element remains pinned while React rerenders.

## Viewport Input Ownership

Browser DOM controls can sit above or beside the streamed video, but native WebRTC
input still belongs to the server. Explicitly arm viewport input only while the
pointer is over the viewport, and disarm it when the pointer enters or presses UI
chrome:

```tsx
function setViewportInputActive(active: boolean) {
  sendMessage({
    event_type: 'setViewportInputActive',
    payload: { active },
  });
}

<aside
  onPointerEnter={() => setViewportInputActive(false)}
  onPointerDown={() => setViewportInputActive(false)}
  onWheel={() => setViewportInputActive(false)}
>
  <StageTree />
</aside>

<main
  className="viewport"
  onPointerEnter={() => setViewportInputActive(true)}
  onPointerDown={() => setViewportInputActive(true)}
  onPointerLeave={() => setViewportInputActive(false)}
>
  <video id="remote-video" muted autoPlay playsInline />
</main>
```

The server should implement the matching gate from `viewer-input-routing`, ignore
`on_input` events while this flag is false, and cancel any active camera drag.
This prevents sidebar clicks, tree expansion, inspector scrolling, and top-bar
selection changes from being interpreted as camera orbit, pan, zoom, or pick
gestures.

## Config Resolution

Use this priority:

1. URL params: `?server=192.168.1.50&signalingport=49100`
2. Env vars: `VITE_SERVER_HOST`, `VITE_SIGNALING_PORT`
3. Defaults: `window.location.hostname`, port `49100`

```bash
VITE_SERVER_HOST=192.168.1.100
VITE_SIGNALING_PORT=49100
```

## Component Layout

```text
App.tsx
  StreamingProvider
    AppContent
      video#remote-video
      stage selector
      StageTree recursive tree
      Inspector selected-prim panel
```

When generating a streaming frontend, create equivalent files such as
`frontend/src/streaming/StreamingContext.tsx`, `frontend/src/App.tsx`,
`frontend/src/components/StageTree.tsx`,
`frontend/src/components/Inspector.tsx`,
`frontend/src/hooks/useWebRTCBackend.ts`, and `frontend/src/types/usd.ts`.

## ViewerBackend Adapter

When using shared UI components, wrap AppStreamer in a `ViewerBackend` adapter instead of letting every component send raw messages. The adapter is promise-based for query responses, observable for selection, and caches tree responses by path.

Required methods:

```typescript
export interface ViewerBackend {
  connect(): Promise<void>;
  disconnect(): void;
  loadStage(url: string): Promise<void>;
  getChildren(path: string): Promise<PrimNode[]>;
  getStageTree(rootPath?: string): Promise<PrimNode[]>;
  getProperties(path: string): Promise<PrimProperty[]>;
  getVariants(path: string): Promise<Record<string, { options: string[]; selection: string }>>;
  setVariant(path: string, variantSet: string, selection: string): Promise<void>;
  selectPrims(paths: string[]): Promise<void>;
  onSelectionChanged(callback: (paths: string[]) => void): () => void;
}
```

Adapter implementation rules:

- Keep resolver buckets keyed by URL or prim path for `openStageResult`, `getChildrenResult`, `getPropertiesResponse`, and `getVariantsResponse`.
- Add timeouts to promises so dropped data-channel responses do not hang UI components permanently.
- Cache latest children per `prim_path` and return cached rows if a request times out.
- Subscribe to `stageSelectionChanged` and call every selection subscriber with the canonical server path list.
- On `getChildrenResult`, make returned child paths selectable by sending `makePrimsSelectable {paths}`.
- Accept the current property event name `getPropertiesResponse`; handle `getPropertiesResult` only as a compatibility alias.
- For selected-prim panels, keep the latest selected path in a `useRef` and
  compare `getPropertiesResponse.prim_path` against that ref. Do not compare
  against a `selectedPath` value captured in the React message callback closure;
  fast server responses can otherwise be dropped after a valid
  `stageSelectionChanged` event.
- Route AppStreamer lifecycle through `EventAction` and `EventStatus`: `EventAction.START` plus `EventStatus.SUCCESS` means connected; `EventStatus.ERROR`, `onStop`, and `onTerminate` update failed/connecting state and reject relevant pending work.

Resolver pattern:

```typescript
const childResolvers = useRef(new Map<string, Resolver<PrimNode[]>[]>());
const propertyResolvers = useRef(new Map<string, Resolver<PrimProperty[]>[]>());
const variantResolvers = useRef(new Map<string, Resolver<VariantMap>[]>());
const selectionHandlers = useRef(new Set<(paths: string[]) => void>());
const treeCache = useRef(new Map<string, PrimNode[]>());

case 'getChildrenResult': {
  const payload = event.payload as { prim_path?: string; children?: PrimNode[] };
  const key = payload.prim_path || rootPrimPathRef.current;
  const children = normalizeChildren(payload.children || []);
  treeCache.current.set(key, children);
  resolveBucket(childResolvers.current, key, children);
  sendMessage({ event_type: 'makePrimsSelectable', payload: { paths: children.map((c) => c.path) } });
  break;
}
case 'getPropertiesResponse':
case 'getPropertiesResult': {
  const payload = event.payload as { prim_path?: string; properties?: Record<string, unknown> };
  resolveBucket(propertyResolvers.current, payload.prim_path || '', toPrimProperties(payload.properties || {}));
  break;
}
case 'getVariantsResponse': {
  const payload = event.payload as { prim_path?: string; variants?: VariantMap };
  resolveBucket(variantResolvers.current, payload.prim_path || '', payload.variants || {});
  break;
}
```

Track the server-provided root path. `openStageResult` includes `root_prim_path`; use it for the initial hierarchy query, top-level `makePrimsSelectable`, and shared backend `getStageTree()` defaults.

```tsx
const rootPrimPathRef = useRef('/World');

case 'openStageResult': {
  const payload = event.payload as { result: string; url: string; root_prim_path?: string };
  if (payload.result === 'success') {
    const root = payload.root_prim_path || '/World';
    rootPrimPathRef.current = root;
    sendMessage({ event_type: 'getChildrenRequest', payload: { prim_path: root } });
    sendMessage({ event_type: 'getPrimCountRequest', payload: {} });
  }
  break;
}
case 'getChildrenResult': {
  const payload = event.payload as { prim_path: string; children: ServerPrim[] };
  const children = (payload.children || []).map(normalizePrim);
  if (payload.prim_path === rootPrimPathRef.current) setPrims(children);
  else setPrims(prev => updatePrimChildren(prev, payload.prim_path, children));
  const paths = children.map(child => child.path).filter(Boolean);
  if (paths.length > 0) {
    sendMessage({ event_type: 'makePrimsSelectable', payload: { paths } });
  }
  break;
}
```

If using the shared UI adapter, route property responses by the current event name:

```typescript
case 'getPropertiesResponse': {
  const payload = event.payload as { prim_path?: string; properties?: Record<string, unknown> };
  const properties = Object.entries(payload.properties || {}).map(([name, value]) => ({
    name,
    type: typeof value,
    value: String(value),
  }));
  resolveBucket(propertyResolvers.current, payload.prim_path || '', properties);
  break;
}
```

Do not listen only for the stale `getPropertiesResult` name.

For direct React inspectors without a full `ViewerBackend`, correlate property
responses through a ref-backed selected path:

```tsx
const [selectedPath, setSelectedPath] = useState('');
const selectedPathRef = useRef('');

case 'stageSelectionChanged': {
  const next = payload.prims?.[0] || '';
  selectedPathRef.current = next;
  setSelectedPath(next);
  setProperties(null);
  if (next) {
    sendMessage({ event_type: 'getPropertiesRequest', payload: { prim_path: next } });
  }
  break;
}
case 'getPropertiesResponse': {
  const payload = event.payload as { prim_path?: string; properties?: Record<string, unknown> };
  if (payload.prim_path === selectedPathRef.current) {
    setProperties(payload.properties || {});
  }
  break;
}
```

## Frontend UI Expectations

A full browser client should be a usable Omniverse Realtime Viewer UI, not just
a video tag. Include these pieces when generating a full browser-streamed
Omniverse Realtime Viewer:

- Auto-open the first sample stage once the stream connects when the server has not already pushed a loaded stage.
- Honor server `push_initial_state` on reconnect: do not require a fresh user action to leave loading state.
- Populate the AOV `<select>` from `availableAOVsResult` or `activeAOVState.available`; do not hardcode only `LdrColor`, `NormalSD`, and `DepthSD`.
- Display prim count from `getPrimCountResult`.
- Display connection status, FPS from video playback quality when available, and latency when WebRTC stats expose it.
- Stage tree supports lazy expansion, search/filter, selected-row state, and prim type icons.
- Use icon sprites or equivalent symbols for `mesh/geom`, `camera`, `light`, `scope`, and `xform`.
- Inspector tracks selected prims from `stageSelectionChanged` and fetches properties with `getPropertiesRequest`.
- Inspector ignores stale property responses by matching `prim_path` to a
  ref-backed current selection, not to closure-captured React state.
- Keep `#remote-video { object-fit: contain; }`, pin it inside a stable viewport container, and put DOM controls above the video with explicit `z-index`.
- DOM controls disable viewport input with `setViewportInputActive {active:false}`;
  the viewport enables it while the pointer is over the stream.

When DOM controls overlay the stream, give them explicit stacking above the `<video>` element:

```css
.toolbar,
.error-banner {
  position: absolute;
  z-index: 3;
}
```

Without explicit stacking, the hardware video layer can visually cover controls once frames arrive, making the app look like it lost the connection UI.

## Recursive Tree Updates

```typescript
function updatePrimChildren(prims: USDPrim[], targetPath: string, children: USDPrim[]): USDPrim[] {
  return prims.map(prim => {
    if (prim.path === targetPath) return { ...prim, children };
    if (prim.children && Array.isArray(prim.children))
      return { ...prim, children: updatePrimChildren(prim.children, targetPath, children) };
    return prim;
  });
}
```

Children semantics: truthy non-array means expandable/not loaded, `null` or absent means leaf, array means loaded children.

The current server worker returns `children: boolean` as expandability metadata, while `StageTree` reads `hasChildren`. Normalize at the boundary:

```typescript
type ServerPrim = Omit<USDPrim, 'children'> & {
  children?: ServerPrim[] | boolean | null;
  has_children?: boolean;
};

function normalizePrim(prim: ServerPrim): USDPrim {
  const childArray = Array.isArray(prim.children) ? prim.children.map(normalizePrim) : undefined;
  const hasChildren = Array.isArray(prim.children)
    ? prim.children.length > 0 || Boolean(prim.hasChildren ?? prim.has_children)
    : Boolean(prim.hasChildren ?? prim.has_children ?? prim.children);
  return { ...prim, hasChildren, children: childArray ?? null };
}
```

See also: `streaming-server`, `streaming-messages`, `streaming-lifecycle`, `stage-management`, `stage-hierarchy`.
