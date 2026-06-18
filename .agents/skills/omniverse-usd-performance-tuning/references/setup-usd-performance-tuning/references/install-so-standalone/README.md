# Install Scene Optimizer Standalone

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when SO core operations or packaged SO validator rules are needed outside Kit.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

PyPI wheel isn't released yet; this reference consumes a prebuilt
`scene_optimizer_core_...release.zip` package. Do not clone the Scene
Optimizer source repo, run `repo.sh`, or depend on repo helper wrappers for
standalone runtime setup. The package is ~350-380 MB; download + extract takes
~1-2 min on a fast connection. EULA env var **not** needed (no Kit).

Use this reference for standalone Scene Optimizer core operations and the
packaged `omni.scene.optimizer.validators` rules when a Kit runtime is
unavailable or not desired. For validator execution, pair this package with a
project-managed `omniverse-asset-validator` environment that can import the
same SO package. Kit remains useful when automatic extension registration or
render-time profiling is needed.

This install reference does not define operation invocation. Keep operation
execution examples in `so-run-operations/references/invocation.md` so agents
have one source of truth.

## Prerequisites

> **Python 3.12 is a HARD requirement.** The drop ships `cp312`-only wheels.
> There is no `abi3`, no `cp310`/`cp311`/`cp313` fallback, and no source
> build path here. Installing under any other Python will appear to succeed
> until the first `import omni.scene.optimizer.core`, which fails with a
> cryptic ABI error. Verify `python3.12 --version` **before** downloading
> the ~330 MB zip.

```bash
python3.12 --version            # required — package is cp312-only, no fallback
command -v unzip                # preferred extractor on Linux (Windows: Expand-Archive)
```

If either is missing, install before continuing
(`apt-get install python3.12 unzip` on Debian/Ubuntu; on systems without a
3.12 package, `uv python install 3.12` is also fine but see the
*uv-managed Python* note in Step 4).

## Step 2 — Pick Archive or Extracted Root by Platform

Use a user-provided package archive path, direct archive URL, or extracted
package root when supplied. Do not clone the source repository.
If an extracted package root is supplied and it has the sentinel paths listed
under Package Version, set `SO_HOME` and `SCENE_OPTIMIZER_PACKAGE_ROOT` to that
root and skip the download/extract steps.

Current public direct archive URLs:

- Linux x86_64: `https://d4i3qtqj3r0z5.cloudfront.net/scene_optimizer_core_usd_25.11_py_3.12%40110.1.0%2Bmaster.401.324ccecb.gl.manylinux_2_35_x86_64.release.zip`
- Windows x86_64: `https://d4i3qtqj3r0z5.cloudfront.net/scene_optimizer_core_usd_25.11_py_3.12%40110.1.0%2Bmaster.401.324ccecb.gl.windows-x86_64.release.zip`

For direct archive URLs, `@` -> `%40` and `+` -> `%2B`. Auto-pick by
`uname -s`/`-m`.

## Step 3 — Pick install location

Ask the user to choose:

- **Per-user (default):** `~/scene-optimizer/` — shared across
  projects, downloaded once. Same literal on Linux/Windows shells.
- **Project-local:** `$(pwd)/packages/scene-optimizer/` — isolated to
  this CWD.

## Step 4 — Download, extract, configure

Use this step only for a direct archive path or URL.

```bash
export SO_PACKAGE=<direct archive path or URL>
export SO_HOME=<chosen path>
mkdir -p "$SO_HOME"
case "$SO_PACKAGE" in
  http://*|https://*) curl -L "$SO_PACKAGE" -o "$SO_HOME/scene_optimizer_core.zip" ;;
  *) cp "$SO_PACKAGE" "$SO_HOME/scene_optimizer_core.zip" ;;
esac
cd "$SO_HOME"
python3.12 - <<'PY'
import zipfile

archive = "scene_optimizer_core.zip"
if not zipfile.is_zipfile(archive):
    raise SystemExit(
        f"{archive} is not a zip archive; set SO_PACKAGE to a direct .zip "
        "archive path or URL and retry"
    )
PY
unzip -q scene_optimizer_core.zip

cat > "$SO_HOME/activate.sh" <<'EOF'
export SO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCENE_OPTIMIZER_PACKAGE_ROOT="$SO_HOME"
export PYTHONPATH="$SO_HOME/python:$SO_HOME/usdpy:$PYTHONPATH"
export LD_LIBRARY_PATH="$SO_HOME/lib:$SO_HOME/extraLibs:$LD_LIBRARY_PATH"

# uv-managed Python 3.12 ships libpython3.12.so.1.0 outside the system
# loader path. Prepend the chosen interpreter's lib dir so SO's C++
# extensions can dlopen it. No-op when the interpreter is a system Python.
_so_pylib="$(python3.12 -c 'import sys, os; print(os.path.join(sys.base_prefix, "lib"))' 2>/dev/null)"
if [ -n "$_so_pylib" ] && [ -d "$_so_pylib" ]; then
    export LD_LIBRARY_PATH="$_so_pylib:$LD_LIBRARY_PATH"
fi
unset _so_pylib
EOF
source "$SO_HOME/activate.sh"
```

Env vars are **session-scoped**. Re-source `$SO_HOME/activate.sh` in
any new shell.

> **uv-managed Python 3.12.** When `python3.12` was installed via
> `uv python install 3.12`, `libpython3.12.so.1.0` lives under
> `~/.local/share/uv/python/cpython-3.12.*/lib/` and is **not** on the
> default loader path. Without the snippet above, the first SO import fails
> with `ImportError: libpython3.12.so.1.0: cannot open shared object
> file`. The `_so_pylib` block in `activate.sh` derives the right
> directory from `sys.base_prefix` so it works for both uv-managed and
> system Pythons.

On Windows: write `activate.bat` instead, using
`set SCENE_OPTIMIZER_PACKAGE_ROOT=%SO_HOME%` and
`set PATH=%SO_HOME%\lib;%SO_HOME%\extraLibs;%PATH%` (no `LD_LIBRARY_PATH`).
Windows resolves `python312.dll` through the launcher that started the
process, so the uv-managed-Python caveat above does not apply.

## Step 5 — Verify

```bash
python3.12 - <<'PY'
def operation_count():
    try:
        from omni.scene.optimizer.core import SceneOptimizerCore

        return "SceneOptimizerCore.getInstance", len(SceneOptimizerCore.getInstance().getOperations())
    except Exception:
        pass

    from omni.scene.optimizer.core.bindings._omni_scene_optimizer_core import acquire_interface

    iface = acquire_interface()
    if hasattr(iface, "get_operations"):
        return "bindings.acquire_interface", len(iface.get_operations())
    parser = iface.json_parser()
    return "bindings.json_parser", len(parser.get_supported_operations())

surface, count = operation_count()
print(f"{surface}: {count} operations")
PY
```

Expect >= 40 (the exact count varies by build). This verifies import and
operation registry only. Operation invocation is defined by
`so-run-operations/references/invocation.md`; do not infer mutation call shapes
from this install probe.

## Limitations

The standalone package supports analysis-mode operations — set
`ExecutionContext.analysisMode = 1` to get per-operation findings without the
full validator engine.

The drop may include a bundled `validator-venv/`. Do not use it as the default
runtime — it may lack `numpy` and is slower on large stages. Use a
project-managed venv with `install-asset-validator-standalone` instead.

## SO Validator Auto-Registration

The standalone SO package includes `omni.scene.optimizer.validators` — 25
Python validator rules (mesh density, unused UVs, primitive fit, etc.) that
use `@register_rule` decorators. When OAV and the SO package share the same
Python environment, importing the validators auto-registers them:

```python
import omni.scene.optimizer.validators  # triggers @register_rule decorators

from omni.asset_validator import CategoryRuleRegistry
registry = CategoryRuleRegistry()
# Now includes "Usd:Performance" and "Omni:Geometry" categories
```

No `register_all()` call is needed for rule discovery. The rule registration
decorators handle registration at import time. Do not treat category names as
validation scope, and do not select rules by bare name — the canonical executor
resolves a scope note's concepts to rule classes by identity (a bare
`find_rule()` can't tell the Scene Optimizer and Asset Validator rules that
share a class name apart).

To verify the install can run a scoped concept after `usd-validation-runner`
has scoped the plan:

```python
from usd_validation_executor import load_registry, validate_concepts

registry = load_registry()
issues = validate_concepts(
    "path/to/asset.usd",
    ["primvar_indexability"],     # canonical concept from the scope note
    registry=registry,
)
```

The executor builds the engine with `init_rules=False` and enables only the
resolved rule class.

The standalone import is `from omni.asset_validator import ValidationEngine`
(no `.core`). The `.core` submodule only exists inside a running Kit session.

## Package Version

Current expected package family (Kit 110.1 parity):

```
scene_optimizer_core_usd_25.11_py_3.12@110.1.0+master.401.324ccecb.gl.<platform>.release.zip
```

Expected layout after unpack:

```
$SO_HOME/
├── .agents/     # Operation guides and SO skills packaged for agents
├── python/      # Python modules (omni.scene.optimizer.*)
├── usdpy/       # USD Python bindings (pxr.*)
├── lib/         # Core shared libraries
├── extraLibs/   # Additional dependencies
└── docs/        # Prebuilt package install notes
```

Sentinel check (all runtime dirs plus agent docs must exist for a valid install):

```bash
for sub in .agents python lib extraLibs usdpy; do
    [[ -d "$SO_HOME/$sub" ]] || echo "MISSING: $sub"
done
[[ -f "$SO_HOME/.agents/operations/INDEX.md" ]] || echo "MISSING: .agents/operations/INDEX.md"
```

## Environment for Docker/CI

Set `WU_SO_PACKAGE_DIR` to point tools at the local backend:

```bash
export WU_SO_PACKAGE_DIR="$SO_HOME"
export SCENE_OPTIMIZER_PACKAGE_ROOT="$SO_HOME"
```

If absent, downstream tools may fall back to NVCF cloud backend or fail.

## Troubleshooting

- If `omni.scene.optimizer.core` cannot be imported, confirm Python 3.12 is
  running and `$SO_HOME/activate.sh` has been sourced in the current shell.
- `ImportError: libpython3.12.so.1.0: cannot open shared object file` →
  the active `python3.12` is uv-managed (or otherwise installed outside
  the system loader path) and `$SO_HOME/activate.sh` was not re-sourced
  after a fresh shell or after the `uv` install. The activate script
  prepends `$(python3.12 -c 'import sys, os; print(os.path.join(sys.base_prefix, "lib"))')`
  to `LD_LIBRARY_PATH`; re-source it. If the import still fails, run
  `python3.12 -c 'import sys; print(sys.base_prefix)'` manually and
  confirm a `lib/libpython3.12.so.1.0` exists under that prefix.
- If library loading fails on Linux, verify `$SO_HOME/lib` and
  `$SO_HOME/extraLibs` are present in `LD_LIBRARY_PATH`.
- If the install looks incomplete, run the sentinel check above and redownload
  when any required directory is missing.
- If downstream tools use a cloud backend or fail to find the package, set
  `WU_SO_PACKAGE_DIR="$SO_HOME"` in the same environment.
