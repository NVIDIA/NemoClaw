<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Standalone Runtime Setup

Use this reference when the user chooses standalone libraries instead of Kit or
when no Kit candidate is available.

## Statuses

- `ready-standalone`: standalone Scene Optimizer and Asset Validator paths are
  selected and verified.
- `needs-runtime-choice`: setup cannot continue without the user choosing Kit,
  standalone, or installation.
- `blocked_missing_scene_optimizer`: the user requested Scene Optimizer but no
  supported SO runtime can be selected or installed.

## Scene Optimizer Prompt

When standalone Scene Optimizer is missing, ask before invoking
`install-so-standalone`. The prompt must include:

- Python 3.12 hard requirement.
- Approximate download size (~350-380 MB for the prebuilt standalone package).
- Intended install location.
- Requirement for a published `scene_optimizer_core_...release.zip` package
  archive path, direct archive URL, or extracted package root when no package
  root is already available.
- SO validators auto-register into OAV via `@register_rule` decorators when
  both packages share the same Python environment — no manual enabling needed.
- Limitation that render-time profiling needs Kit.

Offer:

1. Proceed with standalone Scene Optimizer install.
2. Install Kit instead.
3. Stop and produce diagnosis-only output from available evidence.

If the user proceeds and Python 3.12 is missing, install or select Python 3.12
first, then invoke `install-so-standalone`.

## Expected Standalone Layout

Scene Optimizer standalone uses:

```text
<SO_HOME>/.agents/operations/INDEX.md
<SO_HOME>/python
<SO_HOME>/usdpy
<SO_HOME>/lib
<SO_HOME>/extraLibs
```

Invoke `install-so-standalone` when `SCENE_OPTIMIZER_PACKAGE_ROOT`, `SO_HOME`,
or `WU_SO_PACKAGE_DIR` is missing or does not point at an extracted package with
the sentinel paths above. Do not clone the Scene Optimizer source repository to
satisfy standalone setup.

For standalone Omni Asset Validator, invoke `install-asset-validator-standalone`
when `omni_asset_validate` is missing. Install into the same venv that Scene
Optimizer uses — SO validators auto-register via `@register_rule` when both
packages are importable.

Do not use the Scene Optimizer package's bundled `validator-venv` as the
default Asset Validator runtime — it may lack `numpy` and is slower on large
stages.

## Handoff

After standalone setup, return to:

- `omniverse-usd-performance-tuning` for broad performance requests.
- `usd-validation-runner` for validation.
- `so-run-operations` only after Scene Optimizer operation availability is
  verified and recorded in `<output_path>/setup-preflight.json`.
