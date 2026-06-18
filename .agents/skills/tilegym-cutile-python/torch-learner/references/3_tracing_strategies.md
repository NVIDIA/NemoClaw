# Tracing Strategies for Different Operation Types

This document provides concrete, step-by-step tracing strategies for each category of PyTorch operation. Each strategy shows the exact files to check and patterns to search for.

**Note:** All file paths in this document are relative to the PyTorch source checkout in the skill cache. The default path is `~/.cache/tilegym/pytorch-source`, unless the user chooses another cache directory. All searches must stay within that checkout.

## Strategy 1: nn.Module Operations

**Examples:** `nn.LSTM`, `nn.Conv2d`, `nn.Linear`, `nn.BatchNorm2d`, `nn.Transformer`

### Steps

1. **Find the module class**
   ```bash
   # Search for the module class definition
   grep -rn "class LSTM\b" torch/nn/modules/
   grep -rn "class Conv2d\b" torch/nn/modules/
   grep -rn "class LayerNorm\b" torch/nn/modules/
   ```
   Module classes are organized by category in `torch/nn/modules/`, one file per category. Always search rather than assuming file paths, as the organization may change between versions.

2. **Read the `forward()` method**
   - This is the actual computation. Most modules delegate to either:
     - `torch.nn.functional.<function>()` (functional API)
     - `torch._VF.<function>()` (direct C++ bridge)
     - `torch._C._nn.<function>()` (direct C++ binding)

3. **Follow the delegation**
   - If it calls `F.<function>()`: go to `torch/nn/functional.py`, find that function
   - If it calls `_VF.<function>()`: this goes directly to C++ via `torch._C._VariableFunctions`
   - If it calls `torch.<function>()`: check `torch/__init__.py` or `torch/functional.py`

4. **Continue to C++ layer** (see Strategy 6 below)

### Example: nn.Linear

```
torch/nn/modules/linear.py
    class Linear(Module):
        def forward(self, input):
            return F.linear(input, self.weight, self.bias)
                │
                ▼
torch/nn/functional.py
    def linear(input, weight, bias=None):
        return torch._C._nn.linear(input, weight, bias)
                │
                ▼
native_functions.yaml → linear dispatch → CPU/CUDA implementations
```

## Strategy 2: Functional Operations (F.*)

**Examples:** `F.relu`, `F.softmax`, `F.cross_entropy`, `F.conv2d`, `F.linear`

### Steps

1. **Find the function in `torch/nn/functional.py`**
   ```
   Search for: def <function_name>(
   ```

2. **Identify what it calls**
   Common patterns:
   - `torch._C._nn.<name>()` — Direct C++ binding
   - `torch.relu()`, `torch.softmax()` — Torch namespace (which then dispatches)
   - `_VF.<name>()` — VariableFunctions bridge
   - Pure Python implementation using other ops — Composite operation

3. **For C++ calls, trace to native_functions.yaml**

### Example: F.cross_entropy

```
torch/nn/functional.py
    def cross_entropy(input, target, ...):
        return torch._C._nn.cross_entropy_loss(input, target, ...)
                │
                ▼
native_functions.yaml → cross_entropy_loss
    dispatch:
        CPU, CUDA: cross_entropy_loss        ← aten/src/ATen/native/Loss.cpp
                │
                ▼
    Internally calls: log_softmax + nll_loss  (decomposed implementation)
```

## Strategy 3: Tensor Methods

**Examples:** `tensor.matmul()`, `tensor.view()`, `tensor.permute()`, `tensor.sum()`

### Steps

1. **Check if it's a method variant**
   - In `native_functions.yaml`, look for `variants: function, method`
   - Method calls on tensors dispatch through the same mechanism as `torch.<op>()`

2. **Search native_functions.yaml**
   ```
   Search for: func: <op_name>
   ```

3. **Find the implementation** based on the `dispatch:` table

### Example: tensor.view()

```
tensor.view(shape)
    │
    ▼
native_functions.yaml:
    - func: view(Tensor(a) self, SymInt[] size) -> Tensor(a)
      variants: method
      dispatch:
        CompositeExplicitAutograd: view      ← shared implementation
                │
                ▼
aten/src/ATen/native/TensorShape.cpp → view()
```

## Strategy 4: torch Namespace Operations

**Examples:** `torch.matmul`, `torch.einsum`, `torch.cat`, `torch.stack`, `torch.where`

### Steps

1. **Check `torch/functional.py`** first
   - Some ops like `torch.einsum`, `torch.stft` have Python wrappers here

2. **If not there, search `native_functions.yaml`** directly
   - Many torch namespace ops go straight to C++ dispatch

3. **Follow the dispatch table** to find implementations

### Example: torch.matmul

```
torch.matmul(a, b)
    │
    ▼
native_functions.yaml:
    - func: matmul(Tensor self, Tensor other) -> Tensor
      variants: function, method
                │
                ▼
aten/src/ATen/native/LinearAlgebra.cpp → matmul()
    │
    ├── If both 2D: calls mm() → dispatches to BLAS (cublas for CUDA)
    ├── If batched: calls bmm() → dispatches to BLAS
    ├── If vector-matrix: calls mv()
    └── ... (multiple cases based on input dimensions)
```

## Strategy 5: Autograd Custom Functions

**Examples:** User-defined `torch.autograd.Function` subclasses

### Steps

1. **Find the class** that extends `torch.autograd.Function`
2. **Read `forward()` static method** — the forward computation
3. **Read `backward()` static method** — the gradient computation
4. **For built-in ops, check `derivatives.yaml`** for their backward formulas

### Built-in Autograd Formulas

```
tools/autograd/derivatives.yaml

Example entry:
- name: mm(Tensor self, Tensor mat2) -> Tensor
  self: grad.mm(mat2.t())
  mat2: self.t().mm(grad)
```

This means:
- Gradient w.r.t. `self` = `grad_output @ mat2.T`
- Gradient w.r.t. `mat2` = `self.T @ grad_output`

## Strategy 6: C++ Implementation Tracing

Once you've identified the C++ function name from `native_functions.yaml`:

### For CPU implementations

1. **Search `aten/src/ATen/native/*.cpp`** for the function name
2. Look for patterns:
   ```cpp
   Tensor op_name(const Tensor& self, ...) {
   // or
   TORCH_IMPL_FUNC(op_name_out) (...) {
   // or
   Tensor& op_name_out(const Tensor& self, ..., Tensor& out) {
   ```

### For CUDA implementations

1. **Check `aten/src/ATen/native/cuda/*.cu`** for CUDA kernels
2. **Check `aten/src/ATen/native/cudnn/*.cpp`** for cuDNN-accelerated ops
3. Look for patterns:
   ```cpp
   // Direct CUDA kernel
   __global__ void op_kernel(...) { ... }

   // cuDNN wrapper
   void op_cudnn(...) {
       cudnnOpDescriptor_t desc;
       ...
   }

   // cuBLAS wrapper (for linear algebra)
   at::cuda::blas::gemm(...)
   ```

### Finding cuDNN-accelerated operations

Operations commonly accelerated by cuDNN include convolution, RNN/LSTM/GRU, batch normalization, activation, and softmax. To find the cuDNN implementation for a specific op:

```bash
# Search for cuDNN wrappers related to your op
grep -rn "cudnn.*op_name\|op_name.*cudnn" aten/src/ATen/native/ -i -l

# List all cuDNN wrapper files in your PyTorch version
ls aten/src/ATen/native/cudnn/ 2>/dev/null
```

## Strategy 7: Composed / Decomposed Operations

Some operations are compositions of simpler ops.

### Identifying composed ops

1. **In `native_functions.yaml`**: If an op has no `dispatch:` key, it's a `CompositeImplicitAutograd` op — implemented in terms of other ops
2. **In Python**: If `F.<op>` calls multiple other `torch.*` ops, it's composed
3. **Check `torch/_decomp/decompositions.py`**: Contains explicit decompositions

### Example: F.layer_norm

```
F.layer_norm(input, normalized_shape, weight, bias)
    │
    ▼
native_functions.yaml → layer_norm
    dispatch:
        CPU, CUDA: layer_norm_cpu/cuda  ← has a fused kernel
                │
                ▼
    But under torch.compile, it may decompose to:
        mean → var → subtract → multiply → add
```

### Decomposition Registry

```python
# torch/_decomp/decompositions.py
@register_decomposition(aten.layer_norm)
def layer_norm(input, normalized_shape, weight, bias, eps):
    # Decomposed into elementary operations
    mean = input.mean(dim, keepdim=True)
    var = input.var(dim, keepdim=True, correction=0)
    out = (input - mean) / torch.sqrt(var + eps)
    if weight is not None:
        out = out * weight
    if bias is not None:
        out = out + bias
    return out
```

## Quick Reference: Operation → How to Find It

| Operation Type | Search Strategy |
|---------------|----------------|
| `nn.<Module>` | `grep -rn "class <Module>\b" torch/nn/modules/` → read `forward()` |
| `F.<function>` | `grep -n "def <function>" torch/nn/functional.py` |
| `torch.<op>` | `grep -n "def <op>" torch/functional.py` or search `native_functions.yaml` |
| `tensor.<method>` | `grep "func:.*<method>" native_functions.yaml` (look for `variants: method`) |
| CUDA kernel | `grep -rn "<op>" aten/src/ATen/native/ --include="*.cu"` |
| cuDNN op | `grep -rn "<op>" aten/src/ATen/native/ --include="*.cpp" \| grep cudnn` |
| Autograd backward | `grep -A 5 "name:.*<op>" tools/autograd/derivatives.yaml` |
| Decomposition | `grep -rn "<op>" torch/_decomp/` |
