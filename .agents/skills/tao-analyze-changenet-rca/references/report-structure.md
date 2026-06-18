# RCA Report Structure

```
# Root Cause Analysis Report: <Experiment Name>

## 1. Verdict
- Tier (1-4), score gap, KPI result
- One-paragraph root cause summary
- Top 3 root causes ranked

## 2. Score Analysis
- Score distributions (PASS vs NO_PASS)
- Threshold analysis with confusion matrices
- Per-defect-type score table

## 3. Visual Evidence
For every table below, embed inline thumbnail images using Markdown image syntax:
`![caption](path/to/image)` — use relative paths from the report location.
Before writing the report, generate a thumbnail gallery: write and run a Python script
that copies relevant images into a `rca_images/` subfolder next to the report, resized
to 128×128 px (or original size if smaller). Use these thumbnails in the Markdown tables.

- 3.1 Golden Image Audit
     | Golden Path | Thumbnail | Mean Intensity | Visual Verdict |
     |-------------|-----------|----------------|----------------|
     (one row per audited golden image, thumbnail = `![golden](rca_images/<name>.jpg)`)

- 3.2 Failure Mode Clustering
     | Sample | Score | Defect Type | Test Image | Golden Image | Failure Mode | Description |
     |--------|-------|-------------|------------|--------------|--------------|-------------|
     (embed test + golden thumbnails side-by-side per row)
     - Summary: N obvious defects scoring low → model didn't learn
     - Summary: N dark goldens → data quality issue
     - Summary: N framing mismatches → golden pipeline issue

- 3.3 False Positive Analysis
     | Rank | Sample | Score | Test Image | Golden Image | FP Cause | Component/Type |
     |------|--------|-------|------------|--------------|----------|----------------|
     (top 10 FPs with inline thumbnails and visual cause)
     - Clustering: which components/types dominate FPs

- 3.4 Visual Detectability Assessment (can a human see it at 224x224?)
     Include side-by-side test vs golden thumbnail pairs for:
     - A typical low-scoring PASS pair
     - Representative defects from each type
     - The hardest cases (highest-scoring defects, lowest-scoring defects)

## 4. Cross-Dimensional Analysis
- 4.1 Component-Type Clustering
     | Component Type | Count | Mean PASS Score | Mean Defect Score | Gap | FP Rate | FN Rate |
     |----------------|-------|-----------------|-------------------|-----|---------|---------|
     (with visual explanation for worst types)
- 4.2 Board-Level Analysis (if board IDs available)
- 4.3 Training Image Deep Dive
     | Training Sample | Visual Subtype | Also in Test? | Difficulty vs Test |
     |-----------------|----------------|---------------|-------------------|
     - Training vs test pattern coverage verdict
- 4.4 Multi-Light Condition Analysis (if applicable)

## 5. Data Issues
- Sample counts table (train/val/test × PASS/defect types)
- Defect type coverage matrix
- Class ratio analysis
- Domain gap / board mismatch analysis
- Validation signal check

## 6. Training Config Issues
- Sampler × class weight computation
- LR at checkpoint epoch
- Augmentation audit
- Image size vs component size analysis
- Config parameter table with flags
- Loss function & calibration analysis

## 7. Exploratory Findings

- 7.1 Random Sampling Discoveries
     | Sample | Score | Expected? | Observation |
     |--------|-------|-----------|-------------|
     (20 random samples across full score range — anything unexpected)

- 7.2 Score Anomalies
     | Sample | Score | Why Anomalous | Visual Explanation |
     |--------|-------|---------------|-------------------|
     (outliers that don't match their neighbors)

- 7.3 Golden Consistency Check
     | Component | Board A Golden | Board B Golden | Consistent? |
     |-----------|---------------|---------------|-------------|
     (same component across boards — golden pipeline stability)

- 7.4 Decision Boundary Cases
     | Sample | Score | Label | Test Image | Golden Image | Why Ambiguous |
     |--------|-------|-------|------------|--------------|---------------|
     (samples closest to threshold — the model's hardest calls)

- 7.5 Metadata Correlations
     | Field | Correlation with Score | Interpretation |
     |-------|----------------------|----------------|
     (unexpected correlations found by mining)

- 7.6 Data Integrity Issues
     - Duplicate rows, missing files, NaN scores, path mismatches

- 7.7 Score Distribution Shape Analysis
     - Bimodal? Uniform? Skewed? What does the shape reveal?

- 7.8 Train vs Inference Pipeline Misalignment
     - Normalization, resize, crop, channel order differences

## 8. Counterfactual Impact Analysis
- 8.1 What-If Simulations
     | Root Cause | Fix | Samples Affected | KPI Before | KPI After | Delta |
     |------------|-----|------------------|------------|-----------|-------|
- 8.2 Minimum Viable Fix Path
     | Priority | Fix | Effort | KPI Impact | Risk |
     |----------|-----|--------|------------|------|
     - Is target KPI reachable? If not, why?

## 9. Recommended Fixes (prioritized by impact × feasibility)
```
