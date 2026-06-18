# Well-Known Operations Reference

This file documents PyTorch operations whose implementations are conventional and well-understood. For these ops, **skip the full source tracing workflow** and answer directly from this reference. Only trace the source if the user asks about a specific implementation detail not covered here.

## Tensor Creation

### `torch.zeros` / `torch.ones` / `torch.full`

Allocate memory, fill with a constant value.

- **Python**: Thin wrappers that call into C++ via the dispatcher
- **C++**: Allocates a `TensorImpl` with the requested shape/dtype/device, then fills with the constant value
- **CUDA**: Uses a simple fill kernel (`fill_` op) — a single-pass write over contiguous memory
- **Autograd**: Not tracked (leaf tensors). Gradient is always zero for constant creation

```python
torch.zeros(3, 4, device="cuda", dtype=torch.float32)
# Allocates 3*4*4 = 48 bytes on GPU, fills with 0.0
# Equivalent to: torch.empty(3, 4, ...).fill_(0)

torch.ones(3, 4)         # Fill with 1.0
torch.full((3, 4), 3.14) # Fill with 3.14
torch.zeros_like(x)      # Same shape/dtype/device as x, filled with 0
torch.ones_like(x)       # Same shape/dtype/device as x, filled with 1
torch.full_like(x, val)  # Same shape/dtype/device as x, filled with val
```

### `torch.empty`

Allocates memory without initialization (contains garbage values).

- **C++**: Calls the memory allocator for the target device, returns uninitialized tensor
- **CUDA**: `cudaMalloc` (or caching allocator) — no kernel launch, just memory allocation
- **Key point**: Fastest creation op since it skips the fill step

### `torch.randn` / `torch.rand` / `torch.randint` / `torch.normal`

Allocate memory, fill with random values from a distribution.

- **C++**: Allocates tensor, then calls the RNG kernel
- **CUDA**: Uses cuRAND or Philox RNG on GPU
- `torch.randn` → standard normal (mean=0, std=1)
- `torch.rand` → uniform [0, 1)
- `torch.randint(low, high, size)` → uniform integers in [low, high)
- `torch.normal(mean, std)` → normal with specified parameters
- `torch.randn_like(x)` etc. — same shape/dtype/device as x

### `torch.arange` / `torch.linspace` / `torch.logspace`

Allocate memory, fill with a sequence of values.

- `torch.arange(start, end, step)` → evenly spaced values with given step
- `torch.linspace(start, end, steps)` → evenly spaced values (inclusive endpoints)
- `torch.logspace(start, end, steps)` → logarithmically spaced values
- **C++**: Simple loop or vectorized fill kernel

### `torch.eye`

Identity matrix.

- **C++**: Allocates zeros, fills diagonal with 1.0
- `torch.eye(n)` → n×n identity matrix
- `torch.eye(n, m)` → n×m matrix with 1s on diagonal

### `torch.tensor` / `torch.as_tensor` / `torch.from_numpy`

Create a tensor from existing data.

- `torch.tensor(data)` → always copies data, infers dtype
- `torch.as_tensor(data)` → avoids copy if possible (shares memory with numpy array)
- `torch.from_numpy(ndarray)` → shares memory with numpy array (CPU only)

## Shape Operations

### `tensor.view` / `tensor.reshape`

Change the logical shape without moving data.

- `view()` → returns a new tensor sharing the same underlying data. Requires the tensor to be contiguous in memory. Zero-cost (no data movement)
- `reshape()` → like `view()` if possible, otherwise copies data to make it contiguous first
- **Autograd**: Backward pass applies the inverse reshape to the gradient

```python
x = torch.randn(3, 4)
x.view(12)          # Flatten — no copy
x.view(4, 3)        # Reshape — no copy
x.reshape(-1)       # Flatten — may copy if not contiguous
```

### `tensor.permute` / `tensor.transpose` / `tensor.t()`

Reorder dimensions.

- **C++**: Changes stride metadata only — no data movement. The tensor becomes a view with permuted strides
- `permute(dims)` → arbitrary dimension reordering
- `transpose(dim0, dim1)` → swap two dimensions
- `t()` → shorthand for 2D transpose
- **Key point**: Result may not be contiguous. Call `.contiguous()` if needed for downstream ops

### `tensor.contiguous`

Ensure the tensor is stored contiguously in memory.

- If already contiguous: returns self (no-op)
- If not contiguous: allocates new memory, copies data in contiguous order
- **CUDA**: Uses a copy kernel to rearrange data

### `tensor.unsqueeze` / `tensor.squeeze`

Add or remove size-1 dimensions.

- `unsqueeze(dim)` → inserts a size-1 dimension at `dim`. No data copy, just metadata change
- `squeeze()` → removes all size-1 dimensions. No data copy
- `squeeze(dim)` → removes size-1 dimension at `dim` if it is size 1

### `tensor.expand` / `tensor.repeat`

Broadcast or tile a tensor.

- `expand(sizes)` → broadcast without copying data (sets stride to 0 for broadcast dims). Zero-cost
- `repeat(sizes)` → actually copies data to tile the tensor. Allocates new memory
- **Key point**: Prefer `expand` over `repeat` when possible

### `torch.cat` / `torch.stack`

Concatenate tensors.

- `torch.cat(tensors, dim)` → concatenate along existing dimension. Allocates output, copies all input data
- `torch.stack(tensors, dim)` → like `cat` but adds a new dimension first (each tensor gets unsqueezed)
- **CUDA**: Parallel copy kernel that writes each input's data to the correct offset in the output

### `torch.split` / `torch.chunk`

Split a tensor.

- `split(size, dim)` → split into chunks of given size. Returns views (no copy)
- `chunk(n, dim)` → split into n roughly-equal chunks. Returns views (no copy)

### `tensor.flatten`

- Equivalent to `tensor.reshape(-1)` or `tensor.view(-1)` (contiguous case)

## Dtype and Device Operations

### `tensor.to`

Move tensor to a different device or convert dtype.

- `tensor.to(device)` → copies data to target device (e.g., CPU→CUDA or CUDA→CPU)
- `tensor.to(dtype)` → converts element type (e.g., float32→float16)
- `tensor.to(device, dtype)` → both at once
- **CPU→CUDA**: `cudaMemcpy` (host-to-device transfer)
- **CUDA→CPU**: `cudaMemcpy` (device-to-host transfer)
- **Same device, same dtype**: returns self (no-op)
- Shortcuts: `tensor.cuda()`, `tensor.cpu()`, `tensor.half()`, `tensor.float()`, `tensor.int()`

### `tensor.clone`

- Deep copy: allocates new memory, copies all data
- Preserves autograd history (gradient flows through clone)

### `tensor.detach`

- Returns a new tensor sharing the same data but detached from the computation graph
- No data copy — just a metadata change
- Gradient will not flow through a detached tensor

## Indexing and Slicing

### Basic indexing (`tensor[i]`, `tensor[i:j]`, `tensor[..., k]`)

- Returns a view (no copy) for basic integer/slice indexing
- Uses the same underlying storage with adjusted offset and strides
- **Autograd**: Backward scatters gradients back to the indexed positions

### Advanced indexing (`tensor[bool_mask]`, `tensor[index_tensor]`)

- Returns a copy (not a view) because the indexed elements may not be contiguous
- **CUDA**: Uses a gather kernel
- `tensor[bool_mask]` → selects elements where mask is True (result is 1D)
- `tensor[index_tensor]` → gathers elements at specified indices

### `torch.gather` / `torch.scatter` / `torch.index_select`

- `gather(input, dim, index)` → gather values along a dimension using index tensor
- `scatter(input, dim, index, src)` → scatter values from src into input at index positions
- `index_select(input, dim, index)` → select slices along a dimension
- **CUDA**: Each has a dedicated CUDA kernel for parallel gather/scatter

## Basic Math Operations

### Element-wise arithmetic (`+`, `-`, `*`, `/`, `**`)

- Dispatched as `torch.add`, `torch.sub`, `torch.mul`, `torch.div`, `torch.pow`
- **C++**: Uses `TensorIterator` — a framework that handles broadcasting, dtype promotion, and memory iteration automatically
- **CUDA**: Launches a simple element-wise kernel. Each thread processes one or more elements
- **Autograd**:
  - `add(a, b)`: grad_a = grad, grad_b = grad
  - `mul(a, b)`: grad_a = grad * b, grad_b = grad * a
  - `div(a, b)`: grad_a = grad / b, grad_b = -grad * a / b²
  - `pow(a, n)`: grad_a = n * a^(n-1) * grad

### `torch.matmul` / `torch.mm` / `torch.bmm` / `@` operator

- `mm(a, b)` → 2D matrix multiply. Calls cuBLAS `gemm` on CUDA
- `bmm(a, b)` → batched matrix multiply. Calls cuBLAS `gemmBatched`
- `matmul(a, b)` → general matrix multiply with broadcasting. Dispatches to `mm`, `bmm`, `mv`, or `dot` based on input dimensions
- `@` operator → calls `matmul`
- **CUDA**: All paths ultimately call cuBLAS for the actual computation
- **Autograd**: `grad_a = grad @ b.T`, `grad_b = a.T @ grad`

### Element-wise functions (`abs`, `neg`, `exp`, `log`, `sqrt`, `sin`, `cos`, etc.)

- Simple element-wise math functions
- **C++**: TensorIterator + element-wise kernel
- **CUDA**: One thread per element, applies the math function
- Standard autograd rules (e.g., `exp'(x) = exp(x)`, `log'(x) = 1/x`)

### Comparison ops (`eq`, `ne`, `lt`, `gt`, `le`, `ge`)

- Element-wise comparison, returns a boolean tensor
- `==`, `!=`, `<`, `>`, `<=`, `>=` operators map to these
- Not differentiable (gradient is zero)

### `torch.clamp` / `torch.relu` (as a math op)

- `clamp(input, min, max)` → element-wise clamping
- `relu(x)` → equivalent to `clamp(x, min=0)` conceptually, but has its own optimized kernel
- **Autograd**: grad is passed through where the condition is met, zero otherwise

## Common Reductions

### `tensor.sum` / `tensor.mean` / `tensor.prod`

- Reduce along specified dimensions (or all dimensions if none specified)
- **C++**: Uses reduction kernels optimized for different reduction patterns
- **CUDA**: Tree-reduction pattern using shared memory within thread blocks, then across blocks
- `sum(dim)`: keeps or removes the reduced dimension based on `keepdim`
- **Autograd**:
  - `sum`: grad is broadcast back to input shape
  - `mean`: grad is broadcast and divided by the number of elements
  - `prod`: grad involves the product of all other elements

### `tensor.max` / `tensor.min` / `tensor.argmax` / `tensor.argmin`

- `max()` / `min()` → global max/min (returns scalar)
- `max(dim)` / `min(dim)` → along a dimension (returns values and indices)
- `argmax` / `argmin` → returns only the indices
- **CUDA**: Parallel reduction kernel
- **Autograd**: Gradient flows only to the max/min element (one-hot pattern)

### `tensor.norm` / `torch.linalg.norm`

- Computes vector or matrix norms
- **C++**: Typically decomposes into `abs`, `pow`, `sum`, `pow` (e.g., L2 norm = sqrt(sum(x²)))
- `torch.linalg.norm` is the modern API, `tensor.norm` is legacy

### `tensor.var` / `tensor.std`

- Variance and standard deviation
- **C++**: Computed as reduction ops (may use Welford's algorithm for numerical stability)
- `var(dim, correction=1)` → Bessel's correction by default
- **Autograd**: Standard derivative rules for variance/std

## In-Place Operations

Any op suffixed with `_` modifies the tensor in place:

```python
x.add_(y)       # x = x + y, in place
x.mul_(2)       # x = x * 2, in place
x.zero_()       # fills x with zeros, in place
x.fill_(val)    # fills x with val, in place
x.clamp_(0, 1)  # clamps x to [0, 1], in place
```

- **Key point**: In-place ops on tensors that require grad will raise an error if the tensor is needed for backward computation (since the original values are overwritten)
- In-place ops return the modified tensor for chaining
