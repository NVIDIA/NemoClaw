---
name: tao-run-automl-deft-pipeline
description: >
  Run the canonical NVIDIA AOI three-phase training pipeline — Phase 1 AutoML baseline (HPO),
  Phase 2 DEFT loop (RCA → SDG → mining → plain-train retrain), Phase 3 AutoML refinement on
  the DEFT-augmented dataset. This is the default entry point for any "run the AOI workflow",
  "fine-tune my PCB AOI model end-to-end", "improve my AOI ChangeNet model", or "AOI workflow
  with AutoML" request — route here instead of tao-run-deft-aoi directly unless the user
  explicitly asks for the DEFT loop ONLY (e.g. "run JUST the DEFT loop", "skip AutoML, only
  DEFT"). Also handles the same three-phase pattern for non-AOI DEFT applications — AutoML
  baseline then DEFT loop warm-started from AutoML's winning HPs then post-DEFT AutoML
  refinement on the iteration-augmented dataset. Trigger phrases include "run the AOI
  workflow", "AOI end-to-end", "AutoML + DEFT", "AutoML then DEFT", "tune hyperparameters then
  DEFT", "DEFT with AutoML at both ends", "warm-start DEFT", "improve my AOI model".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit. Workflows (tao-run-automl, tao-run-deft-aoi) declare additional requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.4.0"
allowed-tools: Read Skill Bash Write
tags:
- tao
- applications
---

# AutoML + DEFT Pipeline

A workflow-bridge skill that runs **three phases** in sequence by delegating to two existing skills — `tao-run-automl` for HPO and a DEFT application skill (default `tao-run-deft-aoi` for AOI; other `skills/applications/deft-*` skills for non-AOI cases) for the iterative data-improvement loop.

This skill **does not** re-implement AutoML or DEFT. It owns only the connective tissue: HPO spec inputs, the spec-handoff between AutoML and DEFT, and the post-DEFT AutoML re-run on the augmented dataset.

## When this skill applies

- User asks to "run the AOI workflow" or "improve my AOI ChangeNet model" — **default to this skill**, not `tao-run-deft-aoi` directly. The bare DEFT loop is the inner stage of this pipeline.
- User wants AutoML and DEFT chained on the same model/dataset
- User says "AutoML at both ends", "tune HPs then DEFT", "warm-start DEFT", "AutoML before and after DEFT"
- User has an AutoML-tuned spec and asks how to feed it into DEFT

## When this skill does NOT apply

- User explicitly asks for the DEFT loop only ("run JUST the DEFT loop", "skip AutoML") → use `tao-run-deft-aoi` directly
- User wants only AutoML with no follow-on DEFT → use `tao-run-automl` directly
- User is doing zero-shot eval, RAG, or non-training workflows

---

## The mental model

```
Phase 1 (AutoML baseline)        Phase 2 (DEFT loop, plain train)        Phase 3 (AutoML refinement)
─────────────────────────        ────────────────────────────────        ───────────────────────────
specs/baseline_spec.yaml         (Phase 1 winner pre-seeds baseline      ${RESULTS_DIR}/iter${N}/dataset/
train/base/training_set.csv       — DEFT skips its baseline train)       train_combined_iter${N}.csv
        │                                       │                                       │
        ▼                                       ▼                                       ▼
[ AutoML HPO sweep ]               [ DEFT: baseline-inference → RCA       [ AutoML HPO sweep ]
   N recommendations                 → iter 1..N (plain retrain) ]        re-tunes HPs against the
   pick best by val_loss / FAR      RCA / route / SDG / mining             DEFT-augmented dataset
        │                                       │                                       │
        ▼                                       ▼                                       ▼
best HPs spec + ckpt ─────►      DEFT-augmented CSV ───────────►        final best checkpoint
                                 + iter winner checkpoint               (the deliverable; no
                                 (Phase 3 warm-starts from it)           further retrain)
```

The handoffs are:

- **Phase 1 → Phase 2**: a *spec file* AND the *winning checkpoint*. Retraining the same HPs in DEFT's baseline step is wasted compute, so the bridge deep-merges Phase 1's winning HPs onto `baseline_spec.yaml`, copies the winning checkpoint into `${RESULTS_DIR}/baseline/train/` under the filename DEFT expects, and pre-populates `deft_state.json` + `loop_log.jsonl` so DEFT resumes at baseline inference → evaluate → RCA → iter 1. DEFT itself stays plain-train (`automl_policy: off` preserved). Verbatim 4-step procedure in `references/handoff.md`.
- **Phase 2 → Phase 3**: a *training CSV* AND the *iter winner's checkpoint*. The CSV (`train_combined_iter${N_final}.csv`) is AutoML's training data; the checkpoint (`iterations.<best>.best_ckpt_path` from `deft_state.json`) is wired into each rec's `train.pretrained_model_path` so Phase 3 **fine-tunes from Phase 2's winner** rather than from scratch. Without this warm-start Phase 3 routinely regresses vs the iter winner. Phase 3's winning checkpoint is the deliverable — no separate retrain after Phase 3. See `references/handoff.md`.

## Why three phases instead of two

- **Phase 1 alone** finds good HPs on the *original* training distribution, but the model still has the distributional gaps DEFT is designed to fill.
- **Phase 2 alone** (just DEFT) fills the gaps but uses whatever HPs `specs/baseline_spec.yaml` was hand-authored with — usually not optimal.
- **Phase 3 alone** would run AutoML against the augmented dataset, but without a tuned baseline the DEFT loop's iteration cost is higher (slower convergence, more iterations to hit the KPI).

Running all three: AutoML cheap-tunes once on the original data, DEFT does the heavy data work with reasonable HPs, then AutoML tunes again on the now-richer dataset. Phase 3 is the most important of the three for the final deployed FAR/recall.

## Cost up-front

The pipeline is sequential. Total wall-clock ≈ Phase 1 (N_automl × per-rec train) + Phase 2 (M iterations × per-iter cost) + Phase 3 (N_automl × per-rec train).

Note that **Phase 2 has no separate baseline train** — Phase 1's winning checkpoint is reused as DEFT's baseline, so the baseline cost lands inside Phase 1's N_automl trainings rather than as an extra retrain. Surface this to the user before kickoff. Typically Phase 2's iterations still dominate (each includes SDG + retrain), but Phase 1 and Phase 3 each add several hours on a single-GPU box. Use the per-job estimate from the user's setup (if they have one) rather than guessing minutes. See `references/pitfalls.md` for the per-phase cost breakdown.

---

## Consolidated Pre-Flight — one gate, all three phases

**The pipeline has exactly one user gate.** Before any side-effecting action (docker pull, docker login, any job-launch call delegated to a downstream skill, file mutations under `${RESULTS_DIR}/`), the agent must produce a single consolidated Pre-Flight Summary that subsumes every downstream skill's preflight. Once the user approves, the run is autonomous through all three phases — no further interactive pauses.

The user explicitly does not want to be paged between phases. The DEFT loop's own inline `## Pre-Flight Summary` gate becomes a **zero-question display step** (every value pre-supplied), as does `tao-run-automl`'s shared launch preflight in Phases 1 and 3.

Before printing the gate the agent must read every downstream preflight section in full and run **every read-only check** those sections prescribe, surfacing each *outcome* in the summary. Running every step of the DEFT skill's `## Pre-Flight` is mandatory — if any step is skipped the consolidated gate is invalid and the pipeline must not advance. The summary must include, in order: (1) workspace/host/platform/network, (2) credentials SET/UNSET status, (3) resolved container image URIs with PRESENT/MISSING, (4) dataset table with leakage check, (5) Phase 1 config, (6) Phase 2 config incl. pre-seeded baseline source, (7) Phase 3 config, (8) compute estimate, (9) the confirmation line. After the gate, pass every collected value through to each downstream skill so it has nothing to ask. The only allowed post-gate pauses are mid-run hard-stop safety gates (e.g. DEFT's KPI regression gate); call them out in the summary.

See `references/preflight.md` for the full build procedure, the exact mandatory contents of each summary section (with the GPU memory rule of thumb, DEFT loop defaults, and required inputs verbatim), the downstream gate-suppression inputs, and the fallback when an older skill-bank version hard-codes its own STOP gate.

---

## Phase 1 — AutoML baseline

Invoke `tao-skill-bank:tao-run-automl` with:

| Input | AOI default | Notes |
|---|---|---|
| `network_arch` | `visual-changenet` | Same model the DEFT loop expects |
| `train_dataset_uri` | `<workspace>/train/base/training_set.csv` | Same training set DEFT will start from |
| `eval_dataset_uri` | `<workspace>/train/base/validation_set.csv` | Held-out — must NOT be the KPI test set (`<workspace>/kpi/testing_set.csv`), since that set is reserved for DEFT's final reporting |
| `metric` | FAR @ 100% recall (preferred) or `val_loss` | See `references/pitfalls.md` — ChangeNet AOI is class-imbalanced, val_loss alone can mode-collapse |
| `algorithm` | `bayesian` | LLM-brain or `autoresearch` if compute is tight |
| `automl_max_recommendations` | 5–10 for AOI | More recs = better HPs but linear in compute |
| `spec_overrides` | Pin epochs / batch_size; sweep optimizer-related HPs only | Otherwise AutoML wanders into long-train regimes that blow Phase 2's budget |

After the sweep finishes, AutoML's `result["best"]["specs"]` is the winning hyperparameter dict.

### Handoff to Phase 2

Phase 1 hands over **two artifacts**: the winning *spec* and the winning *checkpoint*. Instead of retraining the same HPs in DEFT's baseline step, pre-seed DEFT's baseline state from Phase 1's outputs so DEFT starts at baseline inference → evaluate → RCA → iter 1. The four steps — write the merged `baseline_spec_automl.yaml`, copy the winning checkpoint into `${RESULTS_DIR}/baseline/train/`, initialise `deft_state.json` with `iterations.baseline.stage_completed == "train"` (and append the matching `loop_log.jsonl` entry), then invoke DEFT — are given verbatim with the exact code in `references/handoff.md`. `automl_policy: off` inside the loop is preserved.

### Quality check before handing off

Run a quick eval of the winning checkpoint against the held-out set: per-class prediction counts (if it collapsed to one class, evaluate the 2nd or 3rd best instead) and a comparison to a zero-shot ChangeNet baseline (if AutoML did not improve over zero-shot, surface that and pause). See `references/handoff.md`.

---

## Phase 2 — DEFT loop (plain training, baseline pre-seeded from Phase 1)

Invoke `tao-skill-bank:tao-run-deft-aoi` (read its `SKILL.md` for the full interface). For non-AOI applications, invoke the matching DEFT skill; the handoff shape is the same.

**The DEFT loop's baseline-train sub-step is skipped.** Phase 1 already produced a checkpoint trained at the winning HPs, and Phase 1's handoff (see above) pre-populated `${RESULTS_DIR}/baseline/train/` and `${RESULTS_DIR}/deft_state.json` so DEFT resumes at baseline inference → evaluate → RCA → iter 1. The rest of the DEFT loop runs unchanged. **Do not modify its `automl_policy: off` invariant.**

The DEFT loop owns:

- The Pre-Flight Summary display step — **not** a fresh user gate. The Consolidated Pre-Flight (above) is the single gate; the DEFT summary still prints as an audit-trail display of the pre-seeded `baseline/train/` source but must not re-prompt, since every input was collected in the consolidated gate.
- Baseline inference → evaluate → RCA on the pre-seeded checkpoint, and the full per-iteration RCA → routing → SDG → mining → assemble → train cycle.
- KPI gating and stop conditions; `${RESULTS_DIR}/` layout, `deft_state.json`, `loop_log.jsonl`, `DEFT_Loop_Report.html`.

After the loop exits (KPI met or `max_iterations` reached), capture two values from `deft_state.json`:

- `iterations.<best>.best_ckpt_path` — the loop's best plain-train checkpoint
- The final iteration label `N_final` — used to locate the augmented training CSV

If the DEFT loop hard-stops on an unrecoverable gate, **skip Phase 3**. There is no validated augmented CSV to feed AutoML.

---

## Phase 3 — AutoML refinement on the DEFT-augmented dataset

Re-invoke `tao-skill-bank:tao-run-automl` with the augmented training CSV as the train dataset, the same held-out validation CSV as before, and **Phase 2's iter winner checkpoint as the warm-start**:

| Input | AOI value |
|---|---|
| `network_arch` | `visual-changenet` |
| `train_dataset_uri` | `${RESULTS_DIR}/iter${N_final}/dataset/train_combined_iter${N_final}.csv` |
| `eval_dataset_uri` | Same as Phase 1 (`<workspace>/train/base/validation_set.csv`) — keep the comparison apples-to-apples |
| `metric` | Same metric as Phase 1 |
| `algorithm` | Same as Phase 1 |
| `automl_max_recommendations` | 5–10 |
| Initial spec | Start from `<workspace>/specs/baseline_spec_automl.yaml` (Phase 1's winner) — gives the sweep a strong centroid to refine around |
| **Warm-start checkpoint** | **`iterations.<best>.best_ckpt_path` from `${RESULTS_DIR}/deft_state.json`** — set `spec_overrides["train"]["pretrained_model_path"]` to this path. Each Phase 3 rec then **fine-tunes from Phase 2's winner** instead of training from scratch. |

The warm-start is **mandatory**: with no warm-start, every rec starts from random init with only 10-20 epochs to reconverge, Phase 3's `val_loss` regresses 0.03-0.05 vs iter1, and the `_pick_best` safety net silently rolls back to the iter winner — wasting Phase 3's compute. The concrete `spec_overrides` code (selecting the lowest-`far_pct` iteration, excluding any prior `final_automl`), the broad-exploration tradeoff, output to `${RESULTS_DIR}/final_automl/`, and wiring Phase 3's checkpoint back into the DEFT report via `iterations.final_automl` + re-running `prepare_inference_spec.py` (with the `_pick_best` regression safety net) are all in `references/handoff.md`.

---

## Pitfalls and quality checks

These apply to both AutoML phases — bake them into agent behavior, don't just paste once. The full detail is in `references/pitfalls.md`:

- **Metric pitfalls (AOI is class-imbalanced).** ChangeNet AOI is PASS-dominant; `val_loss` can mode-collapse to a zero-recall PASS-everything model. Prefer FAR @ 100%-recall directly, or gate val_loss with a `pred_counts` sanity check, or decide top-K by FAR @ 100%-recall. For balanced / regression tasks, val_loss is fine.
- **Run-to-run noise.** AutoML can show 2–3× metric variance for the same config. If the winner looks suspiciously better than the runner-up, re-run with a fresh seed before committing the spec to Phase 2.
- **Cleanliness (data leakage).** Both AutoML phases use a validation set distinct from the KPI test set (`kpi/testing_set.csv`), which stays untouched until DEFT's evaluate stage. Phase 3 trains on the augmented CSV but keeps the same val set so Phase 1 and Phase 3 numbers stay comparable.
- **Compute budget.** Surface the per-phase structure up front and only give a wall-clock range after the user supplies their per-job time.

---

## Quick Start (AOI worked example)

When starting fresh from "run the AOI workflow", the agent delivers a three-phase worded message to the user (Phase 1 AutoML baseline → Phase 2 DEFT loop → Phase 3 AutoML refinement, with the cost framing and "OK to proceed?" close), then after confirmation invokes `tao-run-automl` (Phase 1), writes the merged spec, pre-seeds `deft_state.json`, invokes `tao-run-deft-aoi` (Phase 2) with every input pre-supplied, and invokes `tao-run-automl` again (Phase 3) — with no further pauses unless a downstream skill hits an unrecoverable hard-stop gate — then summarizes the trajectory (baseline AutoML best → DEFT iter 1 → ... → DEFT iter N_final → Phase 3 best).

See `references/quick-start.md` for the verbatim customer-facing message and the exact post-confirmation invoke sequence.

## Non-AOI DEFT applications

The same three-phase pattern applies to other DEFT skills — swap `network_arch`, the Phase 2 DEFT skill, the spec/checkpoint path conventions, and the Phase 3 augmented-CSV path. The handoff shape (Phase 1 emits spec + checkpoint that pre-seeds the DEFT baseline, Phase 2 emits an augmented dataset, Phase 3 emits the final checkpoint) is identical, and the baseline-skip mechanism is generic to any DEFT-style loop with a resumable baseline state. See `references/quick-start.md`.

---

## See also

- `tao-skill-bank:tao-run-automl` — AutoML interface, algorithms, HP ranges
- `tao-skill-bank:tao-run-deft-aoi` — full DEFT AOI loop (Phase 2 default)
- `tao-skill-bank:tao-train-visual-changenet` — underlying ChangeNet train/eval/infer skill (used by both AutoML and DEFT)
- Other `skills/applications/deft-*` skills — non-AOI Phase 2 targets
- `references/preflight.md` — building the consolidated pre-flight gate
- `references/handoff.md` — Phase 1→2 pre-seed, Phase 2 quality check, Phase 3 warm-start + report wiring
- `references/pitfalls.md` — metric, noise, leakage, and compute-budget guidance
- `references/quick-start.md` — verbatim worked-example message and non-AOI variant
