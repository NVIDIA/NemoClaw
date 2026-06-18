# cuTile - Code Generation Rules

## Rule 1: Do not use non-existent cuTile functions. Implement them from primitives.

The following functions do NOT exist in cuTile. Use the listed replacements:

| Non-existent function | Replacement |
|----------------------|-------------|
| `ct.sign(x)` | `ct.where(x > 0, 1, 0) + ct.where(x < 0, -1, 0)` then `ct.astype(..., x.dtype)` |
| `ct.neg(x)` | `-x` or `ct.negative(x)` |
| `ct.sqr(x)`, `ct.square(x)` | `x * x` |
| `ct.sigmoid(x)` | `1.0 / (1.0 + ct.exp(-x))` |
| `ct.silu(x)` | `x * (1.0 / (1.0 + ct.exp(-x)))` |
| `ct.norm(...)` | Implement from `ct.sum`, `ct.sqrt`, etc. |
| `ct.softmax(...)` | Implement from `ct.max`, `ct.exp`, `ct.sum` |
| `ct.flip(...)` | Reverse indices manually (see example below) |
| `ct.empty(...)` | Not supported — use `ct.full` or `ct.zeros` |
| `ct.tensor(...)` | Not supported — use `ct.load` from a tensor |
| `ct.thread_id(...)` | Not supported — use `ct.bid()` for block indices |

```python
# ct.sign replacement:
signed_tx = ct.where(tx > 0, 1, 0) + ct.where(tx < 0, -1, 0)
signed_tx = ct.astype(signed_tx, tx.dtype)

# ct.flip replacement:
@ct.kernel
def flip(input, output, dim_1_size: ct.Constant[int]):
    bid_x = ct.bid(0)
    bid_y = ct.bid(1)
    value = ct.load(input, (bid_x, dim_1_size - 1 - bid_y), shape=(1, 1))
    ct.store(output, index=(bid_x, bid_y), tile=value)
```

Also note the distinction between reduction and element-wise operations:
- `ct.min`/`ct.max` — **reduce** along an axis (like `torch.min(x, dim=...)`)
- `ct.minimum`/`ct.maximum` — **element-wise** comparison between two tensors

```python
# PyTorch: x = torch.min(x, dim=1, keepdim=False)[0]
# cuTile (correct):
x = ct.min(x, axis=1, keepdims=False)
```

## Rule 2: Both `ct.abs(x)` and `abs(x)` are valid in cuTile kernels. `ct.abs` was added in v1.1.0.
```python
# Both are correct
abs_x1 = ct.abs(x1)
abs_x1 = abs(x1)
```

## Rule 3: When loading scalar values in cuTile kernels, use `shape=()` for 0D tile (scalar) loads.
```python
# Loading a scalar value from a 1D array as a 0D tile (scalar)
# The index matches the array's rank, shape=() indicates scalar output
tx = ct.load(x, index=(0,), shape=())  # x is 1D array, loads element as scalar

# Loading a scalar from a 3D array as a 0D tile
tx = ct.load(array3d, index=(0, 0, 0), shape=())  # Valid scalar load

# Single-element tiles are valid for scalar broadcasting patterns
value = ct.load(input, index=(bid_x, bid_y), shape=(1, 1))  # Valid for broadcasting

# Note: When shape=(), the index tuple length must match the SOURCE ARRAY's
# dimensionality, not the shape tuple's length.
```

## Rule 4: cuTile kernel grid must be a tuple of integers with no more than 3 elements.
```python
# Wrong code 1
grid = 1
# Wrong code 2
grid = (1, 2, 3, 4)
# Wrong code 3
grid = [1]  # a list is not a tuple, expect a tuple (1,)
# Correct code 1
grid = (1,)
# Correct code 2
grid = (1, 2)
# Correct code 3
grid = (1, 2, 3)
```

## Rule 5: When looping over an axis, use block ids instead of the loop index.
```python
# Wrong code
for i in range(0, 16, BLOCK):
    tx = ct.load(x, index=(i,), shape=(BLOCK,))
# Correct code
for i in range(0, 16, BLOCK):
    block_id = i // BLOCK
    tx = ct.load(x, index=(block_id,), shape=(BLOCK,))
```

## Rule 6: No need for additional synchronization after kernel launch in cuTile.
```python
# Wrong code
ct.launch(stream, grid, kernel, kernel_args)
torch.cuda.synchronize()

# Correct code
ct.launch(stream, grid, kernel, kernel_args)
```

## Rule 7: Refrain from checking the boundary for out-of-bounds in cuTile kernels.

cuTile automatically handles out-of-bounds accesses with well-defined default values, eliminating the need for manual boundary checks. This applies to:

- **Tile loads/stores**: Out-of-range indices return zeros (or other appropriate defaults) instead of causing errors
- **Block indices (`ct.bid`)**: These are guaranteed to be within valid ranges based on the grid dimensions you specify
- **Memory operations**: `ct.load()` and `ct.store()` safely handle edge cases without explicit bounds checking

Unlike CUDA C/C++ where out-of-bounds accesses can cause undefined behavior, cuTile provides safe defaults. This simplifies kernel code significantly — you can focus on the core computation logic rather than defensive programming against boundary conditions.

## Rule 8: Prefer tile-based programming over loop-based programming in cuTile.

- Total grid size 1 should be avoided unless the problem size is small.
- When the problem size is large, you need to estimate the number of tiles and the block size.

## Rule 9: Use `rand` instead of `randn` to generate random test inputs.

`randn` generates values from a normal distribution which can produce extreme values, making numerical validation unreliable. Use `rand` for test inputs.

## Rule 10: Never use `ct.tfloat32`. Use `float16` inputs with `float32` accumulators.

**The default compute pattern for matmul is: load inputs as `float16`, accumulate in `float32`.** Do not use `ct.tfloat32` — it causes validation failures (~0.1 max absolute error) and is unnecessary when inputs are already float16.

If the input tensor arrives as float32, cast it to float16 on load:

```python
# CORRECT: float16 inputs, float32 accumulator
acc = ct.full((BLOCK_M, BLOCK_N), 0.0, dtype=ct.float32)
for k in range(num_k):
    a = ct.astype(ct.load(A, index=(bid_m, k), shape=(BLOCK_M, BLOCK_K)), ct.float16)
    b = ct.astype(ct.load(B, index=(k, bid_n), shape=(BLOCK_K, BLOCK_N)), ct.float16)
    acc = ct.mma(a, b, acc)
out = ct.astype(acc, output.dtype)

# WRONG: casting to tfloat32 — causes ~0.1 precision error, do not copy this pattern
a = ct.astype(ct.load(A, ...), ct.tfloat32)  # DO NOT DO THIS
```

Note: TileGym examples sometimes cast float32 inputs to `ct.tfloat32` for throughput. **Do not follow that pattern** — it breaks validation. Always use float16 inputs.

## Rule 11: `ct.mma` requires x and y to have the same dtype (unless they are int8/uint8). Cast both inputs to the same type before calling `ct.mma`.
```python
# WRONG: x is float32, y is float16 — TileTypeError in v1.2.0+
p = ct.exp(qk)         # float32
v = ct.load(V, ...)    # float16
o = ct.mma(p, v, o)

# CORRECT: cast y to match x
p = ct.exp(qk)                    # float32
v = ct.load(V, ...)               # float16
v = ct.astype(v, ct.float32)      # now float32 — matches p
o = ct.mma(p, v, o)
```

## Rule 12: `ct.cumsum` works correctly on both 1D `(L,)` with `axis=0` and 2D `(1, L)` with `axis=1`. The 2D form is safer and more idiomatic:
```python
# Both are correct, but 2D form is preferred
ct.cumsum(tile_1d, axis=0)            # tile_1d shape: (L,)
ct.cumsum(tile_2d, axis=1)            # tile_2d shape: (1, L)  ← preferred
```

## Rule 13: When debugging large numerical errors, always check BOTH absolute and relative errors before concluding the kernel is wrong.

A large `max_diff` can be misleading — it may reflect float32 noise on large-valued outputs rather than an algorithmic bug. Before investigating the kernel, compute:

```python
abs_diff = (actual - expected).abs()
rel_diff = abs_diff / (expected.abs() + 1e-8)
print(f"abs_max={abs_diff.max():.3e}, rel_max={rel_diff.max():.3e}, rel_mean={rel_diff.mean():.3e}")
```

If `rel_mean` is small (e.g., < 1e-4) but `abs_max` is large, the kernel is likely correct — the large absolute error comes from float32's limited mantissa on large-valued outputs.

## Rule 14: Numerical test inputs should reflect the physical or mathematical constraints of the algorithm.

Unconstrained random inputs can create ill-conditioned problems where outputs have enormous magnitudes, causing catastrophic cancellation in the final result. Use two-tier validation:

```python
# Tier 1: Shape and dtype check with arbitrary random input
shape_ok = actual.shape == expected.shape and actual.dtype == expected.dtype

# Tier 2: Numerical accuracy with constrained input that matches real usage
x_constrained = construct_valid_input(...)
is_close = torch.allclose(actual_constrained, expected_constrained, atol=1e-3, rtol=1e-3)
```

## Rule 15: Every compute op in `forward()` must be a cuTile kernel — never fall back to PyTorch.

Do not use `nn.*`/`F.*` compute ops (`F.conv2d`, `F.linear`, `torch.matmul`, `torch.bmm`, etc.) in the forward path. Common violations:

| Violation | Why it's wrong | Fix |
|-----------|---------------|-----|
| `F.conv2d(x, w)` because "grid too large" | Tile the spatial dim: `grid = (N, C_out, cdiv(H*W, BLOCK_HW))` | Write a conv cuTile kernel |
| `torch.relu(x_bn)` between cuTile kernels | Normalization + activation is a compute op | Fuse BN+ReLU into a cuTile kernel |
| Labeling `F.linear`/`torch.matmul` as "infrastructure" | These are among the most expensive ops | Route through existing `matmul_kernel` |
| Skipping ops because current params make output trivial | Must work for arbitrary valid params | Implement all ops as cuTile kernels |
| Wrapping launches in `torch.cuda.CUDAGraph` | Produces misleading perf comparisons | Use `ct.launch` directly |

```python
# WRONG: PyTorch fallback for "complex" ops
def forward(self, x):
    x = F.conv2d(x, self.weight)           # ← PyTorch fallback
    x = torch.relu(F.batch_norm(x, ...))   # ← PyTorch fallback
    return x

# CORRECT: all compute in cuTile
def forward(self, x):
    x = launch_conv2d(x, self.weight, self.bias)
    x = launch_bn_relu(x, self.gamma, self.beta, self.running_mean, self.running_var)
    return x
```

## Rule 16: Never pass PyTorch tensors with `requires_grad=True` to cuTile kernels. Use `.detach()` or wrap in `torch.no_grad()`.
```python
# Wrong code
output = torch.zeros(..., requires_grad=True)
ct.launch(stream, grid, kernel, (input, output))

# Correct code
with torch.no_grad():
    ct.launch(stream, grid, kernel, (input, output))
# or
ct.launch(stream, grid, kernel, (input.detach(), output.detach()))
```

## Rule 17: Implement all ops for general inputs — do not exploit specific parameter values to skip computation.

The solution must implement every op in the pipeline as a cuTile kernel that works for arbitrary valid inputs and parameters. Do not analyze the constructor arguments to prove the output is trivially computable (e.g., always zero, always constant) and skip the actual ops. The implementation must be correct if the parameters change.

```python
# WRONG: deduces output is always zero for current parameters, skips all ops
def forward(self, x):
    return torch.zeros(...)  # skips Conv3d, GroupNorm, etc.

# CORRECT: implement all ops as cuTile kernels
def forward(self, x):
    x = launch_conv3d(x, self.weight, self.bias)
    x = launch_group_norm(x, self.gn_weight, self.gn_bias)
    x = launch_min_clamp(x, self.min_value, self.max_value)
    return x
```
