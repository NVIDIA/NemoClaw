# Robot-assembly VLM event-analysis instructions.
# Consumed from /workspace/configs/video_event_analysis_prompt_redid.md.

Response protocol:
- Return exactly two JSON objects.
- JSON A = clip metadata only.
- JSON B = event annotations with an "events" list.
- Any extra narrative text breaks ingestion.

Operational context:
- Fixed close-range camera inside an industrial assembly cell.
- Primary actors: robot arm, end-effector, panel components, gantry hardware, occasional human intrusion.

Objective:
Label safety and operational anomalies for robotic assembly footage.

Accepted sub-categories:
- arm_workpiece_contact
- component_drop
- near_miss_arm
- human_zone_intrusion
- arm_malfunction
- misalignment
- normal_assembly
- arm_idle

Metadata JSON (object A) schema:
- Keys required: version, video_id, format, rectified, scenario_info, scene_description, event_summary, fps, duration, height, width, camera_id
- scenario_info value: "INDOOR_ROBOT_ASSEMBLY"
- scene_description should summarize arm/tool posture, panel/gantry geometry, lighting, visible assembly phase, and safety boundary context
- event_summary should state activity mode and notable timestamps

Event JSON (object B) schema:
- Object-level keys: version, events
- Each event requires:
  - event_id
  - start_time
  - end_time
  - category (collision | near_miss | anomaly | normal_traffic)
  - sub_category (list)
  - instances (list)
  - event_caption

Category mapping table:
- collision -> arm_workpiece_contact, component_drop
- near_miss -> near_miss_arm, human_zone_intrusion
- anomaly -> arm_malfunction, misalignment
- normal_traffic -> normal_assembly, arm_idle

Annotation quality rules:
- sub_category must always serialize as a list value
- event_caption includes severity (low/medium/high), actor/object references, and evidence window
- Prefer track IDs when available; otherwise use concrete labels (robot arm, end-effector, panel tile, gantry bracket, worker hand)
- Time values are numeric seconds

Idle-cell behavior:
- If the arm remains parked with no active cycle, keep metadata and include one arm_idle event.

Robot-cell caveats:
- Tight framing exaggerates apparent motion speed; do not overcall severity from image scale alone.
- Arm-to-part contact can be intentional during placement/fastening; classify collision only when contact is clearly unintended.
- Minor servo vibration is expected; malfunction requires persistent jitter, freeze, or trajectory deviation.
- Reflective panel surfaces can create ghost-arm reflections; verify real contact geometry before labeling.
- Cable flex during normal arm travel is expected; flag only when cable snag alters motion or dislodges parts.
- The full arm may be partially out of frame; infer cautiously from visible end-effector motion rather than hidden joints.

Emit object A first and object B second.
