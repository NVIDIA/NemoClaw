# Kafka and Message Broker Integration

## Overview

This document is a comprehensive reference for integrating DeepStream applications with external message brokers. It covers two complementary areas:

- **Part 1 -- Kafka Integration Use Cases and Patterns**: Pipeline architectures for streaming analytics data to Apache Kafka, including native `nvmsgbroker` pipelines, Python Kafka producer probes, multi-topic integration, error handling, and performance optimization.
- **Part 2 -- Message Broker and Converter Configuration Reference**: Detailed property tables and configuration file formats for the `nvmsgconv` and `nvmsgbroker` GStreamer plugins, protocol adaptor libraries (Kafka, MQTT, Redis, AMQP, Azure IoT), payload schemas, and troubleshooting guidance.

---

# Part 1: Kafka Integration Use Cases and Patterns

## Use Case Requirements

- Process video streams with AI inference
- Extract object detection and tracking metadata
- Stream metadata to Kafka topics
- Support multiple Kafka topics for different data types
- Handle Kafka connection failures gracefully
- Support both sync and async message sending
- Integrate with cloud services and data pipelines

## Prerequisites

Before building any Kafka-based DeepStream pipeline, install these system dependencies:

```bash
# REQUIRED: librdkafka -- DeepStream's Kafka protocol adapter (libnvds_kafka_proto.so)
# dynamically links against librdkafka.so.1, which is NOT bundled with DeepStream.
sudo apt-get install -y librdkafka-dev

# If also running a local MQTT broker for tracker:
sudo apt-get install -y libmosquitto1        # client library for nvtracker
sudo apt-get install -y mosquitto            # broker daemon (if running locally)
sudo apt-get install -y mosquitto-clients    # CLI tools for testing
```

> **Without `librdkafka-dev`**, any pipeline using `nvmsgbroker` with the Kafka protocol adapter will fail at startup with: `unable to open shared library` / `Failed to start`.

## Architecture Overview

### Critical Rule: async=0 on ALL Sinks

**CRITICAL**: When using `tee` to split a pipeline OR using dynamic sources (nvmultiurisrcbin), **ALL sink elements MUST have `async: 0`**. This includes:
- Display sinks (nveglglessink, nv3dsink)
- Message broker sinks (nvmsgbroker)
- File sinks (filesink)
- Any other sink element

**Symptom if missing**: Pipeline stays stuck in PAUSED state. Cameras show "added" but no video displays and no data flows.

**Why**: GStreamer requires all sinks to "preroll" (receive data) before transitioning to PLAYING state. With `async: 0`, sinks don't block the state transition waiting for preroll.

### Pipeline Architecture

**IMPORTANT**: `nvmsgbroker` is a **SINK component** that terminates the pipeline branch. It cannot have downstream components.

For **headless pipelines** (Kafka only, no display):
```
Source -> Decoder -> Muxer -> Inference -> Tracker -> Message Converter -> Message Broker (sink)
```

For **pipelines with both Kafka and display**, use `tee` to split paths:
```
Source -> Decoder -> Muxer -> Inference -> Tracker -> Tee
                                                      |-> [Metadata Branch] Message Converter -> Message Broker (sink)
                                                      |-> [Video Branch] Tiler -> OSD -> Converter -> Renderer (sink)
```

### Data Flow
1. Video processing generates metadata (objects, tracks, frames)
2. Metadata is converted to message format
3. Messages are sent to Kafka broker (metadata branch terminates here)
4. Video continues to display pipeline (if using tee split)
5. Downstream Kafka consumers process analytics data

## Implementation Approaches

### Approach 1: Using nvmsgbroker Plugin (Native DeepStream)

The native DeepStream approach uses `nvmsgbroker` plugin with Kafka protocol library.

**CRITICAL**: `nvmsgbroker` is a **SINK component** that terminates the pipeline branch. It cannot have downstream components like OSD or renderer. If you need both Kafka output and display, use `tee` to split the pipeline into separate branches.

For detailed property tables and configuration file formats for `nvmsgconv` and `nvmsgbroker`, see Part 2 below.

#### Example 1: Headless Pipeline (Kafka Only)

```python
from pyservicemaker import Pipeline
import platform
import sys

def kafka_native_pipeline_headless(video_path, infer_config, kafka_config):
    """
    DeepStream pipeline with native Kafka integration (headless, no display)

    Args:
        video_path: Path to video file
        infer_config: Inference configuration file
        kafka_config: Kafka configuration dict
    """
    pipeline = Pipeline("kafka-pipeline-headless")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "pgie", {"config-file-path": infer_config})

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # Message converter (converts metadata to message format)
    # IMPORTANT: msg2p-newapi=True uses NvDsObjectMeta directly (no NvDsEventMsgMeta required)
    pipeline.add("nvmsgconv", "msgconv", {
        "config": kafka_config["msgconv_config"],
        "payload-type": 0,  # 0=deepstream full schema, 1=minimal
        "msg2p-newapi": True,  # CRITICAL: Use new API to avoid NvDsEventMsgMeta requirement
    })

    # Message broker (Kafka) - THIS IS A SINK, terminates the pipeline
    # IMPORTANT: conn-str uses semicolon separator (host;port), NOT colon
    pipeline.add("nvmsgbroker", "msgbroker", {
        "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        "conn-str": kafka_config["broker_servers"],  # Must be "host;port" format
        "sync": 0,   # 0=async message sending, 1=sync
        "async": 0,  # CRITICAL for dynamic sources: prevents state transition deadlock
        "config": kafka_config["broker_config"]
    })

    # Link pipeline - msgbroker is the sink, no components after it
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "tracker", "msgconv", "msgbroker")

    pipeline.start().wait()
```

#### Example 2: Pipeline with Both Kafka and Display (Using Tee)

```python
from pyservicemaker import Pipeline
import platform
import sys

def kafka_native_pipeline_with_display(video_path, infer_config, kafka_config):
    """
    DeepStream pipeline with native Kafka integration AND display

    Uses tee to split pipeline into metadata branch (Kafka) and video branch (display)

    Args:
        video_path: Path to video file
        infer_config: Inference configuration file
        kafka_config: Kafka configuration dict
    """
    pipeline = Pipeline("kafka-pipeline-with-display")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "pgie", {"config-file-path": infer_config})

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # Add tee to split pipeline
    pipeline.add("tee", "tee")

    # Metadata branch: tee -> queue -> msgconv -> msgbroker (sink)
    pipeline.add("queue", "queue_meta")
    # IMPORTANT: msg2p-newapi=True uses NvDsObjectMeta directly (no NvDsEventMsgMeta required)
    pipeline.add("nvmsgconv", "msgconv", {
        "config": kafka_config["msgconv_config"],
        "payload-type": 0,
        "msg2p-newapi": True,  # CRITICAL: Use new API
    })
    # IMPORTANT: conn-str uses semicolon separator (host;port), NOT colon
    # CRITICAL: async=0 required on ALL sinks when using tee or dynamic sources!
    pipeline.add("nvmsgbroker", "msgbroker", {
        "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        "conn-str": kafka_config["broker_servers"],  # Must be "host;port" format
        "sync": 0,   # Async message sending
        "async": 0,  # CRITICAL: ALL sinks need async=0 to prevent state deadlock!
        "config": kafka_config["broker_config"]
    })

    # Video branch: tee -> queue -> tiler -> osd -> converter -> sink
    pipeline.add("queue", "queue_video")
    pipeline.add("nvmultistreamtiler", "tiler", {"rows": 1, "columns": 1})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nvvideoconvert", "converter")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    # CRITICAL: async=0 required on ALL sinks when using tee or dynamic sources!
    pipeline.add(sink_type, "sink", {
        "sync": 0,   # Don't sync to clock for live sources
        "qos": 0,    # Disable QoS
        "async": 0   # CRITICAL: ALL sinks need async=0 to prevent state deadlock!
    })

    # Link main pipeline
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "tracker", "tee")

    # Link metadata branch (terminates at msgbroker sink)
    pipeline.link(("tee", "queue_meta"), ("src_%u", ""))
    pipeline.link("queue_meta", "msgconv", "msgbroker")

    # Link video branch (terminates at display sink)
    pipeline.link(("tee", "queue_video"), ("src_%u", ""))
    pipeline.link("queue_video", "tiler", "osd", "converter", "sink")

    pipeline.start().wait()

if __name__ == "__main__":
    kafka_config = {
        # IMPORTANT: Use semicolon separator, NOT colon!
        "broker_servers": "localhost;9092",  # Correct: semicolon
        # "broker_servers": "localhost:9092",  # Wrong: colon
        "broker_config": "/path/to/kafka_broker_config.txt",
        "msgconv_config": "/path/to/msgconv_config.txt"
    }
    # Use headless version for Kafka-only, or with_display version for both Kafka and display
    kafka_native_pipeline_headless(sys.argv[1], sys.argv[2], kafka_config)
    # OR
    # kafka_native_pipeline_with_display(sys.argv[1], sys.argv[2], kafka_config)
```

#### Example 3: Using Legacy API (msg2p-newapi=0) with EventMessageUserMetadata

When `msg2p-newapi` is `0` (the default), `nvmsgconv` expects `NvDsEventMsgMeta` to be pre-attached to each frame buffer. This metadata is **NOT** generated automatically by any DeepStream plugin. You must attach it via a probe **upstream** of `nvmsgconv`.

There are two sub-approaches:

##### Option A: Built-in `add_message_meta_probe` (Simplest)

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator
import platform

def kafka_legacy_builtin_probe(video_path, infer_config, kafka_config):
    """
    Kafka pipeline using msg2p-newapi=0 with built-in add_message_meta_probe.
    The built-in probe automatically generates EventMessageUserMetadata
    from NvDsObjectMeta for every detected object.
    """
    pipeline = Pipeline("kafka-legacy-builtin")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference + tracker
    pipeline.add("nvinfer", "pgie", {"config-file-path": infer_config})
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # OSD (needed as attachment point for the built-in probe)
    pipeline.add("nvosdbin", "osd")

    # Tee to split display and Kafka branches
    pipeline.add("tee", "tee")

    # Metadata branch
    pipeline.add("queue", "queue_meta")
    pipeline.add("nvmsgconv", "msgconv", {
        "config": kafka_config["msgconv_config"],
        "payload-type": 0,
        "msg2p-newapi": 0,  # Legacy API - requires EventMessageUserMetadata
    })
    pipeline.add("nvmsgbroker", "msgbroker", {
        "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        "conn-str": kafka_config["broker_servers"],
        "sync": 0,
        "async": 0,
    })

    # Display branch
    pipeline.add("queue", "queue_video")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 0, "qos": 0, "async": 0})

    # Link
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "tracker", "osd", "tee")
    pipeline.link(("tee", "queue_meta"), ("src_%u", ""))
    pipeline.link("queue_meta", "msgconv", "msgbroker")
    pipeline.link(("tee", "queue_video"), ("src_%u", ""))
    pipeline.link("queue_video", "sink")

    # CRITICAL: attach built-in probe AFTER osd, BEFORE tee->msgconv
    # This automatically creates EventMessageUserMetadata from NvDsObjectMeta
    pipeline.attach("osd", "add_message_meta_probe", "metadata generator")

    pipeline.start().wait()
```

**Reference**: `deepstream_test4_app` sample
(`/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test4_app/deepstream_test4.py`)

##### Option B: Custom EventMessageGenerator (Multi-Camera / Custom Sensor Mappings)

For multi-camera pipelines where you need control over sensor IDs and URIs:

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, SensorInfo

class EventMessageGenerator(BatchMetadataOperator):
    """
    Generate EventMessageUserMetadata for downstream nvmsgconv.
    Required when msg2p-newapi=0 (legacy API).

    Uses pyservicemaker API:
        batch_meta.acquire_event_message_meta()  -> acquire from pool
        event_msg.generate(obj, frame, sensor_id, uri, labels)  -> populate
        frame_meta.append(event_msg)  -> attach to frame
    """

    def __init__(self, sensor_map, labels):
        super().__init__()
        self._sensor_map = sensor_map  # dict: source_id (int) -> SensorInfo
        self._labels = labels          # list of class label strings

    def handle_metadata(self, batch_meta, frame_interval=1):
        for frame_meta in batch_meta.frame_items:
            frame_num = frame_meta.frame_number
            for object_meta in frame_meta.object_items:
                if not (frame_num % frame_interval):
                    event_msg = batch_meta.acquire_event_message_meta()
                    if event_msg:
                        source_id = frame_meta.source_id
                        sensor_info = self._sensor_map.get(source_id)
                        sensor_id = sensor_info.sensor_id if sensor_info else "N/A"
                        uri = sensor_info.uri if sensor_info else "N/A"
                        event_msg.generate(
                            object_meta, frame_meta, sensor_id, uri, self._labels
                        )
                        frame_meta.append(event_msg)


def kafka_legacy_custom_generator(video_paths, infer_config, kafka_config, labels):
    """
    Multi-camera Kafka pipeline using msg2p-newapi=0 with custom EventMessageGenerator.
    """
    pipeline = Pipeline("kafka-legacy-custom")

    # Build sensor map from video paths
    sensor_map = {}
    for i, uri in enumerate(video_paths):
        sensor_map[i] = SensorInfo(
            sensor_id=f"Camera{i+1}",
            sensor_name=f"cam{i+1}",
            uri=uri
        )

    # ... (add sources, inference, tracker, tee, msgconv with msg2p-newapi=0, etc.)

    # Attach custom EventMessageGenerator probe UPSTREAM of nvmsgconv
    pipeline.attach(
        "tracker",
        Probe("event_msg_gen", EventMessageGenerator(sensor_map, labels))
    )

    pipeline.start().wait()
```

**Key API calls**:
- `batch_meta.acquire_event_message_meta()` -- acquires `EventMessageUserMetadata` from the pool
- `event_msg.generate(object_meta, frame_meta, sensor_id, uri, labels)` -- populates the metadata
- `frame_meta.append(event_msg)` -- attaches it to the frame for downstream nvmsgconv

**Reference**: `deepstream_test5_app` sample
(`/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test5_app/deepstream_test5.py`)

---

#### Kafka Broker Configuration File

**kafka_broker_config.txt**:
```
[broker]
enable=1
broker-ip-port=localhost:9092
topic=deepstream-analytics
# Optional: SSL/TLS configuration
# enable-tls=1
# ca-file=/path/to/ca-cert
# client-cert-file=/path/to/client-cert
# client-key-file=/path/to/client-key
```

#### Message Converter Configuration File

**msgconv_config.txt**:
```
[message-converter]
enable=1
# Message format: deepstream or custom
msg-format=deepstream
# Schema file for custom format
schema-file=/path/to/schema.json
# Payload type: 0=deepstream, 1=custom
payload-type=0
```

### Approach 2: Using Python Kafka Producer (Custom Probe)

This approach uses Python's `kafka-python` library in a custom probe for more control.

#### Custom Kafka Producer Probe

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator
from kafka import KafkaProducer
from kafka.errors import KafkaError
import json
import sys
import platform

class KafkaMetadataSender(BatchMetadataOperator):
    """
    Custom probe to send metadata to Kafka

    Sends object detection and tracking metadata to Kafka topics
    """
    def __init__(self, kafka_config):
        """
        Initialize Kafka producer

        Args:
            kafka_config: Dict with Kafka configuration
                - bootstrap_servers: Kafka broker addresses
                - topic: Topic name
                - security_config: Optional security config
        """
        super().__init__()

        # Kafka producer configuration
        producer_config = {
            "bootstrap_servers": kafka_config["bootstrap_servers"],
            "value_serializer": lambda v: json.dumps(v).encode('utf-8'),
            "key_serializer": lambda k: str(k).encode('utf-8') if k else None,
            "acks": "all",  # Wait for all replicas
            "retries": 3,
            "max_in_flight_requests_per_connection": 1,
            "enable_idempotence": True
        }

        # Add security configuration if provided
        if "security_config" in kafka_config:
            security = kafka_config["security_config"]
            if security.get("use_ssl"):
                producer_config.update({
                    "security_protocol": "SSL",
                    "ssl_cafile": security.get("ca_file"),
                    "ssl_certfile": security.get("cert_file"),
                    "ssl_keyfile": security.get("key_file")
                })
            elif security.get("use_sasl"):
                producer_config.update({
                    "security_protocol": "SASL_SSL",
                    "sasl_mechanism": security.get("sasl_mechanism", "PLAIN"),
                    "sasl_plain_username": security.get("username"),
                    "sasl_plain_password": security.get("password")
                })

        self.producer = KafkaProducer(**producer_config)
        self.topic = kafka_config["topic"]
        self.send_frame_metadata = kafka_config.get("send_frame_metadata", True)
        self.send_object_metadata = kafka_config.get("send_object_metadata", True)
        self.batch_size = kafka_config.get("batch_size", 1)  # Send every N frames

        self.frame_count = 0
        self.error_count = 0

    def handle_metadata(self, batch_meta):
        """Process batch metadata and send to Kafka"""
        for frame_meta in batch_meta.frame_items:
            self.frame_count += 1

            # Send metadata every N frames (if batch_size > 1)
            if self.frame_count % self.batch_size != 0:
                continue

            try:
                # Prepare message
                message = self._prepare_message(frame_meta)

                # Send to Kafka
                future = self.producer.send(
                    topic=self.topic,
                    key=str(frame_meta.frame_number),  # Use frame number as key
                    value=message
                )

                # Optional: Add callback for success/failure
                future.add_callback(self._on_send_success)
                future.add_errback(self._on_send_error)

            except Exception as e:
                print(f"Error sending message to Kafka: {e}")
                self.error_count += 1

    def _prepare_message(self, frame_meta):
        """Prepare message from frame metadata"""
        message = {
            "frame_number": frame_meta.frame_number,
            # Note: Use buffer_pts for PTS timestamp, ntp_timestamp for NTP timestamp
            "buffer_pts": frame_meta.buffer_pts,
            "ntp_timestamp": frame_meta.ntp_timestamp,
            "pad_index": frame_meta.pad_index,
            "source_id": frame_meta.source_id  # Use source_id property
        }

        # Add frame-level metadata
        if self.send_frame_metadata:
            message["frame_metadata"] = {
                "source_width": frame_meta.source_width,
                "source_height": frame_meta.source_height,
                "pipeline_width": frame_meta.pipeline_width,
                "pipeline_height": frame_meta.pipeline_height
            }

        # Add object metadata
        if self.send_object_metadata:
            objects = []
            for obj_meta in frame_meta.object_items:
                obj_data = {
                    "class_id": obj_meta.class_id,
                    "confidence": float(obj_meta.confidence),
                    # Use object_id to get the tracker-assigned tracking ID
                    "object_id": obj_meta.object_id,
                    "bbox": {
                        "left": float(obj_meta.rect_params.left),
                        "top": float(obj_meta.rect_params.top),
                        "width": float(obj_meta.rect_params.width),
                        "height": float(obj_meta.rect_params.height)
                    }
                }

                # Add secondary inference results if available
                # (stored in obj_meta.obj_user_meta_list)
                if hasattr(obj_meta, 'obj_user_meta_list'):
                    obj_data["attributes"] = self._extract_attributes(obj_meta)

                objects.append(obj_data)

            message["objects"] = objects
            message["object_count"] = len(objects)

        return message

    def _extract_attributes(self, obj_meta):
        """Extract secondary inference attributes from object metadata"""
        attributes = {}
        # Process obj_user_meta_list to extract classification results
        # This depends on how secondary inference stores results
        return attributes

    def _on_send_success(self, record_metadata):
        """Callback for successful message send"""
        pass  # Can add logging here

    def _on_send_error(self, exception):
        """Callback for failed message send"""
        print(f"Failed to send message to Kafka: {exception}")
        self.error_count += 1

    def flush(self):
        """Flush pending messages"""
        self.producer.flush()

    def close(self):
        """Close Kafka producer"""
        self.producer.flush()
        self.producer.close()
        print(f"Kafka producer closed. Sent {self.frame_count} frames, {self.error_count} errors")

def kafka_custom_probe_pipeline(video_path, infer_config, kafka_config):
    """Pipeline with custom Kafka probe"""
    pipeline = Pipeline("kafka-custom-probe")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "pgie", {"config-file-path": infer_config})

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # OSD and sink
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nvvideoconvert", "converter")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 1})

    # Link pipeline
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "tracker", "osd", "converter", "sink")

    # Attach Kafka probe
    kafka_sender = KafkaMetadataSender(kafka_config)
    pipeline.attach("tracker", Probe("kafka-sender", kafka_sender))

    try:
        pipeline.start().wait()
    finally:
        kafka_sender.close()

if __name__ == "__main__":
    kafka_config = {
        "bootstrap_servers": "localhost:9092",
        "topic": "deepstream-analytics",
        "send_frame_metadata": True,
        "send_object_metadata": True,
        "batch_size": 1  # Send every frame
    }
    kafka_custom_probe_pipeline(sys.argv[1], sys.argv[2], kafka_config)
```

### Approach 3: Multi-Topic Kafka Integration

Send different types of metadata to different Kafka topics.

```python
class MultiTopicKafkaSender(BatchMetadataOperator):
    """Send different metadata types to different Kafka topics"""
    def __init__(self, kafka_configs):
        """
        Args:
            kafka_configs: Dict mapping topic names to Kafka configs
                {
                    "object-detections": {...},
                    "tracking-events": {...},
                    "frame-metadata": {...}
                }
        """
        super().__init__()
        self.producers = {}
        self.topics = {}

        for topic_name, config in kafka_configs.items():
            producer = KafkaProducer(
                bootstrap_servers=config["bootstrap_servers"],
                value_serializer=lambda v: json.dumps(v).encode('utf-8')
            )
            self.producers[topic_name] = producer
            self.topics[topic_name] = config.get("topic", topic_name)

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Send object detections
            if "object-detections" in self.producers:
                detections = self._prepare_detections(frame_meta)
                self.producers["object-detections"].send(
                    topic=self.topics["object-detections"],
                    value=detections
                )

            # Send tracking events (new tracks, lost tracks)
            if "tracking-events" in self.producers:
                events = self._prepare_tracking_events(frame_meta)
                if events:
                    self.producers["tracking-events"].send(
                        topic=self.topics["tracking-events"],
                        value=events
                    )

            # Send frame metadata
            if "frame-metadata" in self.producers:
                frame_data = self._prepare_frame_metadata(frame_meta)
                self.producers["frame-metadata"].send(
                    topic=self.topics["frame-metadata"],
                    value=frame_data
                )

    def _prepare_detections(self, frame_meta):
        """Prepare object detection message"""
        # Build detections list by iterating (object_items is an iterator)
        detections = [
            {
                "class_id": obj.class_id,
                "confidence": float(obj.confidence),
                "bbox": {
                    "left": float(obj.rect_params.left),
                    "top": float(obj.rect_params.top),
                    "width": float(obj.rect_params.width),
                    "height": float(obj.rect_params.height)
                }
            }
            for obj in frame_meta.object_items
        ]
        return {
            "frame_number": frame_meta.frame_number,
            "buffer_pts": frame_meta.buffer_pts,  # Use buffer_pts for timestamp
            "ntp_timestamp": frame_meta.ntp_timestamp,
            "detections": detections
        }

    def _prepare_tracking_events(self, frame_meta):
        """Prepare tracking event message"""
        # Detect new tracks, lost tracks, etc.
        # This requires maintaining state across frames
        return {}  # Implement tracking event detection

    def _prepare_frame_metadata(self, frame_meta):
        """Prepare frame metadata message"""
        # Note: object_items is an ITERATOR, not a list - cannot use len() directly
        # Count objects by iterating
        obj_count = sum(1 for _ in frame_meta.object_items)
        return {
            "frame_number": frame_meta.frame_number,
            "buffer_pts": frame_meta.buffer_pts,  # Use buffer_pts for timestamp
            "ntp_timestamp": frame_meta.ntp_timestamp,
            "object_count": obj_count
        }

    def close(self):
        """Close all producers"""
        for producer in self.producers.values():
            producer.flush()
            producer.close()
```

## Error Handling and Resilience

### Retry Logic and Error Handling

```python
class ResilientKafkaSender(BatchMetadataOperator):
    """Kafka sender with retry logic and error handling"""
    def __init__(self, kafka_config):
        super().__init__()
        self.config = kafka_config
        self.max_retries = kafka_config.get("max_retries", 3)
        self.retry_delay = kafka_config.get("retry_delay", 1.0)
        self.message_queue = []  # Queue for failed messages
        self._init_producer()

    def _init_producer(self):
        """Initialize or reinitialize producer"""
        try:
            self.producer = KafkaProducer(
                bootstrap_servers=self.config["bootstrap_servers"],
                value_serializer=lambda v: json.dumps(v).encode('utf-8'),
                retries=self.max_retries,
                max_in_flight_requests_per_connection=1,
                enable_idempotence=True
            )
            self.connected = True
        except Exception as e:
            print(f"Failed to initialize Kafka producer: {e}")
            self.connected = False

    def handle_metadata(self, batch_meta):
        if not self.connected:
            self._init_producer()
            if not self.connected:
                # Store messages for later retry
                self.message_queue.append(batch_meta)
                return

        try:
            # Process current batch
            self._send_batch(batch_meta)

            # Retry queued messages
            while self.message_queue:
                queued_batch = self.message_queue.pop(0)
                try:
                    self._send_batch(queued_batch)
                except Exception as e:
                    # Re-queue if still failing
                    self.message_queue.append(queued_batch)
                    break

        except Exception as e:
            print(f"Error sending to Kafka: {e}")
            self.message_queue.append(batch_meta)
            # Try to reconnect
            self.connected = False

    def _send_batch(self, batch_meta):
        """Send batch metadata to Kafka"""
        for frame_meta in batch_meta.frame_items:
            message = self._prepare_message(frame_meta)
            future = self.producer.send(
                topic=self.config["topic"],
                value=message
            )
            # Wait for delivery (synchronous for reliability)
            future.get(timeout=10)
```

## Performance Optimization

### Batching Messages

```python
class BatchedKafkaSender(BatchMetadataOperator):
    """Batch multiple frames before sending to Kafka"""
    def __init__(self, kafka_config, batch_size=10):
        super().__init__()
        self.producer = KafkaProducer(
            bootstrap_servers=kafka_config["bootstrap_servers"],
            value_serializer=lambda v: json.dumps(v).encode('utf-8'),
            batch_size=16384,  # Kafka batch size in bytes
            linger_ms=100  # Wait up to 100ms to batch
        )
        self.topic = kafka_config["topic"]
        self.batch_size = batch_size
        self.frame_buffer = []

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            self.frame_buffer.append(frame_meta)

            if len(self.frame_buffer) >= self.batch_size:
                self._send_batch()

    def _send_batch(self):
        """Send batched frames"""
        batch_message = {
            "frames": [self._prepare_message(f) for f in self.frame_buffer]
        }
        self.producer.send(topic=self.topic, value=batch_message)
        self.frame_buffer.clear()

    def flush(self):
        """Flush remaining frames"""
        if self.frame_buffer:
            self._send_batch()
        self.producer.flush()
```

## Testing and Validation

### Test Kafka Consumer

```python
from kafka import KafkaConsumer
import json

def test_kafka_consumer(bootstrap_servers, topic):
    """Test consumer to verify messages are being sent"""
    consumer = KafkaConsumer(
        topic,
        bootstrap_servers=bootstrap_servers,
        value_deserializer=lambda m: json.loads(m.decode('utf-8')),
        auto_offset_reset='earliest',
        enable_auto_commit=True
    )

    print(f"Consuming messages from topic: {topic}")
    for message in consumer:
        print(f"Received: {message.value}")
```

## Common Patterns

### Pattern 1: Real-time Analytics Dashboard
- Send object counts and statistics to Kafka
- Dashboard consumes and displays in real-time

### Pattern 2: Data Lake Ingestion
- Send all metadata to Kafka
- Kafka Connect streams to data lake (S3, HDFS)

### Pattern 3: Alert System
- Send only significant events (intrusions, anomalies)
- Alert service consumes and triggers notifications

### Pattern 4: Multi-Tenant Analytics
- Use different topics for different customers/streams
- Enable topic-based access control

---

# Part 2: Message Broker and Converter Configuration Reference

## Architecture

```
Pipeline -> nvmsgconv -> nvmsgbroker -> External Broker
              |              |
              |              +-- Protocol Adaptor Library
              |                   (libnvds_kafka_proto.so, etc.)
              |
              +-- Config File (sensor, place, analytics metadata)
```

**IMPORTANT**: `nvmsgbroker` is a **SINK component** that terminates the pipeline branch. It cannot have downstream components.

---

## nvmsgconv Plugin

### Purpose

Converts DeepStream metadata (NvDsEventMsgMeta or NvDsFrameMeta/NvDsObjectMeta) to message payload format.

### GStreamer Properties

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `config` | string | Path to message converter configuration file | None |
| `payload-type` | int | Payload schema type (see below) | 0 |
| `comp-id` | uint | Component ID for filtering metadata | All |
| `msg2p-lib` | string | Path to custom payload generation library | None |
| `frame-interval` | uint | Generate payload every N frames | 30 |
| `msg2p-newapi` | bool | **IMPORTANT**: Use new message-to-payload API (see below) | false |
| `debug-payload-dir` | string | Directory to dump payloads for debugging | None |
| `multiple-payloads` | bool | Generate multiple payloads per buffer | false |

### CRITICAL: msg2p-newapi Property

**Problem**: By default (`msg2p-newapi: false`), `nvmsgconv` requires `NvDsEventMsgMeta` (exposed as `EventMessageUserMetadata` in pyservicemaker) to be attached to the buffer. This metadata is **NOT automatically generated** by inference or tracker plugins. Without explicitly handling this, nvmsgconv silently produces **zero messages**.

**Two Solutions** (pick one):

#### Solution A: Set msg2p-newapi=True (Simple, Recommended for Most Cases)

Uses the new API that reads directly from `NvDsFrameMeta` and `NvDsObjectMeta` without requiring `NvDsEventMsgMeta`:

```python
# CORRECT - Uses object metadata directly, no NvDsEventMsgMeta needed
pipeline.add("nvmsgconv", "msgconv", {
    "config": msgconv_config,
    "payload-type": 0,
    "msg2p-newapi": True,      # Use new API - reads from NvDsObjectMeta directly
})
```

#### Solution B: Keep msg2p-newapi=0 and Attach EventMessageUserMetadata Probe

Required when using custom `msg2p-lib` payload libraries that expect legacy `NvDsEventMsgMeta`, or when you need fine-grained control over per-object message generation.

**Option B1: Built-in probe** (simplest):
```python
pipeline.add("nvmsgconv", "msgconv", {
    "config": msgconv_config,
    "payload-type": 0,
    # msg2p-newapi defaults to 0 (legacy API)
})

# Built-in probe auto-generates EventMessageUserMetadata from NvDsObjectMeta
pipeline.attach("osd", "add_message_meta_probe", "metadata generator")
```

**Option B2: Custom EventMessageGenerator** (for multi-camera / custom sensor mappings):
```python
from pyservicemaker import Probe, BatchMetadataOperator, SensorInfo

class EventMessageGenerator(BatchMetadataOperator):
    def __init__(self, sensor_map, labels):
        super().__init__()
        self._sensor_map = sensor_map  # dict: source_id -> SensorInfo
        self._labels = labels          # list of class label strings

    def handle_metadata(self, batch_meta, frame_interval=1):
        for frame_meta in batch_meta.frame_items:
            for object_meta in frame_meta.object_items:
                event_msg = batch_meta.acquire_event_message_meta()
                if event_msg:
                    source_id = frame_meta.source_id
                    sensor_info = self._sensor_map.get(source_id)
                    sensor_id = sensor_info.sensor_id if sensor_info else "N/A"
                    uri = sensor_info.uri if sensor_info else "N/A"
                    event_msg.generate(
                        object_meta, frame_meta, sensor_id, uri, self._labels
                    )
                    frame_meta.append(event_msg)

# Attach UPSTREAM of nvmsgconv (e.g., on tracker or osd element)
sensor_map = {0: SensorInfo("Camera1", "cam1", "file:///video.mp4")}
labels = ["car", "bicycle", "person", "roadsign"]
pipeline.attach("tracker", Probe("event_msg_gen", EventMessageGenerator(sensor_map, labels)))
```

For complete pipeline examples using the legacy API, see Part 1 above (Example 3).

#### Common Mistake

```python
# WRONG - Without msg2p-newapi=True AND without EventMessageUserMetadata probe,
# nvmsgconv has no input and produces ZERO messages silently!
pipeline.add("nvmsgconv", "msgconv", {
    "config": msgconv_config,
    "payload-type": 0
})
```

**Reference samples**:
- Built-in probe: `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test4_app/deepstream_test4.py`
- Custom generator: `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test5_app/deepstream_test5.py`

### Payload Types

| Value | Name | Description |
|-------|------|-------------|
| 0 | `PAYLOAD_DEEPSTREAM` | Full DeepStream schema - separate JSON payload per object |
| 1 | `PAYLOAD_DEEPSTREAM_MINIMAL` | Minimal schema - multiple objects in single JSON payload |
| 2 | `PAYLOAD_DEEPSTREAM_PROTOBUF` | Protobuf encoded - multiple objects in single payload |
| 256 | `PAYLOAD_CUSTOM` | Custom schema using msg2p-lib |

### Pipeline Usage

```python
# Using pyservicemaker Pipeline API
pipeline.add("nvmsgconv", "msgconv", {
    "config": "/path/to/msgconv_config.txt",
    "payload-type": 0  # Full DeepStream schema
})
```

---

## nvmsgconv Configuration File

The configuration file defines metadata about sensors, places, and analytics that gets embedded in the message payload.

### Supported Formats

- **INI-style format** (`.txt`) - Recommended
- **YAML format** (`.yml`)

### Configuration Sections

#### [sensor0], [sensor1], ... - Sensor/Camera Information

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `enable` | int | Enable this sensor (0/1) | Yes |
| `type` | string | Sensor type (e.g., "Camera", "Lidar") | Yes |
| `id` | string | Unique sensor identifier | Yes |
| `location` | string | GPS coordinates "lat;lon;alt" | No |
| `description` | string | Human-readable description | No |
| `coordinate` | string | Local coordinates "x;y;z" | No |

#### [place0], [place1], ... - Location/Place Information

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `enable` | int | Enable this place (0/1) | Yes |
| `id` | string/int | Place identifier | Yes |
| `type` | string | Place type (e.g., "garage", "intersection/road") | Yes |
| `name` | string | Place name | Yes |
| `location` | string | GPS coordinates "lat;lon;alt" | No |
| `coordinate` | string | Local coordinates "x;y;z" | No |
| `place-sub-field1` | string | Custom sub-field 1 | No |
| `place-sub-field2` | string | Custom sub-field 2 | No |
| `place-sub-field3` | string | Custom sub-field 3 | No |

#### [analytics0], [analytics1], ... - Analytics Information

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `enable` | int | Enable this analytics config (0/1) | Yes |
| `id` | string | Analytics identifier | Yes |
| `description` | string | Analytics description | No |
| `source` | string | Analytics source/algorithm name | No |
| `version` | string | Analytics version | No |

### Example Configuration (INI-style)

```ini
# msgconv_config.txt

[sensor0]
enable=1
type=Camera
id=CAMERA_001
location=45.293701;-75.830391;48.155
description=Entrance Camera
coordinate=5.2;10.1;11.2

[sensor1]
enable=1
type=Camera
id=CAMERA_002
location=45.293702;-75.830392;48.156
description=Exit Camera
coordinate=6.2;11.1;12.2

[place0]
enable=1
id=1
type=garage
name=ParkingLot_A
location=30.32;-40.55;100.0
coordinate=1.0;2.0;3.0
place-sub-field1=Zone_A
place-sub-field2=Lane_1
place-sub-field3=Level_P1

[analytics0]
enable=1
id=ANALYTICS_001
description=Vehicle Detection and Tracking
source=ResNet18_TrafficCamNet
version=1.0
```

### Example Configuration (YAML)

```yaml
# msgconv_config.yml

sensor0:
  enable: 1
  type: Camera
  id: CAMERA_001
  location: 45.293701;-75.830391;48.155
  description: Entrance Camera
  coordinate: 5.2;10.1;11.2

place0:
  enable: 1
  id: 1
  type: garage
  name: ParkingLot_A
  location: 30.32;-40.55;100.0
  coordinate: 1.0;2.0;3.0
  place-sub-field1: Zone_A
  place-sub-field2: Lane_1
  place-sub-field3: Level_P1

analytics0:
  enable: 1
  id: ANALYTICS_001
  description: Vehicle Detection and Tracking
  source: ResNet18_TrafficCamNet
  version: 1.0
```

### Multi-Source Configuration

For multi-source pipelines, create sensor/place entries for each source:

```ini
# Sensor entries map to source_id in the pipeline
[sensor0]
enable=1
type=Camera
id=STREAM_0
description=Camera 0

[sensor1]
enable=1
type=Camera
id=STREAM_1
description=Camera 1

# Place entries map to source_id
[place0]
enable=1
id=0
type=intersection
name=Location_0

[place1]
enable=1
id=1
type=intersection
name=Location_1
```

---

## nvmsgbroker Plugin

### Purpose

Sends payload metadata to external message brokers using protocol adaptor libraries.

### GStreamer Properties

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `proto-lib` | string | Path to protocol adaptor library | **Required** |
| `conn-str` | string | Connection string for broker | **Required** |
| `config` | string | Path to protocol-specific config file | None |
| `topic` | string | Message topic name | None |
| `comp-id` | uint | Component ID for filtering payloads | All |
| `sync` | int | Synchronous (1) or async (0) message sending | 0 |
| `async` | int | **CRITICAL**: Set to 0 for dynamic sources/tee pipelines | 1 |
| `new-api` | bool | Use new nvmsgbroker API | false |
| `sleep-time` | uint | Sleep time in ms between do_work calls | 0 |

**CRITICAL: async=0 for Dynamic Sources and Tee Splits**

When using `nvmsgbroker` in a pipeline with:
- Dynamic sources (nvmultiurisrcbin)
- Tee splits (multiple branches with different sinks)

You **MUST** set `async: 0` on nvmsgbroker AND all other sinks. Otherwise, the pipeline will be stuck in PAUSED state.

```python
# CORRECT - async=0 for tee/dynamic source pipelines
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",
    "sync": 0,   # Async message sending
    "async": 0,  # CRITICAL: Required for tee/dynamic sources!
})

# WRONG - missing async=0 causes pipeline stuck in PAUSED
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",
    "sync": 0,
    # async defaults to 1, causing state transition deadlock!
})
```

### Protocol Adaptor Libraries

Located at `/opt/nvidia/deepstream/deepstream/lib/`:

| Protocol | Library | Connection String Format |
|----------|---------|-------------------------|
| Kafka | `libnvds_kafka_proto.so` | `host;port` (semicolon-separated) |
| MQTT | `libnvds_mqtt_proto.so` | `host;port` (semicolon-separated) |
| Redis | `libnvds_redis_proto.so` | `host;port` (semicolon-separated) |
| AMQP | `libnvds_amqp_proto.so` | `host;port;username;password` (semicolon-separated) |
| Azure IoT | `libnvds_azure_proto.so` | Full Azure connection string |
| Azure IoT Edge | `libnvds_azure_edge_proto.so` | - |

**CRITICAL: Connection String Format**

DeepStream message broker uses **semicolon (`;`)** as separator, NOT colon (`:`).

```python
# CORRECT - semicolon separator
"conn-str": "localhost;9092"

# WRONG - colon separator (will fail to connect)
"conn-str": "localhost:9092"
```

### Pipeline Usage

```python
# Using pyservicemaker Pipeline API
# For simple pipelines (single source, no tee):
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",  # IMPORTANT: Use semicolon, not colon!
    "topic": "deepstream-analytics",
    "sync": 0,
    "config": "/path/to/kafka_config.txt"
})

# For pipelines with dynamic sources OR tee splits:
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",  # IMPORTANT: Use semicolon, not colon!
    "topic": "deepstream-analytics",
    "sync": 0,
    "async": 0,  # CRITICAL: Required for tee/dynamic sources!
    "config": "/path/to/kafka_config.txt"
})
```

---

## Protocol Adaptor Configurations

### Kafka Protocol Adaptor

#### Dependencies Installation

```bash
# Add Confluent repository
sudo mkdir -p /etc/apt/keyrings
wget -qO - https://packages.confluent.io/deb/7.8/archive.key | gpg \
  --dearmor | sudo tee /etc/apt/keyrings/confluent.gpg > /dev/null

CP_DIST=$(lsb_release -cs)
echo "Types: deb
URIs: https://packages.confluent.io/deb/8.0
Suites: stable
Components: main
Architectures: $(dpkg --print-architecture)
Signed-by: /etc/apt/keyrings/confluent.gpg

Types: deb
URIs: https://packages.confluent.io/clients/deb/
Suites: ${CP_DIST}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/confluent.gpg" | sudo tee /etc/apt/sources.list.d/confluent-platform.sources > /dev/null

# Install dependencies
sudo apt-get update
sudo apt-get install librdkafka-dev libglib2.0-dev libjansson-dev libssl-dev
```

#### Configuration File (cfg_kafka.txt)

```ini
[message-broker]
# Consumer group ID for Kafka consumer
#consumer-group-id = mygroup

# Generic librdkafka configuration (applies to both producer and consumer)
# Semicolon-separated key=value pairs
#proto-cfg = "message.max.bytes=200000;log_level=6"

# Producer-specific librdkafka configuration
#producer-proto-cfg = "queue.buffering.max.messages=200000;message.send.max.retries=3"

# Consumer-specific librdkafka configuration
#consumer-proto-cfg = "max.poll.interval.ms=20000"

# Partition key field name in JSON message
# Use "sensor.id" for full schema, "sensorId" for minimal schema
#partition-key = sensor.id

# Enable connection sharing within same process
#share-connection = 1
```

#### Connection String

Format: `hostname;port`

Example: `localhost;9092` or `kafka-broker.example.com;9092`

#### TLS/SSL Configuration

For secure connections, refer to `/opt/nvidia/deepstream/deepstream/sources/libs/kafka_protocol_adaptor/Security_Setup.md`

---

### MQTT Protocol Adaptor

#### Dependencies Installation

```bash
# Install dependencies
sudo apt-get install libglib2.0-dev libcjson-dev libssl-dev

# Add Mosquitto PPA and install
sudo apt-add-repository ppa:mosquitto-dev/mosquitto-ppa
sudo apt-get update
sudo apt-get install libmosquitto-dev mosquitto
```

#### Configuration File (cfg_mqtt.txt)

```ini
[message-broker]
# Username for broker authentication (deprecated - use env var)
#username = user

# Password for broker authentication (deprecated - use env var)
#password = password

# Unique client ID (empty = random)
client-id = deepstream-client

# TLS Configuration
#enable-tls = 1
#tls-cafile = /path/to/ca-cert.pem
#tls-capath = /path/to/ca-certs-dir/
#tls-certfile = /path/to/client-cert.pem
#tls-keyfile = /path/to/client-key.pem

# Connection sharing
#share-connection = 1

# Mosquitto loop timeout in ms
#loop-timeout = 2000

# Keep-alive interval in seconds
#keep-alive = 60

# Enable threaded mode (required for nvmsgbroker plugin)
#set-threaded = 1
```

#### User Authentication via Environment Variables

```bash
export USER_MQTT=username
export PASSWORD_MQTT=password
```

#### Connection String

Format: `hostname;port`

Example: `localhost;1883`

#### Running Mosquitto Broker

```bash
# Add mosquitto user
sudo adduser --system mosquitto

# Run broker
mosquitto

# Or with config file
mosquitto -c /etc/mosquitto/mosquitto.conf
```

#### Verify Messages

```bash
# Subscribe to topic
mosquitto_sub -t deepstream-analytics -v

# Publish test message
mosquitto_pub -t deepstream-analytics -m 'test message'
```

---

### Redis Protocol Adaptor

#### Dependencies Installation

```bash
# Install dependencies
sudo apt-get install libglib2.0-dev libssl-dev libhiredis-dev
```

#### Configuration File (cfg_redis.txt)

```ini
[message-broker]
# Redis server hostname
#hostname=localhost

# Redis server port
#port=6379

# Password for Redis AUTH (deprecated - use env var)
#password=password

# Redis stream key for payload
#payloadkey=metadata

# Consumer group name
#consumergroup=mygroup

# Consumer name
#consumername=myname

# Maximum stream size (for capped streams)
#streamsize=10000

# Connection sharing
#share-connection = 1
```

#### User Authentication via Environment Variables

```bash
export PASSWORD_REDIS=password
```

#### Connection String

Format: `hostname;port`

Example: `localhost;6379`

#### Running Redis Server

```bash
# Download and build Redis
wget http://download.redis.io/releases/redis-6.0.8.tar.gz
tar xzf redis-6.0.8.tar.gz
cd redis-6.0.8
make

# Run server
src/redis-server

# Or with protected mode disabled (for external connections)
src/redis-server --protected-mode no
```

---

### AMQP Protocol Adaptor (RabbitMQ)

#### Dependencies Installation

```bash
# Install dependencies
sudo apt-get install libglib2.0-dev librabbitmq-dev

# Install RabbitMQ server (optional, for local testing)
sudo apt-get install rabbitmq-server
sudo service rabbitmq-server start
```

#### Configuration File (cfg_amqp.txt)

```ini
[message-broker]
# RabbitMQ server hostname
hostname = localhost

# RabbitMQ server port
port = 5672

# Username (deprecated - use env var)
username = guest

# Password (deprecated - use env var)
password = guest

# AMQP exchange name
exchange = amq.topic

# Topic/routing key
topic = deepstream-analytics

# Maximum frame size
amqp-framesize = 131072

# Heartbeat interval in seconds (0 = disabled)
#amqp-heartbeat = 0

# Connection sharing
#share-connection = 1
```

#### User Authentication via Environment Variables

```bash
export USER_AMQP=username
export PASSWORD_AMQP=password
```

#### Connection String

Format: `hostname;port;username;password`

Example: `localhost;5672;guest;guest`

#### Setup RabbitMQ Queue

```bash
# Enable management plugin
sudo rabbitmq-plugins enable rabbitmq_management

# Create queue
sudo rabbitmqadmin -u guest -p guest -V / declare queue name=myqueue durable=false auto_delete=true

# Bind queue to exchange
rabbitmqadmin -u guest -p guest -V / declare binding source=amq.topic destination=myqueue routing_key=deepstream-analytics

# List queues
sudo rabbitmqctl list_queues
```

#### Consume Messages

```bash
# Install amqp-tools
sudo apt-get install amqp-tools

# Consume from queue
amqp-consume -q "myqueue" -r "deepstream-analytics" -e "amq.topic" cat
```

---

### Azure IoT Protocol Adaptor

#### Dependencies Installation

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y libcurl4-openssl-dev libssl-dev uuid-dev libglib2.0-dev

# Build Azure IoT SDK
git clone https://github.com/Azure/azure-iot-sdk-c.git
cd azure-iot-sdk-c
git checkout tags/1.11.0
git submodule update --init

# Modify CMakeLists.txt:
# - Line 61: set build_as_dynamic to ON
# - Line 65: set use_edge_modules to ON

mkdir cmake && cd cmake
cmake ..
cmake --build .
sudo make install
```

#### Configuration File (cfg_azure.txt)

```ini
[message-broker]
# Azure IoT Hub connection string
#connection_str = HostName=<my-hub>.azure-devices.net;DeviceId=<device_id>;SharedAccessKey=<my-policy-key>

# Custom message properties (key=value pairs)
#custom_msg_properties = key1=value1;key2=value2;

# Connection sharing
#share-connection = 1

# Cleanup timeout in seconds during disconnect
#cleanup-timeout = 20
```

#### Connection String

Full Azure IoT Hub connection string:
```
HostName=<my-hub>.azure-devices.net;DeviceId=<device_id>;SharedAccessKey=<my-policy-key>
```

---

## nvmsgbroker Library Configuration

The nvmsgbroker library (wrapper around protocol adaptors) has its own configuration:

### Configuration File (cfg_nvmsgbroker.txt)

```ini
[nvmsgbroker]
# Enable auto-reconnection (0=disable, 1=enable)
auto-reconnect=1

# Reconnection retry interval in seconds
retry-interval=1

# Maximum retry limit in seconds
max-retry-limit=3600

# Work interval in microseconds
work-interval=10000
```

---

## Message Payload Formats

### Full Schema (payload-type=0)

Generates separate JSON payload per object:

```json
{
  "messageid": "unique-uuid",
  "mdsversion": "1.0",
  "@timestamp": "2024-01-15T10:30:00.000Z",
  "place": {
    "id": "1",
    "name": "ParkingLot_A",
    "type": "garage",
    "location": {
      "lat": 30.32,
      "lon": -40.55,
      "alt": 100.0
    }
  },
  "sensor": {
    "id": "CAMERA_001",
    "type": "Camera",
    "description": "Entrance Camera"
  },
  "analyticsModule": {
    "id": "ANALYTICS_001",
    "description": "Vehicle Detection",
    "source": "ResNet18_TrafficCamNet",
    "version": "1.0"
  },
  "object": {
    "id": "1",
    "speed": 0,
    "direction": 0,
    "orientation": 0,
    "vehicle": {
      "type": "car",
      "make": "",
      "model": "",
      "color": "",
      "license": ""
    },
    "bbox": {
      "topleftx": 100,
      "toplefty": 200,
      "bottomrightx": 300,
      "bottomrighty": 400
    },
    "location": {
      "lat": 0,
      "lon": 0,
      "alt": 0
    },
    "coordinate": {
      "x": 0,
      "y": 0,
      "z": 0
    }
  },
  "event": {
    "id": "event-uuid",
    "type": "entry"
  },
  "videoPath": ""
}
```

### Minimal Schema (payload-type=1)

Multiple objects in single JSON payload:

```json
{
  "messageid": "unique-uuid",
  "mdsversion": "1.0",
  "@timestamp": "2024-01-15T10:30:00.000Z",
  "sensorId": "CAMERA_001",
  "objects": [
    {
      "id": "1",
      "type": "car",
      "confidence": 0.95,
      "bbox": {
        "topleftx": 100,
        "toplefty": 200,
        "bottomrightx": 300,
        "bottomrighty": 400
      }
    },
    {
      "id": "2",
      "type": "person",
      "confidence": 0.88,
      "bbox": {
        "topleftx": 400,
        "toplefty": 150,
        "bottomrightx": 450,
        "bottomrighty": 350
      }
    }
  ]
}
```

---

## Troubleshooting

### Common Issues

1. **"Connection refused" error**
   - Verify broker is running and accessible
   - Check firewall rules
   - Verify connection string format

2. **"Library not found" error**
   - Verify proto-lib path exists
   - Check library dependencies: `ldd /opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so`

3. **Messages not appearing in broker**
   - Verify topic exists (or auto-create is enabled)
   - Check broker logs for errors
   - Enable DeepStream logging (see below)

4. **TLS/SSL connection failures**
   - Verify certificate paths
   - Check certificate validity
   - Ensure proper permissions on key files

### Enable DeepStream Logging

```bash
# Setup logger
chmod u+x /opt/nvidia/deepstream/deepstream/sources/tools/nvds_logger/setup_nvds_logger.sh
sudo /opt/nvidia/deepstream/deepstream/sources/tools/nvds_logger/setup_nvds_logger.sh

# View logs
tail -f /tmp/nvds/ds.log
```

---

## Best Practices

1. **Use async mode** (`sync=0`) for better performance
2. **Configure appropriate batch sizes** in nvmsgconv's `frame-interval`
3. **Use minimal schema** (`payload-type=1`) for lower bandwidth
4. **Enable auto-reconnect** in nvmsgbroker config for resilience
5. **Use environment variables** for credentials instead of config files
6. **Monitor broker lag** to ensure consumers keep up
7. **Use TLS/SSL** for production deployments
8. **Implement retry logic**: Handle transient Kafka failures (see Part 1 above for Python examples)
9. **Batch messages**: Reduce network overhead (see Part 1 above for batching patterns)
10. **Use appropriate partitioning**: Use frame_number or source_id as key
11. **Handle backpressure**: Pause pipeline if Kafka is slow
12. **Monitor producer metrics**: Track send rates and errors
13. **Clean shutdown**: Flush and close producers properly

---

## Related Documentation

- **GStreamer Plugins Overview**: `gstreamer_plugins.md`
- **Service Maker Python API**: `service_maker_api.md`
