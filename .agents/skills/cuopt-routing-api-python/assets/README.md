# Assets — reference routing models

Routing reference implementations (Python). Use as reference when building new applications; do not edit in place.

| Model | Type | Description |
|-------|------|-------------|
| [vrp_basic](vrp_basic/) | VRP | Minimal VRP: 4 locations, 1 vehicle, 3 orders |
| [pdp_basic](pdp_basic/) | PDP | Pickup-delivery pairs, capacity dimension |

**Run:** From each subdir, `python model.py` (requires cuOpt and cudf). See [references/examples.md](../references/examples.md) for more patterns (time windows, multi-depot).
