# Investigation Phases (Detailed Procedures)

The investigation has 5 phases. Phase 1 (numbers) gives you hypotheses. Phase 2 (images) proves or disproves them. Phase 3 (cross-dimensional) finds hidden patterns. Phase 4 (config) explains the mechanism. Phase 5 (counterfactual) quantifies fixes. **Phase 2 is the core — spend the most effort there. Phase 5 is the most actionable — never skip it.**

## PHASE 1: Score Analysis (establish hypotheses)

Read `inference/inference.csv` and compute:

1. **Score statistics**: Split by PASS vs all non-PASS. Compute min/max/mean/median/std for each. Score gap = mean(NO_PASS) - mean(PASS).
2. **Tier classification** from score gap:
   - Tier 1 (Dead): gap < 0.03 — near-random
   - Tier 2 (Weak): gap 0.03–0.10 — some signal, heavy overlap
   - Tier 3 (Moderate): gap 0.10–0.20 — partial separation
   - Tier 4 (Strong): gap > 0.20 — good separation
3. **Threshold sweep**: For 200 thresholds from min to max score, compute TP/FP/TN/FN/precision/recall/F1/FAR. Find: KPI-optimal threshold, best-F1 threshold, 100%-recall threshold. Build confusion matrices.
4. **Per-defect-type scores**: Table of each defect type with count, min/max/mean score. Sort by mean score ascending (hardest to detect first).
5. **KPI verdict**: Can the model meet the target? How far off? (e.g., "100% recall requires FAR = 99%")

This gives you hypotheses: which defect types fail, which PASS components are FP magnets, whether the model learned anything at all.

6. **Threshold-critical sample analysis**: The lowest-scoring defect sets the 100% recall threshold — a single bad sample can force FAR from 5% to 99%. Compute "drop-N" analysis: FAR at 100% recall if worst 1, 2, 3, 5 defects excluded. If dropping a few helps dramatically → data quality issue on those samples. If dropping 5+ barely helps → systemic model failure.

## PHASE 2: Deep Image Investigation (prove with visual evidence)

This is the most important phase. You must **view actual images** to understand why scores are what they are. Use the Read tool to view images — it renders them visually.

**Image path construction:**
- Test image: `{images_dir}/{input_path}/{object_name}_{light_condition}.{ext}`
- Golden image: `{images_dir}/{golden_path}/{object_name}_{light_condition}.{ext}`
- `light_condition` from `dataset.classify.input_map` keys
- `ext` from `dataset.classify.image_ext` (e.g., .jpg)
- `images_dir` from `dataset.classify.train_dataset.images_dir` (or infer_dataset)

### 2A. Threshold-Critical Sample Deep Dive (MUST DO FIRST)

**Goal**: View the samples that directly set the KPI operating point — they have disproportionate impact. A single bad sample can shift FAR from 5% to 99%.

- **Recall-first**: View test + golden for the **bottom 5 lowest-scoring defects**. For each: is it a data issue (dark golden, framing mismatch, mislabel) or a genuine hard case?
- **FAR-first**: View the **top 10 highest-scoring PASS** samples similarly.
- Cross-reference with the drop-N analysis from Phase 1: would fixing these samples make the KPI achievable, or is the overlap systemic?

### 2B. Systematic Golden Image Audit

**Goal**: Find corrupted/dark/misframed golden images that inject noise into scores.

Write and run a Python script that:
1. Loads every unique golden image path referenced by defect samples in inference.csv
2. Computes mean pixel intensity for each golden image
3. **First, establish a baseline**: sample ~20 random PASS golden images and compute
   their mean intensity. This determines what "normal" looks like for this imaging
   modality. Some illumination types (e.g., SolderLight) produce systemically dark
   images where 80%+ of goldens have mean intensity < 30 — this is normal, not
   corruption. Set the "dark/corrupted" threshold relative to the PASS baseline
   (e.g., flag images below the 5th percentile of PASS golden intensities).
4. Flag images below the adaptive threshold as potentially corrupted
5. **Thumbnail generation**: For every image viewed during the investigation (golden audit, failure mode clustering, FP analysis, detectability assessment), copy and resize it to 128×128 px into an `rca_images/` folder next to the report. Name thumbnails descriptively (e.g., `golden_<sample_id>.jpg`, `test_<sample_id>.jpg`). These will be embedded in the final report using `![caption](rca_images/<name>.jpg)` syntax.

Then **view every flagged golden image** with the Read tool to confirm. For each:
- Is it completely dark/black?
- Is it a board-level view instead of component crop?
- Is the component visible and properly framed?

**Report**: Table of golden quality findings with image paths, mean intensity, visual verdict, and inline thumbnail image.

### 2B. Failure Mode Clustering (view ALL defect images)

**Goal**: Classify every test defect into a failure mode category by viewing images.

For **every defect sample** in inference.csv (or up to 50 if there are many):
1. View both the test image and golden image using the Read tool
2. classify each sample at two levels:
  - failure mode (dark golden, framing mismatch, subtle defect, etc.)
  - visual defect subtype (describe what you actually see in the image — do not assume categories, derive them from observation):

| Failure Mode | Defect Subtype | Description | Example |
|--------------|----------------|-------------|---------|

3. Record: sample_id, defect_type, score, failure_mode, visual_description, golden_quality

**This clustering is the key deliverable.** It tells you:
- What fraction of failures are data quality issues (dark golden, framing) vs genuine model limitations?
- Are "obvious" defects scoring low? (= model hasn't learned) vs only "subtle" ones? (= model learned basics but needs refinement)
- Which failure modes dominate? This determines the fix.

### 2C. False Positive Deep Dive

**Goal**: Understand why specific PASS components score high.

1. Take the top 10 highest-scoring PASS samples
2. View both golden and test images for each
3. Classify the FP cause:

| FP Cause | Description |
|----------|-------------|
| **Surface Reflectance** | Reflective surfaces differ between golden and test due to material/angle variation |
| **Position Shift** | Subject slightly offset from golden reference |
| **Lighting Variation** | Different illumination intensity/angle |
| **Golden Quality** | Golden image has issues (dark, misframed) |
| **Background Difference** | Background pattern differs between test and golden |

4. Check if FPs cluster on specific `object_name` values (same component across boards)
5. Check if FPs cluster on specific `comp_type_2` values (component category)

**Report**: Table of top 10 FPs with scores, inline test/golden thumbnails, visual cause classification, and clustering analysis.

### 2D. Comparative Visual Analysis

**Goal**: Establish whether defects are visually detectable at the model's input resolution.

View side-by-side pairs for:
1. A typical low-scoring PASS pair (score near PASS median) — what "normal similar" looks like
2. The training defect sample(s) — what the model was taught
3. Representative defects from each type in test — are they visually distinguishable from PASS?

For each pair, describe: what visual difference exists, how prominent it is, whether a human could detect it at the model's input resolution.

### 2E. Label Semantics & Visual Pattern Alignment Audit

**Goal**: Determine whether the dataset labels correspond to consistent visual concepts, and whether train/validation/test are aligned at the visual-pattern level.

A label is not sufficient evidence by itself. The investigator must verify whether samples sharing the same label also share the same visible pattern. A single label may contain multiple unrelated visual patterns. If the training samples and test samples under the same label are visually different, the model may fail even when the label names match.

For each label in train, validation, and inference:
1. Sample representative rows and construct test/golden image paths
2. View the actual images
3. Assign a **visual subtype** based on what is visible, independent of the CSV label
4. Build a subtype distribution table per split
5. Compare train vs validation vs test subtype coverage and proportions

Required subtype checks:
- Does one label contain multiple unrelated visual patterns? → **Label impurity**
- Does test contain subtypes absent from training? → **Unseen subtype**
- Do train and test use the same label name but different visual meanings? → **Semantic mismatch**
- Do visually similar samples appear under different labels? → **Label inconsistency**

For each label, report:
- split counts
- subtype counts
- representative thumbnails
- purity verdict
- alignment verdict

Severity guidance:
- **High severity**: test subtype absent from train, or label contains unrelated visual mechanisms
- **Medium severity**: subtype exists in train but at very low frequency vs test
- **Low severity**: subtype mix differs slightly but main patterns overlap

## PHASE 3: Cross-Dimensional Analysis (find patterns the model can't see)

### 3A. Component-Type Clustering

**Goal**: Determine if failures correlate with physical component characteristics, not just defect labels.

Write and run a Python script that:
1. Group all inference samples by `comp_type_2` (component category)
2. For each component type, compute: count, mean PASS score, mean defect score, score gap, FP rate, FN rate
3. Rank by FP rate descending — which component types are FP magnets?
4. Rank by FN rate descending — which component types hide defects?

Then **view representative images** from the worst 3 component types for FP and FN. Look for:
- Physical size (large objects lose detail when downscaled to model input size)
- Surface material (reflective vs matte surfaces)
- Subject complexity (multi-element vs simple subjects)

**Report**: Component-type heatmap table with score statistics, FP/FN rates, and visual explanation of why certain types fail.

### 3B. Board-Level & Positional Analysis

**Goal**: Find systematic issues tied to board identity or component position rather than defect type.

1. If `board_id` or equivalent field exists in CSV: group scores by board. Do certain boards consistently produce higher FP rates? (= board-level golden quality issue)
2. If positional data exists (`object_name` often encodes location): do failures cluster spatially? (= lighting gradient, camera vignetting, or board warp)
3. Cross-tabulate: board × defect_type × score. Is the model failing on specific board+component combinations?

**Report**: Board-level score table. Flag any board where mean PASS score > overall 75th percentile (= systematic FP source).

### 3C. Training Image Deep Dive

**Goal**: Understand what the model was actually taught — view the training data, not just test data.

1. Read the training CSV and **view all training defect samples** (test + golden pairs)
2. For each training defect, assign a visual subtype (same taxonomy as Phase 2B)
3. Compare training defect visual patterns vs test defect visual patterns:
   - Does training cover the visual diversity seen in test?
   - Are training defects more obvious/exaggerated than test defects?
   - Is training data from the same board type / lighting setup?
4. View 10 random training PASS pairs — are they truly defect-free? Mislabeled PASS samples poison the model.

**Report**: Training vs test visual pattern comparison table. Flag any test pattern not represented in training.

### 3D. Multi-Light Condition Analysis

**Goal**: If multiple light conditions exist in `dataset.classify.input_map`, check if performance varies by lighting.

1. Check `dataset.classify.input_map` for all light conditions
2. If multiple exist: for each light condition, compute the score distribution separately
3. View the same component under different lights — which light makes defects most visible?
4. Check if the model uses all light conditions or only one

**Report**: Per-light-condition score statistics. Recommendation on which lights are informative vs noise.

## PHASE 4: Data & Training Config Analysis

### 4A. Data Sufficiency

Read training CSV, validation CSV, and inference CSV. Report:
1. **Sample counts**: Total/PASS/per-defect-type for train, validation, test
2. **Defect type coverage matrix**: Which types appear in which splits
3. **Domain gap**: Check whether train and test come from different visual domains.
4. **Validation signal**: Does validation contain any defects? If not, checkpoint selection is blind.
5. **Class ratio analysis**: Compute PASS:defect ratio in train. If > 100:1, the model may never learn defect features. Cross-reference with sampler settings.

### 4B. Training Config Audit

Read `train/experiment.yaml`. Compute and report:

1. **Sampler × class weight interaction**:
   - From code (`oi_dataset.py:get_sampler`): `fail_wt = (num_pass / num_fail) * fpratio_sampling`
   - Effective over-emphasis = fail_wt × cls_weight[1]
   - Flag if > 100x
2. **Learning rate at inference checkpoint**:
   - Linear policy: `effective_lr = lr * (1.0 - epoch / (num_epochs + 1))`
   - Compute at checkpoint epoch. Flag if < 1e-6.
3. **Key config table**: difference_module, loss, embed_dec, freeze_backbone, num_epochs, batch_size, image_size
4. **Model output type**: learnable → softmax P(defect), euclidean → distance
5. **Augmentation audit**: What augmentations are enabled? Are they appropriate for the domain? (e.g., color jitter may destroy color-based signals; aggressive crop can remove small defects)
6. **Image size vs component size**: Is 224x224 sufficient? Compute the pixel-per-mm ratio for the largest components — if original images are 1600+ px and the defect occupies < 5% of the area, 224x224 may discard the defect entirely.

### 4C. Training Metrics

Read `train/status.json` (JSONL format — one JSON object per line). Extract epoch-level metrics if available. Look for:
- Did loss converge or oscillate?
- train_fpr = 0 throughout? (not challenged)
- val_acc = 100% on defect-free validation? (meaningless)
- **Overfitting signal**: train_acc >> val_acc? Loss divergence between train/val?
- **Early stopping**: Did the best checkpoint occur early (underfitting) or at the very end (may not have converged)?

### 4D. Loss Function & Decision Boundary Analysis

**Goal**: Understand if the loss function and decision mechanism match the problem.

1. For **learnable** module: softmax outputs P(defect). Check if the score distribution is bimodal (good) or uniform (model uncertain).
2. For **euclidean** module: distance-based scores have no natural threshold. Check if distances are calibrated — is there a clear gap between PASS and defect distances?
3. Compute **score entropy**: `H = -p*log(p) - (1-p)*log(1-p)` for learnable scores. High entropy near the threshold = model is guessing.
4. **Calibration plot**: Bin scores into 10 buckets, compute actual defect rate per bucket. Is the model calibrated? (score 0.8 should mean ~80% chance of defect)

## PHASE 5: Counterfactual & Actionability Analysis

### 5A. "What-If" Simulations

**Goal**: Quantify the impact of fixing each root cause to prioritize remediation.

For each root cause identified, simulate the fix:
1. **Dark golden fix**: Remove all samples with dark goldens from scoring → recompute FAR at 100% recall
2. **Mislabel fix**: Remove suspected mislabels → recompute metrics
3. **Component-type exclusion**: What if we exclude the worst FP component type? What's the KPI improvement?
4. **Threshold per component type**: Instead of one global threshold, compute optimal per-type thresholds → theoretical best KPI

**Report**: Impact table showing each fix, samples affected, KPI before, KPI after, delta.

### 5B. Minimum Viable Fix Path

**Goal**: Give the user a concrete, prioritized action plan.

1. Rank all root causes by: (impact on KPI) × (1 / effort to fix)
2. For each fix, specify:
   - Exactly what to change (specific samples to relabel, golden images to reshoot, config values to modify)
   - Expected KPI improvement (from 5A simulations)
   - Risk (could this make other metrics worse?)
3. Identify the **minimum set of fixes** needed to reach the target KPI
4. Flag if the target KPI is **unreachable** even with all fixes — and explain why (e.g., defects are genuinely invisible at this resolution)
