# Transformer Kernel Inventory Schema

Transformer-local kernels must use FlashInfer-Bench-style metadata so agents can inventory, compare, and reuse kernels across auto-kernelize runs.

Schema source of truth:
- Definition: https://github.com/flashinfer-ai/flashinfer-bench/blob/main/docs/flashinfer-trace/definition.mdx
- Solution: https://github.com/flashinfer-ai/flashinfer-bench/blob/main/docs/flashinfer-trace/solution.mdx

## Directory layout

For each transformer module, reusable generated kernels live in:

```text
src/tilegym/transformers/<submodule_name>/
|- kernel_definitions/
|  |- <kernel_name>.json
|- kernel_solutions/
|  |- <kernel_name>.json
|- kernels/
|  |- <kernel_name>.py
|- modeling_<submodule_name>.py
```

`kernels/<kernel_name>.py` contains reusable kernel implementation and thin wrapper code only. Model-specific monkey-patch glue, class replacement, patched forward methods, and checkpoint compatibility logic belong in `modeling_<submodule_name>.py` or `src/tilegym/transformers/monkey_patch.py`.

## Definition requirements

Use strict FlashInfer Definition metadata:
- `name`: include concrete problem information.
- `op_type`: general compute category.
- `axes`: symbolic const/var dimensions.
- `inputs` and `outputs`: tensor specs with `shape` and `dtype`.
- `reference`: PyTorch code containing a global `run` function.
- `tags`: use namespaced tags such as `model:<name>`, `stage:prefill`, `stage:decode`, `status:draft`, `status:verified`, and `fused`.

Definitions describe math and interface. They do not describe implementation source files.

### Reference provenance

`reference` is both an executable correctness contract and a provenance pointer. It must:
- start with one or more `# Source: <permalink>` comments before any imports or code;
- point to the precise upstream code region that implements the same compute pattern in `transformers`, using a GitHub-style permalink with line anchors;
- point to the Hugging Face Hub model card or remote `modeling_*.py` code region when the model uses `trust_remote_code=True`;
- include multiple `# Source:` comments for fused kernels whose Definition combines adjacent upstream operations;
- keep a global `run(...)` function after the source comments, written in clear PyTorch and matching the Definition inputs and outputs.

Prefer immutable commit permalinks over branch links. The source comments should identify the upstream math or model callsite, not the generated cuTile implementation.

## Solution requirements

Use FlashInfer Solution metadata with source paths:
- `name`, `definition`, `author`, `spec`, and `sources` are required.
- `spec.language` is `cuda-tile` for cuTile kernels.
- `spec.entry_point` uses `{file_path}::{function_name}` and points at `kernels/<kernel_name>.py`.
- `spec.target_hardware` lists supported GPUs, for example `NVIDIA_B200`.
- `sources.path` references one or more repo-relative files containing the implementation.

For Ocean in-repo inventory, `sources.content` is not required. If an external FlashInfer-Bench submission needs embedded file content, materialize it from `sources.path` at export time.

## Agent workflow rules

Explore subagents must return:
- a list of compute requirements as draft Definition objects, including `reference` snippets with precise source comments;
- an inventory of existing reusable kernels as Solution objects.

Candidate proposal must compare Definitions first:
- exact Definition match: reuse the existing Solution;
- compatible Definition with layout/signature gap: propose a small adapter;
- no compatible Solution: create a new Definition, Solution, and dedicated kernel file.

Kept auto-kernelize experiments must check in the Definition, Solution, and kernel implementation. Discarded experiments keep draft metadata under `sandbox/` only.
