# Install Scene Optimizer via Kit

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when Scene Optimizer should run as a Kit extension. Do not use for standalone SO setup.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Kit + SO Kit extension. SO is fetched from Kit's extension registry on
first `--enable`, cached after.

Use this reference when Scene Optimizer should run inside Kit so validators,
profilers, or remote USD access can share the same Kit runtime.

## Prerequisites

- Python 3.12 environment that can import or install `omni.kit_app`.
- Network access to the Kit package index and extension registry.
- Permission to accept the Kit EULA for headless smoke tests.

## Limitations

- First `--enable` may spend minutes fetching the extension from the registry.
- The in-Kit API differs from the standalone Scene Optimizer API.
- Remote `omniverse://` assets still need a separate authentication preflight.

## Step 1 — Install Kit

Invoke the `install-kit` skill if `python -c "import omni.kit_app"`
fails. Skip otherwise.

## Step 2 — Verify SO loads

```bash
OMNI_KIT_ACCEPT_EULA=yes python -c "
from omni.kit_app import KitApp
import sys
app = KitApp()
app.startup(['--no-window', '--enable', 'omni.scene.optimizer.core'])
from omni.scene.optimizer.core import SceneOptimizerCore
print(len(SceneOptimizerCore.getInstance().getOperations()))
sys.exit(app.shutdown())
"
```

Expect ≥ 40 (floor — varies by version). First run pulls SO from the
registry (~minutes); subsequent runs are cached under
`~/.local/share/ov/data/Kit/`.

The in-Kit verification path uses the public `SceneOptimizerCore` registry.
Operation invocation is defined by `so-run-operations/references/invocation.md`;
do not infer mutation call shapes from this install probe.

## Remote Omniverse assets

For `omniverse://` URLs, run the `omniverse-authentication` skill before the
first stage open. Kit may open a browser window for SSO and cache credentials
locally. Also enable `omni.client` and `omni.usd_resolver` when opening remote
stages from Python:

```python
app.startup([
    "--no-window",
    "--enable", "omni.client",
    "--enable", "omni.usd_resolver",
    "--enable", "omni.scene.optimizer.core",
])
```

If `pxr` or `omni.client` is not importable after startup, add the installed Kit
extension folders to `sys.path` before importing USD modules.

## Troubleshooting

- If `import omni.kit_app` fails, run `install-kit` in the selected Python 3.12
  environment and retry from that environment.
- If the first SO startup is slow, wait for the registry fetch to finish; later
  runs should use the Kit cache under `~/.local/share/ov/data/Kit/`.
- If remote stage opens fail, run `omniverse-authentication` before retrying the
  full stage open.
- If `pxr` or `omni.client` remains unavailable after startup, add the installed
  Kit extension folders to `sys.path` before importing USD modules.
