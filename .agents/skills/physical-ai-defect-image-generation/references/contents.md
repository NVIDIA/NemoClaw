# DIG skill — file inventory

Authoritative list of supporting files shipped with the
`physical-ai-defect-image-generation` skill. SKILL.md's "Supporting files"
section points here.

## Workflow YAMLs and cookbooks

- `assets/configs/*.yaml` — six flow YAMLs (one per row in SKILL.md
  §"Flow walkthroughs") plus `setup/setup_{pretrained,pcb,metal,glass}.yaml`.
  See each flow's walkthrough for submit semantics.
- `assets/cookbooks/{pcb,metal_surface,glass}/` — per-usecase render / crop
  / training cookbooks. Per-board PCBA cookbooks under `pcb/<board>/`.
  Mounted via `localpath:`; sentinels patched at task start.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/preflight_credentials.sh` | Verify the OSMO `hf-token` cred (Common Preconditions §1; images are public on `nvcr.io/nvidia/`, no registry cred needed). |
| `scripts/preflight_pod_template.sh` | Verify OSMO POD_TEMPLATE has `nvoptix` hostPath + `/dev/shm ≥ 16Gi` (§2). Exit codes 0=OK, 1=malformed, 2=403, 3=409, 4=env-fix. |
| `scripts/preflight_urls.sh` | Verify per-flow URL artifacts under `<dig_url_root>` (§3). Args: `<flow:0|1|finetune> <usecase> [variant]`. |
| `scripts/render_defect_spec.py` | AnomalyGen AMP routing fallback (renders `defect_spec.jsonl` from a cookbook). |
| `scripts/pick_best_step.sh` | Pick the highest-`nn_score` checkpoint step from a finetune run's validation logs. |

## References

- `references/preconditions.md` — long-form for SKILL.md §"Common Preconditions" (credentials, pod template, URL artifacts, name stamping, glass UC3 zip, shipped checkpoint defaults, memory rules §4a).
- `references/setup.md` — full `setup/` workflow run-throughs, knob tables, dataset upload procedure, glass UC3 Roboflow zip procedure, bring-your-own-data layout.
- `references/troubleshooting.md` — operational gotchas, log parsing recipes, common failures.
- `references/container-images.md` — image-tag table for all flow tasks (paidf-anomalygen / paidf-simulation / paidf-augmentation).
- `references/disambiguation.md` — full trigger table + prompt construction guidance + when-NOT-to-ask exceptions.
- `references/knob_mapping.md` — full user-intent → `--set` knob table, `crop_max_emit` semantics, per-flow caveats.
- `references/gpu_sizing.md` — per-GPU `train_*` / `infer_*` CPU + memory scaling table for finetune and inference tasks; consult before any multi-GPU submit.
- `references/monitoring.md` — polling cadence, task-status interpretation, log-pull escalation thresholds, failure-classification routing, and post-submit watch-loop discipline. Load before any `osmo workflow submit`, `osmo workflow query`, or `osmo workflow logs` action.
- `references/output_retrieval.md` — `osmo data download` / MinIO `mc cp` commands + canonical anomaly tree.
- `references/output_rendering.md` — presenting outputs to the user (zip archive + preview-grid HTML); the agent's canvas-dir rules.
- `references/flows/*.md` — per-flow walkthroughs (group diagrams, submit-command variants, data handoffs, per-stage troubleshooting).
- `references/nim/` — Day-0 image-edit endpoint manifest + README (Option B local deploy).

## Evals and component skills

- `evals/evals.json` — skill-creator evals (Day 0 PCBA, Day 1 metal_surface, glass finetune).
- Component skills (`skills/{simulation,augmentation,anomalygen,physical-ai-infrastructure-setup-and-resilient-scaling}/SKILL.md`) — consult for issues that originate inside a component's code.
