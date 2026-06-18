# Augmentation + Auto-Labeling


## Table of Contents

- [When to use](#when-to-use)
- [Graph](#graph)
- [Inputs](#inputs)
- [Submit](#submit)
- [Output layout](#output-layout)
- [Troubleshooting](#troubleshooting)

Runs augmentation on source video(s) and then auto-labels augmented outputs.
Original-video auto-labeling is not part of this flow.

## When to use

- User wants synthetic variants plus labels for those variants.
- User does not need labels on source/original video path in the same run.
- User wants a smaller graph than `e2e` while keeping augmentation + AL.

## Graph

```text
setup_group
  setup
    -> stages scripts + cookbook configs + generated per-video configs + .env
      ▼
augmentation_group
  cosmos_worker_0
    -> augmented outputs
      ▼
auto_labeling_augmented_group
  pl_augmented_worker_0
    -> pseudo-labeled augmented outputs
```

## Inputs

| Input | Source | Required by |
|---|---|---|
| Source video | `<storage_url>/datasets/<dataset>/<video>.mp4` | `setup`, `cosmos_worker_0` |
| Cosmos cache | `<storage_url>/data/models/cosmos_transfer` | `cosmos_worker_0` |
| Auto-labeling cache | `<storage_url>/data/models/auto_labeling` | `pl_augmented_worker_0` |
| VLM endpoint | default in-cluster NIM or explicit override | augmentation + AL workers |
| LLM endpoint | default in-cluster NIM or explicit override | augmentation + AL workers |

## Submit

Use the shared submit command and the common optional-overrides block in the
`SKILL.md` "Submit (all flows)" section, with workflow YAML
`assets/configs/osmo/augmentation_and_al.yaml`. This flow runs augmentation
first, then auto-labels the augmented outputs, so the full canonical single-flag
submit shape applies (including both cache URL values).

## Output layout

```text
<storage_url>/datasets/<dataset>-outputs/<run_id>/
├─ setup_b0/
└─ outputs/
   ├─ augmented/<video>_aug0/
   └─ pseudo_labeled_augmented/<video>_aug0/
```

## Troubleshooting

- Completion evidence requirement: include a side-by-side input vs augmented
  video artifact, augmentation summary (`setup_b0/configs/manifest.yaml`
  `sampled_vars` for `<video>_aug0`), and augmented auto-labeling artifact
  summary from `outputs/pseudo_labeled_augmented/<video>_aug0` using the
  workspace-local run copy under `media/vda/runs/<run_id>/`.
- If submit fails with missing cache wiring, run `setup_model_cache.yaml` and
  rerun `pre_submit_guard.py`.
- If workers stall on endpoints, verify `vlm_url`/`llm_url` health and `/v1`
  availability before resubmitting.
