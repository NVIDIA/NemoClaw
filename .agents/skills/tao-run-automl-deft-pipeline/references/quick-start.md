# Quick Start (AOI Worked Example) and Non-AOI Variant

## Quick Start (AOI worked example)

This is what the agent says to the user when starting fresh from "run the AOI workflow":

> I'll run the canonical AOI training pipeline in three phases:
>
> **Phase 1 — AutoML baseline.** I'll sweep `<N>` configs over `<HP list>` against `<workspace>/train/base/validation_set.csv` using `bayesian` with FAR @ 100%-recall as the metric (AOI is class-imbalanced, val_loss alone risks mode collapse). After it finishes I'll spot-check per-class prediction counts before declaring a winner. The winning spec is saved to `specs/baseline_spec_automl.yaml` and the winning **checkpoint** is staged into `${RESULTS_DIR}/baseline/train/`.
>
> **Phase 2 — DEFT loop.** Phase 1's checkpoint is reused as DEFT's baseline — no redundant retrain. DEFT resumes at baseline inference → evaluate → RCA → iter 1 and continues plain-train inside the loop (`automl_policy: off` preserved). The loop runs until the KPI target is met or `max_iterations` is reached. The DEFT skill's inline Pre-Flight Summary still prints (audit trail showing the pre-seeded baseline), but is **not** a second approval point — every input was collected in the consolidated gate above.
>
> **Phase 3 — AutoML refinement.** Final AutoML sweep on the DEFT-augmented CSV (`train_combined_iter${N_final}.csv`), **warm-starting each rec from Phase 2's iter winner checkpoint** so the sweep is HP refinement on a converged model rather than from-scratch retraining (without this, Phase 3 routinely regresses against iter1 on small datasets). The winning checkpoint of this sweep is the deliverable — there's no follow-up retrain. I'll register it under `state.iterations.final_automl` and re-run `prepare_inference_spec.py` so `best_model.json` and `best_model_inference_spec.yaml` point to it — unless Phase 3 regresses, in which case the loop's best iteration wins on the same metric.
>
> Total cost is `<N_automl>` AutoML training jobs × 2 sweeps + `<M_iter>` DEFT iterations (each with SDG + retrain). No extra baseline retrain at the front; no extra retrain at the end — Phase 1's winner is DEFT's baseline, Phase 3's winner is the deliverable. If you can tell me roughly how long one ChangeNet training run takes on your hardware I can give you a wall-clock estimate. OK to proceed?

After confirmation, invoke `tao-skill-bank:tao-run-automl` (Phase 1), write the merged spec, pre-seed `deft_state.json`, invoke `tao-skill-bank:tao-run-deft-aoi` with every input pre-supplied so its inline summary is a display step rather than a re-prompt, then `tao-skill-bank:tao-run-automl` again (Phase 3). No further user pauses unless a downstream skill hits an unrecoverable hard-stop gate (called out in the consolidated summary). Summarize the trajectory at the end: baseline AutoML best → DEFT iter 1 → ... → DEFT iter N_final → Phase 3 best, so the user sees where the gains came from.

## Non-AOI DEFT applications

Same three-phase pattern applies to other DEFT skills. Swap:

- `network_arch` to the relevant model
- The DEFT skill invoked in Phase 2
- The "best HP spec file" and "best HP checkpoint" path conventions to whatever the target DEFT skill expects
- The augmented-CSV path in Phase 3 to whatever the target DEFT skill produces

The handoff shape — Phase 1 emits a *spec + checkpoint* (the checkpoint pre-seeds the DEFT baseline), Phase 2 consumes both and emits an augmented dataset, Phase 3 emits the final checkpoint — is identical. The Phase 1 → Phase 2 baseline-skip mechanism is generic: any DEFT-style loop that exposes a resumable baseline state can be seeded the same way.
