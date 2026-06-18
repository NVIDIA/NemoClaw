# Electron SHM Client

## Electron Main And N-API Addon

Electron main should:

- start the Python sidecar or attach to an existing SHM session
- wait for `shmReady`
- load the N-API addon from the packaged app location
- create one SHM client for the window
- run `WaitFrame` through a native async worker
- forward frame buffers to the renderer without blocking main
- forward JSON app messages between preload and the native client
- cancel pending waits before closing native handles
- terminate the Python sidecar on quit when Electron started it

Do not call a blocking frame wait directly on Electron main.

Native addon surface:

```typescript
type NativeShmClient = {
  connect(options: { name: string }): void;
  close(): void;
  waitFrame(): Promise<SharedArrayBuffer>;
  sendMessage(message: string): void;
  onMessage(callback: (message: string) => void): () => void;
};
```

Addon requirements:

- wrap `libovstream_shm_client.so`
- run frame waits on a libuv worker or equivalent async path
- resolve `waitFrame()` with a `SharedArrayBuffer` containing header + pixels
- keep mapped native memory alive for the JS frame lifetime, or copy into a
  fixed 2-3 slot SharedArrayBuffer ring
- never expose raw pointers, file descriptors, or native handles to JS callers
- validate frame bounds before creating JS views
- make `close()` cancel pending waits safely
- rebuild the addon when Electron ABI changes

Do not allocate a fresh JS buffer every frame. Use stable mapped memory or a
small reusable ring.

## Preload API

Expose a narrow `contextBridge` API:

```typescript
export type ShmViewerApi = {
  connect(options?: { name?: string }): Promise<ViewerCapabilities>;
  disconnect(): Promise<void>;
  waitFrame(): Promise<SharedArrayBuffer>;
  sendMessage(message: { event_type: string; payload?: unknown }): Promise<void>;
  onMessage(callback: (message: { event_type: string; payload: unknown }) => void): () => void;
  getStatus(): Promise<BackendStatus>;
};
```

Preload rules:

- `contextIsolation: true`
- renderer `nodeIntegration: false`
- expose functions, not raw `ipcRenderer`
- validate message envelopes before sending to main
- do not expose filesystem, shell, child process, native addon, or environment
  access directly to React
- return a protocol version from `connect()`

## ViewerBackend Interface

`useShmBackend.ts` should implement the shared frontend contract. Keep SHM
specifics inside frame metadata and backend internals.

```typescript
export type FrameData = {
  width: number;
  height: number;
  sequence: number;
  format: 'BGRA8' | 'RGBA8';
  buffer: SharedArrayBuffer;
  pixelsByteOffset: number;
  byteLength: number;
};

export type RenderSettingCapability = {
  key: string;
  label: string;
  control: string;
  applies_at: 'immediate' | 'reload_required' | 'next_scene_load' | 'unsupported';
  apply_path: string;
  validated: boolean;
  validation_evidence: string;
};

export type RenderSettingsState = {
  settings: Record<string, unknown>;
  capabilities: RenderSettingCapability[];
};

export interface ViewerBackend {
  connect(): Promise<void>;
  disconnect(): void;
  loadStage(path: string): Promise<{ path: string; tree?: PrimNode[] } | void>;
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
  getRenderSettings?(): Promise<RenderSettingsState>;
  setRenderSetting?(key: string, value: unknown): Promise<RenderSettingsState>;
}
```

Behavior:

- `connect()` attaches, subscribes to messages, and starts one frame pump.
- `disconnect()` stops the pump before closing native resources.
- `resize()` updates UI layout unless the server implements a deliberate render
  product reload.
- `onFrame()` fans out frames from the single pump to UI subscribers.
- `pick()` sends a request id and resolves on matching response, with timeout.
- hierarchy, properties, selection, AOVs, and settings use JSON messages.
- Render settings panels must render from `RenderSettingCapability[]`; setting
  changes reject unsupported keys and only report success when active viewer
  state changed or an explicit non-live action was accepted.

## React Renderer And WebGL Blit

The React viewport displays server-rendered pixels:

- maintain canvas size and device pixel ratio
- compute letterboxed content rectangle
- map pointer coordinates into render-product pixels
- upload BGRA/RGBA pixels into a WebGL texture
- draw a full-canvas quad
- render overlays, tree, panels, toolbar, and status as DOM UI
- drop stale frames by sequence number

WebGL setup:

```typescript
const gl = canvas.getContext('webgl', {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
});
```

RGBA upload fallback:

```typescript
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA,
  frame.width,
  frame.height,
  0,
  gl.RGBA,
  gl.UNSIGNED_BYTE,
  rgbaPixels,
);
```

Do not add 3D engines, scene graph helpers, material systems, model loaders, or
camera libraries for the viewport. Read `webgl-shm-transport` for extension
checks, shader details, canvas resize behavior, and conversion fallback.
