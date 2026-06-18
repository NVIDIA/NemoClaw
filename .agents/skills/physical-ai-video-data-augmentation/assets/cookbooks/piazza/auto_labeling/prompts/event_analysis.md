# Piazza VLM prompt for event extraction.
# Runtime mount target: /workspace/configs/video_event_analysis_prompt_redid.md.

Parsing gate for this scene:
1) Output exactly two JSON objects.
2) JSON object #1 is clip metadata only.
3) JSON object #2 contains event annotations under "events".
4) No markdown wrappers, comments, or trailing explanation.

Scene profile:
- Outdoor cobblestone piazza viewed from above.
- Pedestrian flow, cafe seating, and scooter/motorcycle activity coexist in frame.

Analyst task:
Detect pedestrian-safety and two-wheeler risk events from each segment.

Recognized event concepts:
- motorcycle_pedestrian_contact
- pedestrian_collision
- near_miss_motorcycle
- pedestrian_close_call
- erratic_motorcycle
- pathway_obstruction
- pedestrian_flow
- outdoor_dining
- motorcycle_parking

Do not invent categories not listed above.

JSON #1 (metadata) must include:
- version, video_id, format, rectified, scenario_info, scene_description, event_summary, fps, duration, height, width, camera_id
- scenario_info fixed to "OUTDOOR_PIAZZA"
- scene_description should cover square geometry, cafe footprint, parked two-wheelers, weather, lighting, and unusual route blockages
- event_summary should capture movement intensity and timestamped safety outcomes

JSON #2 (event annotations) must include:
- top-level: version, events
- per-event keys: event_id, start_time, end_time, category, sub_category, instances, event_caption
- allowed category values: collision, near_miss, anomaly, normal_traffic

Category mapping:
- collision => motorcycle_pedestrian_contact, pedestrian_collision
- near_miss => near_miss_motorcycle, pedestrian_close_call
- anomaly => erratic_motorcycle, pathway_obstruction
- normal_traffic => pedestrian_flow, outdoor_dining, motorcycle_parking

Field-level constraints:
- sub_category is always a JSON list (example: ["near_miss_motorcycle"])
- event_caption includes severity (low/medium/high), actors, and evidence window
- Use track IDs when present; otherwise use human-readable actor labels
- Timestamps are numeric seconds

No-activity case:
- If the piazza is empty, return metadata and set events to an empty list.

Piazza-specific interpretation notes:
- Canopy cover causes temporary occlusion; disappearance under awnings is not itself anomalous.
- Parked scooters are baseline context; only moving vehicles should drive near_miss or collision calls.
- Tables/chairs are fixed infrastructure unless clearly displaced into travel paths.
- Strong shadow and reflection artifacts on stone may resemble entities; confirm with motion cues.
- Top-down perspective compresses distance; require visible evasive behavior before labeling a near miss.
- In rain, reflected silhouettes can duplicate apparent objects; prioritize track continuity over glare.

Return order is strict: JSON #1 then JSON #2.
