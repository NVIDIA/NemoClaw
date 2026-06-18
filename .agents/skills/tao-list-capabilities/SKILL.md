---
name: tao-list-capabilities
description: >-
  Answer what the TAO Skill Bank plugin can do by generating the response from
  packaged application, data, model, AutoML, and platform manifests.
license: Apache-2.0
compatibility: Requires the packaged TAO skill bank helper scripts.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- tao
- capabilities
- discovery
---

# TAO Skill Bank Capabilities

Use this skill when the user asks what `tao-skill-bank` can do, asks for plugin
capabilities, asks which application or data workflows are available, asks which
models are supported, or asks what models are capable with AutoML.

## Quick Start

Run `scripts/list_tao_capabilities.py` for general capability questions, or
`scripts/list_tao_models.py` for model/action and AutoML support questions.

## Capability Answers

For a general capabilities answer, run the packaged helper:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_capabilities.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --format text
```

Use the helper output as the source of truth for the answer instead of manually
enumerating capabilities from this skill or plugin metadata. Include:

- Every top-level application workflow under `applications/` and what it can do.
- Every top-level data workflow under `data/` and what it can do.
- Supported execution platforms from `scripts/list_tao_platforms.py`.
- The fine-tuning/deployment workflow coverage for models under `models/`: train,
  evaluate, inference, export, and TensorRT engine generation when those actions
  are present in the packaged schema manifest.
- AutoML support and the AutoML train-schema gate.

## Model Lists

When the user asks which TAO models are available or which actions a model can
run, use the packaged model-list script instead of manually scanning model
folders:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_models.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --scope all --format text
```

The model list comes from `skills/models/schemas.manifest.json`.

## AutoML Lists

When the user asks what models are capable with AutoML, use the same model-list
script in AutoML mode, or the compatibility wrapper:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_models.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --scope automl --format text
```

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_automl_support.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --format text
```

AutoML support requires `skills/models/<network>/schemas/train.schema.json` to be
packaged with the plugin and parse successfully as JSON. If that dataclass schema
is missing or invalid, do not describe the model as AutoML-supported.
