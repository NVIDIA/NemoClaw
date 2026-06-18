# Phase Handoffs and Warm-Start

This covers the Phase 1 → Phase 2 baseline pre-seed (spec + checkpoint), the Phase 2 quality check, and the Phase 3 warm-start `spec_overrides` pattern plus wiring Phase 3's output back into the DEFT report.

## Phase 1 → Phase 2 handoff

Phase 1 hands over **two artifacts**: the winning *spec* and the winning *checkpoint*. Retraining the same HPs in DEFT's baseline step is wasted compute — instead, pre-seed DEFT's baseline state from Phase 1's outputs so DEFT starts at baseline inference → evaluate → RCA → iter 1.

**Step 1 — Write the merged spec.** Deep-merge `result["best"]["specs"]` onto `<workspace>/specs/baseline_spec.yaml` (preserve dataset paths, model architecture, lighting layout; overwrite only the HPs AutoML tuned) and write to `<workspace>/specs/baseline_spec_automl.yaml`. Copy this onto the path DEFT reads:

```bash
cp <workspace>/specs/baseline_spec_automl.yaml <workspace>/specs/baseline_spec.yaml
```

**Step 2 — Pre-seed DEFT's baseline.** Locate the winning AutoML rec's best checkpoint (the AutoMLRunner writes `result["best"]["best_checkpoint_path"]` — pass through `eval_fn` for FAR-@-100%-recall metric capture). Pick the DEFT run-id (timestamped subdir under `<workspace>/results/`) and create `${RESULTS_DIR}/baseline/train/`. Copy the AutoML checkpoint into that directory using the filename convention DEFT expects (`model_epoch_<EEE>_step_<SSS>.pth`).

**Step 3 — Initialise `deft_state.json` with baseline already done.** Use `tao-run-deft-aoi/scripts/init_deft_state.py` to write the initial state, then patch in the `iterations.baseline` entry:

```python
import json, pathlib, shutil

state_path = pathlib.Path(f"{RESULTS_DIR}/deft_state.json")
state = json.loads(state_path.read_text())
state["iterations"]["baseline"] = {
    "stage_completed": "train",                      # so DEFT's resume picks up at inference
    "best_ckpt_path": str(baseline_ckpt_path),       # absolute host path
    "train_metric": phase1_winning_metric,            # FAR @ 100% recall captured by Phase 1's eval_fn
    "source": "automl_phase1",                        # provenance flag — not a DEFT-generated checkpoint
}
state_path.write_text(json.dumps(state, indent=2))
```

Append a matching `baseline.train` entry to `loop_log.jsonl` via `scripts/log_stage.py` with `--status ok --summary "baseline train skipped — reused Phase 1 AutoML winning checkpoint"`.

**Step 4 — Invoke DEFT.** When the DEFT loop reads its state on startup it will see `iterations.baseline.stage_completed == "train"` and skip directly to baseline inference → evaluate → RCA → iter 1. `automl_policy: off` inside the loop is preserved.

> **DEFT honors this handoff.** `tao-run-deft-aoi` checks `iterations.baseline.stage_completed == "train"` on startup (Workflow step 2 / Pipeline baseline block in its `SKILL.md`) and resumes at baseline inference against the pre-seeded checkpoint — no retrain.

## Quality check before handing off

Run a quick eval of the winning checkpoint against the held-out set:

- Per-class prediction counts — if it collapsed to one class, the winning HPs are useless for Phase 2. Evaluate the 2nd or 3rd best instead.
- Compare to a zero-shot ChangeNet baseline. If AutoML did not improve over zero-shot, surface that to the user and pause before continuing.

## Phase 3 warm-start — why it is mandatory

Phase 3 receives a small augmented dataset (often a few hundred rows) and a tight epoch budget per rec (typically the same `num_epochs` Phase 1 used). With **no warm-start**, every rec starts from random init and only has 10-20 epochs to reconverge — not enough to outperform the iter winner which already trained for ~baseline + N×iter epochs. Result: Phase 3's `val_loss` regresses by 0.03-0.05 vs iter1, and the `_pick_best` safety net silently rolls back to the iter winner, wasting Phase 3's entire compute.

With warm-start, each rec is doing **targeted HP refinement on a converged model** instead of "train from scratch with slightly different LR". Empirically, this is the difference between Phase 3 routinely regressing and Phase 3 routinely improving.

Tradeoff: warm-starting from `iterations.<best>.best_ckpt_path` means Phase 3 is exploring a narrower region around the iter winner's weights, so it won't discover radically different optima — but for HP *refinement* on a small augmented set, that's the right inductive bias. If you want broad exploration instead, run a separate `tao-run-automl` sweep with no warm-start; don't conflate the two.

## Concrete `spec_overrides` pattern

```python
import json
state = json.loads((RESULTS_DIR / "deft_state.json").read_text())
# _pick_best preferred: lowest far_pct among iterations
best_iter, best_entry = min(
    (k, v) for k, v in state["iterations"].items() if v.get("far_pct") is not None
    and k not in ("final_automl",)                  # don't warm-start from a prior Phase 3
), key=lambda kv: kv[1]["far_pct"])
warmstart_ckpt = best_entry["best_ckpt_path"]
spec_overrides["train"]["pretrained_model_path"] = warmstart_ckpt
```

Output goes to `${RESULTS_DIR}/final_automl/`. The winning checkpoint of this sweep is the pipeline's deliverable.

## Wiring Phase 3's output back into the DEFT report

`tao-run-deft-aoi`'s `scripts/prepare_inference_spec.py` selects the lowest-`far_pct` entry from `deft_state.json["iterations"]`. To make Phase 3's checkpoint visible to the handoff:

1. Append an entry to `${RESULTS_DIR}/deft_state.json` under `iterations.final_automl` with the same shape as iteration entries (`best_ckpt_path`, `threshold`, `far_pct`) — populate from Phase 3's eval output.
2. Re-run `python ${TAO_SKILL_BANK_PATH}/applications/tao-run-deft-aoi/scripts/prepare_inference_spec.py --results-dir ${RESULTS_DIR}`. The script's `_pick_best` will now see the Phase 3 entry and select it on `far_pct` (or fall back to the loop's best if Phase 3 regressed — see safety note below).

**Safety note.** Phase 3 is not guaranteed to beat the loop's best iteration — AutoML can over-fit a small augmented dataset. The `_pick_best` lowest-`far_pct` tie-break protects against this: if Phase 3's checkpoint is worse, the iteration winner is still selected. Surface both numbers to the user in the final summary so the regression is visible.
