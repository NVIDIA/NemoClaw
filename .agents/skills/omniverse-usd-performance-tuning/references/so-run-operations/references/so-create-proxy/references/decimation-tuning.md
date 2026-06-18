<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Decimation Tuning - Upstream Handoff

This local reference preserves the digitaltwin workflow milestone. Scene
Optimizer mechanics for this step are owned by upstream `usd-optimize`.

- Public repository: [https://github.com/NVIDIA-omniverse/usd-optimize/](https://github.com/NVIDIA-omniverse/usd-optimize/)
- Package path: `.agents/skills/create-proxy/references/parameter-tuning.md`
- Upstream web URL: [https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/create-proxy/references/parameter-tuning.md](https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/create-proxy/references/parameter-tuning.md)

Resolve the upstream guide without cloning the source repo:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT/.agents/skills/create-proxy/references/parameter-tuning.md`
2. `$SO_HOME/.agents/skills/create-proxy/references/parameter-tuning.md`

If no package root is available, download and extract the published
`scene_optimizer_core_...release.zip` package for the target platform (direct
archive URLs are in `references/upstreams/usd-optimize.md`), or use the package
path/URL supplied by the user. If the user supplies an extracted
package root directly, resolve this same package path under that root. If
GitHub raw fetch is available, the web URL above is acceptable for docs-only
reads. Do not clone the source repo just to read upstream SO guidance.
