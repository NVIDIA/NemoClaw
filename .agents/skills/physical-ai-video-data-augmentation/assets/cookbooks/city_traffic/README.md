# City Traffic Dataset

## Scene description

A fixed elevated surveillance camera (approximately 3–4 storeys up) looks down at a large multi-lane urban intersection. The intersection features multiple approach lanes with painted directional arrows (straight, left-turn, right-turn), dashed lane dividers, crosswalk stripes on multiple sides, and road text markings. Traffic signals control the flow from all approach directions. An elevated highway overpass structure runs along one side of the intersection. Mixed traffic includes cars, motorcycles/scooters, trucks, and buses navigating turns and through-traffic. Parked vehicles line the roadside, and a green-belted area with trees borders parts of the intersection.

## Augmentation variables

| Variable | Options | Default weights | Rationale |
|----------|---------|----------------|-----------|
| `weather` | clear, overcast, rain | 0.35 / 0.35 / 0.30 | Outdoor intersection with sky visible. Weather changes road reflectivity (critical for lane marking visibility), sky appearance, and overall scene contrast. Rain is safety-relevant (wet roads affect braking distance). |
| `time_of_day` | morning, midday, evening | 0.35 / 0.35 / 0.30 | The open intersection has strong directional lighting effects. Morning/evening produce long shadows from the overpass and signal poles; midday has harsh overhead light. All three are visually distinct. |

## Tuning guide

See the shared parameter reference in [`../TUNING_GUIDE.md`](../TUNING_GUIDE.md).

Scene-specific notes:

- Prioritize `rain` and `evening` weights when source clips are dominated by
  bright daytime traffic.
- Keep `detection_and_tracking.classes` aligned to road users
  (`car`, `truck`, `bus`, `motorcycle`, `bicycle`, `person`) to avoid clutter.
- Raise `vlm_json.frame_fps` when validating short events like red-light
  violations and abrupt braking at intersections.

## Key decisions & warnings

| Decision | Choice | Rationale | Risk if wrong |
|----------|--------|-----------|---------------|
| Augmentation variables | `weather`, `time_of_day` | Outdoor intersection with sky visible — standard outdoor appearance axes. No traffic density (Cosmos can't add/remove vehicles) or road surface variable (implied by weather to avoid contradiction). | Wrong variables → Cosmos generates unrealistic augmentations; MCQ verification questions won't match augmented content |
| Variable options & weights | weather: clear 0.35 / overcast 0.35 / rain 0.30; time_of_day: morning 0.35 / midday 0.35 / evening 0.30 | 3 visually distinct options per variable. Even weights to start. No snow (tropical/subtropical setting based on vegetation). No night (source is daytime; night intersection looks very different with only headlights and signal glow). | Too many fine-grained options → model can't reliably distinguish; skewed weights → underrepresented conditions |
| Detection classes | `[car, truck, bus, motorcycle, bicycle, person]` | Full set of COCO-80 road user classes. Cars are dominant; motorcycles/scooters are prominent in this intersection. Pedestrians appear at crosswalks. | Missing class → road users go untracked; extra class → false-positive detections. Scooters may be classified as motorcycle or bicycle inconsistently. |
| `max_age` | 60 | Vehicles exit the frame during turns and may re-enter from another direction. High max_age bridges these gaps at a large intersection. | Too low → tracks fragment during turns; too high → ghost tracks persist from vehicles that have left the scene entirely |
| `frame_fps` / `sampling_fps` | 6 | Vehicles move at urban speeds through the intersection. 6 fps catches rapid events (T-bone collisions, red-light violations) that occur in 1–2 seconds. | Too low → brief collision or violation events missed between frames; too high → unnecessary token cost |
| Event types | collision: vehicle_collision, vehicle_pedestrian_contact; near_miss: near_miss_vehicles, abrupt_braking, jaywalking_pedestrian; anomaly: red_light_violation, illegal_turn; normal_traffic: through_traffic, turning_traffic, pedestrian_crossing | 10 sub-categories covering intersection-specific safety concerns. Red-light violations and illegal turns are key intersection events not present in straight-road configs. | Missing event type → safety incidents go unlabeled; wrong category → MCQ and event JSON disagree |

**Scene-specific warnings:**
- **Overpass shadow**: The elevated highway casts a large shadow across part of the intersection. This may reduce detection accuracy for vehicles entering the shadow zone and may confuse the VLM's lighting assessment.
- **Signal state not always visible**: The camera angle may not show signal faces directly. The VLM must infer red-light violations from traffic flow patterns, which adds uncertainty. False positives for red_light_violation are likely.
- **Motorcycle/scooter filtering**: Motorcycles commonly filter between stopped cars at this intersection. The VLM should distinguish normal low-speed filtering from dangerous high-speed passing.
- **Large intersection = long crossing times**: Vehicles legitimately spend 5–10 seconds inside the intersection during turns. The VLM should not flag normal long turns as anomalies.

## File inventory

Standard cookbook layout: see [`../FILE_INVENTORY.md`](../FILE_INVENTORY.md).

City-traffic specifics: augmentation variables `weather` + `time_of_day`;
`event_analysis.md` defines 10 event types across 4 categories; `question_bank.json`
holds 11 questions covering safety, weather, and traffic flow.
