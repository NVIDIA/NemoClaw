# Trailer-dashcam VLM prompt.
# Loaded at runtime from /workspace/configs/video_event_analysis_prompt_redid.md.

Submission format for this scene:
- Exactly two JSON objects.
- Object 1: metadata summary.
- Object 2: event list payload.
- No text before, between, or after the two objects.

Observation setup:
- Rear-facing wide-angle camera on a towing vehicle.
- Trailer body and hitch occupy central frame; trailing traffic appears around the trailer silhouette.

Task:
Classify towing safety events and normal towing behavior over the segment.

Permitted event labels:
1. rear_collision
2. backing_contact
3. near_miss_following
4. near_miss_lane_change
5. obstacle_proximity
6. trailer_sway
7. hitch_issue
8. normal_towing
9. normal_backing

Metadata object contract:
- Must provide: version, video_id, format, rectified, scenario_info, scene_description, event_summary, fps, duration, height, width, camera_id
- scenario_info must be "TRAILER_DASHCAM"
- scene_description should mention trailer/hitch condition, roadway type, surroundings, weather, lighting, and whether motion is towing/backing/stationary
- event_summary should condense towing stability plus timestamped incidents

Event payload contract:
- Top level: version and events
- Event records must contain:
  - event_id
  - start_time
  - end_time
  - category (collision | near_miss | anomaly | normal_traffic)
  - sub_category (array)
  - instances (array)
  - event_caption

Category mapping for trailer footage:
- collision -> rear_collision, backing_contact
- near_miss -> near_miss_following, near_miss_lane_change, obstacle_proximity
- anomaly -> trailer_sway, hitch_issue
- normal_traffic -> normal_towing, normal_backing

Output correctness rules:
- sub_category must be an array, never a scalar
- event_caption includes severity (low/medium/high), involved actors, and time bounds
- Use tracker IDs when available, otherwise descriptive identities (following vehicle, cyclist, pedestrian, trailer)
- Use numeric seconds for timing

No-following-traffic case:
- If the rear scene is clear and towing remains stable, include metadata plus one normal_towing event.

Trailer-scene caveats:
- Wide-angle edge distortion alters apparent distance; evaluate sway using hitch-relative motion near frame center.
- The trailer occludes centerline view; side-channel visibility may be the only evidence of trailing vehicles.
- Vertical bounce on rough roads is expected; classify hitch_issue only when motion is excessive or coupling geometry shifts abnormally.
- Trailer angle changes during turns are normal; sway requires persistent lateral oscillation beyond steering dynamics.
- Backing clips naturally reduce clearance; call backing_contact only on contact, and obstacle_proximity on sub-meter near misses.
- Trailer shadows can mimic moving objects on pavement; verify motion source before labeling.

Required order: metadata object first, annotation object second.
