# Robot Assembly Dataset

## Scene description

A fixed close-up camera monitors an industrial robotic assembly cell. The frame is dominated by a robot arm with an end-effector approaching a blue tiled panel array (solar panels or similar modular components) mounted on a metal gantry/support structure. The gantry features grey steel vertical posts and horizontal crossbeams with mounting brackets, bolts, and cable runs. The camera captures the robot arm's workspace at close range, showing the arm joints, end-effector, panel tile surfaces, and structural hardware in detail. Industrial overhead lighting illuminates the cell.

## Augmentation variables

| Variable | Options | Default weights | Rationale |
|----------|---------|----------------|-----------|
| `lighting` | bright, moderate, dim | 0.35 / 0.35 / 0.30 | The only meaningful appearance axis for a controlled indoor assembly cell. Cosmos can vary the overall illumination intensity — bright (full overhead fixtures), moderate (balanced ambient), or dim (reduced lighting with task-light emphasis). No weather or time-of-day variables apply indoors with no exterior windows. |

## Tuning guide

See the shared parameter reference in [`../TUNING_GUIDE.md`](../TUNING_GUIDE.md).

Scene-specific notes:

- `lighting` is the only augmentation variable; scale `n_augmentations` up to
  recover diversity instead of adding unsupported scene variables.
- Keep `detection_and_tracking.classes` intentionally narrow (`person`) because
  robot components are not COCO-80 classes.
- Use higher `vlm_json.frame_fps` when validating fast arm motion anomalies.

## Key decisions & warnings

| Decision | Choice | Rationale | Risk if wrong |
|----------|--------|-----------|---------------|
| Augmentation variables | `lighting` (1 variable only) | Fully indoor controlled environment with no exterior windows. Lighting intensity is the only visual dimension Cosmos can meaningfully vary. Weather and time_of_day do not apply. | Single variable limits augmentation diversity. If more variety is needed, consider adding a second pass with different sigma values rather than a second variable. |
| Variable options & weights | lighting: bright 0.35 / moderate 0.35 / dim 0.30 | 3 distinct lighting levels. Source footage appears moderately lit, so even distribution. | Too many fine-grained options → model can't reliably distinguish them |
| Detection classes | `[person]` | Only COCO-80 class relevant for safety. The robot arm, solar panels, and gantry have no matching COCO-80 classes. Human zone intrusion is the critical safety event that detection can catch. | No tracking for the robot arm itself — all arm-related events rely entirely on VLM analysis. If no humans ever appear, the detector produces zero detections, which is expected. |
| `max_age` | 30 | Static close-up scene with no exit/re-entry pattern. If a person enters, they either stay visible or leave. | Too high would create ghost tracks from brief partial detections of the robot arm or its shadow |
| `frame_fps` / `sampling_fps` | 6 | Robot arms move quickly — an arm collision or malfunction can occur in under a second. 6 fps captures sufficient temporal detail. | Too low → a quick collision or jerk is missed between frames; too high → unnecessary token cost for idle periods |
| Event types | collision: arm_workpiece_contact, component_drop; near_miss: near_miss_arm, human_zone_intrusion; anomaly: arm_malfunction, misalignment; normal_traffic: normal_assembly, arm_idle | 8 sub-categories covering robotic assembly safety and operational events. | Missing event type → safety incidents go unlabeled; wrong category → MCQ and event JSON disagree |

**Scene-specific warnings:**
- **COCO-80 has no robot arm class**: The robot arm, end-effector, panels, and gantry are all invisible to the object detector. ALL assembly-related events (collisions, malfunctions, misalignments) depend entirely on VLM event analysis. Only human intrusion benefits from bounding-box detection.
- **Close-up framing**: The camera is very close to the workspace. This is unusual compared to typical surveillance setups. The VLM may describe the scene differently from wide-angle footage, and captions may focus heavily on mechanical detail rather than spatial layout.
- **Intended contact is the norm**: During normal assembly, the robot arm touches the panels and brackets intentionally. The VLM must distinguish intended assembly contact from unintended collisions — this is a subtle judgment that may produce false positives for arm_workpiece_contact.
- **Reflective panel surfaces**: The blue tiled panels are reflective and may create confusing mirror images of the robot arm. The VLM should not interpret reflections as additional objects or misalignment.
- **Single variable limits augmentation diversity**: With only `lighting` as a variable, the augmented dataset has lower visual diversity than outdoor scenes with 2 variables. Consider running more augmentations per video (`n_augmentations: 3–5`) to compensate.

## File inventory

Standard cookbook layout: see [`../FILE_INVENTORY.md`](../FILE_INVENTORY.md).

Robot-assembly specifics: single augmentation variable `lighting`;
`event_analysis.md` defines 8 event types across 4 categories; `question_bank.json`
holds 10 questions covering safety, lighting, and assembly status.
