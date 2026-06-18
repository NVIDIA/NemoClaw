# Piazza Dataset

## Scene description

An elevated surveillance camera (approximately 2–3 storeys up) looks down at an outdoor European cobblestone piazza. The scene features a large white canopy/awning sheltering outdoor café tables and chairs where patrons dine, several parked motorcycles and scooters at the edge of the square, pedestrians crossing the open cobblestone space, and historic stone building facades with arched windows, columns, and ornamental details framing the piazza on multiple sides. The camera captures the full breadth of the square from an angled overhead perspective.

## Augmentation variables

| Variable | Options | Default weights | Rationale |
|----------|---------|----------------|-----------|
| `weather` | clear, overcast, rain | 0.35 / 0.35 / 0.30 | Outdoor piazza with exposed cobblestones — weather changes surface reflectivity and sky appearance. No snow (Mediterranean climate). Rain kept separate from a surface variable because wet cobblestones are implied by rain (avoids cross-variable contradiction). |
| `time_of_day` | morning, midday, evening | 0.35 / 0.35 / 0.30 | Strong directional lighting in the piazza produces visually distinct shadow patterns at different times. Three options chosen for clear visual separation. Night omitted because the source footage is clearly daytime and the piazza may not have sufficient artificial lighting for realistic night augmentation. |

## Tuning guide

See the shared parameter reference in [`../TUNING_GUIDE.md`](../TUNING_GUIDE.md).

Scene-specific notes:

- Keep `detection_and_tracking.classes` focused on `person` and `motorcycle`
  to reduce false positives in dining areas.
- Start with lower `vlm_json.frame_fps` for slow pedestrian flows, then raise if
  near-miss timing is under-captured.
- Consider raising `detection_and_tracking.max_age` when canopy occlusion causes
  frequent short track drops.

## Key decisions & warnings

| Decision | Choice | Rationale | Risk if wrong |
|----------|--------|-----------|---------------|
| Augmentation variables | `weather`, `time_of_day` | Only 2 variables because Cosmos cannot change object presence/density, and cobblestone surface condition is implied by weather (no separate surface variable). | Wrong variables → Cosmos generates unrealistic or indistinguishable augmentations; MCQ verification questions won't match augmented content |
| Variable options & weights | weather: clear 0.35 / overcast 0.35 / rain 0.30; time_of_day: morning 0.35 / midday 0.35 / evening 0.30 | 3 visually distinct options per variable. Even weights to start; no snow (Mediterranean scene) and no night (no artificial lighting data to anchor realistic night generation). | Too many fine-grained options → model can't reliably distinguish them; skewed weights → underrepresented conditions in training data |
| Detection classes | `[person, motorcycle]` | COCO-80 classes matching the visible subjects: pedestrians/diners and motorcycles/scooters. No cars, trucks, or bicycles visible in the piazza. | Missing class → objects go untracked; extra class → false-positive detections add noise. If scooters are misclassified by the detector, some motorcycle tracks may be missed. |
| `max_age` | 30 | Relatively static scene — pedestrians walk through but don't exit and re-enter like vehicles at intersections. Lower max_age avoids ghost tracks. | Too low → tracks fragment when pedestrians walk behind the canopy or parked motorcycles; too high → ghost tracks persist after pedestrians leave the frame |
| `frame_fps` / `sampling_fps` | 3 | Slow-moving pedestrians and parked motorcycles. Higher fps would waste tokens without catching additional events. | Too low → a fast-moving scooter could arrive and depart between frames, missing a near-miss event; too high → unnecessary token cost |
| Event types | collision: motorcycle_pedestrian_contact, pedestrian_collision; near_miss: near_miss_motorcycle, pedestrian_close_call; anomaly: erratic_motorcycle, pathway_obstruction; normal_traffic: pedestrian_flow, outdoor_dining, motorcycle_parking | 9 event sub-categories across 4 fixed categories covering the main piazza interactions. | Missing event type → safety incidents go unlabeled; wrong category mapping → MCQ questions and event JSON disagree |

**Scene-specific warnings:**
- **Canopy occlusion**: The large white canopy hides ~30–40% of diners and some pedestrian paths from the camera. Detections will be lost when subjects move under the canopy, causing track fragmentation. Consider raising `max_age` to 45 if this is severe.
- **COCO-80 has no scooter class**: Using `motorcycle` as a proxy. Small mopeds or electric scooters may not be detected reliably if they differ significantly from training data motorcycles.
- **No night augmentation**: The source footage is clearly daytime with no visible artificial lighting infrastructure. Generating night variants without anchor data could produce unrealistic results.

## File inventory

Standard cookbook layout: see [`../FILE_INVENTORY.md`](../FILE_INVENTORY.md).

Piazza specifics: augmentation variables `weather` + `time_of_day`;
`event_analysis.md` defines 9 event types across 4 categories; `question_bank.json`
holds 11 questions covering safety, weather, and pedestrian activity.
