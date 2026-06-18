# Pitfalls and Quality Checks

These apply to both AutoML phases. Bake them into agent behavior — don't just paste once.

## Metric pitfalls — AOI is class-imbalanced

ChangeNet AOI datasets are typically PASS-dominant (90%+ PASS rate). `val_loss` (cross-entropy) on imbalanced data has a well-known failure mode: the model can minimize CE by confidently predicting PASS for everything, achieving very low val_loss while having zero recall on defects. The val_loss winner of an AutoML sweep can be a mode-collapsed model.

For AOI, prefer:

- **FAR @ 100%-recall** as the AutoML metric directly (matches the deployment KPI; never collapses)
- Or run val_loss with a **`pred_counts` sanity check**: discard any rec whose predictions collapse to one class
- Or eval all top-K configs by FAR @ 100%-recall on the held-out set before picking — val_loss is the sort key, FAR @ 100%-recall is the decision rule

For balanced datasets and regression tasks (non-AOI DEFT applications), val_loss is fine.

## Run-to-run noise

AutoML can show 2–3× variance in metric for the same HP config across runs (seeds, dataloader shuffles). If the AutoML winner is suspiciously better than the runner-up, re-run with a fresh seed and confirm the metric holds before committing the spec to Phase 2.

## Cleanliness (data leakage)

Both AutoML phases must use a validation set distinct from the KPI test set (`<workspace>/kpi/testing_set.csv`). The KPI test set is reserved for DEFT's final reporting — touching it during AutoML biases the final number upward. The standard split: `train/base/training_set.csv` for AutoML training, `train/base/validation_set.csv` for AutoML val, `kpi/testing_set.csv` left alone until DEFT's evaluate stage.

Phase 3's train_dataset is the DEFT-augmented CSV, which contains synthetic + mined real samples beyond the base training set. The validation set stays the same — that keeps Phase 1 and Phase 3 metric numbers comparable.

## Compute budget

Total cost is roughly:
- Phase 1: `N_automl × per-rec train` — the winning rec's checkpoint *is* DEFT's baseline; no separate baseline train below
- Phase 2: `M_iter × (RCA + SDG + mining + retrain)` — usually the largest term because SDG generates synthetic images
- Phase 3: `N_automl × per-rec train` on the (larger) augmented dataset, so per-rec time is somewhat higher than Phase 1. Phase 3's winner is the deliverable; no follow-up retrain.

Surface the structure to the user up front. Ask them for their per-job time and give a wall-clock range only after that — don't make up minute numbers.
