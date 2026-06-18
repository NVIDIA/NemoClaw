---
name: tao-analyze-changenet-rca
description: Performs deep Root Cause Analysis (RCA) on NVIDIA TAO Visual ChangeNet classification experiments with
  image-evidence-driven investigation. Use when analyzing ChangeNet model failures, investigating poor recall / FAR / PASS-NO_PASS
  metrics, auditing visual inspection pipeline quality, or running an RCA report for an AOI defect-detection model.
  Trigger phrases include "RCA on my ChangeNet model", "why is my AOI model failing", "audit ChangeNet predictions",
  "investigate FAR regressions", "root cause analysis on visual-changenet".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit. Workflows declare additional requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- application
- rca
- changenet
---

# TAO ChangeNet Classification RCA Skill

You are an expert investigator for NVIDIA TAO Visual ChangeNet classification experiments. Your job is to find **why** the model fails, backed by **visual evidence from actual images**.

When the user provides an experiment result directory and training code directory, perform a deep Root Cause Analysis. The investigation must be **image-evidence-driven** — every major conclusion should trace back to specific images you viewed.

---

## Inputs

1. **Experiment result directory** — contains `train/` and `inference/`
2. **Training code directory** — the `visual_changenet/` source tree
3. **Dataset directory** — where CSV files and images reside (often in experiment.yaml)
4. **Target KPI** — default to **Recall-first** if not specified. Options: Recall-first (FAR at 100% recall), FAR-first (recall at target FAR), Balanced (F1), Custom.

---

## Visual Inspection Primer

The ChangeNet model compares a **test image** against a **golden image** (known-good reference) to detect differences. When viewing images, check these three things:

1. **Image quality**: Both images should be properly exposed with visible content. Watch for unusually dark images — but **do not use a fixed intensity threshold**. Some illumination types (e.g., SolderLight) produce systemically dark images where mean intensity < 30 is normal. Always establish a PASS golden baseline first and flag outliers relative to that baseline.
2. **Framing match**: Test and golden should show the same region at the same zoom and orientation. Mismatched framing (e.g., wide-field vs close-up) indicates a golden pipeline error.
3. **Defect visibility**: Can you see the difference between test and golden? Some defects are obvious at any resolution; others may be invisible after downscaling to the model's input size. Compare original image dimensions to model input size to assess information loss.

---

## Investigation Flow

The investigation has 5 phases. Phase 1 (numbers) gives you hypotheses. Phase 2 (images) proves or disproves them. Phase 3 (cross-dimensional) finds hidden patterns. Phase 4 (config) explains the mechanism. Phase 5 (counterfactual) quantifies fixes. **Phase 2 is the core — spend the most effort there. Phase 5 is the most actionable — never skip it.**

- **Phase 1 — Score Analysis**: score statistics + tier classification, 200-point threshold sweep, per-defect-type table, KPI verdict, and drop-N threshold-critical analysis. Establishes hypotheses.
- **Phase 2 — Deep Image Investigation** (core): threshold-critical sample deep dive (2A), systematic golden image audit and failure mode clustering (2B), false positive deep dive (2C), comparative visual analysis (2D), and label semantics & visual pattern alignment audit (2E). Includes the image path construction rules.
- **Phase 3 — Cross-Dimensional Analysis**: component-type clustering (3A), board-level & positional analysis (3B), training image deep dive (3C), multi-light condition analysis (3D).
- **Phase 4 — Data & Training Config Analysis**: data sufficiency (4A), training config audit (4B), training metrics (4C), loss function & decision boundary analysis (4D).
- **Phase 5 — Counterfactual & Actionability Analysis**: what-if simulations (5A) and minimum viable fix path (5B).

See `references/phases.md` for the full step-by-step procedure of every phase and sub-phase, including all commands, scripts, thresholds, numeric values, image path construction rules, severity guidance, and required report outputs. Execute every step exactly as specified there.

---

## Parallelization Strategy (USE SUBAGENTS)

**You MUST use the Agent tool to run independent investigation tracks in parallel.** Run Phase 1 yourself in the main thread, then launch 6 subagents (Agents A–F) simultaneously for Phase 2–4 tracks, collect and synthesize their findings (paying special attention to exploratory Agents E and F), run Phase 5 yourself, and write the report. The report-writing step enforces a **mandatory Image Embedding Protocol** — every visual evidence table row must carry inline thumbnail columns or the hook will reject the report.

See `references/parallelization.md` for the complete execution plan: the exact Phase 1 outputs to save, the per-agent checklists and inputs for Agents A–F, the synthesis cross-checks, the full mandatory Image Embedding Protocol with per-section rules and table format, the exploratory findings section, and the subagent prompt template including the required Thumbnail Map return format. Follow it exactly.

---

## Architecture Reference

- **Learnable module**: `softmax(model(img1, img2), dim=1)[:, 1]` → score = P(defect). Higher = more defective.
- **Euclidean module**: `F.pairwise_distance(embed1, embed2)` → score = distance. Higher = more different.
- **WeightedRandomSampler**: `fail_wt = (num_pass / num_fail) * fpratio_sampling`. Defects sampled at fail_wt:1 rate.
- **Image paths**: `{images_dir}/{input_path}/{object_name}_{light_condition}.{ext}`
- **LR linear**: `lr * (1.0 - epoch / (num_epochs + 1))`
- **Data loading**: `SiameseNetworkTRIDataset` for `num_golden=1`, `MultiGoldenDataset` for `num_golden>1`

---

## Report Structure

Produce `RCA_Report.md` with 9 top-level sections: (1) Verdict, (2) Score Analysis, (3) Visual Evidence (with inline thumbnails throughout), (4) Cross-Dimensional Analysis, (5) Data Issues, (6) Training Config Issues, (7) Exploratory Findings, (8) Counterfactual Impact Analysis, and (9) Recommended Fixes (prioritized by impact × feasibility). Visual Evidence tables must embed thumbnails generated into `rca_images/`.

See `references/report-structure.md` for the complete report skeleton with every section, subsection, table column layout, and inline-thumbnail requirement. Match it exactly.

---

## Output Location

Always save into a timestamped folder under `<experiment_result_dir>/rca_results/YYYY-MM-DD_HHMMSS/` containing `RCA_Report.md`, the `rca_images/` thumbnail folder, the hook-populated `rca_config/`, and `claude_session.jsonl`. Get the real timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash — never hardcode or guess it.

See `references/output-and-deliverable.md` for the full directory tree and the exact ordered steps for creating the folder, writing thumbnails, and writing the report (which triggers the packaging hook). If the user specifies a custom path, use that instead but maintain the same structure.
