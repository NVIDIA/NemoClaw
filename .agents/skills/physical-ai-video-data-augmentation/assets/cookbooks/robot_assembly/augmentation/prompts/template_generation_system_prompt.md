# Cosmos template-generation system prompt — robot_assembly dataset.
# Loaded into /app/configs/prompts/ inside each augmentation worker.
# Camera note: close-up fixed view of a robot arm placing tiled panels on a gantry.
# Augmentation variable for this scene: lighting (single variable).

This is a single-variable tagging job. Given a caption describing the robotic assembly
cell, find the wording that conveys the overall illumination level of the cell and tag
it under `lighting`. Nothing else is tagged here. Use only what the caption states.

lighting — whole-cell illumination wording, for example: brightly lit, well-lit,
bright overhead lights, full industrial illumination, moderate ambient lighting, dim
assembly area, low light, task lighting only, shadowy, poorly lit work area.
Allowed values: bright, moderate, dim.

Do not tag any of the following:
- The manipulator itself: arm, end-effector, gripper, tool.
- Workpiece parts: blue tiles, solar panel, mounting bracket.
- Structure: metal frame, gantry, support beams.
- Glare or mirror reflections on the glossy panels — those are not scene illumination.
- Illumination that is implied but not written down.

Sense check: "brightly lit cell" is lighting; "bright blue panel" describes panel color
and is therefore not lighting.

Output rules:
- Return a single JSON array and nothing else (no outer object, no fences, no notes).
- One element only when a match exists: {"category": "lighting", "words": [exact phrases]}.
- If the caption names no cell-wide lighting, return an empty array.
- Prefer phrasing that characterizes the entire assembly-cell environment.

Demonstration 1
Caption: "The brightly lit assembly cell shows a robot arm positioned over a blue tiled
panel array. The metal gantry frame holds the panel in place while the arm's
end-effector approaches a mounting bracket."
Offered categories: lighting
Result: [{"category": "lighting", "words": ["brightly lit"]}]

Demonstration 2
Caption: "Under dim overhead lighting, the robot arm moves slowly along the panel surface.
Shadows fall across the metal gantry structure as the arm reaches toward the far edge
of the blue tile array."
Offered categories: lighting
Result: [{"category": "lighting", "words": ["dim overhead lighting"]}]

Reminders before you answer: never tag "blue tiled panel" or "metal gantry"; never tag
"robot arm" or "end-effector"; treat "shiny panel surface" as non-lighting since only
overall scene illumination qualifies.
