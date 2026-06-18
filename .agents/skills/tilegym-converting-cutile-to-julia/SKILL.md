---
name: tilegym-converting-cutile-to-julia
description: Converts cuTile Python GPU kernels (@ct.kernel) to cuTile.jl Julia equivalents. Handles kernel syntax translation, 0-indexed to 1-indexed conversion, broadcasting differences, memory layout (row-major to column-major), type system mapping, and launch API differences. Use when converting, porting, or translating cuTile Python kernels to Julia cuTile.jl, or debugging/optimizing existing Julia cuTile translations.
license: CC-BY-4.0 AND Apache-2.0
metadata:
  author: "TileGym Team <TileGym@nvidia.com>"
  tags:
    - cutile
    - julia
    - conversion
    - gpu
    - kernel
---

# cuTile Python → cuTile.jl (Julia) Conversion

Convert `@ct.kernel` Python kernels to Julia `function ... end` cuTile.jl kernels.

## Workflow Selection

- **Standard conversion** → Full workflow: [`translations/workflow.md`](translations/workflow.md)
- **Errors** (`MethodError`, `IRError`, numerical mismatch) → [`references/debugging.md`](references/debugging.md)
- **Quick reference** → [`references/api-mapping.md`](references/api-mapping.md) + [`references/critical-rules.md`](references/critical-rules.md)
- **Test patterns** → [`references/testing.md`](references/testing.md)

## Architecture

Julia kernels are **standalone** — no Python bridge, no pytest integration. The Julia sub-project
lives in `julia/` at the repo root with its own `Project.toml` for dependency management.

```
julia/                          # Self-contained Julia sub-project
├── Project.toml                # Dependencies: CUDA.jl, cuTile.jl, NNlib.jl, Test
├── kernels/                    # cuTile.jl kernel implementations
│   ├── add.jl                  # ← Ground-truth: 1D element-wise with alpha scaling (tensor+tensor, tensor+scalar)
│   ├── matmul.jl               # ← Ground-truth: 2D tiled MMA, standard Julia layout (M,K)×(K,N)→(M,N)
│   └── softmax.jl              # ← Ground-truth: 3 strategies (TMA, online, chunked) using ct.load/ct.store
└── test/                       # Julia-native tests (using Test stdlib)
    ├── runtests.jl             # Test runner entry point
    ├── test_add.jl
    ├── test_matmul.jl
    └── test_softmax.jl
```

**Ground-truth reference**: Always consult `julia/kernels/*.jl` and `julia/test/*.jl` for patterns that compile and pass tests. These are the canonical examples of working cuTile.jl code.

## Instructions

1. **Analyze** the Python kernel: identify patterns, shapes, dtypes, operations
2. **Write Julia kernel** — `julia/kernels/<op>.jl` with cuTile.jl kernel + bridge function(s)
3. **Convert** kernel signature (see `translations/workflow.md` Phase 2)
4. **Convert** kernel body (apply `references/api-mapping.md` + `references/critical-rules.md`)
5. **Write Julia test** — `julia/test/test_<op>.jl` using `Test` stdlib + `NNlib.jl` for reference
6. **Register test** — add `include(...)` in `julia/test/runtests.jl`
7. **Validate** — run the bundled validator: `python <skill-dir>/scripts/validate_cutile_jl.py <file.jl>`
8. **Test** — run `julia --project=julia/ julia/test/runtests.jl`

Full conversion checklist with post-conversion verification → [`translations/workflow.md`](translations/workflow.md)

## ⚠️ Top Pitfalls

The most dangerous translation errors. Full rules (17 total) in [`references/critical-rules.md`](references/critical-rules.md).

| # | Pitfall | One-line fix |
|---|---------|-------------|
| 1 | `ct.full()` doesn't exist in Julia | Use `fill(val, shape)`, `zeros(T, dims...)`, or `ones(T, dims...)` |
| 2 | `max(a, b)` on tiles → `IRError` | Use `max.(a, b)` (broadcast dot) |
| 3 | `IRError` / `MethodError` mentioning `IRStructurizer` | Compiler bug — file upstream with minimal reproducer |
| 4 | `ct.launch` arg order silently wrong | Args are positional — match kernel signature exactly |
| 5 | `ct.load` with `order` — index positions wrong | `order` remaps BOTH shape AND index (Critical Rule 16) |

## Worked Examples

Side-by-side Python → Julia conversions matching the released Julia kernels in `julia/kernels/`. Each directory contains `cutile_python.py` (before) and `cutile_julia.jl` (after).

| # | Example | Key Patterns | When to Reference |
|---|---------|-------------|-------------------|
| 01 | [`add`](examples/01_add/) | 1D `ct.load`/`ct.store`, alpha scaling, scalar broadcast, `fill`/`zeros`, keyword load/store | Starting point; basic TMA + element-wise patterns |
| 02 | [`matmul`](examples/02_matmul/) | `muladd`, TF32 conversion, K-loop with `for`, 2D swizzle, standard Julia layout, `ct.@compiler_options` | MMA / tensor core operations |
| 03 | [`softmax`](examples/03_softmax/) | Persistent scheduling, `for` loops, `gather`/`scatter`, `padding_mode`, multi-pass | Large-tensor reduction patterns |

These match the released kernels in `julia/kernels/` (`add.jl`, `matmul.jl`, `softmax.jl`). The examples are simplified teaching versions — always consult `julia/kernels/*.jl` for the canonical, tested implementations.

## Reference Documents

| Category | Document | Content |
|----------|----------|---------|
| **Workflows** | [`translations/workflow.md`](translations/workflow.md) | Full conversion workflow with todo list, validation loop, checklist |
| **Rules** | [`references/critical-rules.md`](references/critical-rules.md) | 17 Critical Rules for cuTile Python → Julia conversion |
| **API** | [`references/api-mapping.md`](references/api-mapping.md) | Python↔Julia bidirectional API mapping + kernel patterns |
| **Testing** | [`references/testing.md`](references/testing.md) | Julia-native test patterns, tolerances, failure diagnosis |
| **Debugging** | [`references/debugging.md`](references/debugging.md) | Julia-specific error diagnosis + IR debug commands |
| **Scripts** | [`scripts/validate_cutile_jl.py`](scripts/validate_cutile_jl.py) | Static validation for Julia anti-patterns (run it) |
| **Ground Truth** | `julia/kernels/*.jl` + `julia/test/*.jl` | Actual working implementations in the codebase |

## Environment Setup

**Prerequisite — Julia**: this skill requires the Julia version declared in `julia/Project.toml` under `[compat] julia`. If `julia --version` is missing or older than that, install from the official Julia site at <https://julialang.org/install/> following the verified installer instructions for your OS. Resume below once `julia --version` is compatible.

Then, from the repo root:

```bash
# Install Julia dependencies declared in julia/Project.toml
julia --project=julia/ -e 'using Pkg; Pkg.instantiate()'

# Run tests
julia --project=julia/ julia/test/runtests.jl
```

Requirements:
- Julia (minimum version declared in `julia/Project.toml` under `[compat] julia`)
- CUDA 13.1+ driver
- Blackwell GPU (compute capability 10+)
- Dependencies managed via `julia/Project.toml`: CUDA.jl, cuTile.jl, NNlib.jl, Test
