# Mining Reporting Specification

Keep the report tight (600–1200 words). Mining is a deterministic pipeline; the value is making the encoder choice, the row counts, and any silent filter no-ops auditable — not narrative.

```
# Mining Report: <Iteration / Experiment Name>

## 1. Verdict
- Targets in: <N_targets> rows from `<target_parquet>`
- Source pool in: <N_source> rows from `<source_pool_parquet>`
- Mined out: <N_mined> unique source filepaths → `mined.parquet`
- Encoder: <model> @ <model_path>
- Mining params: topn=<topn>, knn_metric=<metric>, filter_by_label=<bool>
- One-line headline: "<N_mined> source images mined for <N_targets> targets, ready for the next training round."

## 2. Inputs
| Input | Path | Rows | Has `label`? | Notes |
|-------|------|------|---------------|-------|
| target_parquet     | … | … | yes/no | source: `tao-route-visual-changenet-samples` mining subset |
| source_pool_parquet | … | … | yes/no | converted from CSV? yes/no |

## 3. Encoder Consistency
- Step 1 model / model_path: …
- Step 2 model / model_path: …
- Match? <yes — required>
- (If a TAO checkpoint:) model_config_path: …

## 4. Mining Run
- Command: `docker run … "$DS_IMAGE" tmm nearest_neighbors …` (where `DS_IMAGE` = `tao_toolkit.data_services` from `versions.yaml`)
- topn=<topn>, knn_metric=<metric>, filter_by_label=<bool>
- Reported by `mining_summary.txt`:
  - queries: <N>
  - neighbours requested: <N × topn>
  - duplicates removed: <N>
  - kept pairs (label filter): <N or n/a>
  - dropped pairs (label filter): <N or n/a>
- Filter no-op warning in docker log? <yes/no — quote the line if yes>

## 5. Per-Label Breakdown (if `label` is present in target_parquet)
| Target Label | N_targets | N_mined source rows | Notes |
|--------------|-----------|----------------------|-------|

(One row per distinct target label. If the target parquet has no label column, write
"label column not present in target parquet — per-label breakdown skipped." and move on.)

## 6. Output Sanity
- mined.parquet schema: <columns>
- First 5 mined paths exist on disk? <yes/no — list any missing>
- Path-encoding sanity check: <pass/fail — see "Common pitfalls" if fail>

## 7. Recommended Actions
1. **Augment** — `mined.parquet` is the augmentation queue for the next training round.
   Concatenate it with the AnomalyGen SDG output (if any) before kicking off training.
2. **If `N_mined ≪ topn × N_targets`** — the source pool is exhausted; widen the pool
   or accept a smaller augmentation budget.
3. **If filter no-op fired** — backfill the missing `label` column on whichever embedding
   parquet lacked it, then re-run Step 3 only (Steps 1–2 do not need to repeat).
4. **If mined images "look unrelated"** — verify Steps 1 and 2 used the *same* `model` and
   `model_path`. The encoder consistency section above is the first thing to check.
```
