# Trailer Dashcam Dataset

## Scene description

A rear-facing wide-angle (fisheye) dashcam is mounted on a vehicle towing an enclosed white box trailer. The trailer body with a spare tire on its rear dominates the upper and center portions of the frame, while the tow hitch and coupler mechanism are visible at the bottom center. The road recedes behind the trailer, with the surrounding suburban environment — residential houses, green lawns, trees, gravel driveways, fences — visible on both sides. The sky is visible above the trailer. This is a moving-camera scene: the background changes as the vehicle drives, turns, and backs up.

## Augmentation variables

| Variable | Options | Default weights | Rationale |
|----------|---------|----------------|-----------|
| `weather` | clear, overcast, rain | 0.35 / 0.35 / 0.30 | Outdoor road scene with sky visible above the trailer. Weather affects road surface reflectivity, visibility distance, and sky appearance. Rain is particularly safety-relevant for towing (wet roads increase sway risk). |
| `time_of_day` | morning, midday, evening | 0.35 / 0.35 / 0.30 | Natural lighting varies dramatically — low-angle morning/evening light creates long shadows and glare, midday gives harsh overhead light. All three are visually distinct in the dashcam perspective. |

## Tuning guide

See the shared parameter reference in [`../TUNING_GUIDE.md`](../TUNING_GUIDE.md).

Scene-specific notes:

- Tune `hallucination_check.threshold` upward when camera motion causes
  over-rejection in rear-facing driving footage.
- Keep `detection_and_tracking.max_age` high enough to bridge occlusions caused
  by the trailer body.
- Raise `vlm_json.frame_fps` when validating short sway or near-miss events.

## Key decisions & warnings

| Decision | Choice | Rationale | Risk if wrong |
|----------|--------|-----------|---------------|
| Augmentation variables | `weather`, `time_of_day` | Outdoor road scene with sky visible — weather and lighting are the dominant appearance axes. No traffic density (can't add/remove vehicles) or road surface variable (implied by weather). | Wrong variables → Cosmos generates unrealistic augmentations; MCQ verification questions won't match augmented content |
| Variable options & weights | weather: clear 0.35 / overcast 0.35 / rain 0.30; time_of_day: morning 0.35 / midday 0.35 / evening 0.30 | 3 visually distinct options per variable. No snow (source footage is green/summer). No night (rear dashcam at night would show mostly taillights/headlights with little scene context). | Too many fine-grained options → model can't reliably distinguish; skewed weights → underrepresented conditions |
| Detection classes | `[car, truck, person, bicycle, motorcycle]` | Road users visible behind and beside the trailer. The trailer itself may be detected as "truck" — that's acceptable for tracking its position. | Missing class → road users go untracked; the trailer being detected as "truck" may create a persistent large-area detection that interferes with tracking smaller objects behind it |
| `max_age` | 45 | Vehicles behind the trailer may be temporarily occluded by the trailer body and then re-appear on either side. 45 bridges typical occlusion gaps. | Too low → tracks fragment when vehicles pass behind the trailer; too high → ghost tracks from vehicles that have actually left the scene |
| `frame_fps` / `sampling_fps` | 6 | Vehicles at road speed; trailer sway can develop quickly. Higher fps catches rapid oscillation and close-following events. | Too low → brief sway episodes or fast-approaching vehicles missed between frames; too high → unnecessary token cost |
| Event types | collision: rear_collision, backing_contact; near_miss: near_miss_following, near_miss_lane_change, obstacle_proximity; anomaly: trailer_sway, hitch_issue; normal_traffic: normal_towing, normal_backing | 9 sub-categories covering towing-specific safety concerns. Sway and hitch issues are unique to towing scenarios. | Missing event type → safety incidents go unlabeled; wrong category → MCQ and event JSON disagree |

**Scene-specific warnings:**
- **Moving camera**: Unlike fixed surveillance cameras, this dashcam moves with the vehicle. The entire background shifts continuously, which may affect Augmentation quality and hallucination detection. Consider raising `hallucination_check.threshold` to 0.75 if too many frames are rejected due to background motion.
- **Fisheye distortion**: The wide-angle lens introduces significant barrel distortion at frame edges. Object detections near the periphery may have distorted bounding boxes, potentially degrading tracking accuracy.
- **Trailer dominates the frame**: The trailer body occupies 30–50% of every frame. The detector will likely track it as a persistent "truck" object. This is not harmful but means the largest tracked object is always the trailer itself, not a safety-relevant road user.
- **No night augmentation**: The source footage is clearly daytime. Night rear-dashcam footage would show primarily taillights and headlight glare — very different visual characteristics that can't be generated convincingly from daytime source.

## File inventory

Standard cookbook layout: see [`../FILE_INVENTORY.md`](../FILE_INVENTORY.md).

Trailer-dashcam specifics: augmentation variables `weather` + `time_of_day`;
`event_analysis.md` defines 9 event types across 4 categories; `question_bank.json`
holds 11 questions covering safety, weather, and towing status.
