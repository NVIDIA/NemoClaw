# VCN Gap Analysis RCA Report Structure

Keep the RCA write-up tight (1000-1800 words). This is a computational gap analysis, not a deep RCA - depth comes from accurate numbers and a clear action list, not narrative.

```
# VCN Gap Analysis Report: <Experiment Name>

## 1. Verdict
- Chosen threshold: <value>  (achieves precision=<p>, recall=<r>, F1=<f1> on NO_PASS at recall ≥ <KPI>)
- KPI reachability: <yes/no — and the recall it actually achieves>
- Total samples: <N>  |  Total weak samples kept: <K>  |  Misclassified: <M>
- Top-3 labels by misclassification share
- One-line headline: "<K> weak samples written to gaps.parquet for augmentation"

## 2. Threshold Selection
- Target NO_PASS recall: <KPI>
- Candidates evaluated: <count>; candidates meeting recall target: <count>
- Chosen threshold and tie-break reasoning (best F1 → precision → threshold)
- Confusion matrix at chosen threshold (from `metrics.json`):

| | Predicted NO_PASS | Predicted PASS |
|--|--|--|
| Actual NO_PASS | TP=… | FN=… |
| Actual PASS    | FP=… | TN=… |

## 3. Weakness Distribution
| Label | Total Samples | Mean Weakness | Median Weakness | Max Weakness | # Misclassified |
|-------|---------------|----------------|------------------|---------------|------------------|

(One row per ground-truth label across the FULL inference CSV — read directly from
`metrics.json` per-label stats — not just the kept K.)

## 4. Top-K Weakest Samples (per label)
| Label | object_name | input_path | siamese_score | weakness | misclassified? |
|-------|-------------|-------------|----------------|-----------|-----------------|

(Up to top_k_per_label rows per label group. Sorted by weakness descending within each group.
Read from gaps.parquet, deduplicated to one row per (input_path, object_name) — gaps.parquet
is per-lighting, but the table is per-sample.)

## 5. Visual Spot Check (10 samples)
| Label | object_name | siamese_score | weakness | Test Image | Verdict |
|-------|-------------|----------------|-----------|-------------|----------|

(5 weakest PASS + 5 weakest NO_PASS. `Test Image` column is `![](rca_images/<filename>)`. `Verdict` is one of: mislabeled / edge case / data quality / systematic.)

## 6. Per-Label Breakdown
(Render the contents of `weak_samples_breakdown.txt` here.)

## 7. Recommended Actions
1. **Relabel** — list every sample tagged `mislabeled` in section 5. Path is `{input_path}/{object_name}` in `inference.csv`.
2. **Augment** — `kpi_gaps.parquet` (`<K> rows × <L> lightings = <K*L> filepaths`) is the augmentation queue. Pass it to `tao-route-visual-changenet-samples` next.
3. **Threshold action** — recommend whether to (a) retrain with current data and re-run this skill, (b) lower the recall target if the visual spot check shows the misclassified samples are genuinely ambiguous, or (c) ship at the current threshold if KPI is met.
4. **Systematic failures** — if any visual spot-check sample is tagged `systematic`, flag the failure mode (which lighting? which component family?) for model architecture review.
```

When `unreachable_kpi.txt` exists, replace sections 3-6 with a single short section quoting that file's contents and stating the model cannot meet the KPI at any threshold. Section 7 then collapses to one recommendation: retrain or relabel.
