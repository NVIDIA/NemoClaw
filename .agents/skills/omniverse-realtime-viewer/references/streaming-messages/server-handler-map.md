<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Streaming Message Server Handler Map

## Server Handler Map

If generating `server/message_handler.py`, keep it small: parse/unpack JSON, select a handler from a dictionary, validate payload defaults, and send a response. Slow USD queries should call a worker/queue rather than blocking the ovstream callback thread. Treat non-app stream messages as ignorable input; browser streaming libraries can send control messages or envelope payloads that are not app JSON.

Robust decode helper:

```python
def decode_app_message(raw: str | bytes | dict) -> dict | None:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        msg = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict):
        return None

    if "messageType" in msg and "data" in msg:
        data = msg["data"]
        try:
            msg = json.loads(data) if isinstance(data, str) else data
        except json.JSONDecodeError:
            return None
        if not isinstance(msg, dict):
            return None

    if "event_type" not in msg:
        return None
    return msg
```

```python
self._handlers = {
    "openStageRequest": self._handle_open_stage,
    "getChildrenRequest": self._handle_get_children,
    "getPropertiesRequest": self._handle_get_properties,
    "getPrimCountRequest": self._handle_get_prim_count,
    "getStatsRequest": self._handle_get_stats,
    "selectPrimsRequest": self._handle_select_prims,
    "makePrimsPickable": self._handle_make_pickable,
    "makePrimsSelectable": self._handle_make_pickable,
    "resetStage": self._handle_reset_stage,
    "resetStageRequest": self._handle_reset_stage,
    "loadingStateQuery": self._handle_loading_state_query,
    "getVariantsRequest": self._handle_get_variants,
    "setVariantRequest": self._handle_set_variant,
    "changeAOVRequest": self._handle_change_aov,
    "getAvailableAOVs": self._handle_get_available_aovs,
    "toggleSegView": self._handle_toggle_seg_view,
    "setCameraGizmo": self._handle_set_camera_gizmo,
}
```

Send helper:

```python
def send_event(stream_server, event_type: str, payload: dict) -> None:
    if not stream_server or not stream_server.is_client_connected:
        return
    try:
        stream_server.send_message(json.dumps({"event_type": event_type, "payload": payload}, default=str))
    except Exception:
        logger.debug("Dropping event during disconnect: %s", event_type, exc_info=True)
```

For a `MessageHandler` wrapper, apply the guard to the underlying ovstream server:

```python
def send_message(self, event_type: str, payload: Dict[str, Any]) -> None:
    send_event(self.server._stream_server, event_type, payload)
```

If generating `server/pxr_worker.py`, make it a stateful JSON-lines worker with pure USD commands such as `load`, `get_children`, `get_properties`, `get_prim_count`, `get_variants`, and `get_root_prim_path`. It should not import ovstream or mutate renderer state.
