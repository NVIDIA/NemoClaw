<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# usd-optimize / Scene Optimizer Package Handoff

Scene Optimizer operation mechanics are owned by upstream `usd-optimize` and
ship with the prebuilt Scene Optimizer package. This package owns digital twin
workflow routing, runtime setup context, validation scope, output workspace
policy, batch orchestration, and reporting.

- Public repository: [https://github.com/NVIDIA-omniverse/usd-optimize/](https://github.com/NVIDIA-omniverse/usd-optimize/)
- Prebuilt package pattern: `scene_optimizer_core_usd_<usd>_py_<python>@<version>.<platform>.release.zip`
- Linux direct archive: `https://d4i3qtqj3r0z5.cloudfront.net/scene_optimizer_core_usd_25.11_py_3.12%40110.1.0%2Bmaster.401.324ccecb.gl.manylinux_2_35_x86_64.release.zip`
- Windows direct archive: `https://d4i3qtqj3r0z5.cloudfront.net/scene_optimizer_core_usd_25.11_py_3.12%40110.1.0%2Bmaster.401.324ccecb.gl.windows-x86_64.release.zip`
- Package operation guides: `.agents/operations/<operation>.md`
- Package operation runner skill: `.agents/skills/run-operations/SKILL.md`
- Package validator runner skill: `.agents/skills/run-validators/SKILL.md`
- Package validator interpretation skill: `.agents/skills/interpret-validators/SKILL.md`
- Package proxy skill: `.agents/skills/create-proxy/SKILL.md`
- Package install skill: `.agents/skills/prebuilt-package/SKILL.md`

## Operation Guide Resolution

For any operation key listed in `references/operations/manifest.json`, derive
the upstream mechanics path instead of storing per-operation package details in
this repo:

- Package path template: `.agents/operations/<operation-key>.md`
- Upstream web URL template: `https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/operations/<operation-key>.md`
- Package operation index: `.agents/operations/INDEX.md`

Resolve local upstream guidance without cloning the source repo:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT`
2. `$SO_HOME`

Each root above must contain `.agents/operations/INDEX.md` and the runtime
sentinels `python/`, `usdpy/`, `lib/`, and `extraLibs/` when it is also used
for standalone execution. The package may include `.claude` and `.codex`
compatibility aliases, but handoffs should use `.agents` paths.

If no package root exists, download and extract the published
`scene_optimizer_core_...release.zip` package for the target platform, or use
the package archive path, direct archive URL, or extracted package root
supplied by the user. If web or raw GitHub fetch is available, the public
repository URL can be used for docs-only reads. Do not clone the source repo
just to read operation parameters, defaults, or implementation gotchas.

Local operation files under `references/operations/<operation-key>.md` keep only
routing frontmatter. Use `references/operations/manifest.json` and
`references/operations/_curation.json` for digitaltwin routing, risk,
confirmation, and recommendation posture. Before invoking any operation, consume
`<output_path>/setup-preflight.json` and confirm the op appears in
`sceneOptimizer.operationsAvailable`.
