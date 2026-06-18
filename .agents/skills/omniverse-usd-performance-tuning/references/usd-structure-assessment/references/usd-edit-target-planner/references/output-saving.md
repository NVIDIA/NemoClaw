<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Output Saving Policy

Use this reference whenever an optimization, restructure, or direct USD edit
writes an optimized stage or layer.

## Default Policy

- Write optimized results to a new output path. Do not overwrite source assets
  unless the user explicitly requested in-place mutation and rollback is clear.
- For data-heavy outputs, prefer `.usdc`. Reserve `.usda` for sparse assembly
  roots or debug outputs where readability matters.
- After writing optimized child layers, update the copied root/assembly layer's
  references or sublayers to point at those new outputs.

## API Semantics

```python
stage.GetRootLayer().Save()                # in-place write to the layer's current identifier
stage.GetRootLayer().Export("out.usdc")    # re-emit just this layer to a new path
stage.Export("out.usdc")                   # flatten the composed stage to a new path
```

- `Sdf.Layer.Save()` writes dirty specs back to the existing file. It is fine
  for newly created layers or explicitly approved in-place source edits.
- Do not use `Save()` as the default after destructive edits to an existing
  `.usdc`. Crate files do not reclaim removed array data, so file size can stay
  bloated even when the composed scene is smaller.
- `Sdf.Layer.Export(path)` or `stage.GetRootLayer().Export(path)` re-emits one
  layer to a new file and preserves that layer's composition arcs.
- `Usd.Stage.Export(path)` flattens the composed stage. Use it only when the
  requested deliverable is a flattened file; it collapses composition structure
  and is not a generic save operation.

## Scene Optimizer Outputs

Scene Optimizer operations mutate the opened stage in memory. The safe default
is:

```python
stage = Usd.Stage.Open("path/to/source.usd")
# run operations
stage.GetRootLayer().Export("path/to/source.optimized.usdc")
```

Optional helper wrappers may write a default sibling output or an explicit
`--output` path. Use `--no-save` only for timing or dry-runs where no optimized
stage should be written.
