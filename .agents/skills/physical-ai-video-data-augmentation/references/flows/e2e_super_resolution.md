# E2E (Super-Resolution Gated)


## Table of Contents

- [When to use](#when-to-use)
- [Graph](#graph)
- [Inputs](#inputs)
- [Submit](#submit)
- [Output layout](#output-layout)
- [Troubleshooting](#troubleshooting)

Runs full VDA graph in sequential order where original auto-labeling (with SR
enabled in setup `.env`) gates augmentation, then labels augmented outputs.

## When to use

- User requests SR-gated end-to-end execution.
- User prefers deterministic sequencing over parallel throughput.
- Hardware/resources favor sequential stage progression.

## Graph

```text
setup_group
  setup (SUPER_RESOLUTION_ENABLED=true)
      ▼
auto_labeling_original_group
  pl_original_worker_0
      ▼
augmentation_group
  cosmos_worker_0
      ▼
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
`assets/configs/osmo/e2e_super_resolution.yaml`. This flow runs the SR-gated
sequential pipeline, so the full canonical single-flag submit shape applies
(including both cache URL values).

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
- If this mode appears parallel, confirm you submitted
  `e2e_super_resolution.yaml` (not `e2e.yaml`).
- If augmentation starts before original AL completion, inspect group/task
  dependencies in rendered workflow.
