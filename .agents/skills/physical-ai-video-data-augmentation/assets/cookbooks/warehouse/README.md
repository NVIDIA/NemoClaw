# Warehouse Dataset

## Scene description

A fixed ground-level surveillance camera looks down the length of an active indoor warehouse construction site. The scene features an exposed red-painted steel beam ceiling with hanging cables and electrical conduits, a bare concrete floor, red steel columns at regular intervals, multiple orange A-frame ladders, a green electric scissor lift, construction materials and debris scattered on the floor, and workers wearing hard hats and high-visibility safety vests. Natural daylight enters through large open walls on the far side of the building, creating a mixed-lighting environment with bright areas near the openings and dimmer zones between columns.

## Augmentation variables

| Variable | Options | Default weights | Rationale |
|----------|---------|----------------|-----------|
| `lighting` | bright, moderate, dim | 0.35 / 0.35 / 0.30 | Indoor scene with mixed light sources (artificial overhead + natural from open walls). Cosmos can vary the overall illumination intensity, producing visually distinct bright, moderate, and dim appearances. |
| `surface_condition` | dry, wet | 0.55 / 0.45 | Bare concrete floor state — dry (matte, dusty) vs. wet (reflective, puddles). Construction sites can have wet floors from cleaning, spills, or rain through open sides. Only 2 options to keep them clearly distinguishable. |

## Tuning guide

See the shared parameter reference in [`../TUNING_GUIDE.md`](../TUNING_GUIDE.md).

Scene-specific notes:

- Prefer conservative `detection_and_tracking.threshold` tuning to balance worker
  recall in mixed bright/dim lighting.
- Keep `detection_and_tracking.classes` minimal because most safety hazards are
  equipment- and environment-driven rather than class-heavy.
- Adjust `vlm_json.frame_fps` only as needed; many warehouse events evolve over
  longer windows than road traffic.

## Key decisions & warnings

| Decision | Choice | Rationale | Risk if wrong |
|----------|--------|-----------|---------------|
| Augmentation variables | `lighting`, `surface_condition` | Indoor scene — weather/time_of_day don't apply directly. Lighting intensity and floor wetness are the main appearance axes Cosmos can vary. | Wrong variables → Cosmos generates unrealistic augmentations (e.g., outdoor weather in an indoor scene); MCQ verification questions won't match |
| Variable options & weights | lighting: bright 0.35 / moderate 0.35 / dim 0.30; surface_condition: dry 0.55 / wet 0.45 | 3 lighting levels for clear visual separation. 2 surface states (dry/wet) — more options (dusty, oily) would be too subtle to distinguish. Dry slightly favored since most construction footage is dry floor. | Too many fine-grained options → model can't reliably distinguish; skewed weights → underrepresented conditions |
| Detection classes | `[person]` | Only COCO-80 class reliably matching the scene subjects. Workers are the primary safety concern. | No tracking for equipment (scissor lifts, ladders) — events involving equipment can only be detected via VLM event analysis, not bounding-box tracking |
| `max_age` | 45 | Workers frequently walk behind columns and large equipment, causing temporary occlusion. Higher than a fully open floor (30) but lower than an intersection (60). | Too low → tracks fragment when workers go behind columns/equipment; too high → ghost tracks persist |
| `frame_fps` / `sampling_fps` | 3 | Workers and equipment move slowly. Falls and contact events develop over multiple seconds. 3 fps captures sufficient temporal detail. | Too low → a quick trip-and-fall might occur between sampled frames; too high → unnecessary token cost |
| Event types | collision: worker_equipment_contact, worker_fall; near_miss: near_miss_equipment, near_miss_falling_object; anomaly: unsafe_ladder_use, cable_trip_hazard; normal_traffic: normal_construction, equipment_operation, worker_transit | 9 sub-categories covering construction safety interactions. Ladder safety and cable hazards are prominent given the scene. | Missing event type → safety incidents go unlabeled; wrong category mapping → MCQ and event JSON disagree |

**Scene-specific warnings:**
- **COCO-80 has no construction equipment classes**: Scissor lifts, ladders, scaffolding, and hoists are invisible to the object detector. All equipment-related safety events rely entirely on VLM event analysis, not tracked bounding boxes. If VLM misses an event, there is no fallback.
- **Column occlusion**: Red steel columns at regular intervals create blind spots. Workers may be obscured for 1–3 seconds while passing behind a column. `max_age: 45` should bridge most gaps, but closely-spaced workers may get their tracks swapped.
- **Cables on floor**: Yellow extension cords are everywhere in the scene. The VLM must distinguish between cables in active walkways (hazard) vs. cables in non-traffic areas (normal). This is a nuanced judgment that may produce false positives.
- **Mixed lighting complicates detection**: Workers in dim areas between columns may be harder to detect. Consider raising `detection_and_tracking.threshold` to 0.15 if too many false positives appear in bright areas, or lowering to 0.1 if workers in dim areas are missed.

## File inventory

Standard cookbook layout: see [`../FILE_INVENTORY.md`](../FILE_INVENTORY.md).

Warehouse specifics: augmentation variables `lighting` + `surface_condition`;
`event_analysis.md` defines 9 event types across 4 categories; `question_bank.json`
holds 11 questions covering safety, lighting, and site activity.
