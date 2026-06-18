<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Streaming Server Frame Loop And Continuity

## Frame Sources

Raw CUDA buffer:

```python
frame = VideoFrame(buffer=cuda_ptr, width=1920, height=1080, pitch_bytes=1920 * 4)
server.stream_video(frame)
```

From a Warp/CuPy/PyTorch CUDA array with `__cuda_array_interface__`:

```python
frame = VideoFrame.from_cuda_array(cuda_array)  # shape H x W x 4, uint8, BGRA8
```

From a DLPack-producing tensor such as Warp, PyTorch, JAX, or CuPy:

```python
config = ovstream.ServerConfig(width=1920, height=1080, video_input=ovstream.VideoInput.TENSOR)
frame = VideoFrame.from_dlpack(tensor)
```

Pre-encoded bitstream descriptors use `size_bytes` and require a matching
`video_input` such as `H264`, `H265`, or `AV1` at server start:

```python
config = ovstream.ServerConfig(width=1920, height=1080, video_input=ovstream.VideoInput.H264)
frame = VideoFrame(buffer=encoded_host_ptr, width=1920, height=1080, size_bytes=encoded_size)
```

`stream_video()` does not copy; keep the CUDA buffer alive until the next
`stream_video()` call on the same server returns. If the producer wrote the
buffer on a CUDA stream, either synchronize before `stream_video()` or pass
`sync=ovstream.CudaSync(stream=..., wait_event=...)` to
`VideoFrame.from_cuda_array()` / `VideoFrame.from_dlpack()`.

## Fixed Stream Resolution

Use one server render and stream size for the session, typically 1920x1080. The frontend should scale the `<video>` element with `object-fit: contain`; NVST handles letterbox coordinate mapping for stream input.

Do not implement live viewport-size changes. ovrtx does not expose a `renderer.resize()` API, ovstream encoders cannot be assumed to resize on the fly, and changing camera aspect after connection has caused failures. If an application exposes a different fixed stream size, apply it through startup configuration or an explicit reconnect/restart path.

## Frame Continuity During Stage Loads

Stage loads must not block the message callback thread or stop video output. Large USD files can take much longer than the WebRTC/encoder liveness window, and connections may be killed after roughly 7 seconds without frames.

Run scene loading on a background thread and use a stage lock around renderer mutation. The render loop should attempt a non-blocking lock; if loading is in progress, skip `renderer.step()` and keep sending the last good frame.

```python
while running:
    if stage_lock.acquire(blocking=False):
        try:
            frame = render_next_frame()
            last_frame = frame
        finally:
            stage_lock.release()
    elif last_frame is not None:
        frame = last_frame
    else:
        frame = loading_frame

    server.stream_video(frame)
```

This preserves WebRTC heartbeats and avoids stepping ovrtx while `reset_stage()`, `open_usd()`, `open_usd_from_string()`, reference updates, or selection state rebuilds are mutating the renderer.

Log the first valid converted frame and set readiness before relying on browser
connection state. This separates renderer/frame-conversion failures from WebRTC
lifecycle failures:

```python
if not logged_first_frame:
    logger.info("First BGRA frame ready: %sx%s", width, height)
    logged_first_frame = True
```
