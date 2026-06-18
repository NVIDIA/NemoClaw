---
name: tao-train-single-step
description: Standard single-step train/eval/export workflow for any TAO model. Use when training a TAO model on a dataset
  without iterative data augmentation, AutoML, or DEFT loops. Trigger phrases include "single train run", "train then evaluate
  then export", "plain TAO training", "normal training", "no AutoML", "skip the loop". Routes through the per-model SKILL.md
  for action specifics and through `tao-launch-workflow` for platform/credentials/dataset intake.
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit. Workflows declare additional requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write
tags:
- training
- single-step
- generic
---

# Normal Train

Standard supervised fine-tuning: train a model on a labeled dataset, optionally evaluate, then optionally export. The most common TAO workflow for adapting a pretrained model to a new dataset.

## Steps

1. **train** — executed through AutoML when the selected model has
   `automl_enabled: true` and `automl_policy` is `auto`; set
   `automl_policy=off` for a plain single training run
2. **eval** — executed if `eval_dataset_uri` is resolved
3. **export** — optional, on user request after training

## Prerequisites

### Required
- **model**: A compatible TAO model (e.g., clip, nvdinov2, grounding_dino)
- **train_dataset_uri**: URI of the training dataset (e.g., `s3://bucket/train/`)
- **platform**: Ask from the generated supported-platform list:
  `${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py --format text`
- **container image confirmation**: resolve the default image from the selected
  model/action config, show it to the user, and require confirmation or
  `image=<override>` before creating runner files or submitting training.

### Optional
- **eval_dataset_uri**: Some model skills mark this as required — check the resolved model skill before treating it as optional.
- **base_checkpoint**: If not provided, defaults to the NGC pretrained checkpoint listed in the model skill, or trains from scratch if no NGC checkpoint exists.
- **automl_policy**: `auto` by default; set `off` to bypass model-level AutoML for this run while leaving model metadata unchanged.
- **image override**: Use `image=<override>` to pin a specific TAO toolkit build
  after reviewing the resolved default.

## Launch Intake

After the user confirms they want this standard train/eval/export workflow,
ask which supported platform they intend to run on. Generate the choices with
`scripts/list_tao_platforms.py --format text`; do not scan platform docs or
folders.

Before creating a plain train runner, inspect the selected model's metadata
with `scripts/list_tao_models.py --scope automl --format json` or read
`skills/models/<network>/references/skill_info.yaml`. If `automl_enabled` is true and
the helper reports a valid train schema for that model, route the train stage
through `skills/applications/tao-run-automl` by default. Only stay on the plain train path
when `automl_policy=off`, the user explicitly asks for no HPO/AutoML, or AutoML
is enabled but not runnable because the model's train schema is not packaged
yet.

Also ask whether long-running monitoring should stay enabled and how many
minutes between status updates. Defaults: enabled, 5 minutes.

After the model/action are known, run `scripts/resolve_tao_image.py --model
<network> --action train --format text` and ask whether to use the resolved
image or an `image=<override>`. Do not create the tao-train-single-step runner until the
image is confirmed.

After platform selection, run
`scripts/list_tao_platforms.py --platform <platform> --format text` and ask
only for credentials relevant to that platform, plus any selected-model
credentials. Do not ask for unrelated platform credentials.
