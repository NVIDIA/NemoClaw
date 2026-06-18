# Electron SHM Validation

## Validation Checklist

- Python starts with `OVRTX_SKIP_USD_CHECK=1` set before ovrtx work.
- Python creates ovrtx renderer and SHM server without Electron attached.
- Electron connects and receives `shmConnected`.
- First frame has valid 16-byte header and expected byte length.
- Sequence increases and stale frames are dropped.
- Colors are correct after BGRA/RGBA handling.
- WebGL canvas displays pixels without scene rendering.
- Resize preserves aspect ratio and pointer mapping.
- Orbit, pan, dolly, wheel, and click threshold work.
- Picking updates selected prim, tree, and property panel.
- Selection outline groups clear on scene switch and update from the
  server-authoritative selected paths.
- Stage switching pauses stepping, resets state, and resumes frames.
- Hierarchy/property requests use JSON and remain bounded.
- Disconnect/reconnect does not leak workers or SHM mappings.
- Shutdown closes native client and Python server cleanly.

Useful checks:

```bash
python3 -m compileall server
npm run typecheck
npm run build:native
npm run lint
```

If local validation cannot run because the GPU/runtime environment is absent,
scaffold the expected integration and document that runtime execution requires
an NVIDIA GPU plus ovrtx/ovstream. Do not substitute a browser renderer.

## Common Mistakes

| Mistake | Consequence | Prevention |
|---|---|---|
| Rendering USD in Electron | Wrong architecture | Keep ovrtx as the only renderer. |
| Treating WebGL as a 3D viewport | Diverges from RTX output | Use WebGL only for pixel blit. |
| Sending frames through JSON | CPU cost and frame drops | Use SHM for pixels. |
| Blocking Electron main in frame wait | Frozen desktop UI | Use N-API async worker. |
| Exposing raw `ipcRenderer` | Unsafe preload boundary | Expose a narrow contextBridge API. |
| Allocating a JS buffer every frame | GC spikes | Use mapped memory or a SAB ring. |
| Ignoring frame header bounds | Texture corruption | Validate dimensions and byte length. |
| Converting BGRA in server-owned memory | Data races | Convert in renderer-owned staging memory. |
| Assuming `/World` | Empty hierarchy | Use `stage-hierarchy` root detection. |
| Live resizing render products | Reload churn | Fixed render size plus letterboxing. |
| Calling ovrtx from callbacks | Renderer races | Enqueue work for the render loop. |
| Reusing stale SHM names | Wrong attach or hang | Generate session names and clean owned stale segments. |
| Forgetting `OVRTX_SKIP_USD_CHECK=1` | Import/runtime conflicts | Set it before any ovrtx work. |

## See Also

- `ovrtx-rendering`
- `stage-loading`
- `streaming-messages`
- `viewer-input-routing`
- `camera-controls`
- `object-selection`
- `stage-hierarchy`
- `selection-feedback`
- `render-settings`
- `stage-management`
- `webgl-shm-transport`
