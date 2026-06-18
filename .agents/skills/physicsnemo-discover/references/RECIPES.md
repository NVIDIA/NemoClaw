# Search Recipes — How to discover PhysicsNeMo artifacts live

Concrete Glob / Grep / Read patterns the skill should use to discover what's actually in the repo, instead of relying on a static inventory. All paths are relative to the resolved repo root.

## Guiding rule

If you are about to name a class, file, or example, **run at least one search below first** to confirm it exists and capture its current description.

---

## 1. Confirm the repo root

```
Read <root>/pyproject.toml                  # check name == "nvidia-physicsnemo"
Glob <root>/physicsnemo/__init__.py         # must exist
Glob <root>/examples/README.md              # usually exists
```

If any of these fail, ask the user to confirm the path.

---

## 2. Find examples for a domain

```
# 2a. Enumerate examples in the target domain
Glob examples/<domain>/**/README.md

# 2b. Read each README's top (title + first paragraph) to match user intent
Read examples/<domain>/<candidate>/README.md   # limit=30

# 2c. When READMEs are ambiguous, inspect the training script imports to see
#     which models / datapipes the example actually uses
Grep "from physicsnemo" examples/<domain>/<candidate>/ --type py -n --head_limit 20
```

If the user's domain keyword doesn't map cleanly to a folder name:

```
# 2d. Broad search for concept across all examples
Grep -l "<concept keyword>" examples/ --type md
Grep -l "<concept keyword>" examples/ --type py
```

---

## 3. List currently-exported models across ALL families matching a data shape

The skill's output surfaces a *menu* of candidate families, not a single pick. Enumerate every family the taxonomy's data-shape row lists — not just the first one that looks plausible.

```
# 3a. Top-level model registry exports — the full top-level menu
Read physicsnemo/models/__init__.py

# 3b. Per-family loop — for EACH candidate family from the taxonomy data-shape row,
#     confirm the subdir exists and read its exports. Do not stop after one match.
Glob physicsnemo/models/<family>/__init__.py
Read physicsnemo/models/<family>/__init__.py
# repeat for every candidate family in the data-shape row

# 3c. Extract purpose from a specific model's docstring (after 3b has surfaced the family)
Grep -n "^class " physicsnemo/models/<family>/<file>.py
Read physicsnemo/models/<family>/<file>.py     # limit ~80 lines around the class

# 3d. Cross-reuse: find which examples instantiate each candidate family.
#     This feeds the "Instantiated by: <example>" annotation in the output skeleton.
Grep -rn "from physicsnemo.models.<family>" examples/ --type py -l
```

For experimental models:

```
Glob physicsnemo/experimental/models/**/__init__.py
Read physicsnemo/experimental/models/<family>/__init__.py
```

Always flag experimental matches as *"API may change"*.

---

## 4. List currently-exported datapipes for a format

```
# 4a. Top-level datapipes exports
Read physicsnemo/datapipes/__init__.py

# 4b. Subpackage exports — enumerate live rather than assuming names
Glob physicsnemo/datapipes/*/__init__.py
Read physicsnemo/datapipes/<subpackage>/__init__.py

# 4c. Base classes for custom data
#     See TAXONOMY.md § Data format → how to find a datapipe for the
#     full file paths + confirmation steps. Commands below are quick
#     reference.
Grep -n "^class " physicsnemo/datapipes/readers/base.py
Grep -n "^class " physicsnemo/datapipes/datapipe.py
Grep -n "^class " physicsnemo/datapipes/transforms/base.py
```

For format-specific discovery:

```
Grep -l "<format name, e.g. HDF5, Zarr, VTK>" physicsnemo/datapipes/ --type py
```

---

## 5. List currently-exported core utilities

```
# 5a. For a known module (distributed, utils, metrics, mesh, diffusion, etc.)
Read physicsnemo/<module>/__init__.py

# 5b. If the init is thin, list the files and sample headers
Glob physicsnemo/<module>/*.py
Grep -n "^(class|def) " physicsnemo/<module>/<file>.py --head_limit 20
```

For submodules (e.g. `utils/logging/`, `utils/profiling/`, `metrics/climate/`):

```
Glob physicsnemo/<module>/*/__init__.py
Read physicsnemo/<module>/<submodule>/__init__.py
```

---

## 6. Find documentation pages

```
# 6a. Top-level doc indexes
Read docs/index.rst
Read docs/api_index.rst
Read docs/examples_index.rst

# 6b. Domain example indexes
Glob docs/examples_*.rst
Read docs/examples_<domain>.rst

# 6c. API doc for a specific module
Glob docs/api/**/*.rst
Read docs/api/<path>.rst

# 6d. Broad search
Grep -l "<concept>" docs/ --glob "*.rst"
```

---

## 7. Confirm a specific class / function exists

```
# 7a. Search by class name across physicsnemo
Grep -n "^class <ClassName>" physicsnemo/ --type py

# 7b. Search by function name
Grep -n "^def <func_name>" physicsnemo/ --type py

# 7c. If not found where expected — check compat layer for renames
Read physicsnemo/compat/__init__.py
```

If a name isn't found anywhere, it may have been renamed. Do not emit it.

---

## 8. Check scale / distribution patterns used in an example

```
# Does this example use DDP, FSDP, domain parallelism?
Grep -n "DistributedManager\|FSDP\|ShardTensor\|torch.distributed" examples/<domain>/<example>/ -l
Grep -n "DistributedManager\|FSDP\|ShardTensor\|torch.distributed" examples/<domain>/<example>/ --type py
```

---

## 9. Decide between similar examples

When the user's description matches multiple examples, compare by:

```
# 9a. README purpose statements (first 20 lines)
Read examples/<domain>/<cand_a>/README.md   # limit 20
Read examples/<domain>/<cand_b>/README.md   # limit 20

# 9b. Data format used (training script imports + file globs)
Grep -n "h5py\|zarr\|xarray\|pyvista\|tfrecord\|numpy.load" examples/<domain>/<cand>/ --type py
Glob examples/<domain>/<cand>/**/*.yaml      # Hydra configs often hint at scale + data
```

Pick the example whose README *purpose statement* and *data format* match the user's situation most closely.

---

## 10. Fallback: pure keyword search

If the user's phrasing doesn't map to any taxonomy entry:

```
Grep -l "<user keyword>" examples/ --type md
Grep -l "<user keyword>" physicsnemo/ --type py
Grep -l "<user keyword>" docs/ --glob "*.rst"
```

---

## 11. Check shared datapipe across examples

See TAXONOMY.md § Cross-example reuse patterns for the rationale and
known reuse cases (Darcy2D, ERA5, VTK). The recipe below is the
mechanical step: grep the datapipe class across `examples/` and surface
confirmed reuse in the output.

```
# 11a. Which examples import a given datapipe class?
Grep -rn "<DatapipeClass>" examples/ --type py -l

# 11b. Which models do those examples pair the datapipe with?
#      Run for each example surfaced by 11a.
Grep -n "from physicsnemo.models" examples/<domain>/<example>/ --type py
```

Use the result to annotate the "Datapipe(s) for your data format" section with *"Reused by: &lt;examples&gt;"* and to pick reference examples that span ≥2 model families on the same data.

---

## Output discipline

Every pointer you emit must be traceable to a tool result in the current turn. If you cannot show where you just read it, don't emit it. This is how the skill stays honest as the repo evolves.
