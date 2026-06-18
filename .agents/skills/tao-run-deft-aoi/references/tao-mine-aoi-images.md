# DEFT AOI Mining — DEFT Loop Reference

Read this when the parent runs the `data_mining` stage (embed-then-mine workflow).
The underlying skill `tao-skill-bank:tao-mine-aoi-images` (`skills/data/tao-mine-aoi-images/SKILL.md`)
owns the full docker invocation (three calls into the `tao_toolkit.data_services`
image resolved from `versions.yaml` at runtime), encoder consistency requirement,
output schema, and common pitfalls. This file only covers the DEFT-loop-specific
overlay: required inputs, three-step order, output layout, and `deft_state.json`
/ `loop_log.jsonl` updates.

## DEFT-Loop Inputs

- `target_parquet` — absolute path from `deft_state.json` (`routing_mining_parquet` field set by the routing stage); required columns: `filepath` (and `label` if `filter_by_label=true`)
- `source_pool_parquet` — parquet of candidate images to mine against with a `filepath` column; convert from CSV up front if needed (preserve `filepath` and `label`)
- `model` — embedding model: `CLIP`, `SigLIP`, or a TAO `.pth`/`.ckpt` checkpoint; default `SigLIP`
- `model_path` — resolved by the parent during Pre-Flight as `SIGLIP_MODEL_PATH`; do not re-resolve at runtime. Default `google/siglip-base-patch16-224` (HuggingFace ID) applies only if Pre-Flight did not set a value. If a local path is set, mount it into the container; if a HuggingFace cache dir is set, mount `~/.cache/huggingface` read-only so the container can load from cache without a network call.
- `topn` — nearest neighbours per target (default `5`)
- `knn_metric` — `cosine` (default, recommended for CLIP/SigLIP), `euclidean`, or `manhattan`
- `min_similarity` — cosine similarity cutoff used at retention time. Read from `state.config.mining_filter.min_similarity` in `deft_state.json`; fall back to `0.9` only when the field is unset/null. **Always log the value actually used** into `knn_summary.csv` (`similarity_threshold` column) so the report shows what cutoff produced the row count, not the prose-default.
- `filter_by_label` — `true` or `false` (default `false`); requires `label` in both embedding parquets

If `routing_mining_parquet` is absent from `deft_state.json` or the file does not exist on disk, stop and return failure without running any docker steps.

## Pre-mine yield precheck (cheap; runs before Step 1 embedding)

Run this on the host before spending GPU time on Step 1+2. For each label in `target_parquet`, count rows in `source_pool_parquet` (or the source CSV) with the same label. If any target label has **zero** source-pool rows of the same label, log a warning and surface it to the user:

```
Pre-mine precheck: target labels {missing} have 0 candidates in mining_pool —
guaranteed 0 yield regardless of similarity. Consider expanding mining_pool.csv
or routing these labels to AnomalyGen exclusively.
```

This is a warning, not a hard stop — k-NN by embedding can still pull rows of a *different* nominal label when their visual content matches (it's the post-routing decision that filters by label, not the source pool itself). But making the zero-coverage cases visible up-front gives the user a chance to fix the pool before the next iteration, instead of discovering it via the post-mine yield monitor below.

## Three-Step Execution Order

1. **Embed targets** (`embedding image_embeddings … input_parquet=<target_parquet>`) → `target_embeddings.parquet`
2. **Embed source pool** (`embedding image_embeddings … input_parquet=<source_pool_parquet>`) → `source_embeddings.parquet`; use the **identical** `model` and `model_path` as Step 1
3. **Mine nearest neighbours** (`tmm nearest_neighbors …`) → `mined.parquet` + `mining_summary.txt`

All three steps use the `tao_toolkit.data_services` image declared in `versions.yaml` (resolved into `$DS_IMAGE` at the top of the run — see `skills/data/tao-mine-aoi-images/SKILL.md` § Setup). Mount the workspace root at an identical path inside the container (`-v $WORKSPACE:$WORKSPACE`) so absolute paths in parquet args resolve the same on both sides.

**Pre-create `experiment_specs/`.** Both `embedding image_embeddings` and `tmm nearest_neighbors` are Hydra-driven and abort with `Primary config directory not found` if no `experiment_specs/` directory exists at the container's working dir. The container does not auto-create it. Before each docker run, `mkdir -p <mining_dir>/experiment_specs/` on the host (the mount makes it visible inside the container), or pass `-w <mining_dir>` and let Hydra find an empty dir there. An empty directory is sufficient — the CLI supplies its own spec via flags. Without this, both steps 1+2 (embedding) and step 3 (mining) fail with the same opaque Hydra error.

## Output Directory

`results/<baseline|iter${N}>/mining_results/<timestamp>/`

Required files:
- `mined.parquet` — unique mined source filepaths (columns: `filepath`)
- `mining_summary.txt` — query count, neighbour count, duplicates removed, kept/dropped pairs
- `target_embeddings.parquet` — Step 1 output (reusable across future mining runs against the same targets)
- `source_embeddings.parquet` — Step 2 output (reusable against the same source pool)

## Pool Composition Requirement

`augmentation/mining_pool/mining_pool.csv` must contain **NG samples** for every defect type listed in the KPI testing set — not just PASS samples. The mining stage retrieves nearest neighbours by SigLIP embedding similarity, so if the pool has zero NG examples for a defect type, no candidate ever crosses the configured `min_similarity` threshold and the iteration silently contributes no real-image augmentation for that type. Document defect-type coverage in the workspace setup; do not work around in code. Past production pools have been missing `SHIFT`, `LIFTED_LEAD`, `UPSIDE_DOWN`, `TOMBSTONE`, and `POLARITY` simultaneously, which leaves 5/8 KPI defect types with no augmentation path.

## Yield Monitor

After Step 3 finishes, read `mining_filter/knn_summary.csv` and compare `kept_count` to the previous iteration's `kept_count` (read from `deft_state.json[f"iter{N-1}"]["mining_mined_count"]` — `baseline.mining_mined_count` for iter1). If `current_kept < 0.5 * previous_kept` (a >50% drop), surface a warning to the user including both counts and the implied drop percentage:

```
Mining yield dropped {drop_pct}% (iter{N-1}: {prev_kept} → iter{N}: {cur_kept}) —
pool near exhaustion for the current weak-sample targets.
Consider expanding mining_pool.csv with new production samples before the next iteration.
```

This is a warning, not a hard stop. The loop should continue, but the iteration summary must flag the drop so the user notices before the next iteration. A 30→5 collapse in iter2 (83% drop) has happened in past runs without any signal reaching the user.

## Output to deft_state.json

```python
state["baseline" | f"iter{N}"]["mining_mined_parquet"] = "<abs_path>/mined.parquet"
state["baseline" | f"iter{N}"]["mining_mined_count"]   = <int>   # rows in mined.parquet
```

## Log Stage

```bash
python3 <skill_root>/scripts/log_stage.py \
    --log-path results/loop_log.jsonl \
    --iter-label <baseline|iter${N}> \
    --stage data_mining --status ok \
    --summary "Mining (VCN): mined=N_mined source images for N_targets targets"
```
