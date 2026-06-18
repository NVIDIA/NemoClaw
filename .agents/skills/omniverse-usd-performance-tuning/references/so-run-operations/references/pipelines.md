<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pipeline Recipes - Upstream Handoff

This local reference preserves the digitaltwin workflow milestone. Scene
Optimizer mechanics for this step are owned by upstream `usd-optimize`.

- Public repository: [https://github.com/NVIDIA-omniverse/usd-optimize/](https://github.com/NVIDIA-omniverse/usd-optimize/)
- Package path: `.agents/operations/PIPELINES.md`
- Upstream web URL: [https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/operations/PIPELINES.md](https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/operations/PIPELINES.md)

Resolve the upstream guide without cloning the source repo:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT/.agents/operations/PIPELINES.md`
2. `$SO_HOME/.agents/operations/PIPELINES.md`

If no package root is available, download and extract the published
`scene_optimizer_core_...release.zip` package for the target platform (direct
archive URLs are in `references/upstreams/usd-optimize.md`), or use the package
path/URL supplied by the user. If the user supplies an extracted
package root directly, resolve this same package path under that root. If
GitHub raw fetch is available, the web URL above is acceptable for docs-only
reads. Do not clone the source repo just to read upstream SO guidance.

## Local Responsibilities

- Keep workflow phase order, prototype-first ordering, and broad optimization milestone ordering in `workflow.md`.
- Use `config-from-evidence.md` for local evidence-to-request routing and `operation-safety.md` for approvals.
- Use `batch-mode.md` for digitaltwin's agent-orchestrated multi-target policy: adaptive concurrency, dependency-aware target groups, and remainder-script prompts.

Named pipeline parameters and per-operation defaults belong upstream. If a
digitaltwin workflow needs to cite a chain, cite the upstream path and record
only the local evidence, target set, approval state, and report fields here.

## Local Routing Keys

The local workflow may route evidence to these operation keys before handing
mechanics to upstream: `computeExtents`, `decimateMeshes`,
`deduplicateGeometry`, `fitPrimitives`, `generateNormals`, `meshCleanup`,
`optimizeMaterials`, `optimizeTimeSamples`, `pruneLeaves`, `pythonScript`,
`removeSmallGeometry`, and `removeUnusedUVs`.
