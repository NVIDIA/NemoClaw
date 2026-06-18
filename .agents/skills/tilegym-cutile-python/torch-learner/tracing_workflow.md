# PyTorch Implementation Tracing Workflow

Trace any PyTorch operation from the user-facing Python API through the C++ ATen library down to CUDA kernels and autograd backward passes by reading actual source code.

> **Context**: This is Step O-0 of the tilegym-cutile-python orchestration workflow. The trace is
> **intermediate context** for the Analyzer Agent — not a final deliverable. After completing
> the trace, immediately proceed to Step O-1 (spawn Analyzer Agent via Task tool).

## Reference Documentation

- **[1_pytorch_codebase_map.md](references/1_pytorch_codebase_map.md)** - PyTorch source tree layout and search strategies
- **[2_dispatch_mechanism.md](references/2_dispatch_mechanism.md)** - Dispatcher: native_functions.yaml, DispatchKey, Python-to-C++ bridges
- **[3_tracing_strategies.md](references/3_tracing_strategies.md)** - Tracing strategies per operation type
- **[4_language_layers.md](references/4_language_layers.md)** - Reading Python, C++, CUDA, and auto-generated code
- **[5_well_known_ops.md](references/5_well_known_ops.md)** - Well-known ops — answer directly without source tracing

## Constraints

- **Search boundary:** ALL file searches MUST be scoped to the PyTorch source checkout in the skill cache or the current working directory. The default cache directory is `~/.cache/tilegym`; users may choose another cache directory via `TILEGYM_SKILL_CACHE_DIR`. NEVER search outside these directories. If a file is not found, the checkout may be missing — do NOT fall back to the broader filesystem.
- **Version matching:** Always use source at the exact version matching the installed PyTorch. Different versions have different file layouts and implementations. Before using an existing cache, verify that it matches the required version.
- **Read real code:** Never guess implementation details. Read the actual files. If you can't find something, say so.

## Worked Example

A complete trace for `nn.LSTM` is at **[examples/lstm_trace.md](examples/lstm_trace.md)**.

## Core Tracing Workflow

### Step 1: Identify the Operations to Trace

Parse the user's code to identify which PyTorch operations need tracing. Trace each one separately.

### Step 2: Check Well-Known Ops (Early Exit)

Check if the operation is in **[5_well_known_ops.md](references/5_well_known_ops.md)** before cloning source code:

- **Tensor creation**: `zeros`, `ones`, `empty`, `randn`, `rand`, `arange`, `linspace`, `eye`, `full`
- **Shape**: `view`, `reshape`, `permute`, `transpose`, `unsqueeze`, `squeeze`, `expand`, `cat`, `stack`, `split`, `flatten`
- **Dtype/device**: `to`, `clone`, `detach`, `contiguous`
- **Indexing**: basic/advanced indexing, `gather`, `scatter`, `index_select`
- **Math**: `+`, `-`, `*`, `/`, `**`, `matmul`/`mm`/`bmm`, `abs`, `exp`, `log`, `sqrt`, trig
- **Comparisons**: `eq`, `ne`, `lt`, `gt`, `le`, `ge`
- **Reductions**: `sum`, `mean`, `max`, `min`, `argmax`, `argmin`, `var`, `std`, `norm`
- **In-place**: any `_`-suffixed variant

**If matched, answer from the reference.** Only proceed to Steps 3-7 if the user asks for details beyond the reference, the op is not listed, or the user wants actual source code.

### Step 3: Ensure PyTorch Source Is Available

**Complete this before any file search.**

```bash
# Check if clone exists
CACHE_DIR="${TILEGYM_SKILL_CACHE_DIR:-$HOME/.cache/tilegym}"
PYTORCH_SOURCE="$CACHE_DIR/pytorch-source"
ls "$PYTORCH_SOURCE/aten/src/ATen/native/native_functions.yaml" 2>/dev/null

# If missing or wrong version, clone:
PYTORCH_VERSION=$(python -c "import torch; print(torch.__version__.split('+')[0])")
git clone --depth=1 --branch "v${PYTORCH_VERSION}" https://github.com/pytorch/pytorch.git "$PYTORCH_SOURCE"
```

**Do NOT proceed until `$PYTORCH_SOURCE` exists with the correct version.** If the
installed PyTorch version changes, switch or refresh the cached checkout to `v${PYTORCH_VERSION}`
before using it. If a compatible source reference cannot be found, say so instead of using stale
or mismatched source.

### Step 4: Find Python Implementation and Bridge

Find the Python entry point and identify how it crosses into C++.

**Where to search** (all paths under `$PYTORCH_SOURCE`):

| Op Type | Search Location |
|---------|----------------|
| `nn.<Module>` | `torch/nn/modules/` — find class, read `forward()` |
| `F.<function>` | `torch/nn/functional.py` — find the function |
| `torch.<op>` | `torch/functional.py`, or search `native_functions.yaml` directly |
| `tensor.<method>` | Search `native_functions.yaml` for the op name |

Inside the Python code, identify the bridge to C++:

| Bridge Pattern | Meaning |
|----------------|---------|
| `_VF.<name>()` | Routes through `torch._C._VariableFunctions` to dispatcher |
| `torch._C._nn.<name>()` | Direct C++ binding |
| `torch.<name>()` / `torch.ops.aten.<name>()` | Dispatcher via torch namespace |
| Multiple `torch.*` calls | Pure Python composition — no single C++ entry |

### Step 5: Look Up native_functions.yaml

Search for the operation in the master dispatch registry:

```bash
grep -A 15 "func:.*<op_name>" "$PYTORCH_SOURCE/aten/src/ATen/native/native_functions.yaml"
```

Extract from the YAML entry:
- **Function signature** and return type
- **Dispatch table**: backend → function name mappings
- **Structured delegation**: whether it delegates to an `out=` variant

Dispatch key meanings:
- `CPU, CUDA: func_impl` → shared implementation
- `CPU: func_cpu` / `CUDA: func_cuda` → separate backends
- `CompositeExplicitAutograd: func_impl` → works on all backends
- No `dispatch:` key → `CompositeImplicitAutograd` (composed from other ops)

### Step 6: Find C++ and Device-Specific Implementations

Search for the function names from the dispatch table (all under `$PYTORCH_SOURCE`):

```bash
# C++ implementation (.cpp and .cu files)
grep -rn "function_name" aten/src/ATen/native/ --include="*.cpp" --include="*.cu"

# Dispatch stub registrations (to find device-specific implementations)
grep -rn "REGISTER_DISPATCH.*stub_name" aten/src/ATen/native/

# cuDNN wrappers
grep -rn "function_name" aten/src/ATen/native/ --include="*.cpp" | grep -i cudnn

# cuBLAS (for linear algebra ops)
grep -rn "blas::gemm\|cublas" aten/src/ATen/native/ --include="*.cpp" --include="*.cu"
```

Note which library is used: custom CUDA kernel (`__global__`), cuDNN, cuBLAS, cuFFT, or Thrust/CUB.

### Step 7: Trace the Autograd Backward Pass

```bash
grep -A 5 "name:.*<op_name>" "$PYTORCH_SOURCE/tools/autograd/derivatives.yaml"
```

In `derivatives.yaml`: `grad` = upstream gradient, `result0`/`result1` = saved forward outputs. Some ops reference a dedicated backward function — trace it the same way.

## Output Format

Structure each trace as:

1. **ASCII flow diagram** — full call chain from user code to kernel
2. **Layer-by-layer trace** — for each layer: file path, key code snippet, explanation
3. **Summary table** — layer → file → key function
4. **Performance notes** (when relevant) — backend selection, optimizations

## Mandatory: Continue to Step O-1

The trace above is **not the final result**. Your next action after completing the trace is to
call the **Task tool** to spawn the Analyzer Agent (Step O-1 in tilegym-cutile-python SKILL.md).

Do NOT output the trace as a summary to the user. Do NOT stop. Do NOT wait for input.
Pass the trace as context in the Analyzer Agent prompt and proceed immediately.
