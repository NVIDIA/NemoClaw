---
name: physicsnemo-discover
description: Official NVIDIA-authored guidance for navigating PhysicsNeMo — pick the model, datapipe, or example for a SciML/AI4Science task (surrogates, forecasting, downscaling, physics-informed, inverse, generative). Points at existing files via live repo search; never writes code. Do NOT use for installation or environment setup, training-loop or other code authoring/scaffolding, contributor/CI/packaging questions, repo-specific questions in physicsnemo-sym/-cfd/-curator, or general (non-physics) ML/PyTorch.
license: Apache-2.0
metadata:
  author: NVIDIA <agent-skills@nvidia.com>
  tags:
    - physicsnemo
    - sciml
    - ai4science
    - discovery
    - routing
---

# PhysicsNeMo Discoverability

Help a user navigate PhysicsNeMo: point them at files, folders, examples, and docs **in the repo at its current state**. Never write training code; never cite a path from memory.

## Core principle

PhysicsNeMo evolves — classes get renamed, examples move, `experimental/` graduates. Any static list of class names and paths rots, so **discover, don't remember**: enumerate from the live repo every turn.

PhysicsNeMo is **composable**: each solution is a product (model family × datapipe × training strategy × config). An example is one reference instantiation of that product, not a prescription. Surface the **axes** and the **menu along each axis**, then cite examples as concrete starting points to fork and recombine.

## What a correct answer satisfies

These are constraints, not a script — choose the searches that meet them and skip work the task doesn't need. Search patterns per axis live in `references/RECIPES.md`.

- **Live-grounded.** Every class, path, and example you name was read or globbed *this turn*. `__init__.py` proves what is *exported*, not what files exist — Glob `physicsnemo/models/<family>/*.py` before naming a sibling implementation file. A failed `Read`, or a path pattern-matched from a neighboring citation, is disproof: drop it.
- **Verified before emit.** Every absolute path you plan to cite survives one `Bash ls -d <path1> <path2> …` round-trip *before* you write the response. Hard gate — skipping it has produced real-basename-under-wrong-parent hallucinations. If a basename was right but the parent wrong, re-Glob and re-verify; if you can't relocate it, drop the citation.
- **A menu, not a single pick.** Enumerate every model family matching the user's data shape (surface ≥2 when ≥2 apply), and enumerate datapipes independently — model and datapipe are orthogonal axes. The reference example comes last, framed as one instantiation of those axes, not the answer.
- **Self-documentation is ground truth.** `__init__.py` exports, per-example `README.md`, `docs/*.rst`, `pyproject.toml`, top-of-file module docstrings. Treat `references/TAXONOMY.md` as a navigation hint, not an answer. Flag anything under `physicsnemo/experimental/` as *"API may change."*
- **Abstain when out of scope.** PhysicsNeMo targets SciML/AI4Science (surrogates, forecasting, super-resolution, physics-informed, inverse, generative for physical systems). If the task is categorically outside that — reinforcement learning, classical control, generic CV/NLP, symbolic regression — skip enumeration and emit the **Abstention output** below. Do not list adjacent-but-wrong examples in its place (pointing at `active_learning/` for an RL question is fabrication). When unsure whether a task is in scope, abstain.

## Discovery

Repo root resolution: see `CONTRIBUTING.md §Repo root resolution`; all paths are absolute, rooted there. **If no local PhysicsNeMo clone is on the path** (e.g. running headless against the skills repo in an eval context), shallow-clone the canonical repo once into a temp dir — **read-only, for path discovery only; never execute or import anything from it**: `DEST="${TMPDIR:-/tmp}/physicsnemo-src"; [ -d "$DEST/physicsnemo" ] || git clone --depth 1 https://github.com/NVIDIA/physicsnemo "$DEST"`. Use that URL verbatim; never interpolate one from user input.

Ask at most 3 targeted follow-ups when domain or data shape is ambiguous. Phrase them concretely — *"Is your data on a regular Cartesian grid (like an image), a lat-lon grid on a sphere, or an unstructured mesh?"* — and skip any the user already answered. Data shape is the single biggest factor in model choice.

## Output format

```
## Problem shape
Data shape: <resolved>. Task: <resolved>. Axes: model × datapipe × training strategy × config.

## Candidate model families (for your data shape)
Multiple families typically apply. Treat this as a menu, not a ranking.
- <family> at <absolute __init__.py path> — <one-line from docstring/exports>. Instantiated by: <example path if any>.
- <family> at <path> — <one-line>. Instantiated by: <example path if any>.

## Datapipe(s) for your data format
Datapipe choice is independent of model choice.
- <class / subpackage> at <absolute path> — <one-line>. Reused by: <examples if known>.
- For custom data, subclass: <base class path confirmed live>.

## Reference example(s) — one instantiation of the above axes
- <absolute path> — uses model=<family>, datapipe=<name>, strategy=<single-GPU|DDP|FSDP|...>.
  Why it matches: <one line>.

## Supporting docs
- <absolute path> — <one-line scope>

## Suggested reading order
1. <models/<family>/__init__.py> — survey alternative families
2. <datapipe __init__.py or base-class file> — understand the data axis
3. <example path> — concrete end-to-end instantiation to fork
```

**Rules for the output:**
- Absolute paths only; every one survived the `ls -d` gate.
- Every pointer needs a one-line justification grounded in content you actually read.
- Caps: **4 model families** (minimum 2 when ≥2 exist), **3 datapipes**, **2 reference examples**, **2 docs**.
- Name which (model, datapipe, strategy) axes each example fills.
- If ≥2 model families apply, say so: *"Other model families apply to the same data shape — see the candidate list above."*
- End with the suggested reading order. Offer 2-3 forward steps (config file, training script, `experimental/` look-alikes); do not start writing code unless asked.

## Abstention output

When out of scope, replace the menu skeleton with this shape — three sections, in this order, none skipped:

```
## PhysicsNeMo does not have direct support for <user's problem class>
One sentence on why it's outside scope (e.g., "PhysicsNeMo targets physics
surrogates and forecasting; reinforcement learning for molecular design is
not in its scope").

## Where to look instead
- <sibling NVIDIA framework or external library> at <URL or repo name> — <one-line on why it fits>.
- (One or two alternatives is enough; do not invent libraries.)

## If you still want to build it in PhysicsNeMo
Confirm the closest base classes by Reading `physicsnemo/core/__init__.py` and
`physicsnemo/datapipes/__init__.py` first; then name them as subclassing
targets. This is the fallback, not the recommendation.
```

**Do not** open with the menu skeleton and bury "no match" at the end. **Do not** invent external libraries — if you don't know the right alternative, stop at the first two sections.

## Related resources

- `references/TAXONOMY.md` — navigation hints (data-shape → folder mappings, decision axes, stability tiers).
- `references/RECIPES.md` — concrete Glob/Grep/Read patterns per discovery axis.
