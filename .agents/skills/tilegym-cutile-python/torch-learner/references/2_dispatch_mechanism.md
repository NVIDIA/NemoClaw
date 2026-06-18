# PyTorch Dispatch Mechanism

This document explains how a Python-level PyTorch call routes through the dispatcher to reach a backend-specific C++ or CUDA implementation.

**Note:** All file paths in this document are relative to the PyTorch source checkout in the skill cache. The default path is `~/.cache/tilegym/pytorch-source`, unless the user chooses another cache directory. All searches must stay within that checkout.

## Overview

When you call `torch.relu(x)` or `x.matmul(y)`, PyTorch doesn't directly call a single function. Instead, it goes through a **dispatcher** that selects the correct backend implementation based on:

1. The operation being called
2. The tensor's device (CPU, CUDA, MPS, etc.)
3. Whether autograd is tracking gradients
4. Other dispatch keys (Batched for vmap, FuncTorchGradWrapper, etc.)

## The Dispatch Pipeline

```
Python call: torch.add(a, b)
    │
    ▼
Python binding (generated or manual)
    │
    ▼
torch::Dispatcher::call()          ← C++ dispatcher
    │
    ▼
DispatchKeySet resolution          ← examines tensor DispatchKeys
    │
    ▼
Dispatch key chain:
    Autograd → ... → CPU/CUDA      ← walks through keys in priority order
    │
    ▼
Backend kernel (e.g., at::native::add_cpu or at::native::add_cuda)
```

## native_functions.yaml: The Master Registry

Every ATen operation is declared in `aten/src/ATen/native/native_functions.yaml`. This is the single source of truth for what operations exist and how they dispatch.

### Entry Format

```yaml
- func: operation_name.overload(Tensor self, Tensor other, ...) -> Tensor
  variants: function, method    # Available as torch.op() and/or tensor.op()
  structured: True              # Uses structured kernels (optional)
  structured_delegate: op.out   # Delegates to out= variant (optional)
  dispatch:
    CPU: op_cpu                 # CPU implementation function name
    CUDA: op_cuda               # CUDA implementation function name
    SparseCPU: op_sparse_cpu    # Sparse CPU variant (optional)
    SparseCUDA: op_sparse_cuda  # Sparse CUDA variant (optional)
    MPS: op_mps                 # Apple Metal variant (optional)
```

### Reading a Real Entry

Example: the `add` operation:

```yaml
- func: add.Tensor(Tensor self, Tensor other, *, Scalar alpha=1) -> Tensor
  device_check: NoCheck
  structured_delegate: add.out
  variants: function, method
  tags: [canonical, pointwise]
```

This tells us:
- **Signature**: `add(self, other, alpha=1) -> Tensor`
- **Variants**: Available as both `torch.add(a, b)` and `a.add(b)`
- **Delegation**: Implementation delegates to the `add.out` variant
- **Tags**: It's a pointwise operation

The `add.out` variant:

```yaml
- func: add.out(Tensor self, Tensor other, *, Scalar alpha=1, Tensor(a!) out) -> Tensor(a!)
  device_check: NoCheck
  structured: True
  dispatch:
    CPU, CUDA: add_out
    SparseCPU: add_out_sparse_cpu
    SparseCUDA: add_out_sparse_cuda
    SparseCsrCPU: add_out_sparse_csr_cpu
    SparseCsrCUDA: add_out_sparse_csr_cuda
    MkldnnCPU: mkldnn_add_out
    MPS: add_out_mps
```

This tells us:
- Both CPU and CUDA dispatch to a function named `add_out`
- Sparse tensors have separate implementations
- MKL-DNN has its own path on CPU
- MPS (Apple GPU) has its own path

### Common Dispatch Patterns

**Pattern 1: Shared implementation** (same function for CPU and CUDA)
```yaml
dispatch:
  CPU, CUDA: my_op_impl       # Single function handles both, uses TensorIterator
```

**Pattern 2: Separate backends**
```yaml
dispatch:
  CPU: my_op_cpu
  CUDA: my_op_cuda
```

**Pattern 3: Structured delegation** (most common for standard ops)
```yaml
structured_delegate: my_op.out  # Delegates to the out= variant
```

**Pattern 4: No dispatch key** (pure Python or composite)
```yaml
# No dispatch: key means it's a CompositeImplicitAutograd op
# Implemented once, works on all backends, autograd handled automatically
```

**Pattern 5: CompositeExplicitAutograd**
```yaml
dispatch:
  CompositeExplicitAutograd: my_op_impl  # Works on all backends, custom autograd
```

## DispatchKey System

DispatchKeys determine which implementation gets called. They form an ordered priority chain.

### Key DispatchKeys (in priority order)

| DispatchKey | Purpose |
|-------------|---------|
| `Autograd` (`AutogradCPU`, `AutogradCUDA`) | Records operations for backward pass |
| `Batched` | vmap batching transforms |
| `Functionalize` | Functional transforms |
| `ADInplaceOrView` | Tracks inplace/view ops for autograd |
| `BackendSelect` | Selects between backends when ambiguous |
| `CPU` | CPU implementation |
| `CUDA` | CUDA implementation |
| `MPS` | Apple Metal Performance Shaders |
| `SparseCPU` / `SparseCUDA` | Sparse tensor backends |
| `QuantizedCPU` / `QuantizedCUDA` | Quantized tensor backends |

### How Dispatch Keys Are Resolved

1. Each tensor has a `DispatchKeySet` based on its device, layout, and other properties
2. When an op is called, PyTorch computes the union of all input tensors' key sets
3. The dispatcher walks through keys from highest to lowest priority
4. The first key that has a registered kernel for this op is called
5. That kernel may call `redispatch` to continue to the next key

### Autograd Dispatch

For most ops, the dispatch chain looks like:

```
AutogradCUDA → CUDA kernel
```

The `AutogradCUDA` wrapper:
1. Saves tensors needed for backward
2. Calls the actual CUDA kernel via `redispatch`
3. Attaches a `grad_fn` to the output tensor

## Python-to-C++ Bridge Mechanisms

### Mechanism 1: `torch._C._VariableFunctions` (via `_VF`)

Used primarily by `nn.functional` and some `nn.Module` implementations.

```python
# In torch/_VF.py:
# _VF is a namespace that routes to torch._C._VariableFunctions

# In torch/nn/modules/rnn.py:
result = _VF.lstm(input, hx, self._flat_weights, ...)
# This calls torch._C._VariableFunctions.lstm()
# Which routes to the C++ dispatcher
```

### Mechanism 2: `torch._C` direct calls

```python
# In torch/nn/functional.py:
return torch._C._nn.linear(input, weight, bias)
# Direct call to generated C++ binding
```

### Mechanism 3: `torch.ops` namespace

```python
# Calling ops by their registered name:
torch.ops.aten.add(a, b)
torch.ops.aten.mm(a, b)
# Routes through the C++ dispatcher
```

### Mechanism 4: Python-defined ops (CompositeImplicitAutograd)

Some ops are implemented purely in Python and never touch C++:

```python
# In torch/nn/functional.py:
def multi_head_attention_forward(...):
    # Implemented in pure Python using other torch ops
    q = linear(query, in_proj_weight, ...)
    ...
```

## Structured Kernels

Modern PyTorch ops use "structured kernels" — a pattern that reduces boilerplate:

1. **Meta function**: Computes output shape and dtype without allocating memory
2. **Implementation function**: Does the actual computation

```yaml
- func: add.out(Tensor self, Tensor other, *, Scalar alpha=1, Tensor(a!) out) -> Tensor(a!)
  structured: True
  dispatch:
    CPU, CUDA: add_out
```

In C++:
```cpp
// Meta function (shape inference):
TORCH_META_FUNC(add) (const Tensor& self, const Tensor& other, const Scalar& alpha) {
    // ... compute output shape, set output metadata
}

// CPU implementation:
TORCH_IMPL_FUNC(add_out_cpu) (const Tensor& self, const Tensor& other, ...) {
    // ... actual CPU computation
}

// CUDA implementation:
TORCH_IMPL_FUNC(add_out_cuda) (const Tensor& self, const Tensor& other, ...) {
    // ... actual CUDA computation
}
```

## Code Generation Pipeline

The code generation system converts YAML declarations into C++ dispatch code.

### Input Files
- `aten/src/ATen/native/native_functions.yaml` — Op declarations
- `tools/autograd/derivatives.yaml` — Autograd backward formulas
- `tools/autograd/templates/*.cpp` — C++ template files

### Generator Scripts
- `torchgen/gen.py` — Main generator for dispatch code
- `tools/autograd/gen_autograd.py` — Generates autograd wrappers
- `tools/autograd/gen_variable_type.py` — Generates VariableType dispatch

### Output (generated during build)
- `RegisterCPU.cpp`, `RegisterCUDA.cpp` — Backend registrations
- `Functions.h`, `NativeFunctions.h` — Function declarations
- `VariableType_*.cpp` — Autograd wrappers
- Python bindings (pybind11 code)

### Reading Generated Code

Since generated code only exists after building, you can understand it by:
1. Reading the YAML entries for your op
2. Reading the templates in `tools/autograd/templates/`
3. Understanding the pattern: YAML entry → template substitution → generated C++

## Tracing an Op Through Dispatch: Quick Reference

Given an op name (e.g., `lstm`):

1. **Find in YAML**: `grep -n "func:.*lstm" aten/src/ATen/native/native_functions.yaml`
2. **Read dispatch table**: Look at the `dispatch:` section
3. **Find CPU impl**: Search for the CPU function name in `aten/src/ATen/native/*.cpp`
4. **Find CUDA impl**: Search for the CUDA function name in `aten/src/ATen/native/cuda/*.cu` or `aten/src/ATen/native/cudnn/*.cpp`
5. **Find autograd**: `grep -n "lstm" tools/autograd/derivatives.yaml`
