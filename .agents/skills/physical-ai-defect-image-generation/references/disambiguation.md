# Disambiguation cheat sheet

Full trigger table, prompt-construction guidance, and "when NOT to ask"
exceptions. SKILL.md §Disambiguation holds the principle and silent-defaults
list; this file is what the agent loads to assemble the `AskUserQuestion`
options on a vague request.

## Triggers that should pause for disambiguation

| User says (example) | Why it's ambiguous | Surface as options |
|---|---|---|
| Any submit / upload / preflight request where the user has **not yet named a `dig_url_root`** (and memory has no prior `dig_url_root` reference) | ~80 GB+ of artifacts land under this prefix and the wrong bucket is expensive to undo. There is **no silent default** — agents must NOT auto-pick `s3://osmo-workflows/dig` even though it appears as a suggestion. | "(a) `s3://osmo-workflows/dig` (the common shared default — confirm only if you own/control this bucket), (b) a different storage prefix you own — any OSMO-supported backend (paste the URL), (c) cancel — you don't have a target bucket ready yet." Save the picked value as a reference memory (see Step 0 §4) immediately after the first successful submit. |
| "generate me N images" / "give me N samples" | `N` could mean upstream patches (`render_patches`) or final crops (`crop_max_emit`); the flow could be Day 0 texture, good-image, or structural. **For structural, there is no `crop_max_emit` knob** — yield is non-linear in `render_patches` (see SKILL.md §"Structural-defect sizing"). | "(a) N final component crops via `crop_max_emit=N` (Day 0 good-image, fastest), (b) N raw scan-grid patches via `render_patches=N` (cookbook crop cap applies; more total final images), (c) N **defect** images via Day 0 texture defects (requires `anomaly_types_json`), (d) N structural-defect crops via `render_patches=ceil(N/30)` on the spark board (also narrow `defect_modes` if N < 30)." |
| "run the PCBA flow" / "do the PCBA pipeline" | Could be Day 0 texture, Day 0 good-image, Day 0 structural, or Day 1 real-alignment — all are PCBA. | "(a) Day 0 texture defects (full pipeline, AMP-routed defects), (b) Day 0 good-image (clean ROIs only), (c) Day 0 structural defects (pose perturbations via IsaacSim), (d) Day 1 inference + labeling on a real PCBA photo." |
| "give me defects" / "generate defects" | Texture (Qwen Image-Edit + AnomalyGen AMP) vs. structural (IsaacSim pose perturbation) vs. missing-component (AnomalyGen native) are entirely different flows. | "(a) texture defects (solder bridge, scratch, discoloration — Day 0 texture), (b) structural / pose defects (tombstone, shift, sideflip — Day 0 structural), (c) missing components (Day 0 texture handles it via AnomalyGen, NOT structural)." |
| "smoke test" / "quick run" / "just test it" | Could mean a 5-image probe, a single-checkpoint passthrough probe, or a setup probe. | "(a) tiny probe (`render_patches=5 crop_max_emit=1`, ~5 final images), (b) full passthrough at the shipped checkpoint (default sizes, ~30 min), (c) setup-only run (the relevant `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml` to populate the DIG root)." |
| "use my data" / "I have a dataset" | Could be a flat user upload (manual-ROI Mode B), a prepared NGC artifact (manual-ROI Mode A), or a real PCBA photo (real-alignment input). | "(a) clean images + per-defect submasks in canonical layout (Day 1 manual ROI Mode A), (b) flat zip / unstructured (Day 1 manual ROI Mode B — staged at runtime), (c) a real PCBA photo of a known board (Day 1 real-photo alignment)." |
| "finetune" / "train a model" | Could be standalone `finetune.yaml` (from labeled URL), Day 0/1 finetune-from-scratch (`use_pretrained_checkpoint=false`), or a custom checkpoint produced by `finetune.yaml` and reused. | "(a) Finetune Only (`finetune.yaml`) on `datasets/<usecase>/raw`, (b) Day 0 or Day 1 with `use_pretrained_checkpoint=false` (inline finetune then infer), (c) reuse an already-trained checkpoint under `<dig_url_root>/models/<usecase>`." |
| "metal" or "glass" (no further context) | Both only have a Day 1 path (no USD/real-alignment exists), so the route is forced — but the user may not know that. | Confirm: "Day 1 inference + labeling on the prepared `<usecase>/raw` dataset is the only flow for this material — proceed?" (Don't ask "manual or real-alignment?" — manual is the only option here.) |
| "use a different board" / "try board X" | Board switch needs both `--set board=` AND `--set real_image_filename=`, and a per-board cookbook must exist. | List the shipped boards (`0603_H100`, `1152819000`) and ask: "(a) `0603_H100` (default), (b) `1152819000`, (c) a new custom board (requires adding `assets/cookbooks/pcb/<board>/usd2roi_nvpcb.yaml` + uploading the photo to `datasets/pcb/assets/input_real_image/<board>.jpg` first)." Board names must be Jinja-safe — see `references/setup.md` §"Bring your own data". |

## How to surface options

- **Prefer `AskUserQuestion`** with 2–4 mutually exclusive options. Lead with the recommended option (label suffix "(Recommended)") when there's a clear default.
- **Quote the user's exact phrasing** in the question so they know what triggered it ("You said 'generate me 10 images' — which stage should the 10 cap?").
- **Show the resulting `--set` differences** in option descriptions — users learn the knob semantics from seeing concrete contrasts (e.g. `crop_max_emit=10` vs. `render_patches=10`).
- **Do not chain disambiguation prompts.** Bundle related questions into one `AskUserQuestion` call (max 4 questions). If two choices are tightly coupled (e.g. board + real photo), gate them behind a single combined option.

## When NOT to disambiguate

- The user has already named the flow / usecase / knob explicitly. Trust them.
- The choice is silent-default territory (PCBA Day 1 → real-alignment, board → `0603_H100`, image-edit endpoint deployment, etc. — see SKILL.md §Disambiguation silent-defaults paragraph). Don't second-guess defaults that were settled at the workflow level.
- The user has answered the same disambiguation in this same conversation already — re-asking is friction.
- Only one of the candidate options is actually viable (e.g. user says "infer on metal" — manual-ROI is the only flow; just say "going with Day 1 manual-ROI, the only flow available for metal" and proceed).
