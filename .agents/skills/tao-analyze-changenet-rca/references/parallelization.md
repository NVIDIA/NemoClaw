# Parallelization Strategy (USE SUBAGENTS)

**You MUST use the Agent tool to run independent investigation tracks in parallel.** This dramatically speeds up the RCA. Follow this execution plan:

## Step 1: Phase 1 — Run sequentially (everything depends on this)
Run Phase 1 yourself in the main thread. Save the results:
- Score statistics, tier, threshold sweep, per-defect-type table, drop-N analysis
- List of bottom 5 defects (for 2A), top 10 FP PASS samples (for 2C)
- All defect types found

## Step 2: Parallel Wave 1 — Launch 6 subagents simultaneously
After Phase 1 completes, launch ALL 6 agents **in a single message with multiple Agent tool calls**:

**Agent A — "Image Evidence: Critical Samples + Failure Clustering"**
- Phase 2A: Threshold-critical sample deep dive (bottom 5 defects, top 10 FPs)
- Phase 2B: Failure mode clustering (view ALL defect images, classify each)
- Provide: inference CSV path, image path construction rules, experiment.yaml path, Phase 1 results (bottom 5 defects list, score stats)

**Agent B — "Image Evidence: Golden Audit + FP Analysis"**
- Phase 2B: Systematic golden image audit (Python script + view flagged goldens)
- Phase 2C: False positive deep dive (top 10 highest-scoring PASS)
- Phase 2D: Comparative visual analysis
- Provide: inference CSV path, image path construction rules, top 10 FP sample IDs from Phase 1

**Agent C — "Data & Label Analysis"**
- Phase 2E: Label semantics & visual pattern alignment audit
- Phase 3C: Training image deep dive (view training defects, compare to test)
- Phase 4A: Data sufficiency analysis
- Provide: train CSV path, val CSV path, inference CSV path, image path construction rules

**Agent D — "Config & Cross-Dimensional Analysis"**
- Phase 3A: Component-type clustering
- Phase 3B: Board-level & positional analysis
- Phase 3D: Multi-light condition analysis
- Phase 4B: Training config audit
- Phase 4C: Training metrics
- Phase 4D: Loss function & decision boundary analysis
- Provide: inference CSV path, experiment.yaml path, status.json path

**Agent E — "Exploratory: Random Sampling & Anomaly Hunting"**
This agent has NO fixed checklist. Its job is to find what the structured agents miss.
- **Random image sampling**: Pick 20 random samples across the full score range (not just extremes). View test + golden for each. Look for anything unexpected — patterns not captured by the defect labels, images that "feel wrong" but aren't flagged, subtle systematic issues.
- **Score anomaly hunting**: Find statistical outliers — samples whose scores don't match their neighbors (e.g., a PASS sample with a score way above other PASS, or a defect with a suspiciously perfect score). View their images and explain the anomaly.
- **Golden-to-golden variance**: Pick 5 components that appear in multiple boards. View their golden images across boards. Are goldens consistent, or do they vary (= golden pipeline instability)?
- **Edge case search**: Find the samples closest to the decision boundary (scores near the optimal threshold). These are the model's hardest decisions. View them. What makes them ambiguous?
- **Correlation mining**: Run a Python script to compute correlations between score and every available metadata field (comp_type, object_name, board, position, image size, etc.). Report any unexpected strong correlations (r > 0.3).
- **Free-form observations**: Note anything surprising, unusual, or unexplained. No finding is too small — even "the naming convention changes after row 500" can be a clue.
- Provide: inference CSV path, train CSV path, image path construction rules, ALL file paths, Phase 1 results

**Agent F — "Exploratory: Cross-Validation & Stress Testing"**
This agent stress-tests the model's behavior and the data integrity.
- **Score consistency check**: If the same component appears on multiple test boards, does it get consistent scores? Large variance = the model is sensitive to non-defect factors. View the most inconsistent components.
- **Synthetic threshold analysis**: Beyond the global optimal threshold, compute per-component-type optimal thresholds. How much KPI improves with component-aware thresholds? This reveals if a single threshold is fundamentally wrong.
- **Data integrity audit**: Run a Python script to check for: duplicate rows, missing image files (test or golden), NaN/empty scores, mismatched column counts, inconsistent path formats, samples where test_path == golden_path (comparing image to itself).
- **Augmentation sensitivity probe**: If augmentation config is available, check if test-time conditions fall outside the augmentation range (e.g., model trained with ±10° rotation but test has ±30° offset from golden).
- **Score distribution shape analysis**: Beyond mean/std — fit score distributions to known shapes (bimodal, uniform, skewed). A bimodal PASS distribution suggests two populations (e.g., two board types with different baselines). Plot histograms if possible.
- **Misalignment between train and inference pipeline**: Compare how images are loaded in training code vs inference code. Check for: different normalization, different resize interpolation, different crop strategy, channel order mismatch (RGB vs BGR).
- Provide: inference CSV path, train CSV path, experiment.yaml path, training code directory, image path construction rules, Phase 1 results

## Step 3: Collect and synthesize — Run sequentially
Collect all 6 agent results. Pay special attention to Agents E and F — they may surface root causes that Agents A-D missed entirely. Cross-reference exploratory findings with structured findings:
- Do the random samples confirm or contradict the failure mode clustering?
- Did anomaly hunting find issues not in any defect type category?
- Does the data integrity audit invalidate any conclusions from other agents?

Then run Phase 5 (counterfactual) yourself, because it needs findings from ALL agents. Include any new root causes from E/F in the what-if simulations.

## Step 4: Write the report — Run sequentially

**BEFORE writing RCA_Report.md**, run `ls rca_images/` to inventory all available thumbnails. You need exact filenames for inline embedding.

**Image Embedding Protocol (MANDATORY)**:
Every visual evidence table row MUST have inline thumbnail columns using `![caption](rca_images/<filename>.jpg)` syntax. A report without per-row images is incomplete — the hook will reject it.

Rules:
- **Section 3.1 (Golden Audit)**: Every audited golden row gets a `![golden](rca_images/...)` column
- **Section 3.2 (Failure Mode Clustering)**: Every defect sample row gets BOTH a test thumbnail column AND a golden thumbnail column
- **Section 3.3 (False Positive Analysis)**: Every FP row gets BOTH test and golden thumbnail columns
- **Section 3.4 (Visual Detectability)**: Every comparison pair gets side-by-side test + golden thumbnails
- **Section 7.4 (Decision Boundary Cases)**: Each boundary sample gets test + golden thumbnails

To match thumbnails to samples: cross-reference `object_name` and `boardname` from each row against filenames in `rca_images/`. If a thumbnail was not generated for a sample, note `(no thumbnail)` in that cell.

Table format for image-heavy sections:
```
| Sample | Score | Test Image | Golden Image | Failure Mode | ... |
|--------|-------|------------|--------------|--------------|-----|
| <obj> | <score> | ![test](rca_images/<test_thumb>.jpg) | ![golden](rca_images/<golden_thumb>.jpg) | <mode> | ... |
```

Add a dedicated section for exploratory findings:
```
## 7. Exploratory Findings (Agents E & F)
- Unexpected patterns discovered
- Data integrity issues
- Cross-validation inconsistencies
- Anything that doesn't fit neatly into Phases 2-4
```

## Subagent Prompt Template

When launching each agent, include in the prompt:
1. The Visual Inspection Primer (copy it)
2. The image path construction rules
3. The specific Phase instructions for that agent
4. Phase 1 results (score stats, key sample IDs, defect types)
5. All file paths (experiment dir, CSV paths, image dir, config paths)
6. Instruction to return structured findings as markdown sections matching the report structure

**IMPORTANT**: Each agent must return:
- Markdown tables with all data (will be pasted into the report)
- List of all images viewed with verdicts
- Key findings and root causes identified
- **Thumbnail filename mapping**: A table mapping each sample (object_name + boardname) to exact thumbnail filenames generated in `rca_images/`. The main thread needs these exact filenames to embed inline images. Format:
  ```
  ## Thumbnail Map
  | object_name | boardname | test_thumbnail | golden_thumbnail |
  |-------------|-----------|----------------|------------------|
  | ... | ... | test_<name>.jpg | golden_<name>.jpg |
  ```
