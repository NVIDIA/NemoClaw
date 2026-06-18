# E2E (Parallel)


## Table of Contents

- [When to use](#when-to-use)
- [Graph](#graph)
- [Inputs](#inputs)
- [Submit](#submit)
- [Output layout](#output-layout)
- [Troubleshooting](#troubleshooting)

Runs full VDA graph with parallel original auto-labeling and augmentation after
setup, then labels augmented outputs.

## When to use

- User requests full pipeline and prefers throughput.
- Original labels and augmented labels are both needed in one run.
- SR-gated sequencing is not required.

## Graph

```text
setup_group
  setup
      ▼
auto_labeling_original_group         augmentation_group
  pl_original_worker_0         ||      cosmos_worker_0
      ▼                                ▼
             auto_labeling_augmented_group
                   pl_augmented_worker_0
```

## Inputs

| Input | Source | Required by |
|---|---|---|
| Source video | `<storage_url>/datasets/<dataset>/<video>.mp4` | setup + original AL + augmentation |
| Cosmos cache | `<storage_url>/data/models/cosmos_transfer` | `cosmos_worker_0` |
| Auto-labeling cache | `<storage_url>/data/models/auto_labeling` | `pl_original_worker_0`, `pl_augmented_worker_0` |
| VLM endpoint | default in-cluster NIM or explicit override | all workers |
| LLM endpoint | default in-cluster NIM or explicit override | all workers |

## Submit

Use the shared submit command and the common optional-overrides block in the
`SKILL.md` "Submit (all flows)" section, with workflow YAML
`assets/configs/osmo/e2e.yaml`. This flow runs original labeling and augmentation in
parallel before augmented labeling, so the full canonical single-flag submit shape
applies (including both cache URL values).

## Output layout

```text
<storage_url>/datasets/<dataset>-outputs/<run_id>/
├─ setup_b0/
└─ outputs/
   ├─ pseudo_labeled/<video>/
   ├─ augmented/<video>_aug0/
   └─ pseudo_labeled_augmented/<video>_aug0/
```

## Troubleshooting

- Completion evidence requirement: include a side-by-side input vs augmented
  video artifact, augmentation summary (`setup_b0/configs/manifest.yaml`
  `sampled_vars` for `<video>_aug0`), and auto-labeling artifact summaries for
  both `outputs/pseudo_labeled/<video>` and
  `outputs/pseudo_labeled_augmented/<video>_aug0` using the workspace-local run
  copy under `media/vda/runs/<run_id>/`.
- If original and augmentation groups do not run in parallel, verify no
  accidental task dependency was introduced between `pl_original_worker_0` and
  `cosmos_worker_0`.
- If augmented-label step cannot start, inspect `cosmos_worker_0` output path
  and readiness first.
