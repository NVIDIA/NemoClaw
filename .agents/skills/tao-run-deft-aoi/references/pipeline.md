# DEFT Loop Pipeline

## Augmentation Pool

Each iteration builds **one** source CSV that feeds mining:

```
mining_filter/source_pool.csv
  = augmentation/mining_pool/mining_pool.csv   (provenance=real, paths normalized to workspace-root)
  + mining_filter/sdg_rows.csv                 (provenance=sdg,  paths already workspace-root-relative)
```

Step 3 assembles `source_pool.csv`; step 4 embeds every row with SigLIP and writes the top-K-per-target survivors (deduped, `provenance` preserved) to `mining_filter/mining_pool.csv`. `train_combined_iter${N}.csv` = base training rows + surviving mining rows. **No SDG bypass — synthetic rows go through the same k-NN as real rows.**

**Per-iter mining bounds.** With `topn` (default 5) survivors per weak target and ~30–60 weak mining-routable targets per iter:

```
total mining winners per iter ≤ topn × num_weak_mining_targets   (deduped, upper bound)
synth share of winners       = fraction of top-K slots whose nearest neighbour was a synth row (k-NN, not a knob)
```

E.g. topn=5, 50 targets, 100 real + 1000 synth in the source pool → upper bound 250 total winners; synth share falls out of SigLIP proximity, not pool sizes. Customers worried about synth dominance should grow the real pool or lower `top_k_per_target` rather than capping pre-gen pool size.

The pre-gen contribution is **per-run, not per-iteration**: the loop re-reads `augmentation/anomalygen/` every iteration. The per-iter synth winners differ because the weak-target set shifts as the model evolves — so the loop naturally picks different synth pairs each iter without any explicit ingest cap. To get new synthetic coverage between runs, the customer regenerates offline and replaces the directory before launching the next run.

**Source pool growth.** `augmentation/mining_pool/mining_pool.csv` is append-only — the production line contributes new real-image samples daily (Day 1 → Day N). Each iteration mines against the current accumulated state of the pool; later iterations naturally benefit from a richer pool. Before running the mining step, verify the file exists and is non-empty; a missing or zero-row pool is a hard stop.

**Schema.** Base training rows arrive with production metadata populated. `augmentation/mining_pool/mining_pool.csv` and `mining_filter/sdg_rows.csv` carry the 4 mandatory columns. `source_pool.csv` and `mining_filter/mining_pool.csv` add a `provenance` column. Merging into `train_combined_iter${N}.csv` follows the Data Contract CSV schema: pad the 10 optional metadata columns with empty strings when absent.

**Quirk: `mining_pool.csv`'s `input_path` is file-style** (e.g. `images/R821@1_SolderLight.jpg` — includes the basename), but TAO's dataloader formula is `{images_dir}/{input_path}/{object_name}_{light}{ext}` which requires dir-style. Before mining or training reads these rows, strip the basename (`input_path = os.path.dirname(orig_input_path)`), then prepend `augmentation/mining_pool/` to make the path workspace-root-relative. `scripts/prestage_pregen.py` does this internally during Pre-Flight source_pool assembly — do not hand-roll the rewrite in iter code; route through the script so the logic stays in one place. Failure mode if you skip the strip: `{images_dir}/augmentation/mining_pool/images/X.jpg/X_SolderLight.jpg` → file-not-found ~30 s into training.

## Pipeline

All stages run inline in the parent context. For SKILL stages, read the matching `references/*.md` first, then invoke the underlying `tao-skill-bank:*` skill via the Skill tool. INLINE stages have no underlying skill — the parent does the work directly.

Baseline runs once before the loop: `train` → `inference` → `evaluate` (skill: `tao-skill-bank:tao-train-visual-changenet`), then `rca` (skill: `tao-skill-bank:tao-analyze-gaps-visual-changenet`). The `train` sub-step is **skipped** when `deft_state.json` arrives with `iterations.baseline.stage_completed == "train"` and a `best_ckpt_path` pointing at an existing file — the `tao-run-automl-deft-pipeline` main skill pre-seeds these from its Phase 1 AutoML winner so DEFT doesn't retrain at the same HPs. In that case, baseline picks up at `inference` against the pre-seeded checkpoint, then `evaluate`, then `rca`. Then each iteration:

1. **[SKILL — `tao-skill-bank:tao-analyze-gaps-visual-changenet`] RCA** on the previous inference result. Output: `rca_results/`. Write `iterations.<iter>.rca_target_defects` and `rca_gaps_parquet` into `deft_state.json` before advancing. See `references/tao-analyze-gaps-visual-changenet.md`.

2. **Route weak samples.** Behaviour depends on whether AnomalyGen is run on the fly or pre-generated:

   - **AnomalyGen runs on the fly** (Cosmos container is configured — `state.config.anomalygen.sub_skill` is set): **[SKILL — `tao-skill-bank:tao-route-visual-changenet-samples`]** Split `rca_gaps_parquet` into `routing_mining_parquet` and `routing_anomalygen_parquet` in `deft_state.json`. Downstream mining and AnomalyGen stages read those paths from disk. See `references/tao-route-visual-changenet-samples.md`.

   - **AnomalyGen is pre-generated** (`state.config.anomalygen.mode == "pregen_ingest"` and `sub_skill == null`): **[INLINE]** Skip the routing skill — there is no AG consumer to route to. Copy `rca_gaps_parquet` verbatim to `routing_results/<TS>/mining_gaps.parquet` and set `routing_anomalygen_parquet` to null in `deft_state.json`. **All weak gaps become mining targets**, regardless of label. The mining step (already configured with `filter_by_label: false`) will let k-NN retrieve whichever source-pool rows are visually closest to each target — real PASS or pre-gen synth NG — without any label-based pre-filter.

     ```python
     # Pre-generated AnomalyGen — one shutil.copyfile, then state update.
     import shutil, json, pathlib
     rca_pq = state["iterations"][iter_label]["rca_gaps_parquet"]
     rt_dir = pathlib.Path(f"{RESULTS_DIR}/{iter_label}/routing_results/{ts}")
     rt_dir.mkdir(parents=True, exist_ok=True)
     mining_pq = rt_dir / "mining_gaps.parquet"
     shutil.copyfile(rca_pq, mining_pq)
     state["iterations"][iter_label]["routing_mining_parquet"] = str(mining_pq)
     state["iterations"][iter_label]["routing_anomalygen_parquet"] = None
     ```

     **Why the simplification matters.** When AnomalyGen is pre-generated, the previous behaviour ran the full routing-vcn skill, which filters `mining_gaps` by *real-pool labels only* (`augmentation/mining_pool/mining_pool.csv['label'].unique()`). For customers whose mining_pool is PASS-only (the common case — production lines collect a stream of nominal samples, not defective ones), this drops every weak NG target from mining. They then get routed to `anomalygen_gaps.parquet`, which has no consumer when AG is pre-generated — silently dropped. Net effect: the loop never gets k-NN neighbours for the very defect classes the model needs to learn. Measured on a real run: every iter dropped 38/88 (43%) of weak samples this way, identically each iter. Promoting all gaps to mining recovers them.

     Log via `scripts/log_stage.py --stage routing --status ok --summary "pre-gen single-bucket: <N> gaps -> mining; no AG fanout"`.

3. **[INLINE] Read the cached pre-gen manifest.** Staging + source-pool assembly were done **once** at Pre-Flight step 10 (`scripts/prestage_pregen.py`). Per iter, this step is now a thin reader: load `${RESULTS_DIR}/synth_pool/manifest.json`, verify the artefacts referenced by it still exist (`source_pool.csv`, `source_pool.parquet`, and `source_embeddings.parquet` if `--embed-with-siglip` was used at pre-flight), and record the manifest pointer into `state.iterations.<iter>.anomalygen_ingest` so the per-iter audit trail still names the source. Log via `scripts/log_stage.py --stage anomalygen --status ok --summary "reused pre-staged synth_pool: R real + S sdg rows"`.

   The previous design re-staged all 1000 pairs + reassembled `source_pool.csv` every iteration, even though neither the pre-gen NG/OK directory nor the real mining_pool changed between iterations. That cost ~70 GB of duplicate disk on a 10-iter run, plus ~50 s of redundant SigLIP source-pool embedding per iter. Only the k-NN target set (`routing_mining_parquet`) and the per-iter `mining_pool.csv` survivors actually need to be recomputed — and those still happen in step 4.

   **Sanity checks** the per-iter step should still run (cheap, < 1 s each):
   - `synth_pool/manifest.json` exists and parses; `counts.sdg_rows` > 0.
   - The NG/OK directory listing has not changed since pre-flight (compare against `manifest.counts.sdg_rows`). Mid-run mutation is still flagged as a hard stop here — *not* silently re-ingested.
   - `augmentation/mining_pool/mining_pool.csv` still exists and is non-empty (production line append-only growth is fine; deletion is not).

   **If a customer wants to refresh the pre-gen pool**, they must re-launch the loop with a new `RESULTS_DIR` (or pass `--force` to `prestage_pregen.py` and rerun pre-flight). The loop does not re-stage mid-run.

4. **[SKILL — `tao-skill-bank:tao-mine-aoi-images`] Mine the cached source pool against the iter's weak targets.** Input: `${RESULTS_DIR}/synth_pool/source_pool.parquet` (built once at pre-flight, real + sdg). Two cases:

   - **Pre-flight ran `--embed-with-siglip`** (recommended path): skip the source-pool embedding step entirely. Embed only the iter's `routing_mining_parquet` targets (~50 rows, < 5 s), then run k-NN against the cached `synth_pool/source_embeddings.parquet`. Cost: one embedding call per iter instead of two.
   - **Pre-flight did not embed**: behave as before — embed source pool from scratch each iter. This is a documented fallback, not the recommended path.

   In both cases keep the **top-K nearest neighbours per target** (`topn=state.config.mining_filter.top_k_per_target`, default 5; deduped). The `provenance` column rides verbatim through embedding so the post-join recovers it. Optionally enforce `cosine ≥ state.config.mining_filter.min_similarity` (default 0.9) as a second filter on top of top-K. Output: `mining_filter/{target_embeddings.parquet, mined.parquet, mining_summary.txt, mining_pool.csv, knn_summary.csv}`. **Synthetic rows go through the same k-NN as real rows — no SDG bypass.** See `references/tao-mine-aoi-images.md`.

   **Mid-iteration leakage check.** Right after mining finishes — before any further CSV assembly — diff `mining_filter/mining_pool.csv` against `train/base/validation_set.csv` on `(input_path, golden_path, label, object_name, boardname)` (use `scripts/validate_training_csv.py --csv <mining_pool.csv> --workspace-root <ws> --validation-csv <validation_set.csv>`). Hard-stop on any hit. Catching leakage here, with only the new rows in scope, is cheap and isolates the offending source. The post-assembly leakage check in step 6b stays as a defence-in-depth backstop.

5. **[INLINE] Assemble training CSV** with monotonic growth:
   - Iter 1: `train/base/training_set.csv` + `mining_filter/mining_pool.csv`.
   - Iter N/resume: previous `train_combined_iter${N-1}.csv` + current `mining_filter/mining_pool.csv`. Never re-add `base_train` when using a previous combined CSV.
   - Write a sibling `_provenance.csv` for every output row; `source ∈ {base_train, previous_iter_train, mining_pool}`.
   - **`images_dir` for the iteration training spec** must be set to the workspace root (e.g. `/data/workspace/`), not `kpi/images/`. SDG rows already carry workspace-root-relative paths. Base training rows carry paths relative to `kpi/images/` — prepend `kpi/images/` to their `input_path` and `golden_path` so all rows share the same coordinate space.
   - **Normalize `label` case — preserve `PASS` uppercase, lowercase+strip everything else.** See `references/visual-changenet.md` for the dataloader rule and the failure mode if you violate it.

6. **[INLINE] Pre-train CSV validation** — run **both** checks below; hard stop on either failure. Both must pass before launching the training container; an invalid CSV burns a full GPU run before the container surfaces the root cause.

   a. **Existence check.** Run `scripts/validate_training_csv.py --csv ${RESULTS_DIR}/iter${ITER}/dataset/train_combined_iter${ITER}.csv --workspace-root <workspace>`. It hard-stops if any `input_path` / `golden_path` refers to a file missing on disk or if a required column is missing.

   b. **Train/validation leakage check.** `scripts/validate_training_csv.py` accepts `--validation-csv`; pass `train/base/validation_set.csv` so the diff on `(input_path, golden_path, label, object_name, boardname)` runs as part of the single validation pass. Hard stop on any validation row appearing in training. (Step 4 already runs the mid-iteration variant on `mining_filter/mining_pool.csv`; this check is the defence-in-depth backstop against leakage introduced by base-CSV reassembly.)

7. **[SKILL — `tao-skill-bank:tao-train-visual-changenet`] Fine-tune + evaluate.** Invoke the skill for the `train` and `evaluate` tasks. For the train task, pass the workflow override `automl_policy: off` so Visual ChangeNet runs plain training instead of model-level AutoML. It owns TAO training, checkpoint discovery, inference, KPI analysis, and best-checkpoint selection. Write the selected checkpoint and KPI metrics into `deft_state.json`. Stop the loop if KPI met or `max_iterations` reached. See `references/visual-changenet.md`.
