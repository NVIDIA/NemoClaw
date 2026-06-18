# Viewer Backend Interface

## Triggers

Use this skill for `ViewerBackend`, local shared UI, backend-agnostic React
viewer UI, reusable viewer components, viewer interface adapters, or
cross-transport UI.

Use this when a frontend should share the same panels, inspectors, selection controls, asset list, and viewer widgets across WebRTC streaming, Electron SHM, Tauri SHM/native IPC, or a future transport.

## Purpose

The local viewer UI module is generated React component code plus a TypeScript
interface contract. The contract lets UI components depend on one
`ViewerBackend` object instead of transport-specific APIs such as AppStreamer
messages, Electron preload calls, Tauri commands, or future IPC layers.

The shared UI does not render USD or 3D content. All USD rendering still uses `ovrtx` in the appropriate server or native process. The UI displays a video, canvas, or pixel surface owned by the transport and overlays reusable React controls that call `ViewerBackend`.

## Read These Skills

| Need | Read |
|---|---|
| Browser/WebRTC transport | `streaming-client`, `streaming-messages`, `streaming-lifecycle` |
| Electron + SHM local transport | `electron-shm-viewer`, `webgl-shm-transport` |
| Tauri/native desktop transport | `tauri-local-viewer` |
| Camera input behavior | `viewer-input-routing`, `camera-controls` |
| Picking and selection | `viewer-input-routing`, `object-selection`, `selection-feedback` |
| Hierarchy and property data | `stage-hierarchy`, `stage-attribute-reads` |
| AOV and render settings messages | `aov-switching`, `render-settings` |

## Local Module Setup

Generate these files inside the frontend app unless the user requests a
different local structure:

```text
frontend/src/viewer-ui/
  ViewerBackend.ts
  types.ts
  StageTree.tsx
  PropertyPanel.tsx
  Inspector.tsx
  PrimIconSprite.tsx
  USDAsset.tsx
  index.ts
```

Use `index.ts` as the local barrel export. Do not add an external package
dependency for shared viewer UI.

Import components and types from the local module:

```typescript
import {
  Inspector,
  PrimIconSprite,
  PropertyPanel,
  StageTree,
  USDAsset,
  type FrameData,
  type PrimNode,
  type PrimProperty,
  type USDAssetItem,
  type ViewerBackend,
} from './viewer-ui';
```

The local `index.ts` exports `Inspector`, `InspectorProps`, `PrimIconSprite`,
`PropertyPanel`, `StageTree`, `StageTreeProps`, `USDAsset`, and all shared
viewer types.

## ViewerBackend Interface

Implement this interface at the transport boundary. Components should call this interface, not raw WebRTC, Electron, Tauri, or server-message APIs.

```typescript
export interface ViewerBackend {
  connect(): Promise<void>;
  disconnect(): void;
  loadStage(path: string): Promise<void>;
  resize?(width: number, height: number): Promise<void>;
  sendRenderScale?(scale: number): Promise<void>;
  setCamera(params: CameraParams): Promise<void>;
  cameraMouseButton(input: PointerInput): Promise<boolean>;
  cameraMouseMove(x: number, y: number): Promise<void>;
  cameraWheel(delta: number): Promise<void>;
  onFrame(callback: (frame: FrameData) => void): () => void;
  onStats?(callback: (stats: FrameBudgetStats) => void): () => void;
  onLoadProgress?(callback: (progress: LoadProgressEvent) => void): () => void;
  onAOVStateChanged?(callback: (active: string, available: string[]) => void): () => void;
  changeAOV?(aov: string): Promise<void>;
  onSelectionChanged(callback: (paths: string[]) => void): () => void;
  pick(x: number, y: number): Promise<string | null>;
  getStageTree(rootPath?: string): Promise<PrimNode[]>;
  selectPrims(paths: string[]): Promise<void>;
  getProperties(path: string): Promise<PrimProperty[]>;
}
```

Method contract:

| Method | Contract |
|---|---|
| `connect()` | Establish the transport, register event/frame listeners, and resolve when commands can be sent. Guard duplicate calls from React remounts. |
| `disconnect()` | Remove listeners, stop frame pumps, close transport handles, and reject or clear pending resolvers. Make cleanup safe to call more than once. |
| `loadStage(path)` | Ask the backend to load a USD stage by URL/path. Clear stale tree, property, selection, progress, AOV, and pending-pick state. Resolve after the backend accepts or completes the load according to that transport's normal semantics. |
| `resize?(width, height)` | Resize a backend-owned dynamic render target when supported. Fixed-resolution video and fixed render-product transports should implement a no-op or omit this method. |
| `sendRenderScale?(scale)` | Request a render-scale change when the backend supports adaptive scaling. Clamp to supported values and publish the effective scale through frame or stats updates when possible. |
| `setCamera(params)` | Set camera state directly for backends that own explicit camera parameters. Native-input transports may resolve without action if camera motion is driven by pointer messages. |
| `cameraMouseButton(input)` | Send a button press/release to the camera controller. Return `true` when the backend classifies the gesture as a click so callers can perform selection picking. |
| `cameraMouseMove(x, y)` | Send pointer motion in viewport-local CSS pixels. Continuous input should be fire-and-forget internally but the Promise should settle quickly. |
| `cameraWheel(delta)` | Send wheel zoom input. Preserve the backend's existing wheel sign convention from `viewer-input-routing` and `camera-controls`. |
| `onFrame(callback)` | Subscribe to frame arrivals or frame timing. Return an unsubscribe function. `FrameData.pixels` is optional because WebRTC video transports may expose only timing. |
| `onStats?(callback)` | Subscribe to transport/render performance stats such as FPS, queue depth, dropped frames, latency, and WebRTC inbound RTP stats when available. |
| `onLoadProgress?(callback)` | Subscribe to stage-load progress phases. Use this for progress bars and disabled UI states during load. |
| `onAOVStateChanged?(callback)` | Subscribe to active AOV and available AOV list changes. Call immediately with cached state when available so controls populate after reconnect. |
| `changeAOV?(aov)` | Request an AOV/render-var switch. Reject unsupported AOV names or no-op only when the backend intentionally has no AOV support. |
| `onSelectionChanged(callback)` | Subscribe to canonical selected prim paths. Return an unsubscribe function and fan out both local UI selections and server/native selection events. |
| `pick(x, y)` | Return the prim path under a viewport-element-local CSS pixel coordinate, or `null`. Never require callers to pass window coordinates. |
| `getStageTree(rootPath?)` | Return normalized `PrimNode[]` for the root or requested prim path. It may use cached tree data, lazy queries, or a full hierarchy snapshot. |
| `selectPrims(paths)` | Select the canonical prim paths in the backend and publish the same path list through `onSelectionChanged`. Also update native selection/highlight state when supported. |
| `getProperties(path)` | Return displayable properties for a prim as `PrimProperty[]`. Normalize backend dictionaries, USD values, or typed command responses at this boundary. |

## Critical Coordinate Contract

`pick(x, y)`, `cameraMouseButton(input)`, and `cameraMouseMove(x, y)` use viewport-element-local CSS pixel coordinates, not window coordinates.

Callers starting from DOM events must subtract the viewport element rect:

```typescript
function toViewportPoint(event: React.PointerEvent, viewport: HTMLElement) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

const { x, y } = toViewportPoint(event, viewportElement);
const clicked = await backend.cameraMouseButton({ x, y, button: event.button, pressed: false });
if (clicked) {
  const pickedPath = await backend.pick(x, y);
  await backend.selectPrims(pickedPath ? [pickedPath] : []);
}
```

If a backend needs render-product pixels, map from viewport-local CSS pixels to the contained image/canvas area inside the backend or viewport adapter. Do not pass raw `PointerEvent.clientX/clientY` into `ViewerBackend`.

## Frame Delivery Contract

`FrameData.pixels` is optional. WebRTC/AppStreamer transports usually render into a `<video>` element and can only report frame timing, decoded dimensions, or stats through `onFrame`. SHM, Tauri, or future pixel transports may provide RGBA pixels.

Shared UI components must not require pixel data. Viewport display components may choose the transport-specific surface:

| Transport | Display surface | `onFrame` payload |
|---|---|---|
| WebRTC streaming | `<video>` from AppStreamer | Timing/dimensions; `pixels` usually absent |
| Electron SHM | Canvas/WebGL texture upload from SHM | RGBA pixels or transport-local buffer metadata adapted to `FrameData` |
| Tauri SHM/native IPC | Canvas/ImageData or texture upload | RGBA pixels when copied/decoded for the React layer |
| Future transport | Transport-owned surface | At least width, height, encoding, and timing when available |

## Type Catalog

```typescript
export interface CameraParams {
  azimuth?: number;
  elevation?: number;
  distance?: number;
  target?: [number, number, number];
}

export interface FrameData {
  width: number;
  height: number;
  encoding: 'rgba';
  pixels?: Uint8ClampedArray;
  frameIndex?: number;
  renderScale?: number;
}

export interface FrameBudgetStats {
  timestampMs: number;
  fps: number;
  sourceFps: number;
  frameIntervalMs: number;
  deliveryMs: number;
  queueDepth: number;
  skippedFrames: number;
  droppedFrames: number;
  renderScale: number;
  backpressure: boolean;
  frame_time_ms?: number;
  stream_time_ms?: number;
  frames_rendered?: number;
  gpu_encoder_active?: boolean;
  roundTripTimeMs?: number;
  packetsLost?: number;
  jitter?: number;
  framesDecoded?: number;
  freezeCount?: number;
  framesPerSecond?: number;
}

export type LoadProgressPhase =
  | 'resolving_asset'
  | 'loading_stage'
  | 'compiling_shaders'
  | 'ready';

export interface LoadProgressEvent {
  phase: LoadProgressPhase;
  stage_url?: string;
}

export type PrimType = 'xform' | 'scope' | 'geom' | 'light' | 'camera';

export interface PrimNode {
  name?: string;
  path: string;
  children?: PrimNode[] | null;
  hasChildren?: boolean;
  type?: PrimType;
}

export type USDPrim = PrimNode;

export interface PrimProperty {
  name: string;
  type: string;
  value: string;
}

export interface USDAssetItem {
  name: string;
  url: string;
}

export interface PointerInput {
  x: number;
  y: number;
  button: number;
  pressed: boolean;
}
```

Normalize transport payloads to these types before data reaches shared components. In particular, convert server fields such as `has_children` or boolean `children` into `hasChildren`, and convert property dictionaries into `PrimProperty[]`.

## Shared Components

| Component | Use |
|---|---|
| `StageTree` | Displays the USD hierarchy, selected-row state, expandable prims, and prim type icons. Wire row selection to `backend.selectPrims()` and expansion/lazy loading to `backend.getStageTree(path)` when the component props require callbacks. |
| `PropertyPanel` | Displays `PrimProperty[]` for one prim. Feed it data from `backend.getProperties(selectedPath)`. |
| `Inspector` | Higher-level selected-prim inspector. Use it when the app wants shared selection/property behavior instead of composing `PropertyPanel` directly. |
| `PrimIconSprite` | Defines the icon sprite used by hierarchy rows and inspector UI. Render once near the application root. |
| `USDAsset` | Displays a loadable USD asset item. Feed it `USDAssetItem` values and call `backend.loadStage(asset.url)` on activation. |

When generating components, keep prop names small and stable. Do not bake
transport APIs into components; adapt the transport to `ViewerBackend` instead.

Minimum prop contracts:

```typescript
export interface StageTreeProps {
  backend: ViewerBackend;
  selectedPaths: string[];
  rootPath?: string;
}

export interface PropertyPanelProps {
  properties: PrimProperty[];
}

export interface InspectorProps {
  backend: ViewerBackend;
  selectedPaths: string[];
}

export interface USDAssetProps {
  asset: USDAssetItem;
  backend?: ViewerBackend;
  onLoad?: (asset: USDAssetItem) => void;
}
```

Minimum behavior:

- `StageTree` loads root nodes with `backend.getStageTree(rootPath)` on mount,
  loads children when an expandable row opens, highlights `selectedPaths`, and
  calls `backend.selectPrims([path])` on row activation.
- `PropertyPanel` renders a compact name/type/value table and treats values as
  display strings unless another skill adds editing behavior.
- `Inspector` subscribes to selected paths through props, fetches properties for
  the primary selected path with `backend.getProperties(path)`, cancels stale
  responses on selection change, and renders an empty state for no selection.
- `PrimIconSprite` may be a no-op component when the app uses text labels or
  CSS icons instead of an SVG sprite.
- `USDAsset` renders one loadable asset row or button and calls `onLoad(asset)`
  when supplied; otherwise it calls `backend.loadStage(asset.url)` when a
  backend prop is supplied.

## Implementing a New Backend

Use the hook-per-transport pattern:

```text
useWebRTCBackend.ts -> AppStreamer + data-channel messages + video timing
useShmBackend.ts    -> Electron preload API + SHM frame pump + JSON control messages
useTauriBackend.ts  -> Tauri commands/events/channels + native frame delivery
```

Implementation rules:

- Return one stable `ViewerBackend` object from the hook with `useMemo`.
- Keep transport objects, request resolvers, caches, and subscriber sets in refs.
- Convert transport events into shared callbacks: frame, stats, load progress, AOV state, and selection.
- Add timeouts to request/response promises for `loadStage`, `pick`, `getStageTree`, and `getProperties`.
- Resolve responses by request id when the protocol supports it; otherwise bucket by URL/path/message type.
- Normalize all hierarchy nodes, property values, AOV names, and selected paths at the backend boundary.
- Make `disconnect()` clear subscribers only when the app is truly tearing down; ordinary event-handler cleanup should only unsubscribe that handler.
- Preserve the single render-thread/server ownership rules from the transport skill. The React backend is an adapter, not a renderer.

Resolver pattern:

```typescript
type Resolver<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: number;
};

const selectionHandlers = useRef(new Set<(paths: string[]) => void>());
const frameHandlers = useRef(new Set<(frame: FrameData) => void>());
const treeResolvers = useRef(new Map<string, Resolver<PrimNode[]>[]>());
const propertyResolvers = useRef(new Map<string, Resolver<PrimProperty[]>[]>());
const treeCache = useRef(new Map<string, PrimNode[]>());

function emitSelection(paths: string[]) {
  for (const handler of selectionHandlers.current) handler(paths);
}

function resolveBucket<T>(buckets: Map<string, Resolver<T>[]>, key: string, value: T) {
  const bucket = buckets.get(key) || [];
  buckets.delete(key);
  for (const resolver of bucket) {
    window.clearTimeout(resolver.timer);
    resolver.resolve(value);
  }
}
```

Transport notes:

- **WebRTC/AppStreamer:** `connect()` owns one AppStreamer connection. Route `onCustomEvent` messages into resolver buckets and subscriber sets. `onFrame` usually publishes timing from video playback quality or stats; leave `pixels` undefined.
- **Electron SHM:** `connect()` attaches preload/native SHM APIs and starts one frame pump. Convert SHM frames to the viewport's upload path and publish shared `FrameData` only for data the shared UI needs.
- **Tauri SHM/native IPC:** `connect()` registers Tauri event listeners and frame channels once. Decode binary RGBA frames when the React layer owns a canvas; otherwise publish timing/dimensions and let the viewport adapter own pixels.

## Integration Recipe

1. Generate `frontend/src/viewer-ui/` with the `ViewerBackend` types and local
   React components required by the app.
2. Implement a backend hook for the chosen transport: `useWebRTCBackend`, `useShmBackend`, `useTauriBackend`, or a new hook.
3. Mount the transport viewport surface: `<video>`, `<canvas>`, or a native pixel-presenting component.
4. Convert pointer events to viewport-local CSS pixels before calling camera or pick methods.
5. Subscribe to backend selection and frame/stat events in React effects.
6. Render shared UI components against the backend rather than raw transport APIs.
7. Keep transport-specific message names and native handles inside the backend hook.

Skeleton:

```tsx
function ViewerApp() {
  const backend = useWebRTCBackend(config);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  useEffect(() => {
    void backend.connect();
    return () => backend.disconnect();
  }, [backend]);

  useEffect(() => backend.onSelectionChanged(setSelectedPaths), [backend]);

  async function handlePointerUp(event: React.PointerEvent) {
    const viewport = event.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const clicked = await backend.cameraMouseButton({ x, y, button: event.button, pressed: false });
    if (!clicked) return;
    const picked = await backend.pick(x, y);
    await backend.selectPrims(picked ? [picked] : []);
  }

  return (
    <>
      <PrimIconSprite />
      <main className="viewer-shell">
        <section className="viewport" onPointerUp={handlePointerUp}>
          <video id="remote-video" />
        </section>
        <aside className="sidebar">
          <StageTree backend={backend} selectedPaths={selectedPaths} />
          <Inspector backend={backend} selectedPaths={selectedPaths} />
        </aside>
      </main>
    </>
  );
}
```

Keep the dependency direction the same: app UI calls local viewer UI
components, those components call `ViewerBackend`, and only backend hooks know
the transport.
