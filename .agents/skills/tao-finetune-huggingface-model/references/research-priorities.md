<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Research Priorities Reference

The live-fetch ladder for Step 3 (Research). Walk priorities in order, stop once
you have enough to write the code. The ordering is deliberate: API-fresh sources
come first (they track current `transformers`); method-specific sources fill in
task-specific details.

---

## Priority ladder

### Priority 1 — Model card usage example *(always fetch)*

- Source: `https://huggingface.co/<model_id>/raw/main/README.md`
- Extract: the card's literal `from transformers import X, Y` block. This is the
  authoritative API surface for this model — the exact `AutoModel`/`AutoProcessor`
  class names, `trust_remote_code`, `torch_dtype`, `_attn_implementation`,
  `quantization_config` requirements.

### Priority 2 — HF repo example script for the task

- Source (CV / standard tasks):
  `https://raw.githubusercontent.com/huggingface/transformers/main/examples/pytorch/<task>/run_<task>.py`
  where `<task>` is one of `image-classification`, `object-detection`,
  `semantic-segmentation`, `instance-segmentation`, `contrastive-image-text`.
- Extract: current-API training loop, argument parsing, collator choice,
  transforms, `compute_metrics`. CI-tested against current `transformers` —
  freshest API patterns available.
- If no matching HF repo script exists for your task (e.g., VLM finetune, depth
  estimation), skip to Priority 3.

### Priority 3 — Author finetune script / notebook linked from the model card

- For `https://github.com/<owner>/<repo>/blob/<ref>/<path>`, rewrite to
  `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` and `WebFetch`.
  Notebooks (`.ipynb`) are JSON — parse and extract code cells.
- Extract: method-specific recipe the HF repo script doesn't cover — custom
  collator, LoRA target modules, loss-masking scheme, learning rate / warmup /
  weight decay, dataset-specific preprocessing.
- Likely older API than Priority 2. If conflicts: Priority 2 for API calls,
  Priority 3 for method details.

### Priority 4 — HF task documentation *(always fetch as cross-check)*

- Source:
  `https://raw.githubusercontent.com/huggingface/transformers/main/docs/source/en/tasks/<task>.md`
  (snake_case — `image_classification`, `object_detection`, `semantic_segmentation`,
  `monocular_depth_estimation`, `image_text_to_text`). The rendered page at
  `huggingface.co/docs/transformers/tasks/<task>` works too but raw markdown is
  cleaner to parse.
- Extract: conceptual explanation of the task, gotchas (e.g.
  `remove_unused_columns=False`), augmentation guidance.
- Lower priority than repo scripts because it often *refers to* them; use it for
  *why*, use the repo script for *how*.

### Priority 5 — Paper methodology *(only if hyperparameters still unclear)*

- Source: `https://huggingface.co/papers/<arxiv_id>` (links datasets, models,
  citations); full text at `https://arxiv.org/abs/<arxiv_id>`.
- Extract: reported learning rate, batch size, training budget, augmentation
  recipe.

### Priority 6 — GitHub search fallback *(last resort)*

Only if no card example, no HF repo script, no author link, no paper exists.

```
WebSearch "site:github.com huggingface <model_type> fine-tune train.py"
```

then `WebFetch` the top result's raw URL. Quality varies; cross-check anything
you extract.

---

## Extract and record

From what you fetched, record in `meta/recipe.md` (and as a comment block at the
top of `train.py`):

- `AutoModel` / processor / image-processor classes
- Collator class and its constructor args
- Preprocessing transforms (train + eval, separately)
- `compute_metrics` implementation
- Model loading kwargs (`torch_dtype`, `attn_implementation`,
  `trust_remote_code`, `id2label`, `ignore_mismatched_sizes`,
  `quantization_config`)
- Training hyperparameter hints (LR, batch size, epochs, scheduler, weight decay)
- Each source URL you actually used — also into `config.yaml` under
  `research_sources:`.

If a section has no live finding, fall back to the matching scaffold reference
(`references/cv-scripts.md` or `references/vlm-scripts.md`) — but log
"fallback to scaffold — no live source for <section>" in `config.yaml` under
`notes:`.

---

## Resolving source conflicts

- **API calls** (imports, class names, argument shapes): prefer higher priority
  (model card > HF repo script > author script > docs > paper). Newer sources
  track the installed `transformers` version.
- **Method details** (collator logic, LoRA targets, loss masking, augmentation):
  prefer the author script over the HF repo script — the author knows the
  model's quirks. If only the HF repo script covers the task, use it.
- Note any discrepancy in a comment next to the affected code with the source
  URL.

---

## Stop criteria

Stop fetching when you have, for the detected task:

| Component | Source priority |
|---|---|
| `AutoModel` / processor class | Priority 1 |
| Train + eval transforms | Priority 2 or 3 |
| Collator | Priority 2 or 3 |
| `compute_metrics` | Priority 2 or 3 or 4 |
| Hyperparameter hints | model card body, Priority 3, or Priority 5 |

If any row is missing after the ladder, fall back to the scaffold reference
(`cv-scripts.md` / `vlm-scripts.md`) and log the gap.
