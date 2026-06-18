# WebGL SHM Transport

## Triggers

Use this skill for Electron SHM, SharedArrayBuffer, WebGL blitter, POSIX SHM pixels, BGRA texture upload, texSubImage2D, or blank canvas.

Use this with the parent `electron-shm-viewer` architecture skill when an Electron app displays ovrtx-rendered frames from a POSIX shared-memory ring buffer.

WebGL is only a 2D pixel blitter here. It uploads already-rendered pixels into one texture and draws a full-viewport quad. It must never load USD, render meshes, evaluate cameras, shade materials, or become a browser 3D renderer. All USD rendering remains in the process that owns `ovrtx.Renderer`.

## Pipeline

```text
SHM ring buffer slot (BGRA8, pitch-aligned)
  -> N-API addon: memcpy to SharedArrayBuffer on a libuv worker thread
  -> Electron IPC/preload: SAB handle crosses process boundary without copying
  -> React renderer: Uint8Array view of the SAB pixel payload
  -> WebGL: texImage2D first frame, texSubImage2D later frames
  -> full-viewport textured quad
  -> canvas sized with object-fit: contain for letterbox
```

Reference `streaming-client` for fixed-resolution letterbox conventions. The same rule applies here, adapted from `<video>` to `<canvas>`: keep the render resolution fixed, scale the presentation with containment, and map pointer events through the visible content rectangle.

## Frame Contract

Each SAB snapshot begins with a 16-byte little-endian header:

```text
byte 0..3    uint32 width
byte 4..7    uint32 height
byte 8..15   uint64 sequence
byte 16..N   pixel bytes
```

Pixels are BGRA8 unless the producer explicitly converts to RGBA8 before publishing. A packed frame has `width * height * 4` pixel bytes after the header.

If the source SHM slot has pitch padding, prefer copying tight rows into the SAB. WebGL 1 cannot upload arbitrary row strides. WebGL 2 can use `UNPACK_ROW_LENGTH`, but tight SAB rows keep the first implementation simpler and more portable.

```ts
const HEADER_BYTES = 16;

interface FrameHeader { width: number; height: number; sequence: bigint }

function readFrameHeader(buffer: SharedArrayBuffer): FrameHeader {
  const view = new DataView(buffer, 0, HEADER_BYTES);
  return { width: view.getUint32(0, true), height: view.getUint32(4, true), sequence: view.getBigUint64(8, true) };
}
```

## Electron Boundary

SharedArrayBuffer requires a cross-origin isolated renderer. Configure COOP/COEP in production and dev:

```ts
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Cross-Origin-Opener-Policy': ['same-origin'],
      'Cross-Origin-Embedder-Policy': ['require-corp'],
    },
  });
});

const win = new BrowserWindow({
  webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: true },
});
```

For Vite dev, set the same two headers in `server.headers` so hot-reload resources do not break isolation.

Expose only explicit preload methods. Do not expose `fs`, `child_process`, arbitrary IPC, or unrestricted Node access to React.

```ts
contextBridge.exposeInMainWorld('shmFrames', {
  getFrameBuffer: () => ipcRenderer.sendSync('shm:get-frame-buffer'),
  getFrameMetadata: () => ipcRenderer.sendSync('shm:get-frame-metadata'),
  onFrameAvailable: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('shm:frame-available', listener);
    return () => ipcRenderer.removeListener('shm:frame-available', listener);
  },
});
```

The renderer-side type should be limited to `getFrameBuffer()`, `getFrameMetadata()`, and `onFrameAvailable(callback)`.

## N-API Copy Rules

The native addon copies the newest complete ring slot into one stable SAB on a libuv worker thread:

```text
slot = ring.newest_complete_slot()
copy header: width, height, sequence
for row in 0..height:
  memcpy(sab.pixels + row * width * 4, slot.pixels + row * slot.pitch_bytes, width * 4)
notify renderer: shm:frame-available
```

Use newest-frame-wins semantics. If the renderer is slower than the producer, skip old ring slots instead of building a queue. Publish the sequence only after the copied frame is coherent.

## Shader Code

Vertex shader:

```glsl
attribute vec2 a_position;
attribute vec2 a_texCoord;

varying vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0); // viewport clip-space position
}
```

Fragment shader:

```glsl
precision mediump float;

uniform sampler2D u_frame;

varying vec2 v_texCoord;

void main() {
  gl_FragColor = texture2D(u_frame, v_texCoord);
}
```

```ts
const QUAD = new Float32Array([
  -1, -1, 0, 1,  1, -1, 1, 1,
  -1,  1, 0, 0,  1,  1, 1, 0,
]);
```

## Texture Upload
Create the program, quad buffer, and texture once. Use `texImage2D` for first allocation or resolution changes; use `texSubImage2D` for normal frames.

```ts
function createTexture(gl: WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return texture;
}

function uploadFrame(
  gl: WebGLRenderingContext,
  texture: WebGLTexture,
  format: number,
  pixels: Uint8Array,
  width: number,
  height: number,
  previous: { width: number; height: number },
) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (previous.width !== width || previous.height !== height) {
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, gl.UNSIGNED_BYTE, pixels);
    previous.width = width;
    previous.height = height;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.UNSIGNED_BYTE, pixels);
  }
}
```

BGRA handling options:

- Use `EXT_texture_format_BGRA8888` when available: `ext.BGRA_EXT` is the upload format.
- Convert BGRA to RGBA in JavaScript for simple viewers.
- Convert BGRA to RGBA in a CUDA kernel before the SHM write for >60 fps or 4K targets.

```ts
const ext = gl.getExtension('EXT_texture_format_BGRA8888') as { BGRA_EXT: number } | null;
const uploadFormat = metadata.format === 'BGRA8' && ext ? ext.BGRA_EXT : gl.RGBA;

function bgraToRgba(source: Uint8Array, scratch: Uint8Array): Uint8Array {
  const src = new Uint32Array(source.buffer, source.byteOffset, source.byteLength / 4);
  const dst = new Uint32Array(scratch.buffer, scratch.byteOffset, scratch.byteLength / 4);
  for (let i = 0; i < src.length; i += 1) {
    const p = src[i];
    dst[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
  }
  return scratch;
}
```

The bit-shift path assumes little-endian desktop CPUs, which is the normal Electron target.

## React Hook Pattern

The hook owns the WebGL context and RAF loop. Native notifications only mark that a frame may be ready; RAF decides when to draw.

```tsx
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    shmFrames: {
      getFrameBuffer(): SharedArrayBuffer | null;
      getFrameMetadata(): { pitchBytes?: number; format: 'BGRA8' | 'RGBA8' };
      onFrameAvailable(callback: () => void): () => void;
    };
  }
}

export function useWebGLCanvas(canvasRef: React.RefObject<HTMLCanvasElement>) {
  const lastSequence = useRef<bigint>(-1n);
  const needsDraw = useRef(true);
  const scratch = useRef<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      setError('WebGL unavailable');
      return;
    }

    const metadata = window.shmFrames.getFrameMetadata();
    const ext = gl.getExtension('EXT_texture_format_BGRA8888') as { BGRA_EXT: number } | null;
    const nativeBgra = metadata.format === 'BGRA8' && !!ext;
    const uploadFormat = nativeBgra ? ext!.BGRA_EXT : gl.RGBA;
    const program = createProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
    const quad = createQuadBuffer(gl, program, QUAD);
    const texture = createTexture(gl);
    const previous = { width: 0, height: 0 };

    const unsubscribe = window.shmFrames.onFrameAvailable(() => {
      needsDraw.current = true;
    });

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!needsDraw.current) return;

      const sab = window.shmFrames.getFrameBuffer();
      if (!sab) return;

      const header = readFrameHeader(sab);
      if (!header.width || !header.height || header.sequence === lastSequence.current) return;

      if (canvas.width !== header.width || canvas.height !== header.height) {
        canvas.width = header.width;
        canvas.height = header.height;
        gl.viewport(0, 0, header.width, header.height);
      }

      const byteLength = header.width * header.height * 4;
      const source = new Uint8Array(sab, HEADER_BYTES, byteLength);
      let pixels = source;
      if (metadata.format === 'BGRA8' && !nativeBgra) {
        if (!scratch.current || scratch.current.byteLength !== byteLength) {
          scratch.current = new Uint8Array(byteLength);
        }
        pixels = bgraToRgba(source, scratch.current);
      }

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      uploadFrame(gl, texture, uploadFormat, pixels, header.width, header.height, previous);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      lastSequence.current = header.sequence;
      needsDraw.current = false;
    };

    const onLost = (event: Event) => { event.preventDefault(); setError('WebGL context lost'); };
    canvas.addEventListener('webglcontextlost', onLost);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.deleteTexture(texture);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    };
  }, [canvasRef]);

  return { error };
}
```

`createProgram` compiles the two shaders above. `createQuadBuffer` binds `a_position` and `a_texCoord` with a stride of four floats and draws `TRIANGLE_STRIP`.

## Canvas Containment

Keep the canvas backing size equal to the frame size. Let CSS contain the element inside its viewport shell:

```css
.viewportShell { width: 100%; height: 100%; overflow: hidden; background: #0b0d10; }
.viewportCanvas { display: block; width: 100%; height: 100%; object-fit: contain; }
```

Map pointer input through the letterboxed content rectangle before sending coordinates to `electron-shm-viewer`:

```ts
function clientToFramePoint(event: React.PointerEvent<HTMLElement>, frameWidth: number, frameHeight: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
  const contentWidth = frameWidth * scale;
  const contentHeight = frameHeight * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = (rect.height - contentHeight) / 2;
  const x = event.clientX - rect.left - offsetX;
  const y = event.clientY - rect.top - offsetY;
  if (x < 0 || y < 0 || x >= contentWidth || y >= contentHeight) return null;
  return { x: Math.floor((x / contentWidth) * frameWidth), y: Math.floor((y / contentHeight) * frameHeight) };
}
```

## Frame Pacing And Backpressure

Use `requestAnimationFrame`, compare sequence numbers, and upload only new frames. Keep showing the previous texture when no new sequence is available. If several frames arrive before the next RAF, draw only the newest SAB contents.

Do not store pixel data in React state. Keep SAB views, scratch buffers, WebGL handles, and sequence numbers in refs.

At 1920x1080 RGBA8, one frame is about 8.3 MB and 60 fps uploads about 497 MB/s. At 3840x2160, one frame is about 33.2 MB and 60 fps uploads about 2.0 GB/s. The main bottlenecks are SHM-to-SAB copy, JavaScript BGRA conversion, texture upload bandwidth, and main-thread scheduling.

Performance guidance:

- reuse the SAB allocation and WebGL texture;
- repack pitch-aligned SHM rows to tight SAB rows;
- prefer native BGRA upload or server-side CUDA conversion for high frame rates;
- disable alpha, antialias, depth, and stencil on the WebGL context;
- throttle UI overlay updates separately from pixel upload;
- remove per-frame logs and avoid draining every skipped ring slot.

## Troubleshooting

Blank canvas:

- verify `window.crossOriginIsolated === true` and the preload returns a `SharedArrayBuffer`;
- decode and log the first header once: width, height, sequence;
- check shader compile and program link logs;
- check that the canvas has a nonzero CSS size and call `gl.getError()` after first `texImage2D`.

Wrong colors:

- red and blue swapped means BGRA bytes were uploaded as RGBA;
- use `EXT_texture_format_BGRA8888`, JavaScript conversion, or server-side CUDA conversion;
- confirm the producer format after AOV changes.

Stride artifacts or diagonal tearing:

- WebGL 1 cannot upload padded rows; copy tight rows into the SAB or use WebGL 2 `UNPACK_ROW_LENGTH`;
- publish only complete ring slots;
- use native completion flags or atomics before the addon copies a slot.

Stale frames:

- confirm the sequence increments and the addon chooses the newest complete slot;
- use RAF instead of rendering directly from every IPC notification;
- check whether DevTools or long React work is blocking the renderer main thread.

Context loss:

- listen for `webglcontextlost`; on restore, recreate the program, buffer, texture, and upload state;
- keep the SAB transport independent from WebGL resource lifetime.

SharedArrayBuffer unavailable:

- set COOP/COEP in Electron responses and the dev server;
- make subresources compatible with `require-corp`;
- keep `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload API.

## Checklist

1. Read `electron-shm-viewer` first for process topology and input protocol ownership.
2. Keep ovrtx as the only USD/3D renderer; WebGL only blits pixels.
3. Copy newest complete SHM slots into a stable SAB on a libuv worker.
4. Parse `[u32 width][u32 height][u64 sequence]` from the first 16 bytes.
5. Reuse one texture and use `texSubImage2D` after first allocation.
6. Handle BGRA/RGBA explicitly.
7. Pace display with RAF and skip stale sequences.
8. Present the fixed render resolution with `object-fit: contain`.
9. Keep Electron security explicit: COOP/COEP, context isolation, no unrestricted Node.
