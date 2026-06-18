# Warehouse-construction VLM event-analysis prompt.
# Runtime file path: /workspace/configs/video_event_analysis_prompt_redid.md.

Formatting contract:
- Emit two JSON objects only.
- First object is metadata without an "events" key.
- Second object contains the "events" array.
- Keep output machine-readable; no commentary.

Video context:
- Ground-level fixed camera inside an active warehouse buildout area.
- Typical entities include workers, ladders, lifts, tools, materials, and floor cabling.

Assignment:
Identify safety incidents, near misses, anomalies, and normal operations.

Allowed sub-categories:
- worker_equipment_contact
- worker_fall
- near_miss_equipment
- near_miss_falling_object
- unsafe_ladder_use
- cable_trip_hazard
- normal_construction
- equipment_operation
- worker_transit

Metadata JSON requirements:
- Mandatory keys: version, video_id, format, rectified, scenario_info, scene_description, event_summary, fps, duration, height, width, camera_id
- scenario_info must equal "INDOOR_WAREHOUSE"
- scene_description should summarize floor layout, active equipment, cable/material distribution, lighting mix, and hazard zones
- event_summary should capture workforce activity level and timestamped outcomes

Event JSON requirements:
- Root keys: version, events
- Every event entry must include:
  - event_id
  - start_time
  - end_time
  - category (collision | near_miss | anomaly | normal_traffic)
  - sub_category (array)
  - instances (array)
  - event_caption

Category mapping:
- collision -> worker_equipment_contact, worker_fall
- near_miss -> near_miss_equipment, near_miss_falling_object
- anomaly -> unsafe_ladder_use, cable_trip_hazard
- normal_traffic -> normal_construction, equipment_operation, worker_transit

Validation constraints:
- sub_category must always be a JSON array
- event_caption includes severity (low/medium/high), actor/equipment references, and supporting timing
- Prefer tracking IDs when present; otherwise use labels like worker/operator/crew member
- Times are numeric seconds

No-worker scenario:
- If no people are visible, return metadata plus an empty events array.

Warehouse-scene caveats:
- Columns and material stacks can hide workers; short occlusion is not itself anomalous.
- Floor cables are common background; classify cable_trip_hazard only when stretched across active walk paths.
- Ladder and scaffold usage both occur; capture unsafe posture/placement under unsafe_ladder_use.
- Mixed lighting may obscure detail; when uncertain, describe observable evidence instead of inferring unseen actions.
- Missing visible PPE can be noted in captions, but keep primary category tied to the observed event class.
- Slow lift repositioning is normal; near_miss_equipment requires close worker proximity during active motion.

Required output order: metadata object first, events object second.
