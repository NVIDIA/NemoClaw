# DeepStream Docker Containers Reference

## Overview

DeepStream Docker images are hosted on the NVIDIA NGC container registry (`nvcr.io`). They package all SDK dependencies (GStreamer, TensorRT, CUDA, models, sample streams) and require the NVIDIA Container Toolkit (`nvidia-container-toolkit`) for GPU access.

- **NGC catalog page**: https://catalog.ngc.nvidia.com/orgs/nvidia/containers/deepstream
- **Official docs**: https://docs.nvidia.com/metropolis/deepstream/dev-guide/text/DS_docker_containers.html

---

## Available Containers (DeepStream 9.0)

### dGPU (x86_64)

| Container | Pull Command | Description |
|-----------|-------------|-------------|
| **Samples** | `docker pull nvcr.io/nvidia/deepstream:9.0-samples-multiarch` | Runtime libraries, GStreamer plugins, reference apps, sample streams, models, configs. Best for running demos and deploying applications. |
| **Triton** | `docker pull nvcr.io/nvidia/deepstream:9.0-triton-multiarch` | Everything in samples + Triton Inference Server and dependencies + development environment. Use when Triton-based inference is needed or building custom DeepStream applications. |

### Jetson (ARM64/aarch64)

| Container | Pull Command | Description |
|-----------|-------------|-------------|
| **Samples** | `docker pull nvcr.io/nvidia/deepstream:9.0-samples-multiarch` | Runtime libraries, GStreamer plugins, reference apps, sample streams, models, configs. **Deployment only** — does not support development inside the container. |
| **Triton** | `docker pull nvcr.io/nvidia/deepstream:9.0-triton-multiarch` | Samples contents + devel libraries + Triton Inference Server backends. |

### dGPU on ARM (GH200, GB200, SBSA)

| Container | Pull Command | Description |
|-----------|-------------|-------------|
| **Triton ARM SBSA** | `docker pull nvcr.io/nvidia/deepstream:9.0-triton-arm-sbsa` | Triton Inference Server + development environment for ARM SBSA platforms. |

---

## Choosing the Right Image

| Use Case | Recommended Image |
|----------|-------------------|
| Running sample apps / demos | `9.0-samples-multiarch` |
| pyservicemaker Python applications | `9.0-triton-multiarch` |
| Triton Inference Server required | `9.0-triton-multiarch` |
| Custom Dockerfile base image | `9.0-samples-multiarch` (minimal) or `9.0-triton-multiarch` (with Triton) |

---

## NGC Authentication

Pulling images requires NGC authentication:

```bash
# 1. Get an API key from https://ngc.nvidia.com
# 2. Log in to the NGC registry
docker login nvcr.io
# Username: $oauthtoken
# Password: <YOUR_NGC_API_KEY>
```

---

## Installing pyservicemaker Inside the Container

The `pyservicemaker` Python wheel is **bundled** in the container but **NOT pre-installed**. You must install it explicitly:

```bash
pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl \
    pyyaml
```

In a Dockerfile:

```dockerfile
RUN pip install --break-system-packages \
    /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl \
    pyyaml
```

> **Note**: The `--break-system-packages` flag is needed on Ubuntu 24.04 (Python 3.12) to install into the system Python environment. Alternatively, use a virtual environment.

---

## Running Containers

### Prerequisites

1. **Docker**: Install `docker-ce` via [official instructions](https://docs.docker.com/engine/install)
2. **NVIDIA Container Toolkit**: Install via [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
3. **NVIDIA Driver**: 590+ for dGPU

### Basic Run (with display)

```bash
export DISPLAY=:0
xhost +

docker run -it --rm \
    --network=host \
    --gpus all \
    -e DISPLAY=$DISPLAY \
    -v /tmp/.X11-unix/:/tmp/.X11-unix \
    nvcr.io/nvidia/deepstream:9.0-triton-multiarch
```

### Headless Run (no display)

```bash
docker run -it --rm \
    --gpus all \
    nvcr.io/nvidia/deepstream:9.0-triton-multiarch
```

> For headless mode, use `fakesink` instead of `nveglglessink`/`nv3dsink` in your pipeline, or output to a file with `filesink`.

### Run with Custom Video File

```bash
docker run -it --rm \
    --gpus all \
    -e DISPLAY=$DISPLAY \
    -v /tmp/.X11-unix/:/tmp/.X11-unix \
    -v /path/to/videos:/data \
    nvcr.io/nvidia/deepstream:9.0-triton-multiarch
```

---

## Building Custom Docker Images

Use a DeepStream image as the base for your application:

```dockerfile
FROM nvcr.io/nvidia/deepstream:9.0-triton-multiarch

# Install pyservicemaker
RUN pip install --break-system-packages \
    /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl \
    pyyaml

# Copy application files
WORKDIR /app
COPY my_app.py .
COPY my_config.yml .

# Enable video driver libraries at runtime (encode/decode)
ENV NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES},video

ENTRYPOINT ["python3", "my_app.py"]
```

### Build and Run

```bash
# Build
docker build -t my-ds-app .

# Run with display
docker run --rm --gpus all \
    -e DISPLAY=$DISPLAY \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    my-ds-app

# Run with RTSP source (no display needed)
docker run --rm --gpus all \
    my-ds-app rtsp://camera-ip/stream
```

---

## Additional Packages

DeepStream 9.0 containers do **not** include certain multimedia libraries by default. Install them if needed:

### Audio/Codec Support

```bash
# Run the bundled install script for common multimedia packages
/opt/nvidia/deepstream/deepstream/user_additional_install.sh

# Or install specific packages manually
apt-get install -y gstreamer1.0-libav gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly
```

### ffmpeg (for sample video preparation scripts)

```bash
apt-get install --reinstall libflac8 libmp3lame0 libxvidcore4 ffmpeg
```

### Kafka Support (librdkafka)

```bash
apt-get install -y librdkafka-dev
```

### Tracker Support (libmosquitto)

```bash
apt-get install -y libmosquitto1
```

---

## Important Paths Inside the Container

| Path | Contents |
|------|----------|
| `/opt/nvidia/deepstream/deepstream/` | DeepStream SDK root |
| `/opt/nvidia/deepstream/deepstream/samples/models/` | Sample models (Primary_Detector, Secondary_*, etc.) |
| `/opt/nvidia/deepstream/deepstream/samples/streams/` | Sample video streams (e.g., `sample_1080p_h264.mp4`) |
| `/opt/nvidia/deepstream/deepstream/samples/configs/` | Sample configuration files |
| `/opt/nvidia/deepstream/deepstream/lib/` | DeepStream libraries (GStreamer plugins, protocol adapters) |
| `/opt/nvidia/deepstream/deepstream/lib/gst-plugins/` | GStreamer plugin `.so` files |
| `/opt/nvidia/deepstream/deepstream/service-maker/python/` | pyservicemaker wheel file |

---

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `GST_PLUGIN_PATH` | GStreamer plugin search path | `/opt/nvidia/deepstream/deepstream/lib/gst-plugins` |
| `LD_LIBRARY_PATH` | Shared library search path | `/opt/nvidia/deepstream/deepstream/lib:$LD_LIBRARY_PATH` |
| `GST_DEBUG` | GStreamer debug log level | `3` (INFO) or `nvinfer:5` (plugin-specific) |
| `NVIDIA_DRIVER_CAPABILITIES` | GPU capabilities exposed | `${NVIDIA_DRIVER_CAPABILITIES},video` |
| `DISPLAY` | X11 display for rendering sinks | `:0` |

---

## Common Docker Issues

### `ModuleNotFoundError: No module named 'pyservicemaker'`

**Cause**: The wheel is bundled but not installed.

**Fix**: Add to Dockerfile:
```dockerfile
RUN pip install --break-system-packages \
    /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl \
    pyyaml
```

### Display sinks fail with `Could not open display`

**Cause**: X11 forwarding not configured.

**Fix**: Pass display environment and socket:
```bash
docker run --rm --gpus all \
    -e DISPLAY=$DISPLAY \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    my-ds-app
```

Or use `fakesink` / `filesink` for headless operation.

### `Failed to load plugin ... libnvds_kafka_proto.so`

**Cause**: `librdkafka` not installed (not bundled in the container).

**Fix**: Add to Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y librdkafka-dev && rm -rf /var/lib/apt/lists/*
```

### Warning about audio decoder not available

**Cause**: Multimedia codec packages removed in DS 9.0 containers.

**Fix**:
```dockerfile
RUN /opt/nvidia/deepstream/deepstream/user_additional_install.sh
```
