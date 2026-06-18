# Auto-Labeling Only


## Table of Contents

- [When to use](#when-to-use)
- [Graph](#graph)
- [Inputs](#inputs)
- [Submit](#submit)
- [Output layout](#output-layout)
- [Troubleshooting](#troubleshooting)

Runs pseudo-labeling on original source video(s) only. No augmentation group.

## When to use

- User requests labeling without synthetic augmentation.
- Quick baseline labels are needed on source video.
- GPU budget should be kept to minimal worker footprint.

## Graph

```text
setup_group
  setup
    -> stages scripts + cookbook configs + .env
      ▼
auto_labeling_group
  pl_original_worker_0
    -> pseudo-labeled original outputs
```

## Inputs

| Input | Source | Required by |
|---|---|---|
| Source video | `<storage_url>/datasets/<dataset>/<video>.mp4` | `setup`, `pl_original_worker_0` |
| Auto-labeling cache | `<storage_url>/data/models/auto_labeling` | `pl_original_worker_0` |
| VLM endpoint | default in-cluster NIM or explicit override | `pl_original_worker_0` |
| LLM endpoint | default in-cluster NIM or explicit override | `pl_original_worker_0` |

## Submit

Use the shared submit command and the common optional-overrides block in the
`SKILL.md` "Submit (all flows)" section, with workflow YAML
`assets/configs/osmo/auto_labeling.yaml`. This flow labels original videos only —
there is no augmentation stage. Keep the shared canonical single-flag submit shape
for consistency; the extra cosmos cache value is ignored by this flow.

## Output layout

```text
<storage_url>/datasets/<dataset>-outputs/<run_id>/
├─ setup_b0/
└─ outputs/
   └─ pseudo_labeled/<video>/
```

## Troubleshooting

- If OSMO reports group self-dependency errors, ensure workflow uses
  `setup_group` -> `auto_labeling_group` (not single merged pipeline group).
- If endpoint probe waits repeatedly, verify URL includes `/v1` and is reachable
  from pods.
