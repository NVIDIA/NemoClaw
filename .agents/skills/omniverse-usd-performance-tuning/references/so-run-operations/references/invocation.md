<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Invocation Reference

How to execute Scene Optimizer operations once the runtime is selected and the
operation plan is approved. Read `<output_path>/setup-preflight.json` to
determine which runtime and API surface to use.

This is the local source of truth for Scene Optimizer operation invocation.
Other workflow docs should link here instead of repeating Python API snippets.

The two runtimes below are peers — neither is preferred. The user's Phase 0
choice determines which section applies.

## Kit Runtime

When `setup-preflight.json` indicates Kit as the selected runtime, bootstrap
Kit first, then use the same supported Python shapes as standalone.

```python
import os
import sys

os.environ.setdefault("OMNI_KIT_ACCEPT_EULA", "yes")

from omni.kit_app import KitApp

app = KitApp()
app.startup([
    "--no-window",
    "--enable", "omni.scene.optimizer.core",
    "--enable", "omni.asset_validator.core",
    # For omniverse:// assets, also enable:
    # "--enable", "omni.client",
    # "--enable", "omni.usd_resolver",
])

from omni.scene.optimizer.core import ExecutionContext, SceneOptimizerCore
from pxr import Usd

# Open stage
stage = Usd.Stage.Open(input_path)

# Attach the stage to an ExecutionContext before direct API calls.
context = ExecutionContext()
context.set_stage(stage)
core = SceneOptimizerCore.getInstance()

# Verify operations are available
ops = core.getOperations()

# Execute a single operation
success, error, output = core.executeOperation(
    "meshCleanup",
    context,
    {"mergeVertices": True},
)
if not success:
    raise RuntimeError(error)

# Or execute a pipeline
pipeline = [
    {"operation": "meshCleanup", "mergeVertices": True},
    {"operation": "optimizeMaterials"},
    {"operation": "pruneLeaves"},
]
for success, error, output in core.executeConfig(context, pipeline):
    if not success:
        raise RuntimeError(error)

# Export optimized output (never overwrite source)
stage.Export(output_path)

sys.exit(app.shutdown())
```

**Key points:**

- Cross-check every operation key against `operationsAvailable` in
  `setup-preflight.json` before execution. If missing, report
  `blocked_missing_so_operation`.
- Probe the selected runtime before writing the script.
- Set `OMNI_KIT_ACCEPT_EULA=yes` in the environment before KitApp import.
- For analysis-only operations, set `context.analysisMode = 1`.
- Operation keys come from the per-operation page's Parameters table and
  starting-config JSON. Invalid keys may warn or silently no-op.
- First run may spend minutes fetching extensions from the registry; subsequent
  runs use the Kit cache under `~/.local/share/ov/data/Kit/`.

## Standalone Runtime

When `setup-preflight.json` indicates standalone, invocation mechanics are
owned by the SO package itself. Resolve the upstream guide:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT/.agents/operations/INVOCATION.md`
2. `$SO_HOME/.agents/operations/INVOCATION.md`

If no package root is available, download and extract the published
`scene_optimizer_core_...release.zip` (direct archive URLs in
`references/upstreams/usd-optimize.md`), or use the package path/URL supplied
by the user.

**Local responsibilities still apply:**

- Cross-check every operation key against `operationsAvailable` in
  `setup-preflight.json` before execution. If missing, report
  `blocked_missing_so_operation`.
- Apply destructive-operation approval gates via `operation-safety.md`.
- Write optimized stages and runtime artifacts under the local output
  workspace chosen by setup.

## Verified Python API Shapes

Verified against
`scene_optimizer_core_usd_25.11_py_3.12@110.1.0+master.401.324ccecb.gl.manylinux_2_35_x86_64.release`.

Preferred public JSON API:

```python
import json
from omni.scene.optimizer.core.scripts import standalone
from pxr import Usd

stage = Usd.Stage.Open(input_path)
ok = standalone.execute_commands_from_json(stage, json.dumps([
    {"operation": "meshCleanup", "mergeVertices": True},
]))
if not ok:
    raise RuntimeError("Scene Optimizer operation chain failed")
stage.Export(output_path)
```

Direct API with per-operation results:

```python
from omni.scene.optimizer.core import ExecutionContext, SceneOptimizerCore
from pxr import Usd

stage = Usd.Stage.Open(input_path)
context = ExecutionContext()
context.set_stage(stage)
results = SceneOptimizerCore.getInstance().executeConfig(context, [
    {"operation": "meshCleanup", "mergeVertices": True},
])
for success, error, output in results:
    if not success:
        raise RuntimeError(error)
stage.Export(output_path)
```

## Invalid Call Shape

Do not pass a plain `pxr.Usd.Stage` directly as the second argument to
`SceneOptimizerCore.executeOperation` or `executeConfig`. The binding expects an
`ExecutionContext`; the stage must be attached with `context.set_stage(stage)`.
The bad shape below reproduces the failure seen in Horde testing:

```python
SceneOptimizerCore.getInstance().executeOperation("printStats", stage, {})
# AttributeError: 'Stage' object has no attribute '_impl'
```

If `_impl` appears in an operation log, stop the operation pass, mark the
attempt as an invalid SO invocation, and rerun through the supported shapes
above. Do not export or report a successful optimized stage from that failed
pass.

## Save Policy

- Export optimized output to a NEW `.usdc` path under `<output_path>/`.
  Never overwrite the source stage.
- Use `stage.Export(path)` for clean output. Use `Sdf.Layer.Export()` only
  for individual layer cleanup (Phase 4.5).
- Use in-place `Save()` only for newly created layers or explicitly
  user-approved source edits.
- Do not flatten unless the user asks for a flattened deliverable.

## Per-Operation Parameters

Per-operation parameter tables, defaults, and implementation caveats are owned
by upstream `usd-optimize`. The same package paths listed in the standalone
section above contain the full operation reference. If GitHub raw fetch is
available, the web URL below is acceptable for docs-only reads:

- [https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/operations/INVOCATION.md](https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/operations/INVOCATION.md)

Do not clone the source repo just to read docs.
