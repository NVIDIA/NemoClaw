<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stage Hierarchy Fallback Worker Protocol

## Fallback Subprocess Protocol

The active streaming server uses `server/pxr_worker.py` and `PxrWorkerClient`, not the older request-id worker. Keep this path for variants, rich metadata, and relationship targets. Requests and responses are one UTF-8 JSON object per line on stdin/stdout; logs go to stderr only. Use line buffering (`bufsize=1`, `reconfigure(line_buffering=True)`).

```json
{"cmd":"load","path":"/path/to/scene.usd"}
{"cmd":"get_children","path":"/World","filters":["USDGeom"]}
{"cmd":"get_properties","path":"/World/Cube"}
{"cmd":"get_variants","path":"/World/Chair"}
{"cmd":"set_variant","path":"/World/Chair","variant_set":"color","variant_selection":"blue"}
{"cmd":"get_pickable_bboxes","paths":["/World/Cube"]}
{"cmd":"get_material_map"}
{"cmd":"get_world_transforms","paths":["/World/Cube"]}
{"cmd":"get_root_prim_path"}
{"cmd":"get_prim_count"}
{"cmd":"shutdown"}
```

Success: `{"ok":true,...data}`. Error: `{"ok":false,"error":"..."}`. The worker is stateful and single-stage; `load` stores `_stage`, and later commands query that loaded stage.

`server/usd_worker.py` shows an older `{request_id,type}` protocol and can remain as historical reference. Do not copy that protocol into the current streaming server unless you also update `PxrWorkerClient`.

## Worker Command Standard

Use these command names and response shapes for generated `server/pxr_worker.py`
and `PxrWorkerClient`. Do not emit `get_base_transforms`; the current command
is `get_world_transforms`.

| Command | Request fields | Success response |
|---|---|---|
| `load` | `path` | `{"ok": true}` |
| `get_bbox` | none | `{"ok": true, "empty": false, "center": [...], "size": [...], "max_dim": 123.0}` |
| `get_children` | `path`, optional `filters` | `{"ok": true, "children": [{"name": "...", "path": "...", "children": true, "type": "geom"}]}` |
| `get_root_prim_path` | none | `{"ok": true, "path": "/World"}` |
| `get_prim_count` | none | `{"ok": true, "count": 1234}` |
| `get_properties` | `path` | `{"ok": true, "properties": {"typeName": "Mesh", "visibility": "inherited", "material:binding": "/World/Looks/Mat"}}` |
| `get_variants` | `path` | `{"ok": true, "variants": {"color": {"options": ["red"], "selection": "red"}}}` |
| `set_variant` | `path`, `variant_set`, `variant_selection` | `{"ok": true}` |
| `get_pickable_bboxes` | optional `paths` | `{"ok": true, "bboxes": {"/World/Cube": {"min": [0,0,0], "max": [1,1,1]}}}` |
| `get_material_map` | none | `{"ok": true, "material_map": {"/World/Cube": "/World/Looks/Mat/EffectLayer"}}` |
| `get_world_transforms` | optional `paths` | `{"ok": true, "transforms": {"/World/Cube": [[...],[...],[...],[...]]}}` |

`get_pickable_bboxes` returns a dictionary keyed by prim path, not a list:

```json
{
  "ok": true,
  "bboxes": {
    "/World/Mesh": {
      "min": [-1.0, 0.0, -1.0],
      "max": [1.0, 2.0, 1.0]
    }
  }
}
```

The property payload is intentionally a simple object keyed by display/property names. Include `typeName` first, serialize authored attributes, serialize relationship targets as strings or string arrays, and add `material:binding` when `UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()` resolves.

`get_children` with `filters=["USDGeom"]` should match the expected selectable
behavior: it includes prims that are themselves geometry, usually
`UsdGeom.Mesh`, not arbitrary containers that only contain geometry descendants.
