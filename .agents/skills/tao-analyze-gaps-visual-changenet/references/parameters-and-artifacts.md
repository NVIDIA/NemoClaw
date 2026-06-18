# VCN Gap Analysis Parameters and Container Artifacts

## Required inputs (detail)

1. **Experiment result directory** — contains `inference/inference.csv` from TAO VCN Classify inference. Required columns: `input_path`, `object_name`, `label`, `siamese_score`. Pass the **directory** (e.g. `inference/latest/`), not the CSV file — the container reads `inference_results_dir/inference.csv`.
2. **Training code/config directory** — contains the VCN train YAML. The container reads `dataset.classify.input_map` (lighting condition list) and `dataset.classify.image_ext` from it to expand each weak sample into one row per lighting.
3. **Dataset directory** — image root prepended to the relative `input_path` from each row (`kpi_media_path`).
4. **Schema overrides** — `min_recall`, `top_k_per_label`, and optionally a hard-pinned `threshold` are passed as Hydra overrides (defaults: `min_recall=1.0`, `top_k_per_label=50`, `threshold=-1.0` meaning sweep). **`top_k_per_label` must be a positive integer** — omitting it flips the container into "below-threshold filter" mode, which at `min_recall=1.0` returns only PASS misclassifications and zero NO_PASS rows.

## Schema overrides and defaults

Each override is a bare Hydra `key=value` that selectively overrides the script's `GapAnalysisConfig` schema. Defaults are baked into the container; introspect them with `docker run ... gap_analysis vcn_aoi --cfg=job`. There is no `dataset` keyword inside the container — that is the TAO launcher's pillar prefix and is dropped here.

- `min_recall` — default `1.0` (zero-miss). Lower if the KPI relaxes.
- `top_k_per_label` — default `50`, per-label augmentation budget. Must be a positive integer.
- `threshold` — default `-1.0`, meaning sweep for the optimal threshold. Set a positive value to hard-pin the decision threshold.

**CLI overrides cover the common case.** `min_recall`, `top_k_per_label`, and optionally `threshold` are passed as Hydra overrides on the command line; the baked-in defaults handle most runs. If the container also accepts a spec file via `-e <spec>` (verify with `--cfg=job`), passing one is a convenience, not a requirement — override only what you need.

## What the container computes (Steps 1-4)

Reads `inference.csv`, sweeps every unique `siamese_score` plus one value just below the minimum, keeps the candidates with NO_PASS-class recall ≥ `min_recall` (with `1e-12` tolerance), then picks the threshold with the best F1 (tie-break: precision, then threshold value). For every row, computes signed weakness from that threshold (positive = misclassified, negative = correct, magnitude = margin). Sorts by weakness descending and takes the top `top_k_per_label` per ground-truth label, then expands each weak row into one row per lighting condition using `dataset.classify.input_map` and `dataset.classify.image_ext` from the train YAML.

`top_k_per_label` is the argument that switches the container from the default "samples below threshold" filter into proper top-K-per-label ranking. At `min_recall=1.0` the threshold is by construction at-or-below every NO_PASS score, so the below-threshold filter returns ONLY misclassified PASS rows and zero NO_PASS rows — useless as an augmentation queue. With `top_k_per_label` set to a positive integer (either in the spec or as a Hydra override), the container computes signed weakness against the threshold for every row and surfaces the K weakest **per ground-truth label**, which is the per-label ranked output downstream steps consume.

If **no** candidate threshold meets the recall target, the container exits non-zero and writes `unreachable_kpi.txt` into `results_dir` explaining which recall the model can actually achieve. In that case, stop the analysis after the docker call, write a one-section report explaining the model fundamentally cannot reach the KPI at any operating point, and recommend retraining or relabeling — skip the visual spot-check.

## Container artifacts (written into `results_dir`)

| Artifact | Contents |
|----------|----------|
| `kpi_gaps.parquet` | Top-K weakest per label, expanded per lighting. Columns: `filepath`, `label`, `siamese_score`, `weakness`. |
| `threshold.txt` | Chosen decision threshold (single float, plain text). |
| `metrics.json` | At the chosen threshold: `precision`, `recall`, `f1`, confusion matrix `{tp, fp, tn, fn}`, plus per-label `{total, mean_weakness, median_weakness, max_weakness, n_misclassified}`. |
| `weak_samples_breakdown.txt` | Per-label kept-row breakdown: `<count>` total, `<%>` of all kept rows, `N` misclassified (weakness > 0), `N` marginal (weakness ≤ 0). |
| `unreachable_kpi.txt` | Only written when the recall target is unreachable. Presence of this file means: skip the visual spot-check, write the abridged report, recommend retrain. |

Print the container's stdout summary (chosen threshold, kept-row counts, per-label breakdown) to your own stdout so the script-check hook can verify the run produced output.

## Output folder layout

Write everything into a timestamped folder under the experiment result directory. The container's outputs go straight there; the visual spot-check writes `rca_images/`; the packaging hook will add `rca_config/` and `claude_session.jsonl` automatically when `RCA_Report.md` is written.

```
<experiment_result_dir>/rca_results/YYYY-MM-DD_HHMMSS/
├── RCA_Report.md              # Full gap analysis report (you write this)
├── kpi_gaps.parquet           # Container: top-K weakest per label, expanded per lighting
├── threshold.txt              # Container: chosen decision threshold (single float)
├── metrics.json               # Container: confusion matrix + per-label distribution stats
├── weak_samples_breakdown.txt # Container: per-label count/misclassified/marginal counts
├── unreachable_kpi.txt        # Container: ONLY when no threshold meets min_recall
├── rca_images/                # You: thumbnails of the 10 viewed weak samples
├── rca_config/                # Auto-copied by hook
└── claude_session.jsonl       # Auto-copied by hook
```

At the start of the run, get the real timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash. Do NOT hardcode or guess. If the user specifies a custom output path, use that instead but maintain the same internal structure.
