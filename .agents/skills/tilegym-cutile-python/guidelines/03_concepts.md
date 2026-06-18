# cuTile - Concepts

## Tile Size Restriction

Each dimension of a tile must be a power of 2 (i.e., 2^n) when using `ct.load` and `ct.store` to load and store the tile.
If the requested tile shape contains any dimension that is **not** a power of 2, cuTile will return an error.
Thus, we need to pass a new parameter for the next larger power-of-2 tile size
and the excess elements are padded with zeros (or the specified padding mode, default is `ct.PaddingMode.ZERO`).

Example:

```python
def next_power_of_2(x: int) -> int:
    return 1 << (x - 1).bit_length()

@ct.kernel
def kernel(x, SIZE: ct.Constant[int], SIZE_P: ct.Constant[int]):
    bid_0 = ct.bid(0)
    bid_1 = ct.bid(1)
    ## Wrong code: tx = ct.load(x, index=(bid_0, bid_1), shape=(SIZE, SIZE)) ## Not a power of 2
    tx = ct.load(x, index=(bid_0, bid_1), shape=(SIZE_P, SIZE_P))
    ## Do some computation on the tile
    ct.store(x, index=(bid_0, bid_1), tile=...) ## The tile is padded with zeros (default)

size = 10  ## Not a power of 2
size_p = next_power_of_2(size) ## 16, the next larger power of 2
ct.launch(stream, grid, kernel, (x, size, size_p))
```

It is a common practice to pass both the original size and the next larger power of 2 size to the kernel as kernel parameters.
This is because the kernel code does not need to know the original size, but only the next larger power of 2 size.


## Understanding Memory Operations in cuTile

`ct.load` and `ct.store` are fundamental operations for managing data movement in cuTile:

1. `ct.load`:
   - Moves data from global memory to tile registers
   - Cannot be used to move data between tile registers
   - For tile-to-tile operations, use NumPy-style operations like:
     - Reshape: `ct.reshape(tile, new_shape)`
     - Transpose: `ct.transpose(tile, axis0, axis1)`
     - Indexing: `tile[:, :, 0:5]`
2. `ct.store`:
   - Moves data from tile registers back to global memory
   - Is the inverse operation of `ct.load`
   - Must match the data type of the destination tensor

Example: Understand the shape of tile from the shape of the input tensor
```python
# In ct.load, the parameter `index` defines the starting point of the tile,
#             the parameter `shape` defines the shape of the tile.
# The same also applies to ct.store

# Create a tile from the input tensor A, the shape of the tile is (BLOCK_B, BLOCK_M)
tx = ct.load(A, index=(bid_b, bid_m), shape=(BLOCK_B, BLOCK_M))
# This creates the same tile shape as tx, but the index is (0, bid_m)
ty = ct.load(A, index=(0, bid_m), shape=(BLOCK_B, BLOCK_M))
```

## Kernel Fusion in cuTile

Kernel fusion is essential in cuTile to maximize performance and minimize memory traffic. Key principles for effective kernel fusion:
1. Maintain consistent tile indices across fused operations
2. Analyze input tensor shapes and block sizes to ensure compatible tile indices
3. Maximize the number of operations within a single kernel
4. Consider memory access patterns when fusing operations

Common kernel fusion patterns:
1. Element-wise operations:
   - Addition, multiplication, or other element-wise operations between tensors
   - Example: A + B where A and B share the same tile indices
2. Matrix multiplication with activation:
   - Fuse matrix multiplication with element-wise operations
   - Example: ReLU(matmul(A, B)) where A and B maintain consistent tile indices
3. Chained matrix operations:
   - Fuse multiple matrix operations that share input tensors
   - Example: matmul(matmul(A, B), C) where A's tile indices are preserved

Best practices:
- Always verify tile index compatibility before fusion
- Use the same block sizes for operations that will be fused
- Consider memory bandwidth when deciding which operations to fuse
- Profile performance to validate fusion benefits

## Default Rules When User Does Not Specify

1. **Default Data Type**: If tensor types are not specified, use `torch.float16` as the default data type for optimal GPU memory usage and performance.

2. **Default Tolerance Values**: If numerical comparison tolerance is not specified, use the following defaults based on data type:
   - `torch.float32`: `atol=1e-3, rtol=1e-3`
   - `torch.float16` and `torch.bfloat16`: `atol=1e-2, rtol=1e-2`

   These values must be carefully balanced — too strict causes false failures from floating-point precision limits; too loose masks real bugs. They account for the reduced precision of half-precision formats while maintaining sensitivity to implementation errors.

3. **Default Tensor Shapes**: If tensor shapes are not specified, generate suitable shapes where:
   - Each dimension is a power of 2 (e.g., 32, 64, 128, 256)
   - Consider GPU memory constraints and typical use cases
   - For higher dimensions: ensure total elements remain reasonable for testing
