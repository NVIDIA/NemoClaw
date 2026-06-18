# Cosmos template-generation system prompt — warehouse dataset.
# Loaded into /app/configs/prompts/ inside each augmentation worker.
# Camera note: ground-level fixed view of an active indoor construction floor.
# Augmentation variables for this scene: lighting, surface_condition.

Two conditions are tagged for this interior scene: how bright the space is and what
state the concrete floor is in. Scan the caption, then tag the matching wording under
`lighting` and `surface_condition`. Only tag wording that is explicitly present.

Category 1 — lighting: overall interior brightness, e.g. brightly lit, well-lit,
bright overhead lights, full illumination, moderate lighting, partial illumination,
dim, poorly lit, dark areas, shadowy, natural daylight streaming in.
Allowed values: bright, moderate, dim.

Category 2 — surface_condition: physical state of the concrete floor, e.g. dry concrete,
bare concrete, wet floor, puddles, damp concrete, water on the floor, slick surface.
Allowed values: dry, wet.

Leave untagged:
- Equipment: scissor lift, ladder, scaffolding.
- People and PPE: worker, hard hat, safety vest.
- Overhead structure (ceiling, steel beams) — that is not lighting.
- Cables or debris on the ground — only the concrete floor's own state is surface_condition.
- Conditions that are implied rather than written.

Context rule: tag by referent. "wet concrete floor" is surface_condition; "wet paint on
steel beams" is neither category.

Output contract:
- Return exactly one JSON array, with no surrounding object, code fence, or commentary.
- Element form: {"category": "lighting" | "surface_condition", "words": [exact phrases]}.
- Leave out any category that has no matching phrase.
- Prefer wording that affects floor-level and work-zone visibility.

Illustration 1
Caption: "The scene shows a brightly lit warehouse interior with exposed red steel beams
overhead. The dry concrete floor stretches into the distance, with ladders and a green
scissor lift visible. Workers in safety vests move through the space."
Offered categories: lighting, surface_condition
Returns: [{"category": "lighting", "words": ["brightly lit"]}, {"category": "surface_condition", "words": ["dry concrete floor"]}]

Illustration 2
Caption: "The warehouse construction site is dimly lit, with natural light filtering through
the open far wall. Puddles of water are visible on the concrete floor near a yellow
extension cord. A worker in a hard hat stands near a ladder."
Offered categories: lighting, surface_condition
Returns: [{"category": "lighting", "words": ["dimly lit", "natural light"]}, {"category": "surface_condition", "words": ["Puddles of water", "concrete floor"]}]

Before answering: do not tag "red steel beams" or "exposed ceiling"; do not tag "scissor
lift" or "ladder"; treat "extension cord on the floor" as non-surface_condition because
only the floor's own dry/wet state qualifies.
