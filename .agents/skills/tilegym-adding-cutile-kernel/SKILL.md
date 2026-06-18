---
name: tilegym-adding-cutile-kernel
description: Add a new cuTile GPU kernel operator to TileGym. Covers dispatch registration in ops.py, cuTile backend implementation, __init__.py exports, test creation, and benchmark in tests/benchmark. Use when adding, creating, or implementing a new cuTile operator/kernel in TileGym, or when asking how to register a new cuTile op.
license: CC-BY-4.0 AND Apache-2.0
metadata:
  author: "TileGym Team <TileGym@nvidia.com>"
  tags:
    - cutile
    - kernel
    - tilegym
    - gpu
    - dispatch
---

# Adding a cuTile Kernel to TileGym

End-to-end workflow for adding a new operator (e.g., `my_op`) with cuTile backend.

## Execution Rules

**MUST follow these rules strictly:**
1. Use TodoWrite to create the checklist below BEFORE writing any code
2. Execute steps **in order** — do NOT skip ahead or combine steps
3. Mark each todo as `completed` after finishing, `in_progress` when starting
4. If a step is not applicable (e.g., no cuTile impl), mark it `completed` with a note, do NOT silently skip
5. Each step MUST result in a file write or explicit skip decision — no silent omissions

## Instructions

MUST copy this checklist to TodoWrite at the start:

```
- [ ] Step 1: Register dispatch interface in ops.py
- [ ] Step 2: Implement cuTile backend
- [ ] Step 3: Register in __init__.py (cutile)
- [ ] Step 4: Add tests
- [ ] Step 5: Add benchmark to tests/benchmark
- [ ] Step 6: Verify (run pytest + lint)
```

## Step 1: Register dispatch interface

**File**: `src/tilegym/ops/ops.py`

Add a `@dispatch` function — this is the **single entry point** for all backends.

```python
@dispatch(
    "my_op",
)
def my_op(
    input: torch.Tensor,
    out: Optional[torch.Tensor] = None,
    **kwargs: Any,
):
    """
    Description of my_op.

    Args:
        input: Input tensor
        out: Optional preallocated output tensor
        **kwargs: Additional arguments for backend-specific configurations

    Returns:
        torch.Tensor
    """
    raise NotImplementedError(f"my_op is not implemented for {get_current_backend()}")
```

**Key rules:**
- Function body only raises `NotImplementedError`
- Include `**kwargs` for backend-specific parameters

**Reference**: See existing ops in `src/tilegym/ops/ops.py` (e.g., `silu_and_mul`, `softmax`)

## Step 2: Implement cuTile backend

**File**: `src/tilegym/ops/cutile/my_op.py`

The file structure follows this template:

```python
import torch
import cuda.tile as ct

from tilegym.backend import register_impl


@ct.kernel
def my_op_kernel_ct(x, output, n_elements: ct.Constant[int], BLOCK_SIZE: ct.Constant[int]):
    bid = ct.bid(0)
    indices = bid * BLOCK_SIZE + ct.arange(0, BLOCK_SIZE)
    x_val = ct.gather(x, indices)
    # ... compute ...
    ct.scatter(output, indices, result)


@register_impl("my_op", backend="cutile")
def my_op(input: torch.Tensor, out: torch.Tensor = None, **kwargs) -> torch.Tensor:
    n = input.numel()
    if out is None:
        out = torch.empty_like(input)
    grid = ((n + 1023) // 1024,)
    ct.launch(stream, grid, kernel, (some args, ...))
    return out
```

**Reference**: `src/tilegym/ops/cutile/silu_and_mul.py`

## Step 3: Register in `__init__.py` (CRITICAL)

Missing this step means the cuTile backend implementation never gets loaded.

**File**: `src/tilegym/ops/cutile/__init__.py`

Add inside `if is_backend_available("cutile"):` block (alphabetically):

```python
from . import my_op
```

And in the function import section:

```python
from .my_op import my_op
```

And add `"my_op"` to `__all__`.

## Step 4: Add tests

**File**: `tests/ops/test_my_op.py`

**CRITICAL**: Always import from `tilegym.ops`, NEVER from `tilegym.ops.cutile.my_op`.

```python
import pytest
import torch

from tilegym.backend import is_backend_available, set_backend
from .. import common

_backends = ["cutile"]


class Test_MY_OP(common.PyTestCase):
    @staticmethod
    def reference(input):
        """Reference implementation using PyTorch."""
        return torch.some_reference(input)

    @pytest.mark.parametrize("shape, dtype", [
        ((1024,), torch.float16),
        ((1024, 512), torch.float32),
        ((64, 64, 64), torch.bfloat16),
    ])
    @pytest.mark.parametrize("backend", _backends)
    def test_op(self, shape, dtype, backend, arch):
        if backend == "cutile" and not is_backend_available("cutile"):
            pytest.skip("Cutile backend not available")
        try:
            set_backend(backend)
        except Exception as e:
            pytest.skip(f"Backend is not supported: {e}")

        self.setUp()

        from tilegym.ops import my_op

        A = torch.randn(*shape, dtype=dtype, device="cuda")
        self.assertCorrectness(
            my_op, self.reference, {"input": A},
            atol=1e-3, rtol=1e-3,
        )
```

**Key patterns:**
- `_backends = ["cutile"]`
- `test_op`: use `set_backend(backend)` with try-except, call `self.setUp()`

**Reference**: `tests/ops/test_silu_and_mul.py`

Below is the common errors.
```
1. Missing _backends list (inside class)
2. test_op / test_op_xxx — missing @pytest.mark.parametrize("backend", _backends), backend parameter, and tilegym.is_backend_available / tilegym.set_backend pattern
```

## Step 5: Add benchmark to tests/benchmark

**File**: `tests/benchmark/bench_my_op.py`

**Key rules from benchmark_rules.md:**
- Call the op via `tilegym.ops.my_op(a, b, ..., backend=backend)` — do **not** use `set_backend`.
- Define `ALL_BACKENDS` (include at least `cutile` and `torch`), filter with `get_supported_backends()`.
- Implement `reference_my_op(...)` and register it: `register_impl("my_op", "torch")(reference_my_op)`.
- Use `create_benchmark_config()` to build `triton.testing.Benchmark` configs (e.g. by shape/dtype).
- Use `@triton.testing.perf_report([...])` on `bench_my_op(...)`; inside the bench function: correctness check with `torch.testing.assert_close(fn(), ref(), ...)`, then `ms = triton.testing.do_bench(fn)` (or `do_bench_cudagraph`), compute GB/s or TFLOPS, and return the metric.
- Entry point: `if __name__ == "__main__": bench_my_op.run(print_data=True)`.

Template structure:

```python
import torch
import triton
import triton.testing

import tilegym
from tilegym.backend import is_backend_available, register_impl

ALL_BACKENDS = [
    ("cutile", "cuTile", ("orange", "-")) if is_backend_available("cutile") else None,
    ("torch", "PyTorch", ("green", "-")),
]

def get_supported_backends():
    return [p for p in ALL_BACKENDS if p is not None]

def reference_my_op(input: torch.Tensor, out: torch.Tensor = None, **kwargs):
    """Reference implementation using PyTorch."""
    ...

register_impl("my_op", "torch")(reference_my_op)

def create_benchmark_config(datatype, ...):
    available_backends = get_supported_backends()
    if not available_backends:
        return None
    backends, names, styles = zip(*available_backends)
    return triton.testing.Benchmark(
        x_names=["M"],  # or other dimension names
        x_vals=[...],
        line_arg="backend",
        line_vals=list(backends),
        line_names=list(names),
        styles=list(styles),
        ylabel="GB/s",  # or TFLOPS
        plot_name="my-op-...",
        args={"datatype": datatype, ...},
    )

@triton.testing.perf_report([
    create_benchmark_config(datatype, ...)
    for datatype in [torch.float16, torch.float32]
    for ... in [...]
])
def bench_my_op(M, backend, datatype, ..., device="cuda"):
    x = torch.randn(..., dtype=datatype, device=device)

    fn = lambda: tilegym.ops.my_op(x, backend=backend)
    ref = lambda: reference_my_op(x)
    torch.testing.assert_close(fn(), ref(), rtol=1e-2, atol=1e-2)

    ms = triton.testing.do_bench(fn)  # or do_bench_cudagraph(fn)
    # Compute metric (e.g. GB/s or TFLOPS) from ms and problem size
    return metric

if __name__ == "__main__":
    bench_my_op.run(print_data=True)
```

**Benchmark Plot Names**: Must include `-TFLOPS` or `-GBps` suffix
  - Example: `plot_name=f"persistent-layer-norm-M{num_rows}-{dtype_name}-GBps"`

## Step 6: Verify

```bash
# Run tests
pytest tests/ops/test_my_op.py -v

# Run benchmark (optional)
python tests/benchmark/bench_my_op.py

# Lint
pre-commit run -a
```
