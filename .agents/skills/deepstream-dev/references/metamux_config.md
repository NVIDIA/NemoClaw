# nvdsmetamux Configuration Reference

## Overview

The `nvdsmetamux` GStreamer plugin performs batch metadata multiplexing for the same source and the "same" frame. This plugin is essential for pipelines where multiple inference models process the same video stream parallelly and their metadata needs to be merged.

### Key Concepts

- **Same Frame Matching**: The "same" frame is determined based on the frame PTS (Presentation Timestamp). The plugin searches for the nearest frame PTS of the same source.
- **PTS Tolerance**: There is a configurable PTS difference tolerance for matching frames. If the PTS difference exceeds this tolerance, frames are not considered the same.
- **Active Pad Selection**: Applications can select which sink pad's video frame will be passed to the source pad.
- **Metadata Merging**: The plugin merges metadata from multiple inference models, allowing you to combine results from different GIEs.
- **Metadata Filtering**: Applications can configure to filter metadata based on source IDs from specific model.

---

## GStreamer Element Properties

The `nvdsmetamux` element exposes the following GStreamer properties:

### Core Properties

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `active-pad` | string | Active sink pad whose buffer will transfer to source pad | null |
| `config-file` | string | Path to the nvdsmetamux configuration file | null |
| `pts-tolerance` | int64 | Time difference tolerance when searching for the same frame of the same source ID (in microseconds) | 60000 |
| `name` | string | The name of the GStreamer object | "nvdsmetamux0" |
| `parent` | GstObject | The parent of the GStreamer object | - |

### Latency Properties

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `latency` | uint64 | Additional latency in live mode to allow upstream to take longer to produce buffers (in nanoseconds) | 0 |
| `min-upstream-latency` | uint64 | Override minimum latency for dynamically plugged sources with higher latency (in nanoseconds) | 0 |

### Start Time Properties

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `start-time` | uint64 | Start time to use if `start-time-selection=set` | 18446744073709551615 |
| `start-time-selection` | enum | Decides which start time is output | 0 (zero) |

**start-time-selection Values**:
| Value | Name | Description |
|-------|------|-------------|
| 0 | zero | Start at 0 running time (default) |
| 1 | first | Start at first observed input running time |
| 2 | set | Set start time with `start-time` property |

---

## Configuration File Reference

The `nvdsmetamux` plugin uses a configuration file (specified via `config-file` property) to define metadata muxing behavior.

### Configuration File Format

The configuration file uses INI-style format with the following structure:

```ini
[property]
enable=1
# sink pad name which data will be pass to src pad.
active-pad=sink_0
# default pts-tolerance is 60 ms.
pts-tolerance=60000

[user-configs]

[group-0]
# src-ids-model-<model unique ID>=<source ids>
# mux all source if don't set it.
src-ids-model-1=0;1;2
src-ids-model-2=1;2;3
```

### Property Section

The `[property]` section contains core configuration parameters.

| Config Key | Type | Description | Default |
|------------|------|-------------|---------|
| `enable` | int | Enable the functions of MetaMux (0=disabled, 1=enabled) | 1 |
| `active-pad` | string | Sink pad name whose data will be passed to source pad. Used to synchronize the sources from the branches. | - |
| `pts-tolerance` | int64 | When the difference between the branch source and the base source is larger than this tolerance value, metamux will not combine the metadata into current output (in microseconds) | 60000 |

### User-Configs Section

The `[user-configs]` section is a placeholder for user-defined configurations. This section can be empty or contain custom settings.

### Group Section

The `[group-0]` section (and additional `[group-N]` sections) configures source ID filtering for specific GIE models.

| Config Key Pattern | Type | Description |
|--------------------|------|-------------|
| `src-ids-model-<unique-id>` | string | The source IDs list to be output for the specified GIE. The GIE `unique-id` should be attached as the key postfix. Values are semicolon-separated. If not set, the metadata of all sources from the GIE will be muxed. |

**Example**:
```ini
[group-0]
src-ids-model-1=0;1;2
src-ids-model-2=1;2;3
```
This means:
- Output source 0, source 1, and source 2 inference results from the GIE with `unique-id=1`
- Output source 1, source 2, and source 3 inference results from the GIE with `unique-id=2`

**Note**: If `src-ids-model-<unique-id>` is not set for a particular GIE, the metadata of all sources from the GIE will be muxed by default.

---

## Complete Configuration Examples

### Example 1: Basic MetaMux Configuration

```ini
# config_metamux.txt
[property]
enable=1
# sink pad name which data will be pass to src pad.
active-pad=sink_0
# default pts-tolerance is 60 ms.
pts-tolerance=60000

[user-configs]

[group-0]
# src-ids-model-<model unique ID>=<source ids>
# mux all source if don't set it.
src-ids-model-1=0;1;2;3
src-ids-model-3=0;1;3
```

### Example 2: Configuration with Larger PTS Tolerance

```ini
# config_metamux_large_tolerance.txt
[property]
enable=1
active-pad=sink_0
# Increased tolerance for high-latency pipelines
pts-tolerance=100000

[user-configs]

[group-0]
src-ids-model-1=0;1;2;3
src-ids-model-2=0;1;2;3
```

### Example 3: Multiple GIE Source Filtering

```ini
# config_metamux_multi_gie.txt
[property]
enable=1
active-pad=sink_0
pts-tolerance=60000

[user-configs]

[group-0]
# Primary detector (unique-id=1): output sources 0, 1, 2
src-ids-model-1=0;1;2
# Primary detector (unique-id=2): output sources 1, 2, 3
src-ids-model-2=1;2;3
# Primary detector (unique-id=3): output all sources
src-ids-model-3=0;1;2;3
```

---

## Pipeline Examples

This example uses a `nvstreamdemux` element to split and select the stream, followed by muxing it for parallel inference with multiple models:
- Primary object detector (ResNet18 TrafficCamNet)
- YOLO26s detection model

Pipeline Architecture:
```
4 video streams → nvstreammux → tee
  ├─ Path 0 (Video): queue → nvdsmetamux sink_0
  └─ Path 1 (Inference): queue → nvstreamdemux
       ├─ Stream 0: queue → tee_0
       ├─ Stream 1: queue → tee_1
       ├─ Stream 2: queue → tee_2
       └─ Stream 3: queue → tee_3
            │
            ├─ Branch 1: tee_0,1,2 → nvstreammux → nvinfer(ResNet18) → tracker → metamux sink_1
            └─ Branch 2: tee_1,2,3 → nvstreammux → nvinfer(YOLO26s) → tracker → metamux sink_2
                 │
                 └─ nvdsmetamux → nvmultistreamtiler → nvdsosd → display
```

**Key Implementation Notes**:

1. **Pad naming conventions**:
   - `nvstreamdemux`: Use `"src_%u"` for output pads (auto-assigned in order)
   - `nvdsmetamux`: Use `"sink_%u"` for input pads (auto-assigned in order)
   - `nvstreammux`: Use `"sink_%u"` for input pads
   - `tee`: Use `"src_%u"` for output pads

2. **Linking order matters for `nvdsmetamux`**:
   - First link → `sink_0` (should match `active-pad` in config)
   - Second link → `sink_1`
   - Third link → `sink_2`

3. **`nvstreammux`**: Set `batched-push-timeout` to `40000` (microseconds).

4. **Adaptive batching (process environment)**: Set the `NVSTREAMMUX_ADAPTIVE_BATCHING=yes` environment variable before the pipeline starts. Adaptive batching dynamically adjusts the batch size when a stream finishes early, avoiding empty slots in the batch.

5. **`nvstreamdemux`**: Set `per-stream-eos: True` on `nvstreamdemux` so that each stream sends EOS independently upon completion, rather than waiting for all streams to finish. This prevents the pipeline from hanging while other streams are still active.

**Code Pattern**:
```python
pipeline.add("nvstreammux", "mux", {
    "batch-size": NUM_SOURCES,
    "width": 1920,
    "height": 1080,
    "batched-push-timeout": 40000,
})

pipeline.add("nvstreamdemux", "demux", {"per-stream-eos": True})

# Add queue and tee after demux for each stream
for i in range(NUM_SOURCES):
    pipeline.add("queue", f"queue_demux_{i}", {"max-size-buffers": 100})
    pipeline.add("tee", f"tee_stream_{i}")

# Link demux outputs - uses src_%u template
for i in range(NUM_SOURCES):
    pipeline.link(("demux", f"queue_demux_{i}"), ("src_%u", ""))
    pipeline.link(f"queue_demux_{i}", f"tee_stream_{i}")

# Link to metamux - use sink_%u template, order determines pad assignment
pipeline.link(("queue_video_path", "metamux"), ("", "sink_%u"))  # → sink_0
pipeline.link(("queue_branch1_out", "metamux"), ("", "sink_%u"))  # → sink_1
pipeline.link(("queue_branch2_out", "metamux"), ("", "sink_%u"))  # → sink_2
```

**Configuration File** (`config_metamux.txt`):
```ini
[property]
enable=1
active-pad=sink_0
pts-tolerance=60000

[user-configs]

[group-0]
src-ids-model-1=0;1;2
src-ids-model-2=1;2;3
```

---

## Common Use Cases

### Use Case 1: Multi-Model Inference

Combine results from multiple inference models (e.g., object detection + YOLO26s) into a single output stream.

### Use Case 2: Selective Source Output

Filter which source streams should have their inference results included in the final output using `src-ids-model-<model unique ID>=<source ids>` configuration.

---

## Common Pitfalls

### Pitfall 1: PTS Tolerance Too Small

**Problem**: Frames are not being matched correctly, resulting in missing metadata.

**❌ Wrong**:
```ini
[property]
pts-tolerance=1000  # Too small for variable latency
```

**✅ Correct**:
```ini
[property]
pts-tolerance=60000  # 60ms tolerance
```

### Pitfall 2: Incorrect Active Pad

**Problem**: Wrong video frame is being output to the source pad.

**Solution**: Ensure `active-pad` matches one of your sink pad names (e.g., `sink_0`, `sink_1`).

```ini
[property]
active-pad=sink_0  # Must match an existing sink pad
```

### Pitfall 3: Missing GIE Unique ID in src-ids-model

**Problem**: Source ID filtering not working for a specific model.

**❌ Wrong**:
```ini
[group-0]
src-ids-model=0;1;2;3  # Missing unique-id suffix
```

**✅ Correct**:
```ini
[group-0]
src-ids-model-1=0;1;2;3  # Include the GIE unique-id (1)
```

### Pitfall 5: Missing Required Sections

**Problem**: Configuration file missing required sections.

**❌ Wrong**:
```ini
[property]
enable=1
active-pad=sink_0

# Missing [user-configs] and [group-0] sections
```

**✅ Correct**:
```ini
[property]
enable=1
active-pad=sink_0
pts-tolerance=60000

[user-configs]

[group-0]
src-ids-model-1=0;1;2;3
```

### Pitfall 4: PTS Synchronization Issues

**Problem**: When using separate nvstreammux instances, frames may have different PTS values.

**Solution**:
- Use the `tee` approach when possible to ensure consistent PTS across branches
- Increase `pts-tolerance` if using separate streammux instances
- Set `sync-inputs=0` on nvstreammux for live sources

---

## Best Practices

1. **Use tee for Single Source**: When processing the same streams through multiple models, use a `tee` element after the first nvstreammux to ensure consistent PTS values.

2. **Set Appropriate PTS Tolerance**: Start with the default (60000 microseconds = 60ms) and adjust based on your pipeline's latency characteristics.

3. **Configure Source IDs Explicitly**: Always specify which source IDs should output from each model using `src-ids-model-<model unique ID>=<source ids>` to avoid unexpected metadata merging.

4. **Use Queues**: Add `queue` elements before and after inference elements to prevent pipeline stalls.

5. **Match Batch Sizes**: Ensure batch sizes are consistent across all branches feeding into nvdsmetamux.

---

## Related Documentation

- **GStreamer Plugins Overview**: `gstreamer_plugins.md`
- **Use Cases and Pipelines**: `use_cases_pipelines.md`
- **nvinfer Configuration Reference**: `nvinfer_config.md`
- **Best Practices**: `best_practices.md`
