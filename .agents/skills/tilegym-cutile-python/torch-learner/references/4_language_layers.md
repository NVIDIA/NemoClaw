# Reading PyTorch Code Across Language Layers

This document explains how to read and navigate PyTorch code at each language layer: Python, C++ (ATen), CUDA, and auto-generated code.

**Note:** All file paths in this document are relative to the PyTorch source checkout in the skill cache. The default path is `~/.cache/tilegym/pytorch-source`, unless the user chooses another cache directory. All searches must stay within that checkout.

## Layer 1: Python

### Module Pattern

All `nn.Module` classes follow this structure:

```python
class MyModule(Module):
    def __init__(self, ...):
        super().__init__()
        # Register parameters and buffers
        self.weight = Parameter(torch.empty(...))
        self.bias = Parameter(torch.empty(...))
        self.reset_parameters()

    def reset_parameters(self):
        # Initialize weights (kaiming, xavier, etc.)
        init.kaiming_uniform_(self.weight, ...)

    def forward(self, input: Tensor) -> Tensor:
        # The actual computation — THIS IS WHAT YOU TRACE
        return F.linear(input, self.weight, self.bias)
```

**Key insight:** `__init__` sets up state; `forward()` is where computation happens. Always start tracing from `forward()`.

### Functional Wrapper Pattern

Functions in `torch/nn/functional.py` typically:

```python
def relu(input: Tensor, inplace: bool = False) -> Tensor:
    # 1. Input validation
    if not isinstance(input, Tensor):
        raise TypeError(...)
    # 2. Delegation to C++
    if inplace:
        return torch.relu_(input)
    return torch.relu(input)
```

**Key insight:** The Python layer is mostly validation and routing. The real computation is always delegated.

### _VF Bridge Pattern

```python
# torch/_VF.py routes through torch._C._VariableFunctions
# Example usage in torch/nn/modules/rnn.py:

result = _VF.lstm(input, hx, self._flat_weights, self.bias,
                  self.num_layers, self.dropout, self.training,
                  self.bidirectional, self.batch_first)
```

**Key insight:** When you see `_VF.<name>()`, this is a direct bridge to the C++ dispatcher. Search for `<name>` in `native_functions.yaml`.

### torch.ops Pattern

```python
# Direct access to registered C++ operators
torch.ops.aten.mm(a, b)        # Calls aten::mm
torch.ops.aten.add(a, b, alpha=1)  # Calls aten::add
```

**Key insight:** `torch.ops.aten.<name>` maps directly to `aten::<name>` in native_functions.yaml.

## Layer 2: C++ (ATen)

### Standard Function Pattern

```cpp
// In aten/src/ATen/native/SomeFile.cpp

Tensor my_op(const Tensor& self, const Tensor& other) {
    // 1. Input checking
    TORCH_CHECK(self.dim() >= 2, "Expected 2D+ tensor");

    // 2. Output allocation
    auto result = at::empty({m, n}, self.options());

    // 3. Dispatch to device-specific implementation
    my_op_stub(self.device().type(), result, self, other);

    return result;
}
```

### Structured Kernel Pattern

Modern ops use structured kernels with meta functions:

```cpp
// Meta function — computes output shape without allocating
TORCH_META_FUNC(my_op)(const Tensor& self, const Tensor& other) {
    // Set output shape
    set_output_raw_strided(0, {m, n}, {}, self.options());
}

// CPU implementation
TORCH_IMPL_FUNC(my_op_out_cpu)(const Tensor& self, const Tensor& other, const Tensor& result) {
    // Actual CPU computation
    my_op_kernel(kCPU, result, self, other);
}

// CUDA implementation
TORCH_IMPL_FUNC(my_op_out_cuda)(const Tensor& self, const Tensor& other, const Tensor& result) {
    // CUDA kernel launch
    my_op_kernel(kCUDA, result, self, other);
}
```

### Dispatch Stub Pattern

Many ops use dispatch stubs to route to device-specific implementations:

```cpp
// Declaration (in header or .cpp file)
DECLARE_DISPATCH(my_op_fn, my_op_stub);

// CPU registration (in cpu/ subdirectory)
REGISTER_DISPATCH(my_op_stub, &my_op_cpu_impl);

// CUDA registration (in cuda/ subdirectory)
REGISTER_DISPATCH(my_op_stub, &my_op_cuda_impl);
```

**Key insight:** When you see `DECLARE_DISPATCH` + a stub call, search for `REGISTER_DISPATCH` with the same stub name to find device implementations.

### TensorIterator Pattern

For element-wise operations, PyTorch uses TensorIterator:

```cpp
Tensor& add_out(const Tensor& self, const Tensor& other,
                const Scalar& alpha, Tensor& result) {
    auto iter = TensorIterator::borrowing_binary_op(result, self, other);
    add_stub(iter.device_type(), iter, alpha);
    return result;
}
```

**Key insight:** TensorIterator handles broadcasting, dtype promotion, and memory iteration. The actual compute kernel is simple — it just processes elements.

### Key C++ Macros

| Macro | Purpose |
|-------|---------|
| `TORCH_CHECK(cond, msg)` | Runtime assertion with error message |
| `TORCH_META_FUNC(name)` | Meta function for structured kernels |
| `TORCH_IMPL_FUNC(name)` | Implementation function for structured kernels |
| `DECLARE_DISPATCH(fn_type, name)` | Declare a dispatch stub |
| `REGISTER_DISPATCH(name, fn_ptr)` | Register implementation for a stub |
| `AT_DISPATCH_ALL_TYPES(dtype, name, fn)` | Dispatch over all scalar types |
| `AT_DISPATCH_FLOATING_TYPES(dtype, name, fn)` | Dispatch over float types only |
| `TORCH_LIBRARY_IMPL(ns, key, m)` | Register op implementations for a dispatch key |

### AT_DISPATCH Pattern

Type dispatching is done with AT_DISPATCH macros:

```cpp
AT_DISPATCH_FLOATING_TYPES(input.scalar_type(), "my_op_cpu", [&] {
    // scalar_t is now the concrete type (float, double)
    auto data = input.data_ptr<scalar_t>();
    // ... operate on data as scalar_t*
});
```

**Key insight:** `scalar_t` inside the lambda is the concrete C++ type. This is how one function handles float32, float64, etc.

## Layer 3: CUDA

### Kernel Launch Pattern

```cpp
// In aten/src/ATen/native/cuda/SomeKernel.cu

// CUDA kernel
template <typename scalar_t>
__global__ void my_op_kernel(
    scalar_t* output,
    const scalar_t* input,
    int64_t numel
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < numel) {
        output[idx] = /* computation */;
    }
}

// Launch wrapper
void my_op_cuda(const Tensor& result, const Tensor& input) {
    int64_t numel = input.numel();
    int threads = 256;
    int blocks = (numel + threads - 1) / threads;

    AT_DISPATCH_FLOATING_TYPES(input.scalar_type(), "my_op_cuda", [&] {
        my_op_kernel<scalar_t><<<blocks, threads, 0,
            at::cuda::getCurrentCUDAStream()>>>(
            result.data_ptr<scalar_t>(),
            input.data_ptr<scalar_t>(),
            numel
        );
        C10_CUDA_KERNEL_LAUNCH_CHECK();
    });
}
```

**Key insight:** Look for `<<<blocks, threads>>>` kernel launch syntax to find where GPU code actually executes.

### cuDNN Wrapper Pattern

For operations that use cuDNN (convolution, RNN, batch norm):

```cpp
// In aten/src/ATen/native/cudnn/SomeOp.cpp

void my_op_cudnn(const Tensor& input, const Tensor& weight, Tensor& output) {
    // 1. Create cuDNN descriptors
    cudnnTensorDescriptor_t inputDesc;
    cudnnCreateTensorDescriptor(&inputDesc);
    cudnnSetTensorNdDescriptor(inputDesc, ...);

    // 2. Configure the operation
    cudnnOpDescriptor_t opDesc;
    cudnnCreateOpDescriptor(&opDesc);

    // 3. Get workspace size
    size_t workspaceSize;
    cudnnGetOpWorkspaceSize(handle, ..., &workspaceSize);

    // 4. Execute
    cudnnMyOperation(
        getCudnnHandle(),
        &alpha, inputDesc, input.data_ptr(),
        filterDesc, weight.data_ptr(),
        opDesc,
        &beta, outputDesc, output.data_ptr()
    );
}
```

**Key insight:** cuDNN wrappers follow a descriptor → configure → workspace → execute pattern. The actual computation is inside the cuDNN library (closed source).

### cuBLAS Wrapper Pattern

For linear algebra (matmul, gemm):

```cpp
// In aten/src/ATen/native/cuda/Blas.cpp or similar

void mm_cuda(const Tensor& self, const Tensor& mat2, const Tensor& result) {
    // Uses cuBLAS for the actual computation
    at::cuda::blas::gemm<float>(
        'N', 'N',       // transpose flags
        m, n, k,        // dimensions
        alpha,
        self.data_ptr<float>(), lda,
        mat2.data_ptr<float>(), ldb,
        beta,
        result.data_ptr<float>(), ldc
    );
}
```

### Identifying CUDA Code

| Pattern | Meaning |
|---------|---------|
| `__global__ void kernel_name(...)` | CUDA kernel function |
| `<<<blocks, threads>>>` | Kernel launch |
| `__shared__ scalar_t smem[]` | Shared memory declaration |
| `blockIdx.x`, `threadIdx.x` | Thread/block indexing |
| `__syncthreads()` | Block synchronization |
| `cudnn*` functions | cuDNN library calls |
| `cublas*` or `at::cuda::blas::*` | cuBLAS library calls |
| `C10_CUDA_KERNEL_LAUNCH_CHECK()` | Post-launch error check |

## Layer 4: Auto-Generated Code

### What Gets Generated

| Generated Artifact | Source | Generator |
|-------------------|--------|-----------|
| Python bindings | `native_functions.yaml` | `torchgen/gen.py` |
| Dispatch registrations | `native_functions.yaml` | `torchgen/gen.py` |
| Autograd wrappers | `derivatives.yaml` | `tools/autograd/gen_autograd.py` |
| VariableType dispatch | `derivatives.yaml` | `tools/autograd/gen_variable_type.py` |

### Finding the Generators

```
torchgen/
├── gen.py                    # Main entry point for code generation
├── model.py                  # Python model of native_functions.yaml
├── api/
│   ├── python.py             # Python binding generation
│   ├── cpp.py                # C++ API generation
│   └── native.py             # Native function API
└── dest/
    ├── register_dispatch_key.py  # Generates RegisterCPU.cpp, RegisterCUDA.cpp
    └── native_functions.py       # Generates NativeFunctions.h
```

### Reading Generated Code Without Building

Since generated code only exists after building PyTorch, you can understand it by reading:

1. **The YAML entry** for your op (inputs and outputs)
2. **The template** in `tools/autograd/templates/` that gets filled in
3. **The generator script** to understand the transformation

Key templates:
```
tools/autograd/templates/
├── Functions.cpp             # Template for function wrappers
├── VariableType.cpp          # Template for autograd dispatch
├── python_variable_methods.cpp  # Template for Python tensor methods
└── TraceType.cpp             # Template for tracing
```

### How to Read derivatives.yaml

```yaml
# tools/autograd/derivatives.yaml

- name: mm(Tensor self, Tensor mat2) -> Tensor
  self: grad.mm(mat2.t())
  mat2: self.t().mm(grad)
```

Translation:
- `grad` = the gradient flowing back from the output (∂L/∂output)
- `self: grad.mm(mat2.t())` = ∂L/∂self = grad_output @ mat2^T
- `mat2: self.t().mm(grad)` = ∂L/∂mat2 = self^T @ grad_output

More complex example:
```yaml
- name: layer_norm(Tensor input, SymInt[] normalized_shape, Tensor? weight, Tensor? bias, float eps) -> Tensor
  input, weight, bias: "layer_norm_backward(grad, input, normalized_shape, result1, result2, weight, bias, {grad_input_mask[0], grad_input_mask[1], grad_input_mask[2]})"
```

Here `result1` and `result2` refer to saved intermediate values (mean and rstd) from the forward pass.

## Search Patterns for Each Layer

### Python Layer
```bash
# Find an nn.Module
grep -rn "class LSTM" torch/nn/modules/

# Find a functional function
grep -rn "def cross_entropy" torch/nn/functional.py

# Find what a module calls
grep -n "forward" torch/nn/modules/rnn.py
```

### C++ Layer
```bash
# Find in native_functions.yaml
grep -n "func:.*lstm" aten/src/ATen/native/native_functions.yaml

# Find C++ implementation
grep -rn "lstm\b" aten/src/ATen/native/RNN.cpp

# Find dispatch registration
grep -rn "REGISTER_DISPATCH.*lstm" aten/src/ATen/native/
```

### CUDA Layer
```bash
# Find CUDA kernels
grep -rn "__global__.*lstm" aten/src/ATen/native/cuda/

# Find cuDNN usage
grep -rn "cudnn.*lstm\|lstm.*cudnn" aten/src/ATen/native/cudnn/

# Find cuBLAS usage
grep -rn "cublas\|blas::gemm" aten/src/ATen/native/cuda/
```

### Autograd Layer
```bash
# Find backward formula
grep -n "name:.*lstm" tools/autograd/derivatives.yaml

# Find autograd Function
grep -rn "class.*Function.*autograd" torch/autograd/
```

## Putting It Together: Reading Order

When tracing an operation from top to bottom:

1. **Start in Python** — understand the user-facing API
2. **Follow to the bridge** — identify how it crosses to C++
3. **Read the YAML** — understand the dispatch configuration
4. **Read C++ implementation** — understand the algorithm
5. **Read CUDA/cuDNN** — understand the GPU execution
6. **Read derivatives.yaml** — understand the backward pass

When tracing from bottom up (e.g., understanding a CUDA kernel):

1. **Start with the kernel** — understand what it computes
2. **Find the dispatch stub** — how is this kernel registered?
3. **Find the YAML entry** — what's the op's full signature?
4. **Find the Python surface** — how does the user call this?
